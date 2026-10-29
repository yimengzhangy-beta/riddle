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
  refreshBillingPortalSession,
  refreshPricingSession,
} from '../monetization';

function plantStaleCookie(name: string) {
  document.cookie = `${name}=${encodeURIComponent('https://host/pricing#token=stale')}; Max-Age=3600; Path=/; Secure; SameSite=Strict`;
  document.cookie = `${name}_expires_at=${EXPIRES}; Max-Age=3600; Path=/; Secure; SameSite=Strict`;
}

describe('hosted-session launchers (mint on every click, cache nothing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedIn.mockReturnValue(true);
    clearMonetizationSessionCookies();
  });

  it('mints a fresh pricing session through the API and returns it to the launcher', async () => {
    const session = await refreshPricingSession();

    expect(mintPricingSession).toHaveBeenCalledTimes(1);
    expect(session).toEqual({ url: PRICING_URL, expiresAt: EXPIRES });
    expect(document.cookie).not.toContain('mai_'); // nothing cached for a later click
  });

  it('mints a fresh billing-portal session the same way', async () => {
    const session = await refreshBillingPortalSession();

    expect(mintBillingPortalSession).toHaveBeenCalledTimes(1);
    expect(session).toEqual({ url: PORTAL_URL, expiresAt: EXPIRES });
    expect(document.cookie).not.toContain('mai_');
  });

  it('discards a stale cached URL from an earlier identity before minting', async () => {
    plantStaleCookie('mai_pricing_url');

    await refreshPricingSession();

    expect(document.cookie).not.toContain('token=stale');
  });

  it('throws and mints nothing when signed out', async () => {
    signedIn.mockReturnValue(false);

    await expect(refreshPricingSession()).rejects.toThrow();
    await expect(refreshBillingPortalSession()).rejects.toThrow();
    expect(mintPricingSession).not.toHaveBeenCalled();
    expect(mintBillingPortalSession).not.toHaveBeenCalled();
  });
});
