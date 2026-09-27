import { getBillingSession } from './api';

/**
 * Launchers for the MonetizationAI-hosted pricing page and billing portal.
 *
 * The app builds neither page. Each launcher click mints a FRESH session URL
 * (GET /billing/session) and redirects to it. The URL is deliberately not
 * cached: the session token embedded in it is short-lived and platform-managed,
 * so a stale URL makes the hosted page fail to load. Minting is one cheap call.
 */

/** Top-level redirect to the hosted plan-selection page. */
export async function openHostedPricing(): Promise<void> {
  const { pricingUrl } = await getBillingSession();
  window.location.assign(pricingUrl);
}

/** Top-level redirect to the hosted billing portal (plan, usage, invoices, cancel). */
export async function openHostedPortal(): Promise<void> {
  const { billingPortalUrl } = await getBillingSession();
  window.location.assign(billingPortalUrl);
}
