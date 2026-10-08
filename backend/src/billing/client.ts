import { MonetizationAI } from '@aws-app-monetization/sdk';
import { config as loadEnv } from 'dotenv';
import * as path from 'path';

/**
 * The one place a MonetizationAI client is constructed. Lazy so that `tsc` and
 * cold-start module evaluation never touch the environment — the constructor
 * validates appId, which is only present at runtime.
 *
 * appId is the ONLY connection input. The SDK resolves its endpoint from
 * MONETIZATION_ENDPOINT and derives the signing region from that endpoint's
 * host, so neither is passed here — the SDK is the single source for the
 * connection, and `.env.monetization` (written by the /monetize skill) is the
 * single source for the values.
 */

let sdk: MonetizationAI | null = null;

export function getMonetize(): MonetizationAI {
  if (!sdk) {
    // The repo-root .env.monetization, for local runs. Fills only unset keys, so
    // the Lambda's real env vars (set by the stack) always win; inside the
    // bundled Lambda the path does not exist and this is a no-op.
    loadEnv({ path: path.resolve(__dirname, '../../../.env.monetization') });
    sdk = new MonetizationAI({
      appId: process.env.MONETIZATION_APP_ID ?? '',
    });
  }
  return sdk;
}
