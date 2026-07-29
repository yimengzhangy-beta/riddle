import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logDbWrite } from '../log';
import type { Attempt, Difficulty, Profile } from '../types';
import { TABLE_NAME, doc, keys, today } from './client';

export async function getProfile(userId: string): Promise<Profile | null> {
  const result = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pk: keys.user(userId), sk: keys.PROFILE } })
  );
  return (result.Item as Profile | undefined) ?? null;
}

export async function putProfile(profile: Profile): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { pk: keys.user(profile.userId), sk: keys.PROFILE, ...profile },
    })
  );
  logDbWrite({ op: 'Put', pk: keys.user(profile.userId), sk: keys.PROFILE });
}

/**
 * Reads the profile, creating an empty one on the user's first authenticated call.
 *
 * The email can be blank when the caller presented an access token, which carries no
 * `email` claim. Rather than freeze a placeholder into the profile, we leave it blank
 * and backfill it the first time an ID token turns up.
 */
export async function ensureProfile(args: {
  userId: string;
  email: string;
}): Promise<Profile> {
  const existing = await getProfile(args.userId);
  if (existing) {
    if (existing.email || !args.email) return existing;
    const healed: Profile = {
      ...existing,
      email: args.email,
      updatedAt: new Date().toISOString(),
    };
    await putProfile(healed);
    return healed;
  }

  const now = new Date().toISOString();
  const profile: Profile = {
    userId: args.userId,
    email: args.email,
    score: 0,
    streak: 0,
    hintsUsedToday: 0,
    hintsDate: today(),
    lastSolvedDate: null,
    riddlesSolved: 0,
    createdAt: now,
    updatedAt: now,
  };
  await putProfile(profile);
  return profile;
}

export async function getAttempt(userId: string, riddleId: string): Promise<Attempt | null> {
  const result = await doc.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: keys.user(userId), sk: keys.attempt(riddleId) },
    })
  );
  return (result.Item as Attempt | undefined) ?? null;
}

export async function putAttempt(attempt: Attempt): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: keys.user(attempt.userId),
        sk: keys.attempt(attempt.riddleId),
        ...attempt,
      },
    })
  );
  logDbWrite({ op: 'Put', pk: keys.user(attempt.userId), sk: keys.attempt(attempt.riddleId) });
}

/** Every riddle this user has already been served, for the unseen-riddle filter. */
export async function listAttempts(userId: string): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    const result = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': keys.user(userId),
          ':prefix': keys.ATTEMPT_PREFIX,
        },
        ExclusiveStartKey: cursor,
      })
    );
    attempts.push(...((result.Items ?? []) as Attempt[]));
    cursor = result.LastEvaluatedKey;
  } while (cursor);

  return attempts;
}

export function newAttempt(args: {
  userId: string;
  riddleId: string;
  difficulty: Difficulty;
}): Attempt {
  return {
    userId: args.userId,
    riddleId: args.riddleId,
    difficulty: args.difficulty,
    guesses: [],
    hintsTaken: 0,
    solved: false,
    points: 0,
    startedAt: new Date().toISOString(),
    solvedAt: null,
  };
}
