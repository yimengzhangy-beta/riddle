import { type HostedSession, mintBillingPortalSession, mintPricingSession } from './api';
import { isSignedIn } from './cognito';

/**
 * The hosted billing pages: plan selection (pricing) and the customer billing
 * portal. Both are rendered by MonetizationAI, not by this app.
 *
 * The SDK's <ManagePlan> and <ManageSubscription> launchers look for a cached
 * session URL in a first-party cookie and, finding none, call the refresh*
 * functions below, which mint a new session through our API (only the API can
 * sign the request). We deliberately cache nothing: a cached URL is bound to the
 * app identity the backend had when it was minted, so after a sandbox→live switch
 * a cached cookie would keep opening the sandbox for up to 8 hours. One extra
 * API call per click is cheaper than a wrong portal.
 */

/**
 * Where the hosted pages are served from. The service mints them on the regional
 * origin of the app's control plane (us-east-2), which this SDK build's built-in
 * trust list does not yet include, so every launcher is handed this list — a URL
 * on any other origin is refused rather than opened.
 */
export const MONETIZATION_HOSTED_ORIGINS: readonly string[] = [
  'https://us-east-2.appmonetization.aws.com',
];

const PRICING_COOKIE = 'mai_pricing_url';
const PORTAL_COOKIE = 'mai_billing_portal_url';

export interface LauncherSession {
  url: string;
  expiresAt?: string;
}

function clearCookie(name: string): void {
  document.cookie = `${name}=; Max-Age=0; Path=/; Secure; SameSite=Strict`;
}

function toLauncherSession(session: HostedSession): LauncherSession {
  return { url: session.url, expiresAt: session.expiresAt ?? undefined };
}

/** Mints a fresh pricing-page session. The <ManagePlan> callback; nothing is cached. */
export async function refreshPricingSession(): Promise<LauncherSession> {
  if (!isSignedIn()) throw new Error('refreshPricingSession: not signed in');
  clearMonetizationSessionCookies();
  return toLauncherSession(await mintPricingSession());
}

/** Mints a fresh billing-portal session. The <ManageSubscription> callback; nothing is cached. */
export async function refreshBillingPortalSession(): Promise<LauncherSession> {
  if (!isSignedIn()) throw new Error('refreshBillingPortalSession: not signed in');
  clearMonetizationSessionCookies();
  return toLauncherSession(await mintBillingPortalSession());
}

/**
 * Removes any hosted-session cookie an earlier build of this app may have left
 * behind, so the launchers never reuse a URL minted under a previous identity.
 * Called at sign-out, at sign-in, and before every mint.
 */
export function clearMonetizationSessionCookies(): void {
  for (const name of [PRICING_COOKIE, PORTAL_COOKIE]) {
    clearCookie(name);
    clearCookie(`${name}_expires_at`);
  }
}
