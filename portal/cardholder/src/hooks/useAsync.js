import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Chargement declaratif : { data, loading, error, reload, setData }.
 * `fn` est appele au montage et a chaque changement de `deps`.
 */
export const useAsync = (fn, deps = [], { enabled = true, initial = null } = {}) => {
  const [state, setState] = useState({ data: initial, loading: enabled, error: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const run = useCallback(async () => {
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current();
      if (id === seq.current) setState({ data, loading: false, error: null });
      return data;
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, loading: false, error }));
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (!enabled) { setState((s) => ({ ...s, loading: false })); return; }
    run();
  }, [enabled, run, ...deps]);

  const setData = useCallback((updater) => setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater })), []);
  return { ...state, reload: run, setData };
};
