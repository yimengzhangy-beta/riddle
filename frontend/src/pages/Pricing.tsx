import { useEffect, useState } from 'react';
import {
  ApiError,
  fetchPlans,
  fetchSubscription,
  formatCents,
  formatDate,
  subscribe,
  type Plan,
} from '../api';
import { isSignedIn } from '../cognito';
import { navigate } from '../router';

/**
 * Plans, read live on every load. Nothing here is hardcoded: a price change in
 * the billing backend shows up without a redeploy — which is also why a failed
 * load shows an error rather than a stale fallback list.
 */
export default function Pricing() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // The checkout-return banner is read once, on mount. Folding it into load()
  // would let it overwrite an action message every time the list refreshes.
  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get('checkout');
    if (status === 'success') setMessage('Payment complete — your new plan is active.');
    if (status === 'expired') setMessage('That checkout link expired. Pick a plan to try again.');
  }, []);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    try {
      const { plans } = await fetchPlans();
      setPlans(plans);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load plans.');
      return;
    }
    if (isSignedIn()) {
      try {
        const { planId } = await fetchSubscription();
        setCurrentPlanId(planId);
      } catch {
        setCurrentPlanId(null);
      }
    }
  }

  async function choose(planId: string) {
    if (!isSignedIn()) {
      setMessage('Sign in first — your plan is tied to your account.');
      navigate('/');
      return;
    }
    setPending(planId);
    setMessage(null);
    try {
      const session = await subscribe(planId);
      if (session.checkoutUrl) {
        window.location.href = session.checkoutUrl;
        return;
      }
      setMessage(
        session.effectiveAt
          ? `Your plan update will apply on ${formatDate(session.effectiveAt)}.`
          : 'Your plan is updated.'
      );
      await load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not start checkout.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="wrap wrap--wide">
      <h1 className="title center" style={{ marginTop: '2rem' }}>
        Plans
      </h1>
      <p className="center muted small">
        Solve riddles, take hints, and let Claude judge the near-misses.
      </p>

      {message && (
        <div className="notice" style={{ marginTop: '1.25rem' }}>
          {message}
        </div>
      )}
      {error && (
        <div className="notice" style={{ marginTop: '1.25rem' }}>
          Couldn&rsquo;t load plans — {error}
        </div>
      )}
      {!plans && !error && (
        <p className="center muted small" style={{ marginTop: '2rem' }}>
          <span className="spinner" /> Loading plans…
        </p>
      )}

      {plans && (
        <div
          style={{
            display: 'grid',
            gap: '1rem',
            marginTop: '2rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))',
          }}
        >
          {plans.map((plan) => {
            const isCurrent = plan.planId === currentPlanId;
            return (
              <section
                key={plan.planId}
                className="card"
                style={{ display: 'flex', flexDirection: 'column' }}
              >
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}
                >
                  <h2
                    style={{
                      margin: 0,
                      fontFamily: 'var(--serif)',
                      fontSize: '1.375rem',
                      fontWeight: 400,
                    }}
                  >
                    {plan.name}
                  </h2>
                  {isCurrent && (
                    <span
                      className="small"
                      style={{ color: 'var(--accent)', fontWeight: 600, whiteSpace: 'nowrap' }}
                    >
                      Current plan
                    </span>
                  )}
                </div>

                <p style={{ fontSize: '2rem', margin: '0.5rem 0 0', fontFamily: 'var(--serif)' }}>
                  {plan.monthlyCents === 0 ? 'Free' : formatCents(plan.monthlyCents, plan.currency)}
                  {plan.monthlyCents > 0 && (
                    <span className="muted small"> /month</span>
                  )}
                </p>

                <p className="muted small" style={{ minHeight: '3.5rem', lineHeight: 1.5 }}>
                  {plan.description}
                </p>

                <ul style={{ paddingLeft: '1.1rem', margin: '0 0 1rem', fontSize: '0.9375rem' }}>
                  {plan.allowances.map((a) => (
                    <li key={a.label} style={{ marginBottom: '0.375rem', lineHeight: 1.5 }}>
                      {a.includedUnits !== null ? `${a.includedUnits} ` : ''}
                      {a.label.toLowerCase()}
                      {a.overageCents !== null &&
                        a.overageCents > 0 &&
                        a.includedUnits !== null && (
                          <span className="muted small">
                            {' '}
                            — then {formatCents(a.overageCents, plan.currency)} each
                          </span>
                        )}
                    </li>
                  ))}
                </ul>

                {/* A spend cap changes what the plan is, so it belongs on the
                    card rather than buried in the terms. */}
                {plan.budgetLimitCents != null && (
                  <p className="muted small" style={{ marginTop: '-0.5rem' }}>
                    Spend capped at {formatCents(plan.budgetLimitCents, plan.currency)} per month.
                  </p>
                )}

                <button
                  className={`btn btn--block ${isCurrent ? 'btn--quiet' : 'btn--primary'}`}
                  style={{ marginTop: 'auto' }}
                  onClick={() => void choose(plan.planId)}
                  disabled={isCurrent || pending !== null}
                >
                  {isCurrent
                    ? 'Your plan'
                    : pending === plan.planId
                      ? 'Starting…'
                      : plan.monthlyCents === 0
                        ? 'Switch to Free'
                        : `Choose ${plan.name}`}
                </button>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
