import { getIdToken, signOut } from './cognito';

/**
 * The Riddle API.
 *
 * Every authenticated call resolves a fresh ID token first, so a long session
 * refreshes transparently rather than failing at the authorizer. A 401 that
 * survives that means the session is genuinely gone — the caller routes to
 * sign-in.
 */

const RAW_API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const API_URL = RAW_API_URL.replace(/\/+$/, '');

export function apiConfigured(): boolean {
  return API_URL !== '';
}

/** A non-2xx response, carrying the parsed body so callers can branch on it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(typeof body.error === 'string' ? body.error : `Request failed (${status})`);
  }

  /** True on a 403 from a billable action: the plan doesn't allow it — offer plans. */
  get planDenied(): boolean {
    return this.status === 403 && this.body.decision === 'DENY';
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {}
): Promise<T> {
  if (!API_URL) {
    throw new ApiError(0, { error: 'Set VITE_API_URL to your deployed API URL.' });
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.auth) {
    const token = await getIdToken();
    if (!token) throw new ApiError(401, { error: 'Your session has expired.' });
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.status === 401) {
    // The authorizer rejected a token we thought was good — the session is over.
    signOut();
    throw new ApiError(401, body);
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

// ------------------------------------------------------------------- riddle

export type Difficulty = 'easy' | 'medium' | 'hard';

export const BASE_POINTS: Record<Difficulty, number> = { easy: 10, medium: 25, hard: 50 };
export const HINT_PENALTY = 5;
export const MAX_HINTS = 3;

export interface Me {
  userId: string;
  email: string;
  score: number;
  streak: number;
  hintsUsedToday: number;
  riddlesSolved: number;
  lastSolvedDate: string | null;
  memberSince: string;
}

export interface PublicRiddle {
  riddleId: string;
  text: string;
  difficulty: Difficulty;
  topic: string;
  hintsAvailable: number;
  hintsTaken: number;
  revealedHints: string[];
}

export interface NextRiddle {
  riddle: PublicRiddle;
  remainingUnseen: number;
}

export interface GuessResult {
  riddleId: string;
  verdict: 'correct' | 'close' | 'wrong';
  reason: string;
  solved: boolean;
  pointsAwarded: number;
  guesses: number;
  hintsTaken: number;
  score: number;
  streak: number;
  answer: string | null;
  exactMatch: boolean;
}

export interface HintResult {
  riddleId: string;
  hint: string;
  hintNumber: number;
  hintsRemaining: number;
  hintsUsedToday: number;
  pointsIfSolved: number;
}

export const getMe = () => request<Me>('/me', { auth: true });

export const nextRiddle = (difficulty: Difficulty) =>
  request<NextRiddle>(`/riddles/next?difficulty=${difficulty}`, { auth: true });

export const submitGuess = (riddleId: string, guess: string) =>
  request<GuessResult>(`/riddles/${encodeURIComponent(riddleId)}/guess`, {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ guess }),
  });

export const takeHint = (riddleId: string) =>
  request<HintResult>(`/riddles/${encodeURIComponent(riddleId)}/hint`, {
    auth: true,
    method: 'POST',
  });

// ------------------------------------------------------------------ billing

/** Short-lived URLs for the MonetizationAI-hosted pricing page and billing portal. */
export interface BillingSession {
  pricingUrl: string;
  billingPortalUrl: string;
}

export const getBillingSession = () =>
  request<BillingSession>('/billing/session', { auth: true });
