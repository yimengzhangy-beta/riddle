import { ResourceNotFoundException } from '@aws-monetization/sdk';
import type { BillableAction } from '../log';
import { logBillingCall, logBillingError } from '../log';
import { monetize } from './client';

/**
 * Plan catalogue, checkout and subscription reads — the player-facing half of
 * billing, as opposed to the gate-and-meter half in ./index.ts.
 *
 * Every amount the backend hands out is in **cents**, exactly as the platform
 * returns it. Converting to dollars is the frontend's job, done once, at render.
 */

/**
 * Which metric each price is measuring. The platform prices by `metricId`, but
 * entitlement is queried by `sourceEventType`, so the join has to happen
 * somewhere — these are the published metric ids for this app.
 */
const METRIC_ACTIONS: Record<string, BillableAction> = {
  '9950c846-4f48-4958-a81c-12e1a1ed42f0': 'serve_riddle',
  '8ba8f24d-7e24-459c-ab55-cb76a5cd9a03': 'submit_guess',
  'e4a80d4b-d977-4b8e-bac4-34eb059b088d': 'take_hint',
  'e1bf1c33-b11c-4bed-b00b-c96634abe3e4': 'judge_guess',
  'a074fb10-e4b8-4c4d-bebf-e69b76c15d93': 'serve_hard_riddle',
};

/** A plan reduced to what the pricing page renders. Amounts stay in cents. */
export interface PlanView {
  planId: string;
  name: string;
  description: string;
  currency: string;
  sortOrder: number;
  /** Recurring flat fee for this cycle, in cents. Zero for the free plan. */
  monthlyCents: number;
  /**
   * Plan-wide spend cap for the period, in cents, or null when the plan has
   * none. Distinct from a quota: the quota counts units, this caps money. A
   * player whose spend crosses it is denied even while under every quota.
   */
  budgetLimitCents: number | null;
  /** One row per metered price on the plan. */
  allowances: {
    action: BillableAction | null;
    label: string;
    includedUnits: number | null;
    overageCents: number | null;
  }[];
}

/**
 * The published plans, newest state every call. Read live rather than cached so
 * a price change in the backend shows up without a redeploy.
 */
export async function listPlans(): Promise<PlanView[]> {
  const { plans = [] } = await monetize().listPlans();

  return plans
    .map((plan): PlanView => {
      const def = plan.planDefinition ?? {};
      const prices = def.prices ?? [];
      const flat = prices.find(
        (p) => p.modelType === 'FLAT_FEE' && p.billingCycle === 'MONTHLY'
      );

      return {
        planId: plan.planId,
        name: def.planName ?? 'Plan',
        description: def.description ?? '',
        currency: def.currency ?? 'USD',
        sortOrder: plan.sortOrder ?? 0,
        monthlyCents: flat?.flatFeeConfig?.amount ?? 0,
        budgetLimitCents: def.budgetLimit ?? null,
        allowances: prices
          .filter((p) => p.modelType === 'USAGE_BASED')
          .map((p) => ({
            action: (p.metricId && METRIC_ACTIONS[p.metricId]) || null,
            label: p.name ?? 'Usage',
            includedUnits: p.includedQuantity ?? null,
            overageCents: p.usageBasedConfig?.unitAmount ?? null,
          })),
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * The player's current plan, or null when they have none. A player without a
 * subscription is a normal state — the platform signals it by throwing, which
 * is translated here so callers do not have to know that.
 */
export async function currentSubscription(
  userId: string
): Promise<{ planId: string | null; pendingChange: unknown | null }> {
  try {
    const { subscription, pendingChange } = await monetize().getSubscription(userId);
    return { planId: subscription?.planId ?? null, pendingChange: pendingChange ?? null };
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return { planId: null, pendingChange: null };
    throw err;
  }
}

/**
 * Starts a plan change. The same call covers subscribing, upgrading and
 * downgrading — the platform compares the target to the player's current plan
 * and the response shape says what happened:
 *   - `checkoutUrl`  → payment is due; the browser must go there.
 *   - `effectiveAt`  → scheduled, no payment (a downgrade at period end).
 *   - neither        → applied immediately, nothing to charge.
 */
export async function startCheckout(
  userId: string,
  planId: string,
  urls: { returnUrl: string; refreshUrl: string }
) {
  try {
    const session = await monetize().createCheckoutSession(userId, planId, urls);
    // The response shape IS the outcome, so record which one came back. A
    // checkout that is issued and never paid looks identical to one that was
    // never requested unless this line exists.
    logBillingCall({
      op: 'create_checkout',
      planId,
      serviceRequestId: requestIdOf(session),
      outcome: session.checkoutUrl
        ? 'checkout_issued'
        : session.effectiveAt
          ? 'scheduled'
          : 'applied_immediately',
    });
    return session;
  } catch (err) {
    logBillingCall({
      op: 'create_checkout',
      planId,
      outcome: 'failed',
      error: err instanceof Error ? err.name : typeof err,
    });
    throw err;
  }
}

/**
 * The billing backend's request id, which the SDK hangs off `$metadata`. It is
 * the only handle AWS can trace a call by, and it is not part of the typed
 * response — hence the cast.
 */
function requestIdOf(response: unknown): string | null {
  const meta = (response as { $metadata?: { requestId?: string } })?.$metadata;
  return meta?.requestId ?? null;
}

export interface SubscriptionSummary {
  planId: string | null;
  planName: string | null;
  currency: string;
  billingCycle: string;
  billingAnchorDate: string | null;
  nextPeriodBoundary: string | null;
  pendingChange: unknown | null;
  /** Base fee + accrued overage, in cents. Derived here — see the caveat below. */
  estimatedChargeCents: number;
  /**
   * The plan's spend cap for the period, in cents, or null if uncapped. Paired
   * with `estimatedChargeCents` this is the budget meter: once spend reaches the
   * cap the platform denies every action, so it is worth showing the player
   * before they hit it rather than after.
   */
  budgetLimitCents: number | null;
  usage: {
    action: BillableAction | null;
    label: string;
    currentUsage: number;
    includedUnits: number | null;
    overageCents: number | null;
  }[];
}

/**
 * What the player is on and how much of it they have used.
 *
 * `estimatedChargeCents` is **computed here, not returned by any API** — there
 * is no per-user invoice call. It is the plan's base fee plus per-metric
 * overage at current usage, which is a projection of the period so far rather
 * than a bill. The UI labels it as an estimate for that reason.
 */
export async function subscriptionSummary(userId: string): Promise<SubscriptionSummary | null> {
  let subscription;
  let pendingChange;
  let nextPeriodBoundary;
  try {
    ({ subscription, pendingChange, nextPeriodBoundary } =
      await monetize().getSubscription(userId));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }

  const { plans = [] } = await monetize().listPlans();
  const plan = plans.find((p) => p.planId === subscription?.planId);
  const prices = plan?.planDefinition?.prices ?? [];
  const cycle = subscription?.billingCycle ?? 'MONTHLY';

  const baseCents =
    prices.find((p) => p.modelType === 'FLAT_FEE' && p.billingCycle === cycle)?.flatFeeConfig
      ?.amount ?? 0;

  // One entitlement read per metered price: the response carries the player's
  // running count for that metric alongside the decision.
  const priced = prices.filter((p) => p.modelType === 'USAGE_BASED' && p.metricId);
  const usage = await Promise.all(
    priced.map(async (price) => {
      const action = (price.metricId && METRIC_ACTIONS[price.metricId]) || null;
      let currentUsage = 0;
      if (action) {
        try {
          const ent = await monetize().checkEntitlement(userId, { eventType: action });
          currentUsage =
            ent.metrics?.find((m) => m.metricId === price.metricId)?.currentUsage ?? 0;
        } catch (err) {
          // A usage read failing should not blank the whole page; the row shows
          // zero and the rest of the summary still renders.
          logBillingError({
            where: 'billing.subscriptionSummary',
            action,
            name: err instanceof Error ? err.name : typeof err,
          });
        }
      }
      return {
        action,
        label: price.name ?? 'Usage',
        currentUsage,
        includedUnits: price.includedQuantity ?? null,
        overageCents: price.usageBasedConfig?.unitAmount ?? null,
      };
    })
  );

  const overageCents = usage.reduce((sum, row) => {
    if (row.includedUnits === null || row.overageCents === null) return sum;
    return sum + Math.max(0, row.currentUsage - row.includedUnits) * row.overageCents;
  }, 0);

  return {
    planId: subscription?.planId ?? null,
    planName: plan?.planDefinition?.planName ?? null,
    currency: plan?.planDefinition?.currency ?? 'USD',
    billingCycle: cycle,
    billingAnchorDate: subscription?.billingAnchorDate ?? null,
    nextPeriodBoundary: nextPeriodBoundary ?? null,
    pendingChange: pendingChange ?? null,
    estimatedChargeCents: baseCents + overageCents,
    budgetLimitCents: plan?.planDefinition?.budgetLimit ?? null,
    usage,
  };
}
