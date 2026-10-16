import { useState, useEffect } from 'react';

export const useMediaQuery = (query) => {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const h = (e) => setMatches(e.matches);
    mq.addEventListener ? mq.addEventListener('change', h) : mq.addListener(h);
    setMatches(mq.matches);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', h) : mq.removeListener(h); };
  }, [query]);
  return matches;
};
