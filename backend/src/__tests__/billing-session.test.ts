import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Smoke test for the hosted-session mint (the SPA's "login hook" equivalent):
 * both sessions minted with return URLs + TTL, and an empty userId mints
 * nothing. The SDK accessor is mocked — no real MonetizationAI is constructed.
 */

const createPricingSession = vi
  .fn()
  .mockResolvedValue({ pricingUrl: 'https://host/pricing#token=p' });
const createBillingPortalSession = vi
  .fn()
  .mockResolvedValue({ billingPortalUrl: 'https://host/billing-portal#token=b' });

vi.mock('../billing/client', () => ({
  getMonetize: () => ({ createPricingSession, createBillingPortalSession }),
}));

import { mintPortalSessions } from '../billing';

describe('mintPortalSessions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints both sessions and returns both URLs for a signed-in player', async () => {
    const out = await mintPortalSessions('user-123', 'https://app.example');

    expect(createPricingSession).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        returnUrl: expect.stringContaining('https://app.example'),
        refreshUrl: expect.any(String),
      })
    );
    expect(createBillingPortalSession).toHaveBeenCalledWith('user-123', expect.any(Object));
    expect(out).toEqual({
      pricingUrl: 'https://host/pricing#token=p',
      billingPortalUrl: 'https://host/billing-portal#token=b',
      expiresInSeconds: expect.any(Number),
    });
  });

  it('throws and mints nothing when userId is empty', async () => {
    await expect(mintPortalSessions('', 'https://app.example')).rejects.toThrow();
    expect(createPricingSession).not.toHaveBeenCalled();
    expect(createBillingPortalSession).not.toHaveBeenCalled();
  });
});
