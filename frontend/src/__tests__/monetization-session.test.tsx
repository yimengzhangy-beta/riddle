// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://riddle.test/" }
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above every import, so anything a factory reads must be hoisted too.
const { signedIn, PRICING_URL, PORTAL_URL, EXPIRES } = vi.hoisted(() => ({
  signedIn: vi.fn(() => true),
  PRICING_URL: 'https://host/pricing#token=p',
  PORTAL_URL: 'https://host/billing-portal#token=b',
  EXPIRES: new Date(Date.now() + 3_600_000).toISOString(),
}));
vi.mock('../cognito', () => ({ isSignedIn: () => signedIn() }));

vi.mock('../api', () => ({
  mintPricingSession: vi.fn().mockResolvedValue({ url: PRICING_URL, expiresAt: EXPIRES }),
  mintBillingPortalSession: vi.fn().mockResolvedValue({ url: PORTAL_URL, expiresAt: EXPIRES }),
}));

import { mintBillingPortalSession, mintPricingSession } from '../api';
import {
  clearMonetizationSessionCookies,
  setMonetizationSessionCookies,
} from '../monetization';

function cookie(name: string): string | null {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

describe('setMonetizationSessionCookies (the login hook)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedIn.mockReturnValue(true);
    clearMonetizationSessionCookies();
  });

  it('mints both hosted sessions and stores both URLs with their expiry', async () => {
    await setMonetizationSessionCookies();

    expect(mintPricingSession).toHaveBeenCalledTimes(1);
    expect(mintBillingPortalSession).toHaveBeenCalledTimes(1);

    expect(cookie('mai_pricing_url')).toBe(PRICING_URL);
    expect(cookie('mai_billing_portal_url')).toBe(PORTAL_URL);
    expect(cookie('mai_pricing_url_expires_at')).toBe(EXPIRES);
    expect(cookie('mai_billing_portal_url_expires_at')).toBe(EXPIRES);
  });

  it('throws and mints nothing when signed out', async () => {
    signedIn.mockReturnValue(false);

    await expect(setMonetizationSessionCookies()).rejects.toThrow();
    expect(mintPricingSession).not.toHaveBeenCalled();
    expect(mintBillingPortalSession).not.toHaveBeenCalled();
    expect(cookie('mai_pricing_url')).toBeNull();
  });

  it('clears every cookie on sign-out', async () => {
    await setMonetizationSessionCookies();
    clearMonetizationSessionCookies();

    expect(document.cookie).not.toContain('mai_');
  });
});
