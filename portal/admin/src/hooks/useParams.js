import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// État de filtres/onglet synchronisé avec la query string (liens profonds,
// bouton retour). `defaults` fournit les valeurs par défaut.
export const useUrlState = (defaults = {}) => {
  const [sp, setSp] = useSearchParams();
  const get = useCallback((k) => (sp.has(k) ? sp.get(k) : defaults[k] ?? ''), [sp, defaults]);
  const set = useCallback((patch, { replace = true } = {}) => {
    const next = new URLSearchParams(sp);
    Object.entries(patch).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '' || v === defaults[k]) next.delete(k); else next.set(k, String(v));
    });
    setSp(next, { replace });
  }, [sp, setSp, defaults]);
  const page = Math.max(1, parseInt(get('page'), 10) || 1);
  const setPage = (p) => set({ page: p > 1 ? p : '' });
  return { get, set, page, setPage, params: sp };
};
