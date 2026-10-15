'use strict';
/**
 * Enveloppe tous les handlers async d'un routeur Express 4 pour que les
 * promesses rejetées remontent au gestionnaire d'erreurs (sinon la requête
 * ne répond jamais). Appliqué une fois par routeur au montage dans server.js.
 */
const isAsync = (fn) => typeof fn === 'function' && fn.constructor && fn.constructor.name === 'AsyncFunction';

const wrap = (fn) => {
  if (fn.__asyncWrapped) return fn;
  const wrapped = fn.length === 4
    ? (err, req, res, next) => Promise.resolve(fn(err, req, res, next)).catch(next)
    : (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  wrapped.__asyncWrapped = true;
  return wrapped;
};

const wrapRouterAsync = (router, seen = new Set()) => {
  if (!router || !Array.isArray(router.stack) || seen.has(router)) return router;
  seen.add(router);
  for (const layer of router.stack) {
    if (layer.route && Array.isArray(layer.route.stack)) {
      for (const l of layer.route.stack) if (isAsync(l.handle)) l.handle = wrap(l.handle);
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      wrapRouterAsync(layer.handle, seen);            // routeur imbriqué
    } else if (isAsync(layer.handle)) {
      layer.handle = wrap(layer.handle);              // middleware async
    }
  }
  return router;
};

module.exports = { wrapRouterAsync };
