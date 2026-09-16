import { getBillingSession } from './api';

/**
 * Launchers for the MonetizationAI-hosted pricing page and billing portal.
 *
 * The app builds neither page. The backend mints short-lived session URLs
 * (GET /billing/session); we cache them in first-party cookies on this origin
 * and redirect. A missing/expired cookie just re-mints — the player never sees
 * a broken launcher while signed in.
 */

const PRICING_COOKIE = 'mai_pricing_url';
const PORTAL_COOKIE = 'mai_billing_portal_url';

function readCookie(name: string): string | null {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

function writeCookie(name: string, value: string, maxAgeSeconds: number): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; secure; samesite=lax`;
}

async function hostedUrl(cookie: typeof PRICING_COOKIE | typeof PORTAL_COOKIE): Promise<string> {
  const cached = readCookie(cookie);
  if (cached) return cached;

  const session = await getBillingSession();
  writeCookie(PRICING_COOKIE, session.pricingUrl, session.expiresInSeconds);
  writeCookie(PORTAL_COOKIE, session.billingPortalUrl, session.expiresInSeconds);
  return cookie === PRICING_COOKIE ? session.pricingUrl : session.billingPortalUrl;
}

/** Top-level redirect to the hosted plan-selection page. */
export async function openHostedPricing(): Promise<void> {
  window.location.assign(await hostedUrl(PRICING_COOKIE));
}

/** Top-level redirect to the hosted billing portal (plan, usage, invoices, cancel). */
export async function openHostedPortal(): Promise<void> {
  window.location.assign(await hostedUrl(PORTAL_COOKIE));
}

/** Drop the cached session URLs — call at sign-out. */
export function clearBillingCookies(): void {
  document.cookie = `${PRICING_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${PORTAL_COOKIE}=; path=/; max-age=0`;
}
