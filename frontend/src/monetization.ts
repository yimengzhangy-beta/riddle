import { type HostedSession, mintBillingPortalSession, mintPricingSession } from './api';
import { isSignedIn } from './cognito';

/**
 * The hosted billing pages: plan selection (pricing) and the customer billing
 * portal. Both are rendered by MonetizationAI, not by this app.
 *
 * The SDK's <ManagePlan> and <ManageSubscription> launchers read a first-party
 * cookie holding the page's URL and redirect without a network call while the
 * session is fresh. When it is absent or expired they call the refresh* functions
 * below, which mint a new session through our API (only the API can sign the
 * request) and refresh the cookies. The API lives on another origin, so the SPA
 * sets the cookies itself, right after sign-in.
 */

const PRICING_COOKIE = 'mai_pricing_url';
const PORTAL_COOKIE = 'mai_billing_portal_url';

/** Matches the API's session length; a cookie never outlives its token. */
const SESSION_SECONDS = 60 * 60 * 8;

export interface LauncherSession {
  url: string;
  expiresAt?: string;
}

function setCookie(name: string, value: string, expiresAt: string | null): void {
  const left = expiresAt ? Math.floor((Date.parse(expiresAt) - Date.now()) / 1000) : SESSION_SECONDS;
  const maxAge = Math.max(0, Math.min(left, SESSION_SECONDS));
  // Not HttpOnly on purpose: the launcher reads it. First-party, Secure, Strict.
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; Secure; SameSite=Strict`;
}

function clearCookie(name: string): void {
  document.cookie = `${name}=; Max-Age=0; Path=/; Secure; SameSite=Strict`;
}

function store(cookie: string, session: HostedSession): LauncherSession {
  setCookie(cookie, session.url, session.expiresAt);
  if (session.expiresAt) setCookie(`${cookie}_expires_at`, session.expiresAt, session.expiresAt);
  else clearCookie(`${cookie}_expires_at`);
  return { url: session.url, expiresAt: session.expiresAt ?? undefined };
}

/** Mints a fresh pricing-page session and stores it. The <ManagePlan> re-mint callback. */
export async function refreshPricingSession(): Promise<LauncherSession> {
  return store(PRICING_COOKIE, await mintPricingSession());
}

/** Mints a fresh billing-portal session and stores it. The <ManageSubscription> re-mint callback. */
export async function refreshBillingPortalSession(): Promise<LauncherSession> {
  return store(PORTAL_COOKIE, await mintBillingPortalSession());
}

/**
 * The login hook: mint both hosted sessions once at sign-in so the launchers
 * redirect instantly. Throws when there is no session to mint for.
 */
export async function setMonetizationSessionCookies(): Promise<void> {
  if (!isSignedIn()) throw new Error('setMonetizationSessionCookies: not signed in');
  await Promise.all([refreshPricingSession(), refreshBillingPortalSession()]);
}

/** The logout mirror: a signed-out browser keeps no live hosted URL. */
export function clearMonetizationSessionCookies(): void {
  for (const name of [PRICING_COOKIE, PORTAL_COOKIE]) {
    clearCookie(name);
    clearCookie(`${name}_expires_at`);
  }
}
