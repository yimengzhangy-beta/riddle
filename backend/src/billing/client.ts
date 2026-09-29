import { MonetizationAI } from '@aws-app-monetization/sdk';
import { config as loadEnv } from 'dotenv';
import * as path from 'path';

/**
 * The one place a MonetizationAI client is constructed. Lazy so that `tsc`,
 * `cdk synth` and cold-start module evaluation never touch the environment —
 * the constructor validates appId, which is only present at runtime.
 *
 * appId is the ONLY connection input. It is the app's live ARN or its sandbox
 * twin (`arn:aws:appmonetization:<region>:<acct>:app/<appId>[/sandbox]`), and the
 * SDK derives live-vs-sandbox from that value. Endpoint and region are the SDK's
 * own to resolve: it reads MONETIZATION_ENDPOINT from the environment and derives
 * the region from that host, so nothing is re-encoded here.
 */

let sdk: MonetizationAI | null = null;

/**
 * The repo-root `.env.monetization` (endpoint, region, app ARN). Loaded only to
 * fill keys that are not already set, so the Lambda's real environment — which
 * the stack injects from the same file at synth time — always wins. Inside the
 * deployed bundle the path does not exist and dotenv silently does nothing.
 */
const ENV_FILE = path.resolve(__dirname, '../../../.env.monetization');

export function getMonetize(): MonetizationAI {
  if (!sdk) {
    loadEnv({ path: ENV_FILE });
    sdk = new MonetizationAI({ appId: process.env.MONETIZATION_APP_ID ?? '' });
  }
  return sdk;
}
