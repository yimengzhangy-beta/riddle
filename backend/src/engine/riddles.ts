import { today } from '../db/client';
import * as daily from '../db/daily';
import * as riddlesDb from '../db/riddles';
import * as usersDb from '../db/users';
import { ModelOutputError, judgeGuess } from '../llm/client';
import { judgeSystemPrompt, judgeUserMessage, retryNudge } from '../prompts';
import type { Attempt, Difficulty, JudgedGuess, Profile, PublicRiddle, Riddle } from '../types';
import { MAX_HINTS } from '../types';
import { applyHint, applySolve, isExactMatch, pointsFor, rollHintBudget } from './scoring';

/** Orchestration: persistence + scoring rules + at most one model call per guess. */

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}

export interface Player {
  userId: string;
  email: string;
}

/** Strips the answer and any hint the player has not paid for. */
function publicView(riddle: Riddle, attempt: Attempt | null): PublicRiddle {
  const hintsTaken = attempt?.hintsTaken ?? 0;
  return {
    riddleId: riddle.riddleId,
    text: riddle.text,
    difficulty: riddle.difficulty,
    topic: riddle.topic,
    hintsAvailable: Math.max(0, MAX_HINTS - hintsTaken),
    hintsTaken,
    revealedHints: riddle.hints.slice(0, hintsTaken),
  };
}

export interface NextRiddleResult {
  riddle: PublicRiddle;
  remainingUnseen: number;
}

/**
 * Serves a riddle of the requested difficulty that this player has never been
 * shown. Reads the player's attempts once, then filters the difficulty's bank
 * against them, so a player who has exhausted a difficulty gets a clear 409
 * rather than a repeat.
 */
export async function nextRiddle(args: {
  player: Player;
  difficulty: Difficulty;
}): Promise<NextRiddleResult> {
  const [bank, attempts] = await Promise.all([
    riddlesDb.listByDifficulty(args.difficulty),
    usersDb.listAttempts(args.player.userId),
  ]);

  if (bank.length === 0) {
    throw new NotFoundError(
      `No ${args.difficulty} riddles in the bank yet — seed some via POST /admin/generate`
    );
  }

  const seen = new Set(attempts.map((a) => a.riddleId));
  const unseen = bank.filter((r) => !seen.has(r.riddleId));

  if (unseen.length === 0) {
    throw new ConflictError(
      `You have already seen every ${args.difficulty} riddle in the bank`
    );
  }

  // Random pick so a player working through a difficulty does not get them in
  // insertion order every session.
  const riddle = unseen[Math.floor(Math.random() * unseen.length)];

  // Serving creates the attempt row, which is also what marks the riddle "seen".
  const attempt = usersDb.newAttempt({
    userId: args.player.userId,
    riddleId: riddle.riddleId,
    difficulty: riddle.difficulty,
  });
  await usersDb.putAttempt(attempt);
  await riddlesDb.incrementServed(riddle.riddleId);
  await daily.bumpQuietly({ riddlesServed: 1 });

  return {
    riddle: publicView(riddle, attempt),
    remainingUnseen: unseen.length - 1,
  };
}

/** Loads the riddle plus this player's attempt, or explains which one is missing. */
async function loadAttempt(
  player: Player,
  riddleId: string
): Promise<{ riddle: Riddle; attempt: Attempt }> {
  const [riddle, attempt] = await Promise.all([
    riddlesDb.getRiddle(riddleId),
    usersDb.getAttempt(player.userId, riddleId),
  ]);

  if (!riddle) throw new NotFoundError(`No riddle ${riddleId}`);
  if (!attempt) {
    throw new ConflictError(
      `You have not been served riddle ${riddleId} — call GET /riddles/next first`
    );
  }

  return { riddle, attempt };
}

export interface GuessResult {
  riddleId: string;
  verdict: JudgedGuess['verdict'];
  reason: string;
  solved: boolean;
  /** Points added to the profile by this guess. Zero unless this guess solved it. */
  pointsAwarded: number;
  guesses: number;
  hintsTaken: number;
  score: number;
  streak: number;
  /** Revealed only once the riddle is solved. */
  answer: string | null;
  /** True when the exact-match fast path settled it without a model call. */
  exactMatch: boolean;
}

export async function submitGuess(args: {
  player: Player;
  riddleId: string;
  guess: string;
}): Promise<GuessResult> {
  const { riddle, attempt } = await loadAttempt(args.player, args.riddleId);

  if (attempt.solved) {
    throw new ConflictError('You have already solved this riddle');
  }

  const profile = await usersDb.ensureProfile(args.player);

  // Normalise first — an exact match needs no model call at all.
  const exactMatch = isExactMatch(args.guess, riddle.answer);

  let judged: JudgedGuess;
  if (exactMatch) {
    judged = { verdict: 'correct', reason: 'Exactly right.' };
  } else {
    try {
      judged = await judgeGuess({
        system: judgeSystemPrompt(),
        user: judgeUserMessage({
          riddleText: riddle.text,
          answer: riddle.answer,
          guess: args.guess,
          previousGuesses: attempt.guesses,
        }),
        buildRetry: retryNudge,
      });
    } catch (err) {
      if (!(err instanceof ModelOutputError)) throw err;
      // The judge is the only thing that can turn a non-exact guess into a solve.
      // Rather than fail the request, fall back to the string comparison we already
      // did and tell the player their guess was not accepted.
      console.error(`Judge unusable, falling back to exact match only: ${err.message}`);
      judged = {
        verdict: 'wrong',
        reason: 'That is not the answer.',
      };
    }
  }

  const solved = judged.verdict === 'correct';
  const nextAttempt: Attempt = {
    ...attempt,
    guesses: [...attempt.guesses, args.guess],
    solved,
    points: solved ? pointsFor(riddle.difficulty, attempt.hintsTaken) : attempt.points,
    solvedAt: solved ? new Date().toISOString() : attempt.solvedAt,
  };

  let nextProfile = profile;
  let pointsAwarded = 0;

  if (solved) {
    const update = applySolve({
      profile,
      difficulty: riddle.difficulty,
      hintsTaken: attempt.hintsTaken,
      today: today(),
    });
    nextProfile = update.profile;
    pointsAwarded = update.pointsAwarded;
  }

  await usersDb.putAttempt(nextAttempt);
  if (solved) {
    await usersDb.putProfile(nextProfile);
    await riddlesDb.incrementSolved(riddle.riddleId);
  }
  await daily.bumpQuietly({
    guesses: 1,
    solves: solved ? 1 : 0,
    pointsAwarded,
  });

  return {
    riddleId: riddle.riddleId,
    verdict: judged.verdict,
    reason: judged.reason,
    solved,
    pointsAwarded,
    guesses: nextAttempt.guesses.length,
    hintsTaken: nextAttempt.hintsTaken,
    score: nextProfile.score,
    streak: nextProfile.streak,
    answer: solved ? riddle.answer : null,
    exactMatch,
  };
}

export interface HintResult {
  riddleId: string;
  hint: string;
  hintNumber: number;
  hintsRemaining: number;
  hintsUsedToday: number;
  /** What the riddle is now worth to this player if they solve it. */
  pointsIfSolved: number;
}

export async function takeHint(args: { player: Player; riddleId: string }): Promise<HintResult> {
  const { riddle, attempt } = await loadAttempt(args.player, args.riddleId);

  if (attempt.solved) {
    throw new ConflictError('You have already solved this riddle');
  }
  if (attempt.hintsTaken >= MAX_HINTS) {
    throw new ConflictError(`You have taken all ${MAX_HINTS} hints for this riddle`);
  }

  const profile = await usersDb.ensureProfile(args.player);

  const hintNumber = attempt.hintsTaken + 1;
  const hint = riddle.hints[attempt.hintsTaken];
  if (typeof hint !== 'string') {
    throw new NotFoundError(`Riddle ${riddle.riddleId} has no hint ${hintNumber}`);
  }

  const nextAttempt: Attempt = { ...attempt, hintsTaken: hintNumber };
  const nextProfile = applyHint(profile, today());

  await usersDb.putAttempt(nextAttempt);
  await usersDb.putProfile(nextProfile);
  await daily.bumpQuietly({ hintsTaken: 1 });

  return {
    riddleId: riddle.riddleId,
    hint,
    hintNumber,
    hintsRemaining: MAX_HINTS - hintNumber,
    hintsUsedToday: nextProfile.hintsUsedToday,
    pointsIfSolved: pointsFor(riddle.difficulty, hintNumber),
  };
}

export interface MeResult {
  userId: string;
  email: string;
  score: number;
  streak: number;
  hintsUsedToday: number;
  riddlesSolved: number;
  lastSolvedDate: string | null;
  memberSince: string;
}

export async function getMe(player: Player): Promise<MeResult> {
  const stored = await usersDb.ensureProfile(player);

  // Show a zeroed hint count once the UTC day has turned, without needing a write.
  const profile: Profile = rollHintBudget(stored, today());

  return {
    userId: profile.userId,
    email: profile.email,
    score: profile.score,
    streak: profile.streak,
    hintsUsedToday: profile.hintsUsedToday,
    riddlesSolved: profile.riddlesSolved,
    lastSolvedDate: profile.lastSolvedDate,
    memberSince: profile.createdAt,
  };
}
