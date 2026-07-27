import Anthropic from '@anthropic-ai/sdk';
import type { GeneratedRiddle, JudgedGuess, Verdict } from '../types';
import { MAX_HINTS, VERDICTS } from '../types';
import { anthropicApiKey } from './secret';

/**
 * The only module in this codebase that knows the Anthropic API exists.
 * Everything above it deals in plain strings and validated plain objects.
 */

const MODEL = 'claude-sonnet-4-6';
const JUDGE_MAX_TOKENS = 512;
const GENERATE_MAX_TOKENS = 8000;

export class ModelOutputError extends Error {}

let clientPromise: Promise<Anthropic> | null = null;

function client(): Promise<Anthropic> {
  if (!clientPromise) {
    clientPromise = anthropicApiKey()
      .then((apiKey) => new Anthropic({ apiKey, maxRetries: 2 }))
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

/** Tolerates a stray code fence or leading prose without accepting malformed JSON. */
function extractJson(raw: string, shape: 'object' | 'array'): unknown {
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  const [openChar, closeChar] = shape === 'object' ? ['{', '}'] : ['[', ']'];
  const start = text.indexOf(openChar);
  const end = text.lastIndexOf(closeChar);
  if (start === -1 || end === -1 || end <= start) {
    throw new ModelOutputError(`no JSON ${shape} found in the reply`);
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new ModelOutputError(`JSON.parse failed: ${(err as Error).message}`);
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ModelOutputError(`"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function validateJudgement(value: unknown): JudgedGuess {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelOutputError('reply was not a JSON object');
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.verdict !== 'string' || !VERDICTS.includes(obj.verdict as Verdict)) {
    throw new ModelOutputError('"verdict" must be one of correct | close | wrong');
  }

  return {
    verdict: obj.verdict as Verdict,
    reason: nonEmptyString(obj.reason, 'reason'),
  };
}

function validateGenerated(value: unknown, wanted: number): GeneratedRiddle[] {
  if (!Array.isArray(value)) {
    throw new ModelOutputError('reply was not a JSON array');
  }
  if (value.length === 0) {
    throw new ModelOutputError('reply contained no riddles');
  }

  // Over-generation is harmless — take what was asked for and drop the rest.
  return value.slice(0, wanted).map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (!Array.isArray(e?.hints) || e.hints.length !== MAX_HINTS) {
      throw new ModelOutputError(`riddles[${i}].hints must be an array of exactly ${MAX_HINTS}`);
    }
    return {
      text: nonEmptyString(e.text, `riddles[${i}].text`),
      answer: nonEmptyString(e.answer, `riddles[${i}].answer`),
      topic: nonEmptyString(e.topic, `riddles[${i}].topic`),
      hints: e.hints.map((h, j) => nonEmptyString(h, `riddles[${i}].hints[${j}]`)),
    };
  });
}

async function complete(args: {
  system: string;
  messages: Anthropic.MessageParam[];
  maxTokens: number;
}): Promise<string> {
  const anthropic = await client();
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: args.maxTokens,
    system: args.system,
    // Thinking off keeps a guess inside API Gateway's 30s integration timeout.
    thinking: { type: 'disabled' },
    messages: args.messages,
  });

  if (message.stop_reason === 'refusal') {
    throw new ModelOutputError('the model refused this request');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new ModelOutputError('the reply hit max_tokens and is truncated');
  }

  return textOf(message);
}

/**
 * Runs one prompt, validates it against the strict JSON contract, and retries
 * exactly once on a parse failure. A second failure throws ModelOutputError so
 * the engine can decide on a fallback.
 */
async function completeStrict<T>(args: {
  system: string;
  user: string;
  maxTokens: number;
  shape: 'object' | 'array';
  validate: (value: unknown) => T;
  buildRetry: (problem: string) => string;
}): Promise<T> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: args.user }];

  const first = await complete({
    system: args.system,
    messages,
    maxTokens: args.maxTokens,
  });

  try {
    return args.validate(extractJson(first, args.shape));
  } catch (err) {
    const problem = err instanceof ModelOutputError ? err.message : String(err);
    console.warn(`Model output rejected, retrying once: ${problem}`);

    // Mid-conversation assistant turns are fine; only a trailing prefill is not.
    const retry = await complete({
      system: args.system,
      messages: [
        ...messages,
        { role: 'assistant', content: first || '(empty reply)' },
        { role: 'user', content: args.buildRetry(problem) },
      ],
      maxTokens: args.maxTokens,
    });

    return args.validate(extractJson(retry, args.shape));
  }
}

/** One call per non-exact guess: is it correct, close, or wrong? */
export async function judgeGuess(args: {
  system: string;
  user: string;
  buildRetry: (problem: string) => string;
}): Promise<JudgedGuess> {
  return completeStrict({
    system: args.system,
    user: args.user,
    maxTokens: JUDGE_MAX_TOKENS,
    shape: 'object',
    validate: validateJudgement,
    buildRetry: args.buildRetry,
  });
}

/** One call per admin batch: generate `count` riddles as a strict JSON array. */
export async function generateRiddles(args: {
  system: string;
  user: string;
  count: number;
  buildRetry: (problem: string) => string;
}): Promise<GeneratedRiddle[]> {
  return completeStrict({
    system: args.system,
    user: args.user,
    maxTokens: GENERATE_MAX_TOKENS,
    shape: 'array',
    validate: (value) => validateGenerated(value, args.count),
    buildRetry: args.buildRetry,
  });
}
