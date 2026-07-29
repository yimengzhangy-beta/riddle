import { MonetizationAI } from '@aws-monetization/sdk';
import { config as loadEnv } from 'dotenv';

/**
 * Lazy SDK handle. The constructor validates `appId`, and the value only exists
 * once the Lambda environment is populated — so a module-level `new` would throw
 * during a bundle or a cold import rather than on the request that needs it.
 *
 * `.env.monetization` is read for local runs only: nothing auto-loads that
 * filename, and dotenv fills only keys that are not already set, so the real
 * Lambda environment always wins.
 */

let client: MonetizationAI | null = null;

export function monetize(): MonetizationAI {
  if (!client) {
    loadEnv({ path: '.env.monetization' });
    client = new MonetizationAI({
      appId: process.env.MONETIZATION_APP_ID ?? '',
      // The AWS Monetization control plane is us-east-1 regardless of where this
      // stack is deployed. Do not substitute the app's own AWS_REGION.
      region: process.env.MONETIZATION_REGION ?? 'us-east-1',
      endpoint: process.env.MONETIZATION_ENDPOINT,
    });
  }
  return client;
}
