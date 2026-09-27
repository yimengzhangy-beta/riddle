import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Smoke test for the hosted-session mint behind GET /billing/session: both
 * sessions are minted with return URLs for a signed-in player, and an empty
 * userId mints nothing. The SDK accessor is mocked — no real MonetizationAI is
 * constructed (its constructor requires an appId the test env does not have).
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
import { getSession } from '../routes/billing';

describe('GET /billing/session', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints both sessions and returns both URLs for a signed-in player', async () => {
    const res = await getSession({ userId: 'user-123', email: 'p@example.com' }, 'https://app.example');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pricingUrl: 'https://host/pricing#token=p',
      billingPortalUrl: 'https://host/billing-portal#token=b',
    });
    expect(createPricingSession).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        returnUrl: expect.stringContaining('https://app.example'),
        refreshUrl: expect.any(String),
      })
    );
    expect(createBillingPortalSession).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ returnUrl: expect.any(String), refreshUrl: expect.any(String) })
    );
  });

  it('throws and mints nothing when userId is empty', async () => {
    await expect(mintPortalSessions('', 'https://app.example')).rejects.toThrow();
    expect(createPricingSession).not.toHaveBeenCalled();
    expect(createBillingPortalSession).not.toHaveBeenCalled();
  });
});
