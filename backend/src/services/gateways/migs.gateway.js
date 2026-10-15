/**
 * MIGS — Mastercard Internet Gateway Service — CPlus 2.6.0
 *
 * MIGS est l'ancienne plateforme Mastercard utilisée principalement
 * par les banques ANZ, CommerzBank, et plusieurs banques africaines.
 * Il est distinct de MPGS (la nouvelle plateforme REST).
 *
 * Deux protocoles :
 *   - MIGS Server Hosted (redirect)  :  form POST avec hash MD5 via vpc_
 *   - MIGS Direct                    :  POST JSON (si la banque a cette option)
 *
 * Auth     : MD5 hash de la chaîne de query triée + secure hash secret
 * Hôte     : selon la banque — ex: migs.mastercard.com.au
 *
 * Opérations :
 *   processPayment   →  Purchase (alias card.router)
 *   purchase         →  vpc_Command=pay
 *   authorizeOnly    →  vpc_Command=authorise
 *   capture          →  vpc_Command=capture
 *   refund           →  vpc_Command=refund
 *   queryStatus      →  vpc_Command=queryDR
 *   ping             →  queryDR avec une ref factice
 */
'use strict';

const https  = require('https');
const crypto = require('crypto');
const logger = require('../../config/logger');

// ─── Config dynamique ─────────────────────────────────────────────
const cfg = () => ({
  host:         process.env.MIGS_HOST         || 'migs.mastercard.com.au',
  path:         process.env.MIGS_PATH         || '/vpcpay',
  merchantId:   process.env.MIGS_MERCHANT_ID,
  accessCode:   process.env.MIGS_ACCESS_CODE,
  secureHash:   process.env.MIGS_SECURE_HASH,  // 128-char hex ou autre selon config banque
  hashType:     process.env.MIGS_HASH_TYPE     || 'MD5',  // MD5 ou SHA256 selon la banque
  version:      process.env.MIGS_VERSION       || '1',
  locale:       process.env.MIGS_LOCALE        || 'fr',
  timeoutMs:    parseInt(process.env.MIGS_TIMEOUT_MS || '20000'),
});

// ─── Calcul du secure hash MIGS ──────────────────────────────────
//
// Algorithme :
//   1. Trier toutes les paires vpc_ par clé (ordre alphabétique, insensible à la casse non)
//   2. Concaténer les valeurs séparées par '&' : key1=val1&key2=val2...
//   3. HMAC-SHA256 (ou MD5 selon config banque) de la string avec le secureHash
//
const computeSecureHash = (params, secret) => {
  const hashType = cfg().hashType;

  // Trier les clés alphabétiquement (VPC standard)
  const sorted = Object.keys(params)
    .filter(k => k !== 'vpc_SecureHash' && k !== 'vpc_SecureHashType')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');

  if (hashType === 'SHA256') {
    return crypto
      .createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(sorted, 'utf8')
      .digest('hex')
      .toUpperCase();
  }
  // MD5 legacy
  return crypto
    .createHmac('md5', secret)
    .update(sorted, 'utf8')
    .digest('hex')
    .toUpperCase();
};

// ─── Vérifier le hash de la réponse ──────────────────────────────
const verifyResponseHash = (params, secret) => {
  const received = params.vpc_SecureHash;
  if (!received) return false;
  const computed = computeSecureHash(params, secret);
  return crypto.timingSafeEqual(
    Buffer.from(computed.toUpperCase()),
    Buffer.from(received.toUpperCase()),
  );
};

// ─── HTTP client MIGS ─────────────────────────────────────────────
const migsRequest = async (params, retries = 2) => {
  const c = cfg();

  // Ajouter le hash
  params.vpc_SecureHashType = c.hashType;
  params.vpc_SecureHash     = computeSecureHash(params, c.secureHash);

  const payload = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const headers = {
    'Content-Type':   'application/x-www-form-urlencoded',
    'Content-Length': String(Buffer.byteLength(payload)),
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.request(
          { hostname: c.host, port: 443, path: c.path, method: 'POST', headers, timeout: c.timeoutMs },
          (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              // MIGS répond en query string : vpc_TxnResponseCode=0&vpc_Message=Approved...
              const parsed = {};
              data.split('&').forEach(pair => {
                const [k, v] = pair.split('=').map(decodeURIComponent);
                if (k) parsed[k] = v;
              });
              resolve({ status: res.statusCode, body: parsed, raw: data });
            });
          }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error(`MIGS timeout (${c.timeoutMs}ms)`)); });
        req.on('error',   reject);
        req.write(payload);
        req.end();
      });

      // Vérifier le hash de la réponse
      if (result.body.vpc_SecureHash) {
        const valid = verifyResponseHash(result.body, c.secureHash);
        if (!valid) {
          logger.error('MIGS: invalid response signature — possible tamper');
          return { status: 0, body: { vpc_TxnResponseCode: '7', vpc_Message: 'Invalid signature' } };
        }
      }

      if (result.status >= 500 && attempt < retries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      return result;

    } catch (err) {
      if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
      throw err;
    }
  }
};

// ─── Paramètres de base ───────────────────────────────────────────
const baseParams = (txnId) => {
  const c = cfg();
  return {
    vpc_Version:     c.version,
    vpc_Merchant:    c.merchantId,
    vpc_AccessCode:  c.accessCode,
    vpc_MerchTxnRef: txnId,
    vpc_Locale:      c.locale,
  };
};

// ─── PURCHASE (autorisation + capture immédiate) ─────────────────
const purchase = async ({ txnId, amount, currency, cardData, description }) => {
  const c = cfg();
  logger.info('MIGS PURCHASE', { txnId, amount, currency });

  const amountMinor = Math.round(amount * 100).toString();

  try {
    const { body } = await migsRequest({
      ...baseParams(txnId),
      vpc_Command:     'pay',
      vpc_Amount:      amountMinor,
      vpc_Currency:    currency,
      vpc_OrderInfo:   description || txnId,
      // Données carte — MIGS accepte le PAN/CVV côté serveur (PCI P2PE requis)
      // En mode SoftPOS, cardData = cryptogramme EMV
      ...(cardData ? {
        vpc_CardNum:        cardData.pan          || '',
        vpc_CardExp:        cardData.expiry        || '',
        vpc_CardSecurityCode: cardData.cvv         || '',
        vpc_CardNum:        cardData.encryptedData || cardData.pan || '',
      } : {}),
    });

    return mapResponse(body, txnId);
  } catch (err) {
    logger.error('MIGS PURCHASE failed', { txnId, err: err.message });
    return networkError();
  }
};

// ─── AUTHORIZE ONLY ───────────────────────────────────────────────
const authorizeOnly = async ({ txnId, amount, currency, cardData, description }) => {
  logger.info('MIGS AUTHORIZE', { txnId, amount, currency });
  try {
    const { body } = await migsRequest({
      ...baseParams(txnId),
      vpc_Command:   'authorise',
      vpc_Amount:    Math.round(amount * 100).toString(),
      vpc_Currency:  currency,
      vpc_OrderInfo: description || txnId,
      ...(cardData ? { vpc_CardNum: cardData.encryptedData || cardData.pan || '' } : {}),
    });
    return mapResponse(body, txnId);
  } catch (err) { return networkError(); }
};

// ─── CAPTURE ──────────────────────────────────────────────────────
const capture = async ({ txnId, migsTransactionNo, amount, currency }) => {
  if (!migsTransactionNo) return { approved: false, responseCode: '05', message: 'vpc_TransactionNo requis' };
  logger.info('MIGS CAPTURE', { txnId, migsTransactionNo });
  try {
    const { body } = await migsRequest({
      ...baseParams(`CAP-${txnId}`),
      vpc_Command:       'capture',
      vpc_Amount:        Math.round(amount * 100).toString(),
      vpc_Currency:      currency,
      vpc_TransactionNo: migsTransactionNo,
    });
    const ok = body.vpc_TxnResponseCode === '0';
    return { approved: ok, responseCode: body.vpc_TxnResponseCode, message: body.vpc_Message };
  } catch (err) { return networkError(); }
};

// ─── REFUND ───────────────────────────────────────────────────────
const refund = async ({ txnId, migsTransactionNo, amount, currency }) => {
  if (!migsTransactionNo) return { approved: false, responseCode: '05', message: 'vpc_TransactionNo requis' };
  logger.info('MIGS REFUND', { txnId, migsTransactionNo, amount });
  try {
    const { body } = await migsRequest({
      ...baseParams(`REF-${txnId}`),
      vpc_Command:       'refund',
      vpc_Amount:        Math.round(amount * 100).toString(),
      vpc_Currency:      currency,
      vpc_TransactionNo: migsTransactionNo,
    });
    const ok = body.vpc_TxnResponseCode === '0';
    return { approved: ok, responseCode: body.vpc_TxnResponseCode, message: body.vpc_Message };
  } catch (err) { return networkError(); }
};

// ─── VOID ─────────────────────────────────────────────────────────
const voidAuth = async ({ txnId, migsTransactionNo }) => {
  if (!migsTransactionNo) return { approved: false, responseCode: '05' };
  logger.info('MIGS VOID', { txnId, migsTransactionNo });
  try {
    const { body } = await migsRequest({
      ...baseParams(`VOID-${txnId}`),
      vpc_Command:       'voidAuthorisation',
      vpc_TransactionNo: migsTransactionNo,
    });
    return { approved: body.vpc_TxnResponseCode === '0', responseCode: body.vpc_TxnResponseCode };
  } catch (err) { return networkError(); }
};

// ─── QUERY STATUS ─────────────────────────────────────────────────
const queryStatus = async ({ txnId }) => {
  logger.info('MIGS queryDR', { txnId });
  try {
    const { body } = await migsRequest({
      ...baseParams(txnId),
      vpc_Command: 'queryDR',
      vpc_User:    process.env.MIGS_QUERY_USER     || '',
      vpc_Password: process.env.MIGS_QUERY_PASSWORD || '',
    });
    return {
      found:          body.vpc_TxnResponseCode !== undefined,
      responseCode:   body.vpc_TxnResponseCode,
      message:        body.vpc_Message,
      transactionNo:  body.vpc_TransactionNo,
      authCode:       body.vpc_AuthorisationCode,
      amount:         body.vpc_Amount ? parseInt(body.vpc_Amount) / 100 : null,
    };
  } catch (err) { return { found: false }; }
};

// ─── PING ─────────────────────────────────────────────────────────
const ping = async () => {
  if (!cfg().merchantId) return { ok: false, reason: 'not_configured' };
  try {
    // queryDR avec une ref improbable — si le serveur répond, il est up
    const r = await queryStatus({ txnId: 'PING_' + Date.now() });
    return { ok: true }; // on reçoit une réponse = serveur disponible
  } catch (err) { return { ok: false, reason: err.message }; }
};

// ─── Alias card.router ────────────────────────────────────────────
const processPayment = async ({ txnId, amount, currency, emvPayload, network, type, deviceId }) =>
  purchase({ txnId, amount, currency, cardData: { encryptedData: emvPayload } });

// ─── Response mapper ──────────────────────────────────────────────
const mapResponse = (body, txnId) => {
  // vpc_TxnResponseCode === '0' = approuvé
  // Autres codes = refus ou erreur
  const approved  = body.vpc_TxnResponseCode === '0';
  const respCode  = MIGS_CODE_MAP[body.vpc_TxnResponseCode] || body.vpc_TxnResponseCode || '05';

  return {
    approved,
    responseCode:    respCode,
    message:         body.vpc_Message || 'UNKNOWN',
    authCode:        body.vpc_AuthorisationCode  || null,
    rrn:             body.vpc_ReceiptNo          || null,
    maskedPan:       body.vpc_Card               || null,
    cardScheme:      null,
    gatewayRef:      body.vpc_TransactionNo      || null,
    migsTransactionNo: body.vpc_TransactionNo    || null,
    declineCategory: approved ? null : MIGS_DECLINE_CATEGORY[body.vpc_TxnResponseCode],
    retryable:       ['5', '6', '96'].includes(body.vpc_TxnResponseCode),
    balanceCheck:    body.vpc_TxnResponseCode === 'N' ? 'insufficient' : 'not_checked',
  };
};

// vpc_TxnResponseCode → ISO 8583 code
const MIGS_CODE_MAP = {
  '0':  '00', // Approved
  '1':  '05', // Bank declined
  '2':  '05', // Bank declined (CSC mismatch)
  '3':  '05', // No reply from bank
  '4':  '54', // Expired card
  '5':  '96', // Insufficient funds — NOTE: MIGS '5' = "Insufficient credit"
  '6':  '91', // Communication error
  '7':  '96', // Payment server system error
  '8':  '12', // Transaction type not supported
  '9':  '04', // Bank declined (fraud)
  'A':  '51', // Transaction aborted
  'B':  '05', // Card security check failed
  'C':  '14', // Invalid card number
  'D':  '05', // Declined (card acceptor)
  'E':  '54', // Expired card (exact)
  'F':  '41', // Card reported as lost
  'I':  '05', // Invalid card
  'N':  '51', // Cardholder is not enrolled
  'P':  '96', // Transaction has been voided
  'Q':  '14', // Invalid transaction
  'R':  '62', // Transaction not permitted
  'S':  '43', // Duplicate order ID
  'T':  '13', // Address verification failed
  'U':  '96', // Card security code failed
  'V':  '96', // Address Verification not supported
};

const MIGS_DECLINE_CATEGORY = {
  '5':  'insufficient_funds',
  'N':  'insufficient_funds',
  '4':  'card_expired',
  'E':  'card_expired',
  'F':  'card_blocked',
  '9':  'fraud_suspected',
  '6':  'network_error',
  '7':  'network_error',
};

const networkError = () => ({
  approved: false, responseCode: '96', message: 'MIGS unavailable',
  authCode: null, maskedPan: null, migsTransactionNo: null,
  declineCategory: 'network_error', retryable: true, balanceCheck: 'check_failed',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { processPayment, purchase, authorizeOnly, capture, refund, voidAuth, queryStatus, ping };
