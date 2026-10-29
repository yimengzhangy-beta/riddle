import { logError, logMonetization, stackFrames } from '../log';
import { getMonetize, monetizeInitialized } from './client';

/**
 * Entitlement and metering for the three player actions a plan covers.
 *
 * The values are the metric `eventType`s created in AWS Monetization — an event
 * with any other string is silently dropped, so this union is the contract.
 */
export type BillableAction = 'play_riddle' | 'submit_guess' | 'take_hint';

/** The player's plan does not allow the action. handler.ts maps it to 403. */
export class NotEntitledError extends Error {
  constructor(readonly reason: string) {
    super(`Not entitled: ${reason}`);
  }
}

/** `MONETIZATION_ENFORCE=false` keeps the gate open while testing metering only. */
function enforcing(): boolean {
  return process.env.MONETIZATION_ENFORCE !== 'false';
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * The entitlement gate. Runs before any paid work, so a denied request costs
 * nothing. A DENY (no subscription, quota exceeded, …) throws NotEntitledError.
 *
 * A failure to *reach* the service fails OPEN: the request is served and the
 * error logged, so a billing outage never takes the game down. To fail closed
 * instead, rethrow in the catch.
 */
export async function requireEntitlement(userId: string, action: BillableAction): Promise<void> {
  if (!enforcing()) return;

  const startedAt = Date.now();
  let decision: 'ALLOW' | 'DENY';
  let reason: string | undefined;

  try {
    const result = await getMonetize().checkEntitlement(userId, { eventType: action });
    decision = result.decision;
    // `reason` is { category, code }; the code (NO_SUBSCRIPTION, QUOTA_EXCEEDED, …) is the enum.
    reason = result.reason?.code;
  } catch (err) {
    logMonetization({
      op: 'entitlement',
      eventType: action,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: errorName(err),
    });
    logError({
      where: 'monetization.requireEntitlement',
      name: errorName(err),
      message: 'entitlement check failed; allowing the request (fail-open)',
      frames: stackFrames(err),
    });
    return;
  }

  logMonetization({
    op: 'entitlement',
    eventType: action,
    decision,
    reason,
    ok: true,
    durationMs: Date.now() - startedAt,
  });

  if (decision === 'DENY') throw new NotEntitledError(reason ?? 'NOT_ENTITLED');
}

/**
 * Records one unit of a billable action against the player's quota. Never
 * throws — a lost event is a billing problem, not a reason to fail a request
 * that already did its work. The SDK batches events; `flushUsage()` sends them
 * before the Lambda returns.
 */
export async function recordUsage(userId: string, action: BillableAction): Promise<void> {
  const startedAt = Date.now();
  try {
    await getMonetize().putEvent(userId, { eventType: action });
    logMonetization({ op: 'usage', eventType: action, ok: true, durationMs: Date.now() - startedAt });
  } catch (err) {
    logMonetization({
      op: 'usage',
      eventType: action,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: errorName(err),
    });
    logError({
      where: 'monetization.recordUsage',
      name: errorName(err),
      message: 'usage event was not recorded',
      frames: stackFrames(err),
    });
  }
}

/**
 * Lambda freezes the environment as soon as the handler returns, so buffered
 * usage events must be sent first. Never throws.
 */
export async function flushUsage(): Promise<void> {
  if (!monetizeInitialized()) return;
  const startedAt = Date.now();
  try {
    await getMonetize().flush();
    logMonetization({ op: 'flush', ok: true, durationMs: Date.now() - startedAt });
  } catch (err) {
    logMonetization({ op: 'flush', ok: false, durationMs: Date.now() - startedAt, error: errorName(err) });
  }
}
