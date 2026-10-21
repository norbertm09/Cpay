// Résumé de caisse (GET /merchant/cash/summary), partagé par les écrans.
import { cashApi } from '../services/api';
import { useAsync } from './useAsync';
import { useCallback, useEffect, useRef } from 'react';

const REFRESH = 'cpay:cash-summary-refresh';

export const useCashSummary = (deps = []) => {
  const { data, state, error, reload: load } = useAsync(() => cashApi.summary(), deps);
  const source = useRef({});
  useEffect(() => {
    const refresh = event => { if (event.detail !== source.current) load(); };
    window.addEventListener(REFRESH, refresh);
    return () => window.removeEventListener(REFRESH, refresh);
  }, [load]);
  const reload = useCallback(() => {
    const result = load();
    window.dispatchEvent(new CustomEvent(REFRESH, { detail: source.current }));
    return result;
  }, [load]);
  return { summary: data, state, error, reload };
};
