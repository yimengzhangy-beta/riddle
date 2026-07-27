import type { Player } from '../engine/riddles';
import { nextRiddle, submitGuess, takeHint } from '../engine/riddles';
import { requireDifficulty, requireString } from './input';
import type { RouteResult } from './result';

/** Routes parse and validate HTTP input, then delegate. They never touch DynamoDB. */

/** GET /riddles/next?difficulty=easy */
export async function getNext(
  player: Player,
  query: Record<string, string | undefined>
): Promise<RouteResult> {
  const difficulty = requireDifficulty(query.difficulty, '"difficulty" query parameter');
  const result = await nextRiddle({ player, difficulty });
  return { status: 200, body: result };
}

/** POST /riddles/{id}/guess — body: { guess } */
export async function postGuess(
  player: Player,
  riddleId: string,
  body: Record<string, unknown>
): Promise<RouteResult> {
  const guess = requireString(body, 'guess', 500);
  const result = await submitGuess({ player, riddleId, guess });
  return { status: 200, body: result };
}

/** POST /riddles/{id}/hint */
export async function postHint(player: Player, riddleId: string): Promise<RouteResult> {
  const result = await takeHint({ player, riddleId });
  return { status: 200, body: result };
}
