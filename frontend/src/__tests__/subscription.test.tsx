import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Summary } from '../api';
import SubscriptionPage from '../pages/Subscription';

/**
 * A Pro subscriber partway through a period, over quota on guesses so the
 * estimated-charge arithmetic is actually exercised:
 *   base 499c + (420 - 400) * 1c = 519c → $5.19
 */
const SUBSCRIBED: Summary = {
  planId: '94ffd774-4fb0-4e10-afa9-6f866cab26c3',
  planName: 'Pro',
  currency: 'USD',
  billingCycle: 'MONTHLY',
  billingAnchorDate: '2026-07-01T00:00:00.000Z',
  nextPeriodBoundary: '2026-08-01T00:00:00.000Z',
  pendingChange: null,
  estimatedChargeCents: 519,
  usage: [
    { action: 'submit_guess', label: 'Guesses', currentUsage: 420, includedUnits: 400, overageCents: 1 },
    { action: 'take_hint', label: 'Hints', currentUsage: 12, includedUnits: 80, overageCents: 1 },
  ],
};

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, fetchSummary: vi.fn() };
});

const api = await import('../api');

beforeEach(() => {
  // Without this, call counts accumulate across tests and the "never fetched"
  // assertion below sees calls made by earlier cases.
  vi.clearAllMocks();
  vi.mocked(api.fetchSummary).mockResolvedValue(SUBSCRIBED);
});

describe('My subscription page', () => {
  it('shows the current plan name', async () => {
    render(<SubscriptionPage onSignOut={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Pro/)).toBeDefined());
  });

  it('shows estimated charges in dollars, labelled as an estimate', async () => {
    render(<SubscriptionPage onSignOut={() => {}} />);
    await waitFor(() => expect(screen.getByText(/\$5\.19/)).toBeDefined());

    const text = document.body.textContent ?? '';
    expect(text).toContain('Estimated charges');
    expect(text).toMatch(/not a final invoice/i);
    // "Total" or "Invoice" would overclaim — this figure is derived, not billed.
    expect(text).not.toMatch(/final total/i);
    expect(text).not.toContain('$519');
  });

  it('shows the billing period and next billing date', async () => {
    render(<SubscriptionPage onSignOut={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Billing period/)).toBeDefined());
    expect(document.body.textContent).toContain('Next billing date');
  });

  it('renders a usage row per priced metric', async () => {
    render(<SubscriptionPage onSignOut={() => {}} />);
    await waitFor(() => expect(screen.getByText('Guesses')).toBeDefined());

    const text = document.body.textContent ?? '';
    expect(text).toContain('420 of 400'); // over quota, shown honestly
    expect(text).toContain('12 of 80');
    expect(text).toContain('$0.01');
  });

  it('surfaces a scheduled plan change', async () => {
    vi.mocked(api.fetchSummary).mockResolvedValue({
      ...SUBSCRIBED,
      pendingChange: { planId: 'd9f6372d-7811-453c-b014-ceec9d761eb7', effectiveDate: '2026-08-01T00:00:00.000Z' },
    });
    render(<SubscriptionPage onSignOut={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Changing plan on/)).toBeDefined());
  });

  it('shows a no-subscription state with a route to plans, not an error', async () => {
    vi.mocked(api.fetchSummary).mockResolvedValue({ planId: null });
    render(<SubscriptionPage onSignOut={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/don.t have an active subscription/i)).toBeDefined()
    );
    expect(screen.getByText('View plans')).toBeDefined();
    expect(screen.queryByText('Estimated charges')).toBeNull();
  });

});
