import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});
const SECRET_ID = process.env.ANTHROPIC_SECRET_NAME!;

let cached: Promise<string> | null = null;

/**
 * Reads the Anthropic API key from Secrets Manager once per Lambda container.
 * Accepts either a raw string secret or a JSON secret with an ANTHROPIC_API_KEY key.
 */
export function anthropicApiKey(): Promise<string> {
  if (!cached) {
    cached = (async () => {
      const result = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
      const raw = result.SecretString;
      if (!raw) throw new Error(`Secret ${SECRET_ID} has no SecretString`);

      const trimmed = raw.trim();
      if (trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed) as Record<string, string>;
        const key = parsed.ANTHROPIC_API_KEY ?? parsed.apiKey;
        if (!key) throw new Error(`Secret ${SECRET_ID} JSON has no ANTHROPIC_API_KEY field`);
        return key;
      }
      return trimmed;
    })().catch((err) => {
      // Don't cache a failure — the next invocation should retry.
      cached = null;
      throw err;
    });
  }
  return cached;
}
