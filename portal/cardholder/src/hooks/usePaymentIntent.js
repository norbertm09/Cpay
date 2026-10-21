import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_ERROR = 'L’enregistrement du paiement est indisponible. Autorisez le stockage de cet onglet puis réessayez.';
const CONFLICT = 'Reprenez le paiement enregistré avant de créer une nouvelle opération.';
const SAFE_REFUSALS = ['VALIDATION_ERROR', 'MERCHANT_INACTIVE', 'CARD_NOT_FOUND', 'CARD_INACTIVE', 'CURRENCY_MISMATCH', 'INVALID_PIN', 'INSUFFICIENT_BALANCE', 'LIMIT_EXCEEDED'];
function payloadOf(body) {
  if (!body || typeof body.merchantId !== 'string' || !body.merchantId || typeof body.amount !== 'number'
    || !Number.isFinite(body.amount) || body.amount <= 0 || (body.description !== undefined && typeof body.description !== 'string')) throw new Error('Paramètres de paiement invalides.');
  return { merchantId: body.merchantId, amount: body.amount, ...(body.description ? { description: body.description } : {}) };
}
function read(scope) {
  const raw = sessionStorage.getItem(scope);
  if (raw === null) return null;
  const data = JSON.parse(raw);
  if (data?.version !== 1 || typeof data.key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(data.key) || typeof data.known !== 'boolean') throw new Error(STORAGE_ERROR);
  return { version: 1, key: data.key, payload: payloadOf(data.payload), known: data.known };
}
function newKey() {
  if (!window.crypto?.getRandomValues) throw new Error('Un navigateur sécurisé est requis pour enregistrer le paiement.');
  if (window.crypto.randomUUID) return window.crypto.randomUUID();
  return Array.from(window.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}
export function usePaymentIntent({ cardholderId, cardId, currency }) {
  const scope = cardholderId && cardId && currency ? `cpay:cardholder-payment-intent:v1:${JSON.stringify([cardholderId, cardId, currency])}` : null;
  const identity = useRef({ scope, generation: 0 });
  if (identity.current.scope !== scope) identity.current = { scope, generation: identity.current.generation + 1 };
  const generation = identity.current.generation;
  const alive = useRef(scope);
  alive.current = scope;
  useEffect(() => { alive.current = scope; return () => { alive.current = null; }; }, [scope]);
  const active = useRef(new Set());
  const initial = useMemo(() => {
    if (!scope) return { entry: null, error: 'Carte ou session indisponible.' };
    try { return { entry: read(scope), error: null }; } catch (_) { return { entry: null, error: STORAGE_ERROR }; }
  }, [scope]);
  const [update, setUpdate] = useState(null);
  const state = update?.scope === scope ? update : initial;
  const current = useCallback(() => scope && alive.current === scope && identity.current.generation === generation, [scope, generation]);
  const set = useCallback((entry, error = null) => { if (current()) setUpdate({ scope, entry, error }); }, [scope, current]);
  const execute = useCallback(async (body, send) => {
    if (!current()) throw new Error('La session a changé. Rouvrez le paiement.');
    if (active.current.has(scope)) throw new Error('Paiement en cours. Attendez son résultat.');
    let entry;
    const payload = payloadOf(body);
    try { entry = read(scope); } catch (_) { set(state.entry, STORAGE_ERROR); throw new Error(STORAGE_ERROR); }
    if (entry && JSON.stringify(entry.payload) !== JSON.stringify(payload)) { set(entry, CONFLICT); throw new Error(CONFLICT); }
    entry = entry || { version: 1, key: newKey(), payload, known: false };
    // A previous refusal says nothing about the outcome of this new attempt.
    entry = { ...entry, known: false };
    try { sessionStorage.setItem(scope, JSON.stringify(entry)); } catch (_) { set(entry, STORAGE_ERROR); throw new Error(STORAGE_ERROR); }
    set(entry);
    active.current.add(scope);
    try {
      const result = await send({ ...payload, idempotencyKey: entry.key });
      if (!current()) throw new Error('La session a changé. Reprenez ce paiement dans sa session d’origine.');
      const known = { ...entry, known: true };
      try { sessionStorage.setItem(scope, JSON.stringify(known)); } catch (_) { throw new Error(STORAGE_ERROR); }
      set(known);
      return result;
    } catch (err) {
      if (current() && [400, 404, 422].includes(err?.response?.status) && SAFE_REFUSALS.includes(err?.response?.data?.code)) {
        const known = { ...entry, known: true };
        try { sessionStorage.setItem(scope, JSON.stringify(known)); set(known); } catch (_) { set(entry, STORAGE_ERROR); }
      }
      throw err;
    } finally { active.current.delete(scope); }
  }, [scope, current, set, state.entry]);
  const startNew = useCallback(() => {
    if (!current()) throw new Error('La session a changé.');
    if (active.current.has(scope)) throw new Error('Paiement en cours.');
    let entry;
    try { entry = read(scope); } catch (_) { set(state.entry, STORAGE_ERROR); throw new Error(STORAGE_ERROR); }
    if (entry && !entry.known) throw new Error(CONFLICT);
    try { sessionStorage.removeItem(scope); set(null); } catch (_) { throw new Error(STORAGE_ERROR); }
  }, [scope, current, set, state.entry]);
  return { execute, startNew, restored: initial.entry?.payload || null, payload: state.entry?.payload || null,
    pending: !!state.entry, canStartNew: !!state.entry?.known, error: state.error };
}
