import { logBilling, logError, stackFrames } from '../log';
import { getMonetize } from './client';

/**
 * Billing (AWS Monetization). The only module that knows the platform exists —
 * handler.ts calls `requireEntitlement` before a billable action's paid work
 * and `meter` after it succeeds; routes and the engine stay billing-unaware.
 *
 * Entitlement FAILS OPEN on service errors: a billing outage serves the request
 * rather than taking the game down. A DENY decision (NO_SUBSCRIPTION,
 * QUOTA_EXCEEDED) is a normal answer, not an error, and always blocks.
 */

/** Must match each metric's sourceEventType on the AWS Monetization app. */
export type BillableAction = 'play_riddle' | 'submit_guess' | 'take_hint';

/** MONETIZATION_ENFORCE=false keeps every route open (e.g. while plans are drafts). */
function enforcing(): boolean {
  return process.env.MONETIZATION_ENFORCE !== 'false';
}

export class EntitlementDeniedError extends Error {
  constructor(
    readonly action: BillableAction,
    readonly code: string
  ) {
    super('Your plan does not cover this action.');
  }
}

/** The platform's reason code, whichever shape the SDK returns it in. */
function reasonCode(reason: unknown): string | undefined {
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object' && 'code' in reason) {
    const code = (reason as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Gate a billable action BEFORE its paid work, so a denied request costs
 * nothing. Throws EntitlementDeniedError on DENY; anything operational is
 * logged and allowed through (fail-open).
 */
export async function requireEntitlement(userId: string, action: BillableAction): Promise<void> {
  if (!enforcing()) return;

  let decision: string;
  let code: string | undefined;
  let planId: string | null;
  try {
    const ent = await getMonetize().checkEntitlement(userId, { eventType: action });
    decision = ent.decision ?? 'UNKNOWN';
    code = reasonCode(ent.reason);
    planId = ent.planId ?? null;
  } catch (err) {
    logError({
      where: 'billing.entitlement',
      name: err instanceof Error ? err.name : typeof err,
      message: 'entitlement check failed; allowing request (fail-open)',
      frames: stackFrames(err),
    });
    return;
  }

  logBilling({ action, op: 'entitlement', decision, code, planId });
  if (decision === 'DENY') {
    throw new EntitlementDeniedError(action, code ?? 'NOT_ENTITLED');
  }
}

/**
 * Record one unit AFTER the action succeeded — the route throws on failure, so
 * a metered event always means the action happened. Never fails the request.
 */
export async function meter(userId: string, action: BillableAction): Promise<void> {
  try {
    await getMonetize().putEvent(userId, { eventType: action });
    logBilling({ action, op: 'meter', decision: 'RECORDED' });
  } catch (err) {
    logError({
      where: 'billing.meter',
      name: err instanceof Error ? err.name : typeof err,
      message: 'metering event failed; request unaffected',
      frames: stackFrames(err),
    });
  }
}

/**
 * Mint the hosted pricing + billing-portal sessions for a signed-in player.
 * The SPA redirects to whichever it needs from its "Upgrade" / "Manage
 * subscription" launchers — the app never builds those pages, MonetizationAI
 * hosts them. The URLs carry short-lived tokens, so the SPA mints per click.
 */
export async function mintPortalSessions(
  userId: string,
  origin: string
): Promise<{ pricingUrl: string; billingPortalUrl: string }> {
  if (!userId) throw new Error('mintPortalSessions: userId is required');

  const m = getMonetize();
  const [{ pricingUrl }, { billingPortalUrl }] = await Promise.all([
    m.createPricingSession(userId, {
      returnUrl: `${origin}/?checkout=success`,
      refreshUrl: `${origin}/?checkout=expired`,
    }),
    m.createBillingPortalSession(userId, {
      returnUrl: `${origin}/`,
      refreshUrl: `${origin}/?portal=expired`,
    }),
  ]);

  return { pricingUrl, billingPortalUrl };
}
