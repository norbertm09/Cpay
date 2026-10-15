'use strict';

/**
 * C-Pay SDK — JavaScript/Node.js
 * @version 1.1.0
 * @author Calculus Plus SAS <dev@c-pay.global>
 * @link https://c-pay.global/developers
 *
 * Compatibilite : les anciens noms `CPlusClient` / `CPlusError` restent
 * exportes comme alias de `CPayClient` / `CPayError`.
 */

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const SDK_VERSION = '1.1.0';
const DEFAULT_BASE_URL = 'https://api.c-pay.global/api/v1';

// En-tetes de signature des webhooks, par ordre de preference. Le backend
// envoie les deux pendant la periode de transition.
const SIGNATURE_HEADERS = ['x-cpay-signature', 'x-cplus-signature'];

class CPayError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name    = 'CPayError';
    this.code    = code;
    this.statusCode = statusCode;
  }
}

class CPayClient {
  /**
   * @param {Object} options
   * @param {string} options.apiKey        - Clé API (sk_live_xxx ou sk_test_xxx)
   * @param {string} [options.baseUrl]     - URL de base (défaut: https://api.c-pay.global/api/v1)
   * @param {number} [options.timeout]     - Timeout en ms (défaut: 30000)
   * @param {string} [options.currency]    - Devise par défaut (défaut: XAF)
   */
  constructor(options = {}) {
    if (!options.apiKey) throw new CPayError('apiKey est requis', 'MISSING_API_KEY');
    this.apiKey   = options.apiKey;
    this.baseUrl  = options.baseUrl  || DEFAULT_BASE_URL;
    this.timeout  = options.timeout  || 30000;
    this.currency = options.currency || 'XAF';
    this.sandbox  = options.apiKey.startsWith('sk_test_');
    if (this.sandbox) console.warn('[C-Pay SDK] Mode SANDBOX actif — les transactions ne sont pas réelles.');
  }

  /**
   * Requête HTTP interne
   */
  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url    = new URL(this.baseUrl + path);
      const isHttp = url.protocol === 'http:';
      const lib    = isHttp ? http : https;
      const payload = body ? JSON.stringify(body) : null;

      const options = {
        hostname: url.hostname,
        port:     url.port || (isHttp ? 80 : 443),
        path:     url.pathname + url.search,
        method,
        headers:  {
          'X-API-Key':    this.apiKey,
          'Content-Type': 'application/json',
          'Accept':       'application/json',
          'User-Agent':   `cpay-sdk-js/${SDK_VERSION}`,
        },
        timeout: this.timeout,
      };
      if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new CPayError(json.error || 'Erreur API', json.code || 'API_ERROR', res.statusCode));
            } else {
              resolve(json);
            }
          } catch {
            reject(new CPayError('Réponse invalide du serveur', 'INVALID_RESPONSE', res.statusCode));
          }
        });
      });
      req.on('error', (e) => reject(new CPayError(e.message, 'NETWORK_ERROR')));
      req.on('timeout', ()  => { req.destroy(); reject(new CPayError('Timeout', 'TIMEOUT')); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ─── COLLECTION ───────────────────────────────────────────────

  /**
   * Initier un encaissement Mobile Money
   * @param {Object} params
   * @param {number} params.amount         - Montant en XAF (min 100)
   * @param {string} params.customerPhone  - Numéro du client (+242XXXXXXXXX)
   * @param {string} params.method         - 'airtel_money' | 'mtn_momo'
   * @param {string} [params.description]  - Description de la transaction
   * @param {string} [params.reference]    - Référence de votre système
   * @param {string} [params.currency]     - Devise (défaut: XAF)
   * @returns {Promise<{txnId, status, reference}>}
   *
   * @example
   * const txn = await cpay.collection.momo({
   *   amount: 5000,
   *   customerPhone: '+242060000001',
   *   method: 'airtel_money',
   *   reference: 'CMD-001'
   * });
   */
  get collection() {
    const self = this;
    return {
      /**
       * Encaissement Mobile Money (Airtel Money ou MTN MoMo)
       */
      async momo({ amount, customerPhone, method, description, reference, currency }) {
        if (!amount || amount < 100) throw new CPayError('Montant minimum 100 XAF', 'INVALID_AMOUNT');
        if (!customerPhone)          throw new CPayError('customerPhone requis', 'MISSING_PHONE');
        if (!['airtel_money','mtn_momo'].includes(method)) throw new CPayError('method doit être airtel_money ou mtn_momo', 'INVALID_METHOD');
        return self._request('POST', '/merchant/public/collect', {
          amount, currency: currency || self.currency,
          customerPhone, method, description, reference
        });
      },

      /**
       * Créer un lien de paiement par carte
       */
      async payLink({ amount, description, psp = 'cybersource', currency, recipientPhone }) {
        if (!amount || amount < 100) throw new CPayError('Montant minimum 100 XAF', 'INVALID_AMOUNT');
        return self._request('POST', '/merchant/public/pay-links', {
          amount, currency: currency || self.currency,
          description, psp, paymentMethod: 'card', recipientPhone
        });
      },

      /**
       * Encaissement Sans Contact (NFC)
       */
      async contactless({ amount, description, reference, currency }) {
        if (!amount || amount < 100) throw new CPayError('Montant minimum 100 XAF', 'INVALID_AMOUNT');
        return self._request('POST', '/merchant/collect/contactless', {
          amount, currency: currency || self.currency, description, reference
        });
      }
    };
  }

  // ─── DISBURSEMENT ─────────────────────────────────────────────

  /**
   * Décaissement Mobile Money
   * @param {Object} params
   * @param {number} params.amount         - Montant en XAF (min 500)
   * @param {string} params.recipientPhone - Numéro du bénéficiaire (+242XXXXXXXXX)
   * @param {string} params.operator       - 'airtel_money' | 'mtn_momo'
   * @param {string} [params.description]
   * @param {string} [params.reference]
   *
   * @example
   * const disb = await cpay.disbursement.momo({
   *   amount: 10000,
   *   recipientPhone: '+242060000001',
   *   operator: 'mtn_momo'
   * });
   */
  get disbursement() {
    const self = this;
    return {
      async momo({ amount, recipientPhone, operator, description, reference, currency }) {
        if (!amount || amount < 500) throw new CPayError('Montant minimum 500 XAF', 'INVALID_AMOUNT');
        if (!recipientPhone)          throw new CPayError('recipientPhone requis', 'MISSING_PHONE');
        if (!['airtel_money','mtn_momo'].includes(operator)) throw new CPayError('operator invalide', 'INVALID_OPERATOR');
        return self._request('POST', '/merchant/disburse', {
          amount, currency: currency || self.currency,
          recipientPhone, operator, description, reference
        });
      }
    };
  }

  // ─── TRANSACTIONS ─────────────────────────────────────────────

  get transactions() {
    const self = this;
    return {
      /**
       * Lister les transactions
       * @param {Object} [params]
       * @param {number} [params.page=1]
       * @param {number} [params.limit=20]
       * @param {string} [params.status]   - 'pending' | 'authorized' | 'failed'
       * @param {string} [params.type]     - 'collect' | 'disburse'
       */
      async list({ page = 1, limit = 20, status, type } = {}) {
        const qs = new URLSearchParams({ page, limit });
        if (status) qs.set('status', status);
        if (type)   qs.set('type', type);
        return self._request('GET', `/merchant/public/transactions?${qs}`);
      },

      /**
       * Obtenir une transaction par ID
       */
      async get(txnId) {
        if (!txnId) throw new CPayError('txnId requis', 'MISSING_TXN_ID');
        return self._request('GET', `/merchant/transactions/${txnId}`);
      }
    };
  }

  // ─── PAY LINKS ────────────────────────────────────────────────

  get payLinks() {
    const self = this;
    return {
      async list({ page = 1, limit = 20, status } = {}) {
        const qs = new URLSearchParams({ page, limit });
        if (status) qs.set('status', status);
        return self._request('GET', `/merchant/pay-links?${qs}`);
      },
      async create(params) { return self.collection.payLink(params); },
      async cancel(payLinkId) {
        return self._request('DELETE', `/merchant/pay-links/${payLinkId}`);
      }
    };
  }

  // ─── WEBHOOKS ─────────────────────────────────────────────────

  /**
   * Extraire la signature d'un webhook depuis les en-têtes de la requête.
   * `X-CPay-Signature` est lu en premier, puis `X-CPlus-Signature` (ancien
   * nom, encore envoyé pendant la transition).
   * @param {Object} headers  - req.headers (Node/Express), clés insensibles à la casse
   * @returns {string|null}
   */
  static signatureFromHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null;
    const lower = {};
    for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
    for (const name of SIGNATURE_HEADERS) {
      const v = lower[name];
      if (v) return Array.isArray(v) ? v[0] : String(v);
    }
    return null;
  }

  /**
   * Vérifier la signature d'un webhook C-Pay (HMAC-SHA256, comparaison à
   * temps constant).
   * @param {string|Object} payload   - Corps brut de la requête (JSON string de préférence)
   * @param {string|Object} signature - Valeur de l'en-tête X-CPay-Signature, ou l'objet
   *                                    req.headers (la bonne clé est alors choisie)
   * @param {string} webhookSecret    - Votre secret webhook
   * @returns {boolean}
   *
   * @example
   * app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
   *   const valid = CPayClient.verifyWebhook(req.body, req.headers, process.env.CPAY_WEBHOOK_SECRET);
   *   if (!valid) return res.status(401).end();
   *   // Traiter le paiement...
   * });
   */
  static verifyWebhook(payload, signature, webhookSecret) {
    if (!webhookSecret) return false;
    const sig = (signature && typeof signature === 'object') ? CPayClient.signatureFromHeaders(signature) : signature;
    if (!sig || typeof sig !== 'string') return false;
    const raw = Buffer.isBuffer(payload) ? payload
      : (typeof payload === 'string' ? payload : JSON.stringify(payload));
    const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

module.exports = {
  CPayClient, CPayError,
  // Alias de compatibilite (SDK 1.0.x)
  CPlusClient: CPayClient, CPlusError: CPayError,
  SIGNATURE_HEADERS,
};
