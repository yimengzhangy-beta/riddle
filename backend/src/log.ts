import { AsyncLocalStorage } from 'async_hooks';

/**
 * Structured audit logging.
 *
 * Every event is one JSON object on a single stdout line — that is the shape
 * CloudWatch Logs Insights discovers fields from without a parse expression.
 * All events of one request share `requestId`, which is API Gateway's own
 * request id, so a Lambda event and the matching access-log line join on it.
 *
 * HARD RULE — never log user content. No guess text, no riddle text, no
 * answers, no hints, no prompts, no model completions. Ids, enum values,
 * counts and timings only. See CLAUDE.md.
 */

export type LlmPurpose = 'guess_judgment' | 'riddle_generation';

/**
 * How a guess was settled. `normalized` means it never reached the model.
 * `judge_not_entitled` means the player's plan does not include Claude judging,
 * so an inexact guess was settled by string comparison alone — the difference
 * between that and `llm_judged` is the free-to-paid conversion opportunity.
 */
export type GuessResolution =
  | 'normalized'
  | 'llm_judged'
  | 'llm_unavailable'
  | 'judge_not_entitled';

/**
 * The metered actions. Each value is the `sourceEventType` of a published
 * AWS Monetization metric — the strings are the contract with the billing
 * backend, so they are spelled here once and imported everywhere else.
 */
export type BillableAction =
  | 'serve_riddle'
  | 'serve_hard_riddle'
  | 'submit_guess'
  | 'take_hint'
  | 'judge_guess';

interface RequestContext {
  requestId: string;
  userId: string | null;
  route: string;
  method: string;
  riddleId: string | null;
  startedAt: number;
}

/**
 * A Lambda execution environment handles one invocation at a time, so a module
 * global would do — AsyncLocalStorage keeps the context correct anyway if this
 * handler is ever run somewhere that overlaps requests.
 */
const storage = new AsyncLocalStorage<RequestContext>();

function emit(event: string, fields: Record<string, unknown> = {}): void {
  const ctx = storage.getStore();
  console.log(
    JSON.stringify({
      event,
      ts: new Date().toISOString(),
      requestId: ctx?.requestId ?? null,
      userId: ctx?.userId ?? null,
      route: ctx?.route ?? null,
      ...fields,
    })
  );
}

/**
 * Opens the audit trail for one request: emits the `request` event, then runs
 * the handler with the context every later event reads its ids from.
 */
export function withRequest<T>(
  ctx: Omit<RequestContext, 'startedAt'>,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run({ ...ctx, startedAt: Date.now() }, () => {
    emit('request', { method: ctx.method, riddleId: ctx.riddleId });
    return fn();
  });
}

/** Closes the trail. Duration is measured from `withRequest`, not from cold start. */
export function logResponse(status: number): void {
  const ctx = storage.getStore();
  emit('response', {
    method: ctx?.method ?? null,
    status,
    durationMs: ctx ? Date.now() - ctx.startedAt : null,
  });
}

/**
 * One model call. Absence of this event on a guess request is itself the signal
 * that the normalisation fast path settled it — see the guess_resolved event.
 */
export function logLlmCall(fields: {
  purpose: LlmPurpose;
  model: string;
  attempt: number;
  durationMs: number;
  ok: boolean;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string | null;
  error?: string;
}): void {
  emit('llm_call', {
    ...fields,
    totalTokens:
      fields.inputTokens === undefined && fields.outputTokens === undefined
        ? undefined
        : (fields.inputTokens ?? 0) + (fields.outputTokens ?? 0),
  });
}

/** A DynamoDB write. The item key only — never the item. */
export function logDbWrite(fields: {
  op: 'Put' | 'Update';
  pk: string;
  sk: string;
  /** Attribute names touched by an Update. Names only, never values. */
  counters?: string[];
  /** False when a conditional write was rejected, e.g. the riddle dedupe guard. */
  written?: boolean;
}): void {
  emit('db_write', fields);
}

/** How one guess was settled, and at what cost. Verdict is an enum, not text. */
export function logGuessResolved(fields: {
  riddleId: string;
  resolution: GuessResolution;
  verdict: string;
  solved: boolean;
  guessNumber: number;
  hintsTaken: number;
}): void {
  emit('guess_resolved', fields);
}

/**
 * One entitlement decision. Every field is an id or an enum the billing backend
 * defines — `reason` is a code like NO_SUBSCRIPTION or QUOTA_EXCEEDED, never a
 * sentence built from the player's request.
 */
export function logEntitlement(fields: {
  action: BillableAction;
  decision: 'ALLOW' | 'DENY';
  reason: string;
  planId: string | null;
  enforced: boolean;
}): void {
  emit('entitlement', fields);
}

/** One usage event handed to the billing backend. Counts only. */
export function logMetered(fields: {
  action: BillableAction;
  quantity: number;
  ok: boolean;
  /** Error class name only — an SDK message can quote what it was given. */
  error?: string;
}): void {
  emit('metered', fields);
}

/**
 * A billing call that failed for operational reasons — distinct from a DENY,
 * which is an answer rather than a failure. The class name only, for the same
 * reason `logError` withholds messages from SDK errors.
 */
export function logBillingError(fields: {
  where: string;
  action: BillableAction | null;
  name: string;
}): void {
  emit('billing_error', fields);
}

/**
 * An operational failure. Only the error class and a message this codebase
 * controls — never a message built from request or model text.
 */
export function logError(fields: {
  name: string;
  message: string;
  where: string;
  frames?: string;
}): void {
  emit('error', fields);
}

/**
 * The "at ..." lines of a stack, without the leading message line. A thrown
 * error's message can quote the input that produced it — an AWS SDK validation
 * error will happily echo an attribute value — so an unexpected error's stack
 * is kept for debugging while its message is not.
 */
export function stackFrames(err: unknown, limit = 8): string {
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, limit)
    .join(' | ');
}
