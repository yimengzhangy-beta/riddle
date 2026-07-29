import { useState } from 'react';
import { AuthError, PASSWORD_RULES, signIn, signUp } from '../cognito';

/**
 * The way in. One form, two modes — a separate "register" page would double the
 * surface for what is really one decision.
 *
 * On sign-up the password rules are shown as a live checklist rather than as an
 * error after the fact: the pool will reject a weak password, and finding that
 * out on submit is a worse experience than being told up front.
 */
export default function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signingUp = mode === 'up';
  const unmet = PASSWORD_RULES.filter((r) => !r.test(password));
  const canSubmit =
    email.trim() !== '' && password !== '' && (!signingUp || unmet.length === 0) && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (signingUp) await signUp(email.trim(), password);
      else await signIn(email.trim(), password);
      onDone();
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <div className="wrap">
      <div style={{ maxWidth: '22rem', margin: '3rem auto 0' }}>
        <h1 className="title">{signingUp ? 'Make an account' : 'Welcome back'}</h1>
        <p className="muted small" style={{ marginTop: 0 }}>
          {signingUp
            ? 'Your score and streak follow you across devices.'
            : 'Pick up where you left off.'}
        </p>

        <div className="card" style={{ marginTop: '1.5rem' }}>
          <label className="field">
            <span className="field__label">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
            />
          </label>

          <label className="field">
            <span className="field__label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              autoComplete={signingUp ? 'new-password' : 'current-password'}
            />
          </label>

          {signingUp && (
            <ul className="policy">
              {PASSWORD_RULES.map((rule) => (
                <li key={rule.label} data-ok={password !== '' && rule.test(password)}>
                  {rule.label}
                </li>
              ))}
            </ul>
          )}

          {error && <p className="error-text">{error}</p>}

          <button
            className="btn btn--primary btn--block"
            style={{ marginTop: '1.25rem' }}
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {busy ? <span className="spinner" /> : signingUp ? 'Create account' : 'Sign in'}
          </button>
        </div>

        <p className="center small muted" style={{ marginTop: '1.25rem' }}>
          {signingUp ? 'Already have an account?' : 'New here?'}{' '}
          <button
            className="btn btn--text"
            style={{ fontWeight: 600 }}
            onClick={() => {
              setMode(signingUp ? 'in' : 'up');
              setError(null);
            }}
          >
            {signingUp ? 'Sign in' : 'Make one'}
          </button>
        </p>
      </div>
    </div>
  );
}
