import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  BASE_POINTS,
  HINT_PENALTY,
  type Difficulty,
  type GuessResult,
  type PublicRiddle,
  nextRiddle,
  submitGuess,
  takeHint,
} from '../api';
import { openHostedPricing } from '../billing';
import { navigate } from '../router';

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

type Phase =
  | { kind: 'picking' }
  | { kind: 'loading' }
  | { kind: 'playing'; riddle: PublicRiddle }
  | { kind: 'solved'; result: GuessResult; difficulty: Difficulty };

interface Props {
  onStats: (stats: { score: number; streak: number }) => void;
}

export default function Play({ onStats }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'picking' });
  const [guess, setGuess] = useState('');
  const [verdict, setVerdict] = useState<GuessResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Set alongside `notice` on a 403 whose body says decision:'DENY' — the
  // player's plan doesn't cover the action, so the notice grows a plans link.
  const [planDenied, setPlanDenied] = useState(false);
  const [confirmHint, setConfirmHint] = useState(false);
  const guessRef = useRef<HTMLInputElement>(null);

  function fail(message: string, err?: unknown) {
    setNotice(message);
    setPlanDenied(err instanceof ApiError && err.planDenied);
  }

  // Focus the guess box whenever a riddle appears, so typing just works.
  useEffect(() => {
    if (phase.kind === 'playing') guessRef.current?.focus();
  }, [phase.kind, phase.kind === 'playing' ? phase.riddle.riddleId : '']);

  async function start(difficulty: Difficulty) {
    setPhase({ kind: 'loading' });
    setVerdict(null);
    setGuess('');
    setNotice(null);
    setPlanDenied(false);
    try {
      const { riddle } = await nextRiddle(difficulty);
      setPhase({ kind: 'playing', riddle });
    } catch (err) {
      setPhase({ kind: 'picking' });
      if (!(err instanceof ApiError)) {
        setNotice('Something went wrong. Try again.');
        return;
      }
      if (err.planDenied) {
        // Out of riddles on this plan (or no plan yet).
        fail(err.message, err);
      } else if (err.status === 409) {
        // Every riddle at this difficulty has already been served to them.
        setNotice(`You've seen every ${difficulty} riddle. Try another difficulty.`);
      } else if (err.status === 404) {
        setNotice(`No ${difficulty} riddles in the bank yet.`);
      } else {
        setNotice(err.message);
      }
    }
  }

  async function send() {
    if (phase.kind !== 'playing' || guess.trim() === '' || busy) return;
    setBusy(true);
    try {
      const result = await submitGuess(phase.riddle.riddleId, guess.trim());
      onStats({ score: result.score, streak: result.streak });
      if (result.solved) {
        setPhase({ kind: 'solved', result, difficulty: phase.riddle.difficulty });
      } else {
        setVerdict(result);
        setGuess('');
        guessRef.current?.focus();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setNotice('You have already solved this one.');
        setPhase({ kind: 'picking' });
      } else if (err instanceof ApiError && err.planDenied) {
        fail(err.message, err);
      } else {
        setNotice(err instanceof Error ? err.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function useHint() {
    if (phase.kind !== 'playing') return;
    setConfirmHint(false);
    setBusy(true);
    try {
      const result = await takeHint(phase.riddle.riddleId);
      setPhase({
        kind: 'playing',
        riddle: {
          ...phase.riddle,
          hintsTaken: result.hintNumber,
          hintsAvailable: result.hintsRemaining,
          revealedHints: [...phase.riddle.revealedHints, result.hint],
        },
      });
      guessRef.current?.focus();
    } catch (err) {
      if (err instanceof ApiError) {
        fail(err.message, err);
      } else {
        setNotice(err instanceof Error ? err.message : 'Could not take a hint.');
      }
    } finally {
      setBusy(false);
    }
  }

  // --------------------------------------------------------------- rendering

  if (phase.kind === 'solved') {
    return <Solved result={phase.result} onNext={() => void start(phase.difficulty)} />;
  }

  if (phase.kind === 'picking' || phase.kind === 'loading') {
    return (
      <div className="wrap">
        <h1 className="title center" style={{ marginTop: '2rem' }}>
          Pick a riddle
        </h1>
        <p className="center muted small">Hints cost {HINT_PENALTY} points each.</p>

        {notice && (
          <div className="notice" style={{ marginTop: '1.25rem' }}>
            {notice}
            {planDenied && <SeePlans />}
          </div>
        )}

        <div className="difficulty-grid">
          {DIFFICULTIES.map((d) => (
            <button
              key={d}
              className="difficulty"
              onClick={() => void start(d)}
              disabled={phase.kind === 'loading'}
            >
              <span className="difficulty__name">{cap(d)}</span>
              <span className="difficulty__points">{BASE_POINTS[d]} pts</span>
            </button>
          ))}
        </div>

        {phase.kind === 'loading' && (
          <p className="center muted small" style={{ marginTop: '2rem' }}>
            <span className="spinner" /> Finding one you haven&rsquo;t seen…
          </p>
        )}
      </div>
    );
  }

  const { riddle } = phase;
  const worth = Math.max(0, BASE_POINTS[riddle.difficulty] - HINT_PENALTY * riddle.hintsTaken);

  return (
    <div className="wrap">
      <div className="riddle-meta" style={{ marginTop: '1.5rem' }}>
        <span>{riddle.difficulty}</span>
        <span className="dot" />
        <span>{riddle.topic}</span>
        <span className="dot" />
        <span>worth {worth}</span>
      </div>

      <p className="riddle">{riddle.text}</p>

      <div className="guess-row">
        <input
          ref={guessRef}
          type="text"
          value={guess}
          onChange={(e) => setGuess(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
          placeholder="Your answer"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          aria-label="Your answer"
        />
        <button
          className="btn btn--primary"
          onClick={() => void send()}
          disabled={busy || guess.trim() === ''}
        >
          {busy ? <span className="spinner" /> : 'Guess'}
        </button>
      </div>

      {verdict && <Verdict result={verdict} />}
      {notice && (
        <div className="notice" style={{ marginTop: '1rem' }}>
          {notice}
          {planDenied && <SeePlans />}
        </div>
      )}

      {riddle.revealedHints.length > 0 && (
        <div className="hints">
          {riddle.revealedHints.map((hint, i) => (
            <p className="hint" key={i}>
              <span className="hint__n">{i + 1}.</span>
              <span>{hint}</span>
            </p>
          ))}
        </div>
      )}

      <div className="btn-row">
        <button
          className="btn btn--quiet"
          onClick={() => setConfirmHint(true)}
          disabled={busy || riddle.hintsAvailable === 0}
        >
          {riddle.hintsAvailable === 0
            ? 'No hints left'
            : `Hint · −${HINT_PENALTY} pts · ${riddle.hintsAvailable} left`}
        </button>
        <button className="btn btn--text" onClick={() => setPhase({ kind: 'picking' })}>
          Skip
        </button>
      </div>

      {confirmHint && (
        <div
          className="modal-backdrop"
          onClick={() => setConfirmHint(false)}
          role="dialog"
          aria-modal="true"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">Use a hint for {HINT_PENALTY} points?</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              This riddle would then be worth {Math.max(0, worth - HINT_PENALTY)} points.
              You have {riddle.hintsAvailable} hint
              {riddle.hintsAvailable === 1 ? '' : 's'} left on it.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem' }}>
              <button className="btn btn--primary" style={{ flex: 1 }} onClick={() => void useHint()}>
                Use hint
              </button>
              <button className="btn btn--quiet" onClick={() => setConfirmHint(false)}>
                Not yet
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- pieces

function Verdict({ result }: { result: GuessResult }) {
  const tone = result.verdict === 'close' ? 'close' : 'wrong';
  return (
    <div className={`verdict verdict--${tone}`}>
      <span className="verdict__label">
        {result.verdict === 'close' ? 'Close.' : 'Not quite.'}
      </span>
      {result.reason}
    </div>
  );
}

function Solved({ result, onNext }: { result: GuessResult; onNext: () => void }) {
  const [shown, setShown] = useState(0);

  // Count the points up rather than snapping — the one moment worth savouring.
  useEffect(() => {
    if (result.pointsAwarded <= 0) return setShown(0);
    const step = Math.max(1, Math.round(result.pointsAwarded / 18));
    const id = setInterval(() => {
      setShown((n) => {
        if (n + step >= result.pointsAwarded) {
          clearInterval(id);
          return result.pointsAwarded;
        }
        return n + step;
      });
    }, 28);
    return () => clearInterval(id);
  }, [result.pointsAwarded]);

  return (
    <div className="wrap">
      <div className="solved">
        <p className="muted small" style={{ letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Solved
        </p>
        <p className="solved__points">+{shown}</p>
        <p className="solved__answer">{result.answer}</p>
        <p className="muted small" style={{ marginTop: '0.25rem' }}>
          {result.streak > 1
            ? `${result.streak}-day streak · ${result.score} points total`
            : `${result.score} points total`}
        </p>
        <button
          className="btn btn--primary"
          style={{ marginTop: '2rem', minWidth: '12rem' }}
          onClick={onNext}
          autoFocus
        >
          Next riddle
        </button>
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Intercepts an in-app link so it routes rather than reloading the page. */
function link(to: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
  };
}

/** The paywall nudge on a plan DENY: opens the hosted pricing page. */
function SeePlans() {
  return (
    <a
      className="verdict__upgrade"
      href="/upgrade"
      onClick={(e) => {
        e.preventDefault();
        void openHostedPricing().catch(() => alert('Could not open plans — please try again.'));
      }}
    >
      See plans →
    </a>
  );
}
