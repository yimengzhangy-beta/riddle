import type { Difficulty } from '../types';
import { DIFFICULTIES } from '../types';

/** Shared request-validation helpers. Routes throw these; the handler maps them to 400. */

export class BadRequest extends Error {}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 500
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequest(`"${field}" is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new BadRequest(`"${field}" must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 200
): string | null {
  if (body[field] === undefined || body[field] === null) return null;
  return requireString(body, field, maxLength);
}

export function requireDifficulty(raw: string | undefined, source: string): Difficulty {
  const value = (raw ?? '').trim().toLowerCase();
  if (!DIFFICULTIES.includes(value as Difficulty)) {
    throw new BadRequest(
      `${source} must be one of ${DIFFICULTIES.join(' | ')}${value ? ` (got "${value}")` : ''}`
    );
  }
  return value as Difficulty;
}

export function requireCount(body: Record<string, unknown>, max: number): number {
  const value = body.count;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new BadRequest(`"count" must be an integer between 1 and ${max}`);
  }
  return value;
}
