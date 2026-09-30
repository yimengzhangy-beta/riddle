import { MonetizationAI } from '@aws-app-monetization/sdk';
import { config as loadEnv } from 'dotenv';

/**
 * The one place a MonetizationAI client is constructed. Lazy so that `tsc` and
 * cold-start module evaluation never touch the environment — the constructor
 * validates appId, which is only present at runtime.
 *
 * appId is the ONLY connection input. It is the app's live ARN or its sandbox
 * twin (`…/app/<appId>` vs `…/app/<appId>/sandbox`); the SDK derives live vs
 * sandbox from that value. Endpoint and region are the SDK's own to resolve:
 * it reads MONETIZATION_ENDPOINT from the environment and derives the region
 * from that endpoint's host, so neither is passed here.
 */

let sdk: MonetizationAI | null = null;

export function getMonetize(): MonetizationAI {
  if (!sdk) {
    // No framework loads this filename; fills only unset keys, so real env vars
    // (the Lambda's, set by the stack) always win. Local runs read the repo's
    // .env.monetization from the working directory.
    loadEnv({ path: '.env.monetization' });
    sdk = new MonetizationAI({ appId: process.env.MONETIZATION_APP_ID ?? '' });
  }
  return sdk;
}
