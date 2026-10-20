import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newIdempotencyKey } from '../services/api';

const FIELDS = {
  collect: ['amount', 'currency', 'method', 'description', 'reference', 'customerPhone', 'operator'],
  withdraw: ['amount', 'description'],
  transfer: ['direction', 'amount', 'description', 'accountId'],
};
const SAFE_REJECTIONS = ['VALIDATION_ERROR', 'PHONE_INVALID', 'INVALID_PHONE', 'CURRENCY_MISMATCH'];
const STORAGE_ERROR = 'L’enregistrement de l’opération est indisponible. Autorisez le stockage de cet onglet puis réessayez.';
const CONFLICT = 'Reprenez les paramètres de l’opération enregistrée avant de réessayer. Son résultat doit être connu avant une nouvelle opération.';

function businessFields(operation, body) {
  const payload = {};
  for (const field of FIELDS[operation] || []) {
    if (body[field] !== undefined) {
      if (!['string', 'number'].includes(typeof body[field])) throw new Error('Paramètre d’opération invalide.');
      payload[field] = body[field];
    }
  }
  return payload;
}
function read(scope, operation) {
  const raw = window.sessionStorage.getItem(scope);
  if (!raw) return null;
  const entry = JSON.parse(raw);
  if (!entry || typeof entry.key !== 'string' || !entry.key || !entry.payload || typeof entry.known !== 'boolean') throw new Error(STORAGE_ERROR);
  // A whitelist also applies when reading persisted data from an older version.
  return { key: entry.key, payload: businessFields(operation, entry.payload), known: entry.known };
}

// One financial intent per actor/operation/tab. Never clear on unmount or logout:
// the same actor must be able to resume after authenticating again. Other actors
// have separate scopes; a callback held by a closed step-up dialog cannot send.
export function useFinancialIntent(user, operation) {
  const scope = user?.merchantId && user?.userId && FIELDS[operation]
    ? `cpay:financial-intent:v1:${JSON.stringify([user.merchantId, user.userId, operation])}` : null;
  const generationRef = useRef({ scope, version: 0 });
  if (generationRef.current.scope !== scope) {
    generationRef.current = { scope, version: generationRef.current.version + 1 };
  }
  const generation = generationRef.current.version;
  const inFlight = useRef(new Map());
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    scopeRef.current = scope;
    return () => { scopeRef.current = null; };
  }, [scope]);
  const initial = useMemo(() => {
    if (!scope) return { entry: null, error: null };
    try { return { entry: read(scope, operation), error: null }; }
    catch (_) { return { entry: null, error: STORAGE_ERROR }; }
  }, [scope, operation]);
  const [update, setUpdate] = useState(null);
  const state = update?.scope === scope ? update : initial;
  const set = useCallback((entry, error = null) => setUpdate({ scope, entry, error }), [scope]);

  const execute = useCallback(async (body, send) => {
    if (!scope || scopeRef.current !== scope || generationRef.current.version !== generation) throw new Error('La session a changé. Rouvrez cette opération.');
    let entry;
    try {
      const payload = businessFields(operation, body);
      entry = read(scope, operation);
      if (entry && JSON.stringify(entry.payload) !== JSON.stringify(payload)) {
        set(entry, CONFLICT);
        throw new Error(CONFLICT);
      }
      entry = entry || { key: newIdempotencyKey(), payload, known: false };
      // Durability is a prerequisite to sending, including every retry.
      window.sessionStorage.setItem(scope, JSON.stringify(entry));
      set(entry);
    } catch (err) {
      if (err.message === CONFLICT) throw err;
      set(entry || state.entry, STORAGE_ERROR);
      throw new Error(STORAGE_ERROR);
    }
    inFlight.current.set(scope, (inFlight.current.get(scope) || 0) + 1);
    try {
      const response = await send({ ...entry.payload, ...(body.confirm ? { confirm: body.confirm } : {}) }, entry.key);
      const known = { ...entry, known: true };
      let current;
      try { current = read(scope, operation); }
      catch (_) {
        if (scopeRef.current === scope && generationRef.current.version === generation) set(entry, STORAGE_ERROR);
        throw new Error(STORAGE_ERROR);
      }
      if (current?.key !== entry.key) throw new Error('L’opération enregistrée a changé. Rouvrez cette opération.');
      try {
        window.sessionStorage.setItem(scope, JSON.stringify(known));
      }
      catch (_) { if (scopeRef.current === scope && generationRef.current.version === generation) set(entry, STORAGE_ERROR); throw new Error(STORAGE_ERROR); }
      if (scopeRef.current !== scope || generationRef.current.version !== generation) throw new Error('La session a changé. Rouvrez cette opération.');
      set(known);
      return response;
    } catch (err) {
      // Only verified pre-execution validation failures allow business edits.
      // Network, server, conflict and step-up failures always retain the key.
      const data = err?.response?.data;
      const resourceFields = ['txnId', 'transactionId', 'transferId', 'withdrawalId', 'resourceId', 'orderId', 'id', 'reference', 'resource'];
      if ([400, 422].includes(err?.response?.status) && SAFE_REJECTIONS.includes(data?.code)
          && !resourceFields.some(field => data[field] != null)) {
        try {
          const current = read(scope, operation);
          if (current?.key === entry.key && !current.known) {
            window.sessionStorage.removeItem(scope);
            if (scopeRef.current === scope && generationRef.current.version === generation) set(null);
          }
        }
        catch (_) { if (scopeRef.current === scope && generationRef.current.version === generation) set(entry, STORAGE_ERROR); }
      }
      throw err;
    } finally {
      const count = inFlight.current.get(scope) || 0;
      if (count <= 1) inFlight.current.delete(scope);
      else inFlight.current.set(scope, count - 1);
    }
  }, [scope, operation, set, state.entry, generation]);

  const startNew = useCallback(() => {
    if (!scope || scopeRef.current !== scope || generationRef.current.version !== generation) throw new Error('La session a changé.');
    if (inFlight.current.get(scope)) throw new Error('L’opération est en cours. Attendez son résultat avant une nouvelle opération.');
    let entry;
    try { entry = read(scope, operation); }
    catch (_) { set(state.entry, STORAGE_ERROR); throw new Error(STORAGE_ERROR); }
    if (entry && !entry.known) throw new Error(CONFLICT);
    try { window.sessionStorage.removeItem(scope); set(null); }
    catch (_) { set(entry, STORAGE_ERROR); throw new Error(STORAGE_ERROR); }
  }, [scope, operation, set, state.entry, generation]);

  return { execute, startNew, restored: initial.entry?.payload || null, payload: state.entry?.payload || null,
    pending: !!state.entry, canStartNew: !!state.entry?.known, error: state.error };
}
