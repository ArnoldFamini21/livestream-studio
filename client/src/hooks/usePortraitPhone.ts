import { useEffect, useState } from 'react';

const PORTRAIT_PHONE_QUERY = '(max-width: 760px) and (orientation: portrait)';

/** True on a phone held upright, where a 16:9 stage would be tiny. */
export function useIsPortraitPhone(): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(PORTRAIT_PHONE_QUERY).matches
      : false
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(PORTRAIT_PHONE_QUERY);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return matches;
}
