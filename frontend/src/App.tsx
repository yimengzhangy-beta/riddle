import { useCallback, useEffect, useRef, useState } from 'react';
import { getMe } from './api';
import { currentEmail, isSignedIn, signOut } from './cognito';
import Activating from './pages/Activating';
import Auth from './pages/Auth';
import Play from './pages/Play';
import Pricing from './pages/Pricing';
import Subscription from './pages/Subscription';
import { navigate, usePath } from './router';

interface Stats {
  score: number;
  streak: number;
}

/** Routes a signed-out visitor can still reach. Pricing has to be one of them. */
const PUBLIC_PATHS = ['/pricing', '/pricing/activating'];

export default function App() {
  const path = usePath();
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [stats, setStats] = useState<Stats | null>(null);

  const loadStats = useCallback(async () => {
    if (!isSignedIn()) return;
    try {
      const me = await getMe();
      setStats({ score: me.score, streak: me.streak });
    } catch {
      // A failed /me shouldn't block play — the header just stays quiet, and the
      // next guess response carries fresh totals anyway.
    }
  }, []);

  useEffect(() => {
    if (signedIn) void loadStats();
    else setStats(null);
  }, [signedIn, loadStats]);

  function leave() {
    signOut();
    setSignedIn(false);
    navigate('/');
  }

  const needsAuth = !PUBLIC_PATHS.includes(path);

  return (
    <div className="shell">
      <Header
        signedIn={signedIn}
        stats={stats}
        path={path}
        onSignOut={leave}
      />
      <main>
        {!signedIn && needsAuth ? (
          <Auth onDone={() => setSignedIn(true)} />
        ) : path === '/pricing' ? (
          <Pricing />
        ) : path === '/pricing/activating' ? (
          <Activating />
        ) : path === '/subscription' ? (
          <Subscription onSignOut={leave} />
        ) : (
          <Play onStats={setStats} />
        )}
      </main>
    </div>
  );
}

function Header({
  signedIn,
  stats,
  path,
  onSignOut,
}: {
  signedIn: boolean;
  stats: Stats | null;
  path: string;
  onSignOut: () => void;
}) {
  // Nudge the score when it changes, so points landing in the header is felt.
  const [bump, setBump] = useState(false);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    if (stats == null) return;
    if (previous.current !== null && stats.score !== previous.current) {
      setBump(true);
      const id = setTimeout(() => setBump(false), 700);
      previous.current = stats.score;
      return () => clearTimeout(id);
    }
    previous.current = stats.score;
  }, [stats]);

  const go = (to: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
  };

  return (
    <header className="header">
      <div className="wrap wrap--wide header__inner">
        <a className="brand" href="/" onClick={go('/')}>
          Riddle
        </a>

        {signedIn && stats && (
          <div className="stats" aria-live="polite">
            <span className="stat">
              <span
                className={`stat__value stat__value--accent${bump ? ' stat__value--bump' : ''}`}
              >
                {stats.score}
              </span>
              <span className="stat__label">points</span>
            </span>
            {stats.streak > 0 && (
              <span className="stat">
                <span className="stat__value">{stats.streak}</span>
                <span className="stat__label">day streak</span>
              </span>
            )}
          </div>
        )}

        <nav className="nav">
          {signedIn && (
            <a href="/" onClick={go('/')} data-active={path === '/'}>
              Play
            </a>
          )}
          <a href="/pricing" onClick={go('/pricing')} data-active={path === '/pricing'}>
            Plans
          </a>
          {signedIn && (
            <>
              <a
                href="/subscription"
                onClick={go('/subscription')}
                data-active={path === '/subscription'}
                title={currentEmail() ?? undefined}
              >
                Account
              </a>
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  onSignOut();
                }}
              >
                Sign out
              </a>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
