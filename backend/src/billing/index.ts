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

export type BillableAction = 'riddle_played' | 'guess_submitted' | 'hint_taken';

/**
 * How long the SPA may cache the minted hosted-session URLs. The token's real
 * TTL is platform-managed; this only bounds the cookie cache, and an expired
 * URL just re-mints on the next launcher click.
 */
const SESSION_CACHE_SECONDS = 60 * 60;

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

/**
 * Gate a billable action BEFORE its paid work, so a denied request costs
 * nothing. Throws EntitlementDeniedError on DENY; anything operational is
 * logged and allowed through (fail-open).
 */
export async function requireEntitlement(userId: string, action: BillableAction): Promise<void> {
  if (!enforcing()) return;

  let decision: string;
  let reason: string | undefined;
  let planId: string | null;
  try {
    const ent = await getMonetize().checkEntitlement(userId, { eventType: action });
    decision = ent.decision;
    // `reason` is a code string on current SDKs; older builds wrapped it in an object.
    const r: unknown = ent.reason;
    reason = typeof r === 'string' ? r : ((r as { code?: string } | undefined)?.code ?? undefined);
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

  logBilling({ action, op: 'entitlement', decision, code: reason, planId });
  if (decision === 'DENY') {
    throw new EntitlementDeniedError(action, reason ?? 'NOT_ENTITLED');
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
 * The SPA stores the returned URLs in cookies on its own origin and redirects
 * to them from its "Upgrade" / "Manage subscription" launchers — the app never
 * builds those pages, MonetizationAI hosts them.
 */
export async function mintPortalSessions(
  userId: string,
  origin: string
): Promise<{ pricingUrl: string; billingPortalUrl: string; expiresInSeconds: number }> {
  if (!userId) throw new Error('mintPortalSessions: userId is required');

  const m = getMonetize();
  // Label which mint failed (the error class and frames carry no content), so
  // an outage of one hosted page is distinguishable from the other in the log.
  const labelled = <T>(where: string, p: Promise<T>): Promise<T> =>
    p.catch((err: unknown) => {
      logError({
        where,
        name: err instanceof Error ? err.name : typeof err,
        message: 'hosted session mint failed',
        frames: stackFrames(err),
      });
      throw err;
    });
  const [{ pricingUrl }, { billingPortalUrl }] = await Promise.all([
    labelled(
      'billing.pricingSession',
      m.createPricingSession(userId, {
        returnUrl: `${origin}/?checkout=success`,
        refreshUrl: `${origin}/?checkout=expired`,
      })
    ),
    labelled(
      'billing.portalSession',
      m.createBillingPortalSession(userId, {
        returnUrl: `${origin}/`,
        refreshUrl: `${origin}/?portal=expired`,
      })
    ),
  ]);

  return { pricingUrl, billingPortalUrl, expiresInSeconds: SESSION_CACHE_SECONDS };
}
