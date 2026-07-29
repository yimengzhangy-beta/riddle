import {
  currentSubscription,
  listPlans,
  startCheckout,
  subscriptionSummary,
} from '../billing/account';
import type { Player } from '../engine/riddles';
import { BadRequest } from './input';
import type { RouteResult } from './result';

/** Routes parse and validate HTTP input, then delegate. They never touch the SDK. */

/**
 * Where the player's browser is, as opposed to where this API is. Checkout has
 * to send them back to the web app, and the Lambda's own origin is the API
 * Gateway URL — so the frontend origin is configuration, not something that can
 * be read off the request.
 */
function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}

/** GET /plans — public, so the pricing page renders before anyone signs in. */
export async function getPlans(): Promise<RouteResult> {
  return { status: 200, body: { plans: await listPlans() } };
}

/** GET /subscription — the caller's current plan, or null when they have none. */
export async function getSubscription(player: Player): Promise<RouteResult> {
  return { status: 200, body: await currentSubscription(player.userId) };
}

/** GET /subscription/summary — current plan, usage this period, estimated charge. */
export async function getSubscriptionSummary(player: Player): Promise<RouteResult> {
  const summary = await subscriptionSummary(player.userId);
  // No subscription is a state, not a failure — the page renders a sign-up
  // prompt from it rather than an error.
  return { status: 200, body: summary ?? { planId: null } };
}

/**
 * POST /subscribe — body: { planId }
 *
 * One endpoint for subscribing, upgrading and downgrading; the response shape
 * tells the client which of the three happened.
 */
export async function postSubscribe(
  player: Player,
  body: Record<string, unknown>
): Promise<RouteResult> {
  const planId = body.planId;
  if (typeof planId !== 'string' || planId.trim() === '') {
    throw new BadRequest('"planId" must be a non-empty string');
  }

  const base = appBaseUrl();
  const session = await startCheckout(player.userId, planId.trim(), {
    // Paid checkout returns here, carrying the plan it was for, so the page can
    // wait for activation to propagate before showing the player their plan.
    returnUrl: `${base}/pricing/activating?planId=${encodeURIComponent(planId.trim())}`,
    // An expired checkout session activated nothing — send them back to choose again.
    refreshUrl: `${base}/pricing?checkout=expired`,
  });

  return { status: 200, body: session };
}
