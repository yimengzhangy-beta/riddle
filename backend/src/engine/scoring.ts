import type { Difficulty, Profile } from '../types';
import { BASE_POINTS, HINT_PENALTY } from '../types';

/**
 * Pure scoring and streak rules. No IO, no model, no clock beyond what the caller
 * supplies — the engine passes today's date in so this stays testable.
 */

/**
 * Canonical form used for the exact-match fast path, and for the dedupe key when
 * generating riddles. Lowercases, strips accents and punctuation, drops a leading
 * article, and collapses whitespace.
 */
export function normalize(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining accents left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:a|an|the)\s+/, '');
}

export function isExactMatch(guess: string, answer: string): boolean {
  const normalizedGuess = normalize(guess);
  return normalizedGuess !== '' && normalizedGuess === normalize(answer);
}

/** Points for a solve: the difficulty's base, less HINT_PENALTY per hint taken. */
export function pointsFor(difficulty: Difficulty, hintsTaken: number): number {
  return Math.max(0, BASE_POINTS[difficulty] - HINT_PENALTY * hintsTaken);
}

function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * How a solve today relates to the player's last one. A streak counts consecutive
 * UTC days on which the player solved at least one riddle: solving twice in one day
 * does not extend it, and missing a day restarts it.
 */
export type StreakStep = 'same-day' | 'extends' | 'restarts';

export function streakStep(lastSolvedDate: string | null, today: string): StreakStep {
  if (lastSolvedDate === today) return 'same-day';
  return lastSolvedDate === previousDay(today) ? 'extends' : 'restarts';
}

export interface ProfileUpdate {
  profile: Profile;
  pointsAwarded: number;
}

/** Folds a solve into the profile: score, streak, solve count. */
export function applySolve(args: {
  profile: Profile;
  difficulty: Difficulty;
  hintsTaken: number;
  today: string;
}): ProfileUpdate {
  const pointsAwarded = pointsFor(args.difficulty, args.hintsTaken);

  const step = streakStep(args.profile.lastSolvedDate, args.today);
  const streak =
    step === 'same-day'
      ? args.profile.streak
      : step === 'extends'
        ? args.profile.streak + 1
        : 1;

  return {
    pointsAwarded,
    profile: {
      ...args.profile,
      score: args.profile.score + pointsAwarded,
      streak,
      riddlesSolved: args.profile.riddlesSolved + 1,
      lastSolvedDate: args.today,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Rolls the daily hint counter over when the UTC date has changed. Returns the
 * profile unchanged when it is still the same day.
 */
export function rollHintBudget(profile: Profile, today: string): Profile {
  if (profile.hintsDate === today) return profile;
  return { ...profile, hintsUsedToday: 0, hintsDate: today };
}

/** Records one hint against today's budget. */
export function applyHint(profile: Profile, today: string): Profile {
  const rolled = rollHintBudget(profile, today);
  return {
    ...rolled,
    hintsUsedToday: rolled.hintsUsedToday + 1,
    updatedAt: new Date().toISOString(),
  };
}
