'use strict';

/**
 * CPlus SDK — JavaScript/Node.js
 * @version 1.0.0
 * @author Calculus Plus <dev@c-pay.global>
 * @link https://c-pay.global/developers
 */

const https = require('https');
const http  = require('http');

class CPlusError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name    = 'CPlusError';
    this.code    = code;
    this.statusCode = statusCode;
  }
}

class CPlusClient {
  /**
   * @param {Object} options
   * @param {string} options.apiKey        - Clé API (sk_live_xxx ou sk_test_xxx)
   * @param {string} [options.baseUrl]     - URL de base (défaut: https://api.c-pay.global/api/v1)
   * @param {number} [options.timeout]     - Timeout en ms (défaut: 30000)
   * @param {string} [options.currency]    - Devise par défaut (défaut: XAF)
   */
  constructor(options = {}) {
    if (!options.apiKey) throw new CPlusError('apiKey est requis', 'MISSING_API_KEY');
    this.apiKey   = options.apiKey;
    this.baseUrl  = options.baseUrl  || 'https://api.c-pay.global/api/v1';
    this.timeout  = options.timeout  || 30000;
    this.currency = options.currency || 'XAF';
    this.sandbox  = options.apiKey.startsWith('sk_test_');
    if (this.sandbox) console.warn('[CPlus SDK] Mode SANDBOX actif — les transactions ne sont pas réelles.');
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
          'User-Agent':   'cplus-sdk-js/1.0.0',
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
              reject(new CPlusError(json.error || 'Erreur API', json.code || 'API_ERROR', res.statusCode));
            } else {
              resolve(json);
            }
          } catch {
            reject(new CPlusError('Réponse invalide du serveur', 'INVALID_RESPONSE', res.statusCode));
          }
        });
      });
      req.on('error', (e) => reject(new CPlusError(e.message, 'NETWORK_ERROR')));
      req.on('timeout', ()  => { req.destroy(); reject(new CPlusError('Timeout', 'TIMEOUT')); });
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
   * const txn = await cplus.collection.momo({
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
        if (!amount || amount < 100) throw new CPlusError('Montant minimum 100 XAF', 'INVALID_AMOUNT');
        if (!customerPhone)          throw new CPlusError('customerPhone requis', 'MISSING_PHONE');
        if (!['airtel_money','mtn_momo'].includes(method)) throw new CPlusError('method doit être airtel_money ou mtn_momo', 'INVALID_METHOD');
        return self._request('POST', '/merchant/public/collect', {
          amount, currency: currency || self.currency,
          customerPhone, method, description, reference
        });
      },

      /**
       * Créer un lien de paiement par carte
       */
      async payLink({ amount, description, psp = 'cybersource', currency, recipientPhone }) {
        if (!amount || amount < 100) throw new CPlusError('Montant minimum 100 XAF', 'INVALID_AMOUNT');
        return self._request('POST', '/merchant/public/pay-links', {
          amount, currency: currency || self.currency,
          description, psp, paymentMethod: 'card', recipientPhone
        });
      },

      /**
       * Encaissement Sans Contact (NFC)
       */
      async contactless({ amount, description, reference, currency }) {
        if (!amount || amount < 100) throw new CPlusError('Montant minimum 100 XAF', 'INVALID_AMOUNT');
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
   * const disb = await cplus.disbursement.momo({
   *   amount: 10000,
   *   recipientPhone: '+242060000001',
   *   operator: 'mtn_momo'
   * });
   */
  get disbursement() {
    const self = this;
    return {
      async momo({ amount, recipientPhone, operator, description, reference, currency }) {
        if (!amount || amount < 500) throw new CPlusError('Montant minimum 500 XAF', 'INVALID_AMOUNT');
        if (!recipientPhone)          throw new CPlusError('recipientPhone requis', 'MISSING_PHONE');
        if (!['airtel_money','mtn_momo'].includes(operator)) throw new CPlusError('operator invalide', 'INVALID_OPERATOR');
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
        if (!txnId) throw new CPlusError('txnId requis', 'MISSING_TXN_ID');
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
   * Vérifier la signature d'un webhook CPlus
   * @param {string} payload         - Corps de la requête (JSON string)
   * @param {string} signature       - Header X-CPlus-Signature
   * @param {string} webhookSecret   - Votre secret webhook
   * @returns {boolean}
   *
   * @example
   * app.post('/webhook', (req, res) => {
   *   const valid = CPlusClient.verifyWebhook(
   *     JSON.stringify(req.body),
   *     req.headers['x-cplus-signature'],
   *     process.env.CPLUS_WEBHOOK_SECRET
   *   );
   *   if (!valid) return res.status(401).end();
   *   // Traiter le paiement...
   * });
   */
  static verifyWebhook(payload, signature, webhookSecret) {
    const crypto = require('crypto');
    const expected = 'sha256=' + crypto
      .createHmac('sha256', webhookSecret)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');
    return signature === expected;
  }
}

module.exports = { CPlusClient, CPlusError };
