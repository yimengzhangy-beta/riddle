import { getBillingSession } from './api';

/**
 * Launchers for the MonetizationAI-hosted pricing page and billing portal.
 *
 * The app builds neither page. On every click the backend mints a fresh
 * short-lived session URL (GET /billing/session) and we redirect to it.
 * Nothing is cached client-side: a cached URL outlives a backend switch
 * (sandbox ↔ live, or a change of app), and sends the player to the wrong
 * checkout for up to an hour.
 */

const LEGACY_COOKIES = ['mai_pricing_url', 'mai_billing_portal_url'];

/** Top-level redirect to the hosted plan-selection page. */
export async function openHostedPricing(): Promise<void> {
  clearBillingCookies();
  const session = await getBillingSession();
  window.location.assign(session.pricingUrl);
}

/** Top-level redirect to the hosted billing portal (plan, usage, invoices, cancel). */
export async function openHostedPortal(): Promise<void> {
  clearBillingCookies();
  const session = await getBillingSession();
  window.location.assign(session.billingPortalUrl);
}

/** Drop any session URLs an older build cached — called at sign-out and before each launch. */
export function clearBillingCookies(): void {
  for (const name of LEGACY_COOKIES) document.cookie = `${name}=; path=/; max-age=0`;
}
