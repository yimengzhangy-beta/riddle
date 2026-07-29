import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '../api';
import Pricing from '../pages/Pricing';

/**
 * Fixtures are the plans actually published for this app, so a card that
 * silently drops a field fails here rather than in production.
 */
const PLANS: Plan[] = [
  {
    planId: 'd9f6372d-7811-453c-b014-ceec9d761eb7',
    name: 'Free',
    description:
      '10 riddles, 30 guesses and 5 hints a month, on easy and medium. Guesses must match the answer exactly.',
    currency: 'USD',
    sortOrder: -1,
    monthlyCents: 0,
    budgetLimitCents: null,
    allowances: [
      { action: 'serve_riddle', label: 'Riddles', includedUnits: 10, overageCents: 0 },
      { action: 'submit_guess', label: 'Guesses', includedUnits: 30, overageCents: 0 },
      { action: 'take_hint', label: 'Hints', includedUnits: 5, overageCents: 0 },
    ],
  },
  {
    planId: '94ffd774-4fb0-4e10-afa9-6f866cab26c3',
    name: 'Pro',
    description:
      '120 riddles, 400 guesses and 80 hints a month, all difficulties, with Claude judging inexact guesses.',
    currency: 'USD',
    sortOrder: 499,
    monthlyCents: 499,
    budgetLimitCents: null,
    allowances: [
      { action: 'serve_riddle', label: 'Riddles', includedUnits: 120, overageCents: 1 },
      { action: 'submit_guess', label: 'Guesses', includedUnits: 400, overageCents: 1 },
      { action: 'take_hint', label: 'Hints', includedUnits: 80, overageCents: 1 },
    ],
  },
  {
    planId: '9fd3c011-5182-4a07-b884-c88d39bc6871',
    name: 'Unlimited',
    description:
      '500 riddles, 850 guesses and 200 hints a month, all difficulties, with Claude judging inexact guesses.',
    currency: 'USD',
    sortOrder: 999,
    monthlyCents: 999,
    budgetLimitCents: null,
    allowances: [
      { action: 'serve_riddle', label: 'Riddles', includedUnits: 500, overageCents: 1 },
      { action: 'submit_guess', label: 'Guesses', includedUnits: 850, overageCents: 1 },
      { action: 'take_hint', label: 'Hints', includedUnits: 200, overageCents: 1 },
    ],
  },
];

// The formatters are deliberately NOT mocked — a cents-to-dollars slip should
// fail the test, and it can only do that if the real implementation runs.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchPlans: vi.fn(),
    fetchSubscription: vi.fn(),
    subscribe: vi.fn(),
  };
});

// Pricing asks cognito whether anyone is signed in before marking a current plan.
vi.mock('../cognito', () => ({ isSignedIn: vi.fn(() => false) }));

const api = await import('../api');
const cognito = await import('../cognito');

beforeEach(() => {
  vi.mocked(api.fetchPlans).mockResolvedValue({ plans: PLANS });
  vi.mocked(api.fetchSubscription).mockResolvedValue({ planId: null });
  vi.mocked(cognito.isSignedIn).mockReturnValue(false);
});

describe('Pricing page', () => {
  it('renders every plan exactly once, in order', async () => {
    render(<Pricing />);
    await waitFor(() => expect(screen.getByText('Pro')).toBeDefined());

    // One card per plan, counted by its heading — the plan name also appears as
    // the price on the $0 tier, so counting raw text would double-count Free.
    const names = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(names).toEqual(['Free', 'Pro', 'Unlimited']);
  });

  it('shows prices formatted as dollars, never raw cents', async () => {
    render(<Pricing />);
    await waitFor(() => expect(screen.getByText('Pro')).toBeDefined());

    expect(screen.getByText(/\$4\.99/)).toBeDefined();
    expect(screen.getByText(/\$9\.99/)).toBeDefined();
    // The $0 tier reads as "Free" rather than "$0.00".
    expect(screen.getAllByText('Free').length).toBeGreaterThan(0);

    // 499 / 999 would mean the cents→dollars conversion was skipped.
    expect(document.body.textContent).not.toMatch(/\$499\b/);
    expect(document.body.textContent).not.toMatch(/\$999\b/);
  });

  it('lists included quantities and overage rates for each plan', async () => {
    render(<Pricing />);
    await waitFor(() => expect(screen.getByText('Pro')).toBeDefined());

    const text = document.body.textContent ?? '';
    expect(text).toContain('400 guesses');
    expect(text).toContain('80 hints');
    expect(text).toContain('850 guesses');
    // Overage is a real per-unit price, shown in dollars.
    expect(text).toContain('$0.01');
  });

  it('renders each plan description', async () => {
    render(<Pricing />);
    await waitFor(() => expect(screen.getByText('Pro')).toBeDefined());
    for (const plan of PLANS) {
      expect(screen.getByText(plan.description)).toBeDefined();
    }
  });

  it('orders plans by sortOrder, cheapest first', async () => {
    render(<Pricing />);
    await waitFor(() => expect(screen.getByText('Pro')).toBeDefined());

    const text = document.body.textContent ?? '';
    expect(text.indexOf('Free')).toBeLessThan(text.indexOf('Pro'));
    expect(text.indexOf('Pro')).toBeLessThan(text.indexOf('Unlimited'));
  });

  it('shows no billing-cycle toggle when only monthly pricing exists', async () => {
    render(<Pricing />);
    await waitFor(() => expect(screen.getByText('Pro')).toBeDefined());
    // Every published plan is monthly-only — a cycle switch would be dead UI.
    expect(screen.queryByText(/annual/i)).toBeNull();
  });

  it('marks the plan the player is already on', async () => {
    vi.mocked(cognito.isSignedIn).mockReturnValue(true);
    vi.mocked(api.fetchSubscription).mockResolvedValue({ planId: PLANS[1].planId });

    render(<Pricing />);
    await waitFor(() => expect(screen.getByText('Current plan')).toBeDefined());
    expect(screen.getByText('Your plan')).toBeDefined();
  });

  it('shows the spend cap only on plans that have one', async () => {
    const capped = PLANS.map((p, i) => (i === 1 ? { ...p, budgetLimitCents: 10000 } : p));
    vi.mocked(api.fetchPlans).mockResolvedValue({ plans: capped });

    render(<Pricing />);
    await waitFor(() => expect(screen.getByText('Pro')).toBeDefined());

    // $100.00 cap rendered as dollars, and only once (Free/Unlimited have none).
    const caps = screen.getAllByText(/Spend capped at \$100\.00 per month/);
    expect(caps).toHaveLength(1);
  });

  it('shows an error instead of inventing plans when the load fails', async () => {
    vi.mocked(api.fetchPlans).mockRejectedValue(new Error('backend down'));
    render(<Pricing />);
    await waitFor(() => expect(screen.getByText(/Couldn/)).toBeDefined());
    expect(screen.queryByText('Pro')).toBeNull();
  });
});
