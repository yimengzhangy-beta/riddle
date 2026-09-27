import { MonetizationAI } from '@aws-app-monetization/sdk';
import { config as loadEnv } from 'dotenv';

/**
 * The one place a MonetizationAI client is constructed. Lazy so that `tsc` and
 * cold-start module evaluation never touch the environment — the constructor
 * validates appId, which is only present at runtime.
 *
 * appId is the ONLY connection input. It is the app's live ARN or its sandbox
 * ARN (the SDK derives live vs sandbox from the value), and the SDK resolves the
 * endpoint and region itself from MONETIZATION_ENDPOINT — nothing is passed here.
 */

let sdk: MonetizationAI | null = null;

export function getMonetize(): MonetizationAI {
  if (!sdk) {
    // No framework loads this filename; fills only unset keys, so real env vars
    // (the Lambda's, set by the stack) always win. Local dev reads the repo-root
    // .env.monetization whichever directory the process starts in. `quiet`
    // because dotenv otherwise writes to the console, and log.ts is the only
    // module allowed to do that.
    loadEnv({ path: ['.env.monetization', '../.env.monetization'], quiet: true });
    sdk = new MonetizationAI({
      appId: process.env.MONETIZATION_APP_ID ?? '',
    });
  }
  return sdk;
}
