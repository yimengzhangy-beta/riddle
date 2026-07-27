import { createHash } from 'crypto';
import * as riddlesDb from '../db/riddles';
import { generateRiddles } from '../llm/client';
import { generateSystemPrompt, generateUserMessage, retryNudge } from '../prompts';
import type { Difficulty, GeneratedRiddle, Riddle } from '../types';
import { normalize } from './scoring';

/** Batch riddle generation: one model call, then a deduped write into the bank. */

export const MAX_GENERATE_COUNT = 10;

/**
 * Two riddles are "the same" when they share an answer and a topic once both are
 * normalised. Hashing that pair into the riddle id turns dedupe into a conditional
 * write, so concurrent batches cannot both insert the same riddle.
 */
function dedupeId(answer: string, topic: string): string {
  const key = `${normalize(answer)}|${normalize(topic)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

export interface GenerateResult {
  difficulty: Difficulty;
  topic: string | null;
  requested: number;
  /** Riddles the model returned, after schema validation. */
  generated: number;
  /** Riddles actually written to the bank. */
  written: number;
  /** Dropped because an equivalent answer+topic was already present. */
  duplicates: number;
  riddles: { riddleId: string; text: string; answer: string; topic: string }[];
  bankSize: number;
}

export async function generateBatch(args: {
  count: number;
  difficulty: Difficulty;
  topic: string | null;
}): Promise<GenerateResult> {
  const avoidAnswers = await riddlesDb.existingAnswers(args.difficulty);

  const generated: GeneratedRiddle[] = await generateRiddles({
    system: generateSystemPrompt(),
    user: generateUserMessage({
      count: args.count,
      difficulty: args.difficulty,
      topic: args.topic,
      avoidAnswers,
    }),
    count: args.count,
    buildRetry: retryNudge,
  });

  // Dedupe within the batch first, so one call cannot spend two writes on the same
  // answer, then let the conditional write catch collisions with the existing bank.
  const seenInBatch = new Set<string>();
  const written: Riddle[] = [];
  let duplicates = 0;

  for (const candidate of generated) {
    const id = dedupeId(candidate.answer, candidate.topic);
    if (seenInBatch.has(id)) {
      duplicates++;
      continue;
    }
    seenInBatch.add(id);

    const stored = await riddlesDb.putGenerated({
      generated: candidate,
      difficulty: args.difficulty,
      dedupeId: id,
    });

    if (stored) written.push(stored);
    else duplicates++;
  }

  const bank = await riddlesDb.listByDifficulty(args.difficulty, 200);

  return {
    difficulty: args.difficulty,
    topic: args.topic,
    requested: args.count,
    generated: generated.length,
    written: written.length,
    duplicates,
    riddles: written.map((r) => ({
      riddleId: r.riddleId,
      text: r.text,
      answer: r.answer,
      topic: r.topic,
    })),
    bankSize: bank.length,
  };
}
