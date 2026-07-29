import { useEffect, useState } from 'react';

/**
 * A very small path router.
 *
 * The app has no routing library yet, and billing needs exactly three real URLs
 * — checkout has to be able to send a player back to one. Rather than pull in a
 * dependency for that, this reads `location.pathname` and re-renders on history
 * changes. Swap it for a real router when the riddle UI needs one.
 *
 * Note for deployment: because these are real paths rather than hashes, static
 * hosting must rewrite unknown paths to index.html (Amplify: add a rewrite of
 * `/<*>` to `/index.html` with status 200), or a refresh on /pricing 404s.
 */

export function navigate(path: string): void {
  if (window.location.pathname + window.location.search === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);

  return path;
}
