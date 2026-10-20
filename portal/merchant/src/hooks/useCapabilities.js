// Capacités réelles par pays (registre serveur, GET /api/v1/public/capabilities) : lues une seule
// fois par session de page, partagées entre Encaisser / Retirer / Transférer. Sans réponse de
// l'API, aucun moyen n'est bloqué côté client (le serveur refuse de toute façon avec
// 403 CAPABILITY_NOT_ACTIVE) et aucun n'est présenté comme disponible.
import { useEffect, useState } from 'react';
import { capabilitiesApi } from '../services/api';

export const CAPABILITY_UNAVAILABLE_MSG = 'Non disponible dans votre pays pour le moment';
const OPEN = ['active', 'pilot'];
let cache = null; let inflight = null;

const load = () => {
  if (cache) return Promise.resolve(cache);
  if (!inflight) inflight = capabilitiesApi.summary().then(r => { cache = r.data; return cache; }).finally(() => { inflight = null; });
  return inflight;
};

// Statut d'une cellule : opération (collect|withdraw|transfer) × méthode (mobile_money|card|wallet_to_bank|bank_to_wallet|gimac) [× opérateur].
export const capabilityStatus = (caps, country, operation, method, operator) => {
  const c = caps?.countries?.find(x => x.code === String(country || '').toUpperCase());
  if (!c) return null;
  const cell = c.operations?.[operation]?.[method];
  if (!cell) return null;
  if (operator && Array.isArray(cell.operators)) {
    const op = cell.operators.find(o => String(o.operator).toUpperCase() === String(operator).toUpperCase());
    return op ? op.status : 'unavailable';
  }
  return cell.status || null;
};

export const useCapabilities = (country) => {
  const [caps, setCaps] = useState(cache);
  const [state, setState] = useState(cache ? 'ok' : 'loading');
  useEffect(() => {
    let on = true;
    load().then(c => { if (on) { setCaps(c); setState('ok'); } }).catch(() => { if (on) setState('error'); });
    return () => { on = false; };
  }, []);
  const status = (operation, method, operator) => capabilityStatus(caps, country, operation, method, operator);
  // null (inconnu / API indisponible) = non bloquant côté client
  const isOpen = (operation, method, operator) => { const s = status(operation, method, operator); return s === null || OPEN.includes(s); };
  const isPilot = (operation, method, operator) => status(operation, method, operator) === 'pilot';
  const countryInfo = caps?.countries?.find(x => x.code === String(country || '').toUpperCase()) || null;
  return { caps, state, status, isOpen, isPilot, countryInfo, message: CAPABILITY_UNAVAILABLE_MSG };
};
export default useCapabilities;
