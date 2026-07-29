import type { BillableAction } from '../log';
import { logBillingError, logEntitlement, logMetered } from '../log';
import { monetize } from './client';

/**
 * The only module in this codebase that knows AWS Monetization exists.
 * Everything above it deals in action names and plain booleans.
 *
 * Two things happen here, and they are deliberately separate:
 *   - `entitled` / `requireEntitled` decide whether a player may do something.
 *   - `meter` records that they did it, after the fact.
 *
 * A denial is a normal outcome, not an error: an unsubscribed player is DENY
 * with reason NO_SUBSCRIPTION. Only transport failures reach a catch block.
 */

/** Thrown when a player is not entitled to the action they asked for. */
export class NotEntitledError extends Error {
  constructor(
    readonly action: BillableAction,
    readonly reason: string,
    readonly planId: string | null
  ) {
    // The message is a literal built from enum values — safe to surface and log.
    super(`Your plan does not include this (${reason})`);
  }
}

/**
 * Enforcement is on unless explicitly disabled. Set MONETIZATION_ENFORCE=false to
 * keep the game open while checking that metering alone works; any other value
 * (or none) enforces.
 */
function enforcing(): boolean {
  return process.env.MONETIZATION_ENFORCE !== 'false';
}

export interface Decision {
  allow: boolean;
  reason: string;
  planId: string | null;
}

/**
 * Resolves one action for one player. Fails **open** on a transport error: a
 * billing outage should not take the game down, and the alternative is denying
 * every paying player at once. A DENY *decision* still denies — that is an
 * answer, not a failure.
 */
export async function entitled(userId: string, action: BillableAction): Promise<Decision> {
  if (!enforcing()) {
    return { allow: true, reason: 'ENFORCEMENT_DISABLED', planId: null };
  }

  try {
    const result = await monetize().checkEntitlement(userId, { eventType: action });
    // `reason` is structured — a category (which gate produced the decision) and
    // a branchable code. The code is the part worth surfacing and branching on.
    const decision: Decision = {
      allow: result.decision !== 'DENY',
      reason: result.reason?.code ?? 'UNSPECIFIED',
      planId: result.planId ?? null,
    };
    logEntitlement({
      action,
      decision: result.decision,
      reason: decision.reason,
      planId: decision.planId,
      enforced: true,
    });
    return decision;
  } catch (err) {
    // Transport or service failure — not a decision. Let the player through and
    // leave a trail. The message is withheld: an SDK error can quote its input.
    logBillingError({
      where: 'billing.entitled',
      action,
      name: err instanceof Error ? err.name : typeof err,
    });
    return { allow: true, reason: 'CHECK_FAILED_OPEN', planId: null };
  }
}

/** `entitled`, but throws instead of returning false. For a hard gate on a route. */
export async function requireEntitled(userId: string, action: BillableAction): Promise<void> {
  const decision = await entitled(userId, action);
  if (!decision.allow) {
    throw new NotEntitledError(action, decision.reason, decision.planId);
  }
}

/**
 * Records one unit of usage. Never throws: a player's turn must not fail because
 * a meter did. A dropped event under-bills, which is the safe direction.
 */
export async function meter(
  userId: string,
  action: BillableAction,
  quantity = 1
): Promise<void> {
  try {
    await monetize().putEvent(userId, { eventType: action, quantity: String(quantity) });
    logMetered({ action, quantity, ok: true });
  } catch (err) {
    logMetered({
      action,
      quantity,
      ok: false,
      error: err instanceof Error ? err.name : typeof err,
    });
  }
}

/**
 * Drains the event buffer. The SDK batches, and a Lambda is frozen the moment it
 * returns — without this, the last events of an invocation are lost.
 */
export async function flushBilling(): Promise<void> {
  try {
    await monetize().flush();
  } catch (err) {
    logBillingError({
      where: 'billing.flush',
      action: null,
      name: err instanceof Error ? err.name : typeof err,
    });
  }
}
