import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Single-table layout. Every row is (pk, sk):
 *
 *   RIDDLE#<riddleId> | META                 the riddle, its answer and its hints
 *   USER#<userId>     | PROFILE              score, streak, hint budget
 *   USER#<userId>     | ATTEMPT#<riddleId>   one row per riddle served to that user
 *   DAILY#<date>      | META                 per-UTC-day activity counters
 *
 * Riddle rows additionally carry a GSI key so GET /riddles/next can page one
 * difficulty without scanning the table:
 *
 *   gsi1pk = DIFF#<difficulty>   gsi1sk = RIDDLE#<riddleId>
 *
 * Only this directory talks to DynamoDB. The engine and routes go through the
 * repository functions in db/riddles.ts, db/users.ts and db/daily.ts.
 */
export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE_NAME = process.env.TABLE_NAME!;
export const DIFFICULTY_INDEX = process.env.DIFFICULTY_INDEX!;

export const keys = {
  riddle: (riddleId: string) => `RIDDLE#${riddleId}`,
  user: (userId: string) => `USER#${userId}`,
  daily: (date: string) => `DAILY#${date}`,
  attempt: (riddleId: string) => `ATTEMPT#${riddleId}`,
  difficulty: (difficulty: string) => `DIFF#${difficulty}`,
  META: 'META',
  PROFILE: 'PROFILE',
  ATTEMPT_PREFIX: 'ATTEMPT#',
} as const;

/** YYYY-MM-DD in UTC — the unit both the streak and the daily hint budget use. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
