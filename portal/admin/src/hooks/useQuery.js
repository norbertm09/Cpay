import { useCallback, useEffect, useRef, useState } from 'react';
import { isForbidden } from '../utils/errors';

// Chargement asynchrone avec états loading / error / data, relance et
// rafraîchissement périodique. `fn` reçoit un AbortSignal-like (flag annulé).
export const useQuery = (fn, deps = [], { enabled = true, interval = 0, keep = false } = {}) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!!enabled);
  const [forbidden, setForbidden] = useState(false);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (silent = false) => {
    if (!enabled) { setLoading(false); return; }
    const id = ++seq.current;
    if (!silent) { setLoading(true); if (!keep) setError(null); }
    try {
      const res = await fnRef.current();
      if (id !== seq.current) return;
      setData(res); setError(null); setForbidden(false);
    } catch (e) {
      if (id !== seq.current) return;
      setError(e); setForbidden(isForbidden(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [enabled, ...deps]);

  useEffect(() => { run(); }, [run]);
  useEffect(() => {
    if (!interval || !enabled) return undefined;
    const t = setInterval(() => run(true), interval);
    return () => clearInterval(t);
  }, [interval, enabled, run]);

  return { data, error, loading, forbidden, reload: () => run(false), refresh: () => run(true), setData };
};

export const useDebounce = (value, delay = 350) => {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), delay); return () => clearTimeout(t); }, [value, delay]);
  return v;
};
