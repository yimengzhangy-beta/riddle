import { MonetizationAI } from '@aws-app-monetization/sdk';
import { config as loadEnv } from 'dotenv';

/**
 * The only module that constructs the AWS Monetization client.
 *
 * Lazy on purpose: the constructor validates `appId`, and the environment is not
 * there at build or synth time. `MONETIZATION_APP_ID` is the sandbox ARN while
 * testing and the live ARN once published — the stack sets it from the repo-root
 * `.env.monetization`, and the SDK derives live vs sandbox from the value. The
 * endpoint comes from `MONETIZATION_ENDPOINT` the same way; nothing is passed here.
 */

let sdk: MonetizationAI | null = null;

export function getMonetize(): MonetizationAI {
  if (!sdk) {
    // No framework loads this filename. In Lambda the real env vars win (dotenv only
    // fills keys that are unset); the file matters for a local invocation.
    loadEnv({ path: '.env.monetization', quiet: true });
    sdk = new MonetizationAI({ appId: process.env.MONETIZATION_APP_ID ?? '' });
  }
  return sdk;
}

/** True once a call in this execution environment has constructed the client. */
export function monetizeInitialized(): boolean {
  return sdk !== null;
}
