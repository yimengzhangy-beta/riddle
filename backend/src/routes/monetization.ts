import type { Player } from '../engine/riddles';
import { createBillingPortalSession, createPricingSession } from '../monetization/sessions';
import type { RouteResult } from './result';

/**
 * POST /monetization/pricing-session — a session for the hosted pricing page.
 * POST /monetization/billing-portal-session — a session for the hosted billing portal.
 *
 * Both take no input: the player is whoever the JWT says. The frontend stores the
 * returned URL and redirects to it (see frontend/src/monetization.ts).
 */
export async function postPricingSession(player: Player): Promise<RouteResult> {
  return { status: 200, body: await createPricingSession(player.userId) };
}

export async function postBillingPortalSession(player: Player): Promise<RouteResult> {
  return { status: 200, body: await createBillingPortalSession(player.userId) };
}
