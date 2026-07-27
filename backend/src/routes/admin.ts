import { MAX_GENERATE_COUNT, generateBatch } from '../engine/generate';
import { optionalString, requireCount, requireDifficulty } from './input';
import type { RouteResult } from './result';

/**
 * POST /admin/generate — body: { count, difficulty, topic? }
 *
 * The caller has already been checked for `admins` group membership in the handler.
 */
export async function postGenerate(body: Record<string, unknown>): Promise<RouteResult> {
  const count = requireCount(body, MAX_GENERATE_COUNT);
  const difficulty = requireDifficulty(
    typeof body.difficulty === 'string' ? body.difficulty : undefined,
    '"difficulty"'
  );
  const topic = optionalString(body, 'topic', 120);

  const result = await generateBatch({ count, difficulty, topic });
  return { status: 201, body: result };
}
