#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppStack, readMonetizationEnv } from '../lib/app-stack';

/**
 * Two environments, one stack definition. Sandbox is sandbox and live is live:
 * each has its own API, DynamoDB table, Cognito user pool and Lambda, and each
 * Lambda signs AWS Monetization calls with its own identity — the live app ARN,
 * or that ARN with `/sandbox` appended. Players and money never cross.
 *
 *   npx cdk deploy --all                 # both
 *   npx cdk deploy RiddleSandboxStack    # just one
 */

const app = new cdk.App();

const env = { account: '136311627418', region: 'us-east-1' };

const monetization = readMonetizationEnv();
// The committed value is the live ARN; tolerate a `/sandbox` suffix left from testing.
const liveAppId = (monetization.MONETIZATION_APP_ID ?? '').replace(/\/sandbox$/, '');
const sandboxAppId = liveAppId ? `${liveAppId}/sandbox` : '';
const monetizationEndpoint = monetization.MONETIZATION_ENDPOINT ?? '';
const monetizationEnforce = monetization.MONETIZATION_ENFORCE ?? 'true';

/** Where each environment's web app is served from (override at synth time). */
const LIVE_APP_URL = process.env.APP_BASE_URL ?? 'https://live.dryqiojss602m.amplifyapp.com';
const SANDBOX_APP_URL =
  process.env.SANDBOX_APP_BASE_URL ?? 'https://main.d2v99bb7j5etb9.amplifyapp.com';
const LOCAL_DEV = 'http://localhost:5173';

// Live — real players, real money. The stack name and function name are
// unchanged from the single-stack days so no resource is replaced.
new AppStack(app, 'RiddleStack', {
  env,
  functionName: 'riddle-api',
  appBaseUrl: LIVE_APP_URL,
  allowedOrigins: [LIVE_APP_URL, LOCAL_DEV],
  monetizationAppId: liveAppId,
  monetizationEndpoint,
  monetizationEnforce,
  queryPrefix: 'riddle',
});

// Sandbox — test accounts, test cards, isolated usage counters.
new AppStack(app, 'RiddleSandboxStack', {
  env,
  functionName: 'riddle-api-sandbox',
  appBaseUrl: SANDBOX_APP_URL,
  allowedOrigins: [SANDBOX_APP_URL, LOCAL_DEV],
  monetizationAppId: sandboxAppId,
  monetizationEndpoint,
  monetizationEnforce,
  queryPrefix: 'riddle-sandbox',
});

cdk.Tags.of(app).add('project', 'riddle');
