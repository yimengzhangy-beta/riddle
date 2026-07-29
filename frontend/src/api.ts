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

/** A non-2xx response, carrying the parsed body so callers can read `upgradeUrl`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(typeof body.error === 'string' ? body.error : `Request failed (${status})`);
  }

  /** The player's plan does not cover this — the body carries where to go next. */
  get isNotEntitled(): boolean {
    return this.status === 403;
  }

  get upgradeUrl(): string {
    return typeof this.body.upgradeUrl === 'string' ? this.body.upgradeUrl : '/pricing';
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

export interface Allowance {
  action: string | null;
  label: string;
  includedUnits: number | null;
  overageCents: number | null;
}

export interface Plan {
  planId: string;
  name: string;
  description: string;
  currency: string;
  sortOrder: number;
  monthlyCents: number;
  /** Plan-wide spend cap in cents for the period, or null when uncapped. */
  budgetLimitCents: number | null;
  allowances: Allowance[];
}

export interface UsageRow {
  action: string | null;
  label: string;
  currentUsage: number;
  includedUnits: number | null;
  overageCents: number | null;
}

export interface Summary {
  planId: string | null;
  planName?: string | null;
  currency?: string;
  billingCycle?: string;
  billingAnchorDate?: string | null;
  nextPeriodBoundary?: string | null;
  pendingChange?: { planId?: string | null; effectiveDate?: string } | null;
  estimatedChargeCents?: number;
  budgetLimitCents?: number | null;
  usage?: UsageRow[];
}

export interface CheckoutSession {
  checkoutUrl?: string;
  expiresAt?: string;
  effectiveAt?: string;
}

/** Public — renders for a signed-out visitor. */
export const fetchPlans = () => request<{ plans: Plan[] }>('/plans');

export const fetchSubscription = () =>
  request<{ planId: string | null }>('/subscription', { auth: true });

export const fetchSummary = () => request<Summary>('/subscription/summary', { auth: true });

export const subscribe = (planId: string) =>
  request<CheckoutSession>('/subscribe', {
    auth: true,
    method: 'POST',
    body: JSON.stringify({ planId }),
  });

// -------------------------------------------------------------- formatting

/** Amounts cross the wire in cents. This is the only place they become dollars. */
export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** ISO timestamp → a plain date. Billing dates are days, not moments. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}
