import { useEffect, useState } from 'react';
import { fetchSummary, formatCents, formatDate, type Summary } from '../api';
import { navigate } from '../router';

/**
 * What the player is on, and how much of it they have used.
 *
 * Everything here is read live. The one derived number is the estimated charge,
 * and it is labelled as an estimate because that is what it is — there is no
 * per-user invoice to read, so the backend projects base fee plus overage at
 * current usage. It is not a bill.
 */
export default function Subscription({ onSignOut }: { onSignOut: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setSummary(await fetchSummary());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load your subscription.');
      }
    })();
  }, []);

  return (
    <div className="wrap">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginTop: '2rem',
        }}
      >
        <h1 className="title" style={{ margin: 0 }}>
          Your account
        </h1>
        <button className="btn btn--text" onClick={onSignOut}>
          Sign out
        </button>
      </div>

      {error && (
        <div className="notice" style={{ marginTop: '1.25rem' }}>
          {error}
        </div>
      )}
      {!summary && !error && (
        <p className="muted small" style={{ marginTop: '2rem' }}>
          <span className="spinner" /> Loading…
        </p>
      )}

      {/* No plan is a state, not a failure — send them somewhere useful. */}
      {summary && !summary.planId && (
        <section className="card" style={{ marginTop: '1.5rem' }}>
          <h2 style={{ marginTop: 0, fontFamily: 'var(--serif)', fontWeight: 400 }}>
            You don&rsquo;t have an active subscription
          </h2>
          <p className="muted small">Choose a plan to keep playing.</p>
          <button className="btn btn--primary" onClick={() => navigate('/pricing')}>
            View plans
          </button>
        </section>
      )}

      {summary && summary.planId && (
        <div className="stack" style={{ marginTop: '1.5rem' }}>
          <section className="card">
            <h2
              className="small muted"
              style={{ marginTop: 0, textTransform: 'uppercase', letterSpacing: '0.06em' }}
            >
              Current plan
            </h2>
            <p style={{ fontSize: '1.75rem', margin: '0.25rem 0', fontFamily: 'var(--serif)' }}>
              {summary.planName}{' '}
              <span className="muted small" style={{ fontFamily: 'var(--sans)' }}>
                {summary.billingCycle}
              </span>
            </p>

            <p style={{ margin: '1rem 0 0' }}>
              <strong>Estimated charges: </strong>
              {formatCents(summary.estimatedChargeCents ?? 0, summary.currency)}
            </p>
            <p className="muted small" style={{ marginTop: '0.125rem' }}>
              Estimate based on current usage — not a final invoice.
            </p>

            {/*
              Only some plans carry a spend cap. It is not a quota: it limits
              money rather than units, and crossing it blocks every action —
              including ones still well inside their own quota.
            */}
            {summary.budgetLimitCents != null &&
              (() => {
                const spent = summary.estimatedChargeCents ?? 0;
                const cap = summary.budgetLimitCents!;
                const pct = cap > 0 ? (spent / cap) * 100 : 0;
                return (
                  <div style={{ marginTop: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <strong className="small">Spend budget</strong>
                      <span className="muted small">
                        {formatCents(spent, summary.currency)} of{' '}
                        {formatCents(cap, summary.currency)} ({Math.round(pct)}%)
                      </span>
                    </div>
                    <Meter pct={pct} />
                    <span className="muted small">
                      {pct >= 100
                        ? 'Budget reached — further usage is blocked until the next period.'
                        : `${formatCents(Math.max(0, cap - spent), summary.currency)} of budget left this period.`}
                    </span>
                  </div>
                );
              })()}

            <p className="muted small" style={{ marginBottom: 0, marginTop: '1rem' }}>
              Billing period {formatDate(summary.billingAnchorDate)} –{' '}
              {formatDate(summary.nextPeriodBoundary)} · Next billing date{' '}
              {formatDate(summary.nextPeriodBoundary)}
            </p>

            {summary.pendingChange && (
              <div className="notice" style={{ marginTop: '1rem' }}>
                Changing plan on {formatDate(summary.pendingChange.effectiveDate)}.
              </div>
            )}
          </section>

          <section className="card">
            <h2
              className="small muted"
              style={{ marginTop: 0, textTransform: 'uppercase', letterSpacing: '0.06em' }}
            >
              Usage this billing period
            </h2>
            {(summary.usage ?? []).length === 0 && (
              <p className="muted small">Nothing metered on this plan yet.</p>
            )}
            {(summary.usage ?? []).map((row) => {
              const pct =
                row.includedUnits && row.includedUnits > 0
                  ? (row.currentUsage / row.includedUnits) * 100
                  : 0;
              return (
                <div key={row.label} style={{ marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{row.label}</span>
                    <span className="muted small">
                      {row.currentUsage} of {row.includedUnits ?? '∞'}
                      {row.includedUnits ? ` (${Math.round(pct)}%)` : ''}
                    </span>
                  </div>
                  <Meter pct={pct} />
                  {row.overageCents !== null &&
                    row.overageCents > 0 &&
                    row.includedUnits !== null && (
                      <span className="muted small">
                        {formatCents(row.overageCents, summary.currency)} per{' '}
                        {row.label.toLowerCase().replace(/s$/, '')} after {row.includedUnits}
                      </span>
                    )}
                </div>
              );
            })}
          </section>
        </div>
      )}
    </div>
  );
}

function Meter({ pct }: { pct: number }) {
  return (
    <div
      style={{
        height: 8,
        borderRadius: 999,
        background: 'var(--line)',
        overflow: 'hidden',
        margin: '0.375rem 0',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${Math.min(100, Math.max(0, pct))}%`,
          background: pct >= 100 ? '#a3342a' : 'var(--accent)',
          transition: 'width 400ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
    </div>
  );
}
