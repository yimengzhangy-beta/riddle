import { MonetizationAI } from '@aws-monetization/sdk';
import { config as loadEnv } from 'dotenv';

/**
 * The one place a MonetizationAI client is constructed. Lazy so that `tsc` and
 * cold-start module evaluation never touch the environment — the constructor
 * validates appId, which is only present at runtime.
 */

let sdk: MonetizationAI | null = null;

export function getMonetize(): MonetizationAI {
  if (!sdk) {
    // No framework loads this filename; fills only unset keys, so real env
    // vars (the Lambda's) always win. Local dev reads backend/.env.monetization.
    loadEnv({ path: '.env.monetization' });
    sdk = new MonetizationAI({
      appId: process.env.MONETIZATION_APP_ID ?? '',
      // AWS Monetization's control plane is us-east-1 regardless of where the
      // stack deploys — this is NOT the app's AWS_REGION.
      region: process.env.MONETIZATION_REGION ?? 'us-east-1',
      endpoint: process.env.MONETIZATION_ENDPOINT,
    });
  }
  return sdk;
}
