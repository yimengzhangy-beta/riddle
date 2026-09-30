import { mintPortalSessions } from '../billing';
import type { Player } from '../engine/riddles';
import type { RouteResult } from './result';

/**
 * GET /billing/session — mint the hosted pricing + billing-portal session URLs
 * for the signed-in player. The SPA calls this on each launcher click; the
 * URLs embed a short-lived session token, so they are never cached.
 */
export async function getSession(player: Player, origin: string): Promise<RouteResult> {
  const session = await mintPortalSessions(player.userId, origin);
  return { status: 200, body: session };
}
