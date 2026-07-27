import type { Player } from '../engine/riddles';
import { getMe } from '../engine/riddles';
import type { RouteResult } from './result';

/** GET /me — the caller's profile, score and streak. */
export async function getProfile(player: Player): Promise<RouteResult> {
  const profile = await getMe(player);
  return { status: 200, body: profile };
}
