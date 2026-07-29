import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logDbWrite, logError } from '../log';
import type { DailyStats } from '../types';
import { TABLE_NAME, doc, keys, today } from './client';

type Counter = keyof Omit<DailyStats, 'date'>;

/**
 * Bumps one or more counters on the DAILY#<date> / META row, creating it on first
 * write. Counter names are attribute names supplied by this module only — never
 * from request input — but they still go through ExpressionAttributeNames so a
 * future counter can't collide with a DynamoDB reserved word.
 */
export async function bump(counts: Partial<Record<Counter, number>>, date = today()): Promise<void> {
  const entries = Object.entries(counts).filter(
    ([, n]) => typeof n === 'number' && n !== 0
  ) as [Counter, number][];
  if (entries.length === 0) return;

  const names: Record<string, string> = { '#date': 'date' };
  const values: Record<string, unknown> = { ':zero': 0, ':date': date };
  const sets = entries.map(([counter, n], i) => {
    names[`#c${i}`] = counter;
    values[`:v${i}`] = n;
    return `#c${i} = if_not_exists(#c${i}, :zero) + :v${i}`;
  });

  await doc.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: keys.daily(date), sk: keys.META },
      UpdateExpression: `SET ${sets.join(', ')}, #date = :date`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
  logDbWrite({
    op: 'Update',
    pk: keys.daily(date),
    sk: keys.META,
    counters: entries.map(([counter]) => counter),
  });
}

/**
 * Same as `bump` but never rejects. Stats are cosmetic — a failure here must not
 * fail the player's request. Still `await` it: a floating promise would be frozen
 * with the Lambda execution environment before it lands.
 */
export async function bumpQuietly(
  counts: Partial<Record<Counter, number>>,
  date = today()
): Promise<void> {
  try {
    await bump(counts, date);
  } catch (err) {
    logError({
      where: 'db.daily.bump',
      name: err instanceof Error ? err.name : typeof err,
      message: 'daily stats bump failed',
    });
  }
}

export async function getDaily(date = today()): Promise<DailyStats | null> {
  const result = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: keys.daily(date), sk: keys.META } })
  );
  return (result.Item as DailyStats | undefined) ?? null;
}
