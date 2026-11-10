'use strict';
/**
 * Identité de route canonique (audit du 10 novembre 2026, § 2 « idempotence et capacité »).
 *
 * Express route sans tenir compte de la casse ni du slash final : `/Withdraw`, `/withdraw/` et `/withdraw`
 * atteignent le même handler. Les contrôles qui comparaient le chemin brut (`idempotency.isMoneyEndpoint`,
 * `capability.mapCashRequest`, clé d'idempotence `METHOD + originalUrl`) voyaient donc trois routes différentes :
 * une variante d'URL contournait l'obligation de clé et la garde de capacité, et la même clé créait un ordre
 * par variante. Toute décision fondée sur le chemin passe désormais par `canonicalPath`.
 */
const canonicalPath = (url) => {
  let p = String(url || '').split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch (_) { /* séquence invalide : chemin brut */ }
  p = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return (p || '/').toLowerCase();
};

/** `METHOD /chemin/canonique` — identité d'une intention (clé d'idempotence, journal). */
const routeIdentity = (req) => `${String(req.method || 'GET').toUpperCase()} ${canonicalPath(req.originalUrl || req.url)}`;

/** Dernier segment canonique (`/collect`, `/withdraw`…). */
const lastSegment = (url) => { const p = canonicalPath(url); return p === '/' ? '' : p.slice(p.lastIndexOf('/') + 1); };

module.exports = { canonicalPath, routeIdentity, lastSegment };
