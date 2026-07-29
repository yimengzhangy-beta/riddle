import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { logDbWrite } from '../log';
import type { Difficulty, GeneratedRiddle, Riddle } from '../types';
import { DIFFICULTY_INDEX, TABLE_NAME, doc, keys } from './client';

function rowOf(riddle: Riddle) {
  return {
    pk: keys.riddle(riddle.riddleId),
    sk: keys.META,
    gsi1pk: keys.difficulty(riddle.difficulty),
    gsi1sk: keys.riddle(riddle.riddleId),
    ...riddle,
  };
}

export async function getRiddle(riddleId: string): Promise<Riddle | null> {
  const result = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: keys.riddle(riddleId), sk: keys.META } })
  );
  return (result.Item as Riddle | undefined) ?? null;
}

/**
 * Writes one generated riddle to the bank. Returns null when a riddle with the
 * same normalised answer+topic already exists — the dedupe key is a deterministic
 * id, so the conditional write is what actually enforces uniqueness even when two
 * generation batches race.
 */
export async function putGenerated(args: {
  generated: GeneratedRiddle;
  difficulty: Difficulty;
  dedupeId: string;
}): Promise<Riddle | null> {
  const riddle: Riddle = {
    riddleId: args.dedupeId,
    text: args.generated.text,
    answer: args.generated.answer,
    difficulty: args.difficulty,
    topic: args.generated.topic,
    hints: args.generated.hints,
    timesServed: 0,
    timesSolved: 0,
    createdAt: new Date().toISOString(),
  };

  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: rowOf(riddle),
        ConditionExpression: 'attribute_not_exists(pk)',
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      logDbWrite({ op: 'Put', pk: keys.riddle(riddle.riddleId), sk: keys.META, written: false });
      return null;
    }
    throw err;
  }

  logDbWrite({ op: 'Put', pk: keys.riddle(riddle.riddleId), sk: keys.META, written: true });
  return riddle;
}

/** Seeds a riddle with a random id — used only by tests and manual fixtures. */
export async function putRiddle(riddle: Omit<Riddle, 'riddleId'>): Promise<Riddle> {
  const full: Riddle = { riddleId: randomUUID(), ...riddle };
  await doc.send(new PutCommand({ TableName: TABLE_NAME, Item: rowOf(full) }));
  logDbWrite({ op: 'Put', pk: keys.riddle(full.riddleId), sk: keys.META });
  return full;
}

/** All riddles of one difficulty, via the byDifficulty GSI. */
export async function listByDifficulty(
  difficulty: Difficulty,
  limit = 100
): Promise<Riddle[]> {
  const result = await doc.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: DIFFICULTY_INDEX,
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': keys.difficulty(difficulty) },
      Limit: limit,
    })
  );
  return (result.Items ?? []) as Riddle[];
}

/** Answers already in the bank, so a generation batch can avoid repeating them. */
export async function existingAnswers(difficulty: Difficulty): Promise<string[]> {
  const riddles = await listByDifficulty(difficulty, 200);
  return riddles.map((r) => r.answer);
}

export async function incrementServed(riddleId: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: keys.riddle(riddleId), sk: keys.META },
      UpdateExpression: 'SET timesServed = if_not_exists(timesServed, :zero) + :one',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
    })
  );
  logDbWrite({
    op: 'Update',
    pk: keys.riddle(riddleId),
    sk: keys.META,
    counters: ['timesServed'],
  });
}

export async function incrementSolved(riddleId: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: keys.riddle(riddleId), sk: keys.META },
      UpdateExpression: 'SET timesSolved = if_not_exists(timesSolved, :zero) + :one',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
    })
  );
  logDbWrite({
    op: 'Update',
    pk: keys.riddle(riddleId),
    sk: keys.META,
    counters: ['timesSolved'],
  });
}
