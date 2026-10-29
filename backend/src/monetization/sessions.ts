import { logMonetization } from '../log';
import { getMonetize } from './client';

/**
 * Sessions for the two MonetizationAI-hosted pages: plan selection (the pricing
 * page) and the customer billing portal. The browser cannot sign AWS requests,
 * so the frontend asks this API to mint a session and then redirects to the URL.
 *
 * The pages are hosted — this app renders neither plans nor invoices itself.
 */

export interface HostedSession {
  /** Full URL to redirect the browser to. Carries a short-lived token. */
  url: string;
  /** ISO-8601, or null when the service did not say. */
  expiresAt: string | null;
}

/** The Cognito ID token lives 12h; the service caps a hosted session at 24h. */
const SESSION_SECONDS = 60 * 60 * 8;

/** Where the hosted pages send the player back to: the web app, never the API. */
function appOrigin(): string {
  const raw = process.env.APP_BASE_URL;
  if (!raw) throw new Error('APP_BASE_URL is not set');
  return new URL(raw).origin;
}

function toIso(value: Date | string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function createPricingSession(userId: string): Promise<HostedSession> {
  const origin = appOrigin();
  const startedAt = Date.now();
  try {
    const { pricingUrl, expiresAt } = await getMonetize().createPricingSession(userId, {
      returnUrl: `${origin}/`,
      refreshUrl: `${origin}/?pricing=expired`,
      sessionDurationSeconds: SESSION_SECONDS,
    });
    if (!pricingUrl) throw new Error('pricing session carried no URL');
    logMonetization({ op: 'pricing_session', ok: true, durationMs: Date.now() - startedAt });
    return { url: pricingUrl, expiresAt: toIso(expiresAt) };
  } catch (err) {
    logMonetization({
      op: 'pricing_session',
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.name : typeof err,
    });
    throw err;
  }
}

export async function createBillingPortalSession(userId: string): Promise<HostedSession> {
  const origin = appOrigin();
  const startedAt = Date.now();
  try {
    const { billingPortalUrl, expiresAt } = await getMonetize().createBillingPortalSession(userId, {
      returnUrl: `${origin}/`,
      refreshUrl: `${origin}/?portal=expired`,
      sessionDurationSeconds: SESSION_SECONDS,
    });
    logMonetization({ op: 'billing_portal_session', ok: true, durationMs: Date.now() - startedAt });
    return { url: billingPortalUrl, expiresAt: toIso(expiresAt) };
  } catch (err) {
    logMonetization({
      op: 'billing_portal_session',
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.name : typeof err,
    });
    throw err;
  }
}
