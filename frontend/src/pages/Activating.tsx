import { useEffect, useState } from 'react';
import { fetchSubscription } from '../api';
import { navigate } from '../router';

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 60_000;

/**
 * Where hosted checkout drops the player after they pay.
 *
 * A subscription activates asynchronously, so for a second or two after payment
 * the API still reports the old plan. Landing straight on /pricing in that
 * window shows them what they just paid to leave. This waits for the new plan to
 * appear, then moves on — and gives up gracefully rather than spinning forever,
 * because a slow activation is not a failed payment.
 */
export default function Activating() {
  const targetPlanId = new URLSearchParams(window.location.search).get('planId');
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!targetPlanId) {
      navigate('/pricing?checkout=success');
      return;
    }

    let active = true;
    const deadline = Date.now() + TIMEOUT_MS;

    const tick = async () => {
      if (!active) return;
      try {
        const { planId } = await fetchSubscription();
        if (planId === targetPlanId) {
          active = false;
          navigate('/pricing?checkout=success');
          return;
        }
      } catch {
        // Transient — keep polling until the deadline rather than failing here.
      }
      if (Date.now() >= deadline) {
        active = false;
        setTimedOut(true);
        return;
      }
      window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      active = false;
    };
  }, [targetPlanId]);

  return (
    <div className="wrap center" style={{ marginTop: '4rem' }}>
      <h1 className="title">Activating your plan…</h1>
      <p className="muted">
        {timedOut
          ? 'This is taking a little longer than usual. Your payment went through and your plan will update shortly.'
          : "Hang tight — we're confirming your new plan."}
      </p>
      {/* Always rendered: nobody should be stuck watching a spinner. */}
      <p style={{ marginTop: '1.5rem' }}>
        <a
          href="/pricing?checkout=success"
          style={{ color: 'var(--accent)' }}
          onClick={(e) => {
            e.preventDefault();
            navigate('/pricing?checkout=success');
          }}
        >
          Not redirected automatically? Head back to plans →
        </a>
      </p>
    </div>
  );
}
