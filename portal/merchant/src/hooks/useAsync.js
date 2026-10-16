// Chargement d'une ressource avec états loading / ok / error / unavailable et
// relance. `load` renvoie une promesse axios ; `deps` relance le chargement.
import { useState, useEffect, useCallback, useRef } from 'react';
import { isFeatureUnavailable } from '../services/api';

export const useAsync = (load, deps = [], { enabled = true, initial = null } = {}) => {
  const [data, setData] = useState(initial);
  const [state, setState] = useState(enabled ? 'loading' : 'idle');
  const [error, setError] = useState(null);
  const seq = useRef(0);
  const run = useCallback(() => {
    const id = ++seq.current;
    setState('loading'); setError(null);
    return Promise.resolve()
      .then(load)
      .then(r => { if (id !== seq.current) return; setData(r?.data ?? r); setState('ok'); })
      .catch(err => { if (id !== seq.current) return; setError(err); setState(isFeatureUnavailable(err) ? 'unavailable' : 'error'); });
  }, deps);
  useEffect(() => { if (enabled) run(); }, [run, enabled]);
  return { data, state, error, reload: run, setData };
};
