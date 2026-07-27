export type Difficulty = 'easy' | 'medium' | 'hard';

export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/** Points awarded for a solve, before the per-hint penalty. */
export const BASE_POINTS: Record<Difficulty, number> = {
  easy: 10,
  medium: 25,
  hard: 50,
};

export const HINT_PENALTY = 5;
export const MAX_HINTS = 3;

/** RIDDLE#<id> / META — one riddle in the bank. */
export interface Riddle {
  riddleId: string;
  text: string;
  answer: string;
  difficulty: Difficulty;
  topic: string;
  /** Exactly MAX_HINTS hints, ordered from vaguest to most revealing. */
  hints: string[];
  timesServed: number;
  timesSolved: number;
  createdAt: string;
}

/** What a player is allowed to see: never the answer, and only the hints they took. */
export interface PublicRiddle {
  riddleId: string;
  text: string;
  difficulty: Difficulty;
  topic: string;
  hintsAvailable: number;
  hintsTaken: number;
  revealedHints: string[];
}

/** USER#<id> / PROFILE */
export interface Profile {
  userId: string;
  email: string;
  score: number;
  streak: number;
  hintsUsedToday: number;
  /** YYYY-MM-DD (UTC) that hintsUsedToday counts against. */
  hintsDate: string;
  /** YYYY-MM-DD (UTC) of the most recent solve, or null if never solved. */
  lastSolvedDate: string | null;
  riddlesSolved: number;
  createdAt: string;
  updatedAt: string;
}

/** USER#<id> / ATTEMPT#<riddleId> — one row per riddle the user has been served. */
export interface Attempt {
  userId: string;
  riddleId: string;
  difficulty: Difficulty;
  guesses: string[];
  hintsTaken: number;
  solved: boolean;
  points: number;
  startedAt: string;
  solvedAt: string | null;
}

/** DAILY#<date> / META — one row per UTC day, for at-a-glance activity stats. */
export interface DailyStats {
  date: string;
  riddlesServed: number;
  guesses: number;
  solves: number;
  hintsTaken: number;
  pointsAwarded: number;
}

/** The strict JSON contract the model must satisfy when judging a guess. */
export type Verdict = 'correct' | 'close' | 'wrong';

export const VERDICTS: Verdict[] = ['correct', 'close', 'wrong'];

export interface JudgedGuess {
  verdict: Verdict;
  /** One short sentence the player sees. Must not leak the answer unless correct. */
  reason: string;
}

/** One riddle as the model is asked to produce it during batch generation. */
export interface GeneratedRiddle {
  text: string;
  answer: string;
  topic: string;
  hints: string[];
}
