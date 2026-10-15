'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const { pciSecurityHeaders } = require('./middleware/pci.middleware');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const logger = require('./config/logger');
const { validateEnv } = require('./config/env');
const { requestContext } = require('./middleware/request-context');
const { asyncHandler, notFound, errorHandler } = require('./middleware/errors');
const { wrapRouterAsync } = require('./middleware/async-wrap');
const crypto = require('crypto');
const { verifyToken } = require('./middleware/auth');

// Échappement HTML pour les pages publiques (pay.c-pay.global)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timingSafeEqualStr = (a, b) => {
  const ba = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
};

const adminRoutes = require('./routes/admin.routes');
const merchantRoutes    = require('./routes/merchant.routes');
const cardholderRoutes  = require('./routes/cardholder.routes');
const gtpCardRoutes     = require('./routes/gtp-card.routes');
const mtnMomoRoutes     = require('./routes/mtn-momo.routes');
const card2momoRoutes   = require('./routes/card2momo.routes');
const railsRoutes = require('./routes/rails.routes');
const { secretRouter: webhooksMmSecretRouter, legacyRouter: webhooksMmLegacyRouter } = require('./routes/webhooks-mm.routes');
const { cardholderResetRouter, merchantResetRouter, distributionAdminRouter, agentRouter } = require('./routes/password_reset_distribution.routes');
const { cardholderRouter: claimsChRouter, adminRouter: claimsAdminRouter } = require('./routes/claims.routes');
const { adminRouter: distAdminRouter, bankRouter, agencyRouter, agentPortalRouter } = require('./routes/distribution.routes');
const orchestrator = require('./services/orchestration/orchestrator');
const { detectFromPhone } = require('./services/detection/detection.engine');
const { runSettlement } = require('./services/settlement/settlement.engine');
const { runAutoSettlement } = require('./services/settlement/auto-settlement');
const { merchantAuth } = require('./middleware/auth');
const { idempotency } = require('./middleware/idempotency');
const {
  validatePaymentRequest,
  validateLinkRequest,
  validatePayLinkSendRequest,
} = require('./middleware/validation');
const { sendWhatsAppText } = require('./services/notifications/whatsapp.service');
const { sendSmsSmpp } = require('./services/notifications/smpp.service');

const { httpMetrics, metricsHandler } = require('./config/metrics');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  contentSecurityPolicy: false, // Géré par pciSecurityHeaders
}));

// En-têtes de sécurité (HSTS, X-Frame-Options, nosniff, no-store sur les parcours sensibles).
// WAVE-2 : les middlewares PCI cosmétiques (no-op) et pciErrorHandler ont été supprimés.
app.use(pciSecurityHeaders);
app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || 'https://c-pay.global,https://www.c-pay.global,https://admin.c-pay.global,https://merchant.c-pay.global,https://card.c-pay.global,https://app.c-pay.global,https://bank.c-pay.global,https://agency.c-pay.global,https://agent.c-pay.global,http://localhost:3001,http://localhost:3002')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  credentials: true,
}));
// cookie-parser doit preceder les routes : les refresh tokens transitent
// desormais en cookie HttpOnly (voir middleware/auth.js).
app.use(cookieParser());
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: true }));
app.use(requestContext);
app.use(httpMetrics);

app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/api/v1/merchant/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api/v1/admin/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));
// REQ 8.3.4 : Rate limiting strict sur authentification cardholder
app.use('/api/v1/cardholder/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 5,  standardHeaders: true, legacyHeaders: false }));
app.use('/api/v1/cardholder/payment',    rateLimit({ windowMs:  5 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));
app.use('/api/v1/cardholder/card/pin',   rateLimit({ windowMs: 15 * 60 * 1000, max: 3,  standardHeaders: true, legacyHeaders: false }));
app.use('/api/v1/cardholder/unload',     rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }));


app.get('/health', asyncHandler(async (_req, res) => {
  const dbOk = await require('./config/database').pool.query('SELECT 1').then(() => true).catch(() => false);
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'connected' : 'unreachable',
    version: require('../package.json').version,
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
}));


const publicPayLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/v1/pay/:shortId', publicPayLimiter, asyncHandler(async (req, res) => {
  const { phone, method } = req.body || {};
  const { shortId } = req.params;
  if (method === 'card' || req.body?.cardNum || req.body?.cvv) {
    // Jamais de PAN/CVV côté serveur sur la page publique : champ hébergé PSP à venir
    return res.status(410).json({ error: 'Paiement par carte indisponible sur la page publique', code: 'CARD_PAYMENT_DISABLED' });
  }
  const normalized = detectFromPhone(String(phone || ''));
  if (!normalized.success) return res.status(422).json({ error: normalized.error || 'Numéro invalide', code: 'PHONE_INVALID' });
  const { query } = require('./config/database');
  const r = await query(
    `SELECT * FROM pay_links WHERE short_id=$1 AND status='pending' AND expires_at>NOW()`,
    [shortId]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Lien invalide ou expiré' });
  const link = r.rows[0];
  const result = await orchestrator.processTransaction({
    merchantId:    link.merchant_id,
    type:          'collect',
    amount:        Number(link.amount),
    customerPhone: normalized.phone,
    description:   link.description || 'Paiement C-Pay',
    payLinkId:     link.pay_link_id,
  });
  if (result.success) {
    await query(
      `UPDATE pay_links SET status='paid', paid_at=NOW(), paid_amount=$1 WHERE pay_link_id=$2 AND status='pending'`,
      [link.amount, link.pay_link_id]
    );
  }
  res.status(result.success || result.pending ? 200 : 402).json({
    success: !!result.success, pending: !!result.pending, txnId: result.txnId, message: result.message, error: result.error || null,
  });
}));

// ─── Swagger UI ───────────────────────────────────────────────────
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
app.use('/api/v1/docs', swaggerUi.serve);
app.get('/api/v1/docs/', swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { background: #1d4f92; }',
  customSiteTitle: 'C-Pay API Documentation',
  swaggerOptions: {
    url: '/api/v1/docs.json',
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
    defaultModelsExpandDepth: 1,
    defaultModelExpandDepth: 1,
  }
}));
app.get('/api/v1/docs.json', (req, res) => { res.json(swaggerSpec); });

// Route upgrade compte développeur → merchant production
app.post('/api/v1/developer/upgrade', async (req, res) => {
  const { email, businessName, phone, country, rccm, nif } = req.body;
  if (!email || !businessName) return res.status(422).json({error:'email et businessName requis'});
  try {
    const { query } = require('./config/database');
    // Vérifier si compte développeur existe
    const dev = await query(
      `SELECT * FROM admin_notifications WHERE type='developer_registration' AND message LIKE $1 LIMIT 1`,
      [`%${email}%`]
    );
    if (!dev.rows.length) return res.status(404).json({error:'Compte développeur introuvable'});

    // Notifier l'admin pour validation manuelle
    await query(
      `INSERT INTO admin_notifications (type, title, message, metadata)
       VALUES ('developer_upgrade_request', 'Demande upgrade Développeur → Merchant', $1, $2)`,
      [`${email} demande un accès production pour: ${businessName}`,
       JSON.stringify({ email, businessName, phone, country, rccm, nif })]
    );
    res.json({ success: true, message: 'Demande reçue — notre équipe validera votre compte production sous 48h.' });
  } catch(err){ res.status(500).json({error:err.message}); }
});

app.post('/api/v1/developer/register', async (req, res) => {
  const { name, email, phone, appName, integrationType, country } = req.body;
  if (!name || !email || !phone || !appName) return res.status(422).json({error:'Champs requis'});
  try {
    const { query } = require('./config/database');
    await query(
      `INSERT INTO admin_notifications (type, title, message, metadata)
       VALUES ('developer_registration', 'Nouveau développeur inscrit', $1, $2)`,
      [`${name} (${email}) — App: ${appName} — Pays: ${country||'CG'}`,
       JSON.stringify({ name, email, phone, appName, integrationType, country })]
    );
    res.json({ success: true, message: 'Compte sandbox en cours de création — credentials par email sous 24h.' });
  } catch(err){ res.status(500).json({error:err.message}); }
});

app.use('/api/v1/partners', wrapRouterAsync(require('./routes/partners.routes')));
// ─── CONSENTEMENTS ────────────────────────────────────────────────
app.get('/api/v1/consent/check', verifyToken, asyncHandler(async (req, res) => {
  const { portal } = req.query;
  if (!portal) return res.status(422).json({ error: 'portal requis' });
  const { query } = require('./config/database');
  const r = await query(`SELECT * FROM consents WHERE user_id=$1 AND user_type=$2 AND portal=$3`, [String(req.user.sub), String(req.user.type), String(portal).slice(0, 32)]);
  res.json({ hasConsented: r.rows.length > 0, consent: r.rows[0] || null });
}));

app.post('/api/v1/consent/accept', verifyToken, asyncHandler(async (req, res) => {
  const { portal, cguAccepted, privacyAccepted, contractAccepted } = req.body || {};
  if (!portal) return res.status(422).json({ error: 'portal requis' });
  const { query } = require('./config/database');
  await query(`INSERT INTO consents (user_id, user_type, portal, cgu_accepted, privacy_accepted, contract_accepted, ip_address, user_agent)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (user_id, user_type, portal)
    DO UPDATE SET cgu_accepted=$4, privacy_accepted=$5, contract_accepted=$6, accepted_at=NOW()`,
    [String(req.user.sub), String(req.user.type), String(portal).slice(0, 32), !!cguAccepted, !!privacyAccepted, !!contractAccepted,
     req.ip, (req.headers['user-agent'] || '').slice(0, 512)]
  );
  res.json({ success: true });
}));

// WAVE-4 : caisse marchande (docs/CAISSE-API.md) — montée AVANT les routeurs admin / marchand
app.use('/api/v1/admin/cash',    wrapRouterAsync(require('./routes/cash-admin.routes')));
app.use('/api/v1/merchant/cash', wrapRouterAsync(require('./routes/cash.routes')));
app.use('/api/v1/admin', wrapRouterAsync(adminRoutes));
app.use('/api/v1/merchant', wrapRouterAsync(merchantRoutes));
app.use('/api/v1/cardholder', wrapRouterAsync(cardholderRoutes));
app.use('/api/v1/cardholder/gtp', wrapRouterAsync(gtpCardRoutes));
app.use('/api/v1/momo', wrapRouterAsync(mtnMomoRoutes));
app.use('/api/v1', wrapRouterAsync(card2momoRoutes));
// Webhooks Mobile Money
const { handleMtnWebhook, handleAirtelWebhook, handleCyberSourceWebhook, handleMigsWebhook } = require('./routes/webhook-handlers');
app.post('/api/v1/webhooks/mtn',         handleMtnWebhook);
app.post('/api/v1/webhooks/airtel',      handleAirtelWebhook);
app.post('/api/v1/webhooks/cybersource', handleCyberSourceWebhook);
app.post('/api/v1/webhooks/migs',        handleMigsWebhook);
app.use('/api/v1/rails', wrapRouterAsync(railsRoutes));
// WAVE-2 : webhooks Mobile Money (Orange, Wave, Africell, Express Union, Free Money, Moov)
//   - chemin secret : POST /api/v1/webhooks/<WEBHOOK_PATH_SECRET>/:provider
//   - chemins publics historiques donnés aux opérateurs : /webhooks/orange, /webhooks/wave/…, /webhooks/<provider>/:txnId
app.use('/api/v1/webhooks', webhooksMmSecretRouter);
app.use('/webhooks', webhooksMmLegacyRouter);

// ─── Reset mot de passe ───────────────────────────────────────────
app.use('/api/v1/cardholder', wrapRouterAsync(cardholderResetRouter));
app.use('/api/v1/merchant',   wrapRouterAsync(merchantResetRouter));

// ─── Réclamations & Incidents ─────────────────────────────────────
app.use('/api/v1/cardholder', wrapRouterAsync(claimsChRouter));
app.use('/api/v1/admin',      wrapRouterAsync(claimsAdminRouter));

// ─── WAVE-2 : vitrine (assistant, leads, réclamations) + CRM admin ───
app.use('/api/v1/public',    wrapRouterAsync(require('./routes/public-crm.routes')));
app.use('/api/v1/admin/crm', wrapRouterAsync(require('./routes/crm-admin.routes')));

// ─── Distribution ─────────────────────────────────────────────────
app.use('/api/v1/admin/distribution', wrapRouterAsync(distAdminRouter));
app.use('/api/v1/bank',               wrapRouterAsync(bankRouter));
app.use('/api/v1/agency',             wrapRouterAsync(agencyRouter));
app.use('/api/v1/agent',              wrapRouterAsync(agentPortalRouter));

app.post('/api/v1/collect', merchantAuth, validatePaymentRequest, idempotency, asyncHandler(async (req, res) => {
  const { amount, customerPhone, emvPayload, aidDetected, description, deviceId } = req.body;
  const result = await orchestrator.processTransaction({
    merchantId: req.user.merchantId,
    type: 'collect',
    amount,
    customerPhone,
    emvPayload,
    aidDetected,
    description,
    deviceId,
  });

  res.status(result.statusCode || (result.success || result.pending ? 200 : 402)).json({
    success: !!result.success,
    pending: !!result.pending,
    txnId: result.txnId,
    message: result.message,
    amount: result.amount,
    currency: result.currency,
    authCode: result.authCode,
    error: result.error || null,
    code: result.code || undefined,
  });
}));

app.post('/api/v1/payout', merchantAuth, validatePaymentRequest, idempotency, asyncHandler(async (req, res) => {
  const { amount, customerPhone, emvPayload, aidDetected, description, deviceId } = req.body;
  const result = await orchestrator.processTransaction({
    merchantId: req.user.merchantId,
    type: 'payout',
    amount,
    customerPhone,
    emvPayload,
    aidDetected,
    description,
    deviceId,
  });

  res.status(result.statusCode || (result.success || result.pending ? 200 : 402)).json({
    success: !!result.success,
    pending: !!result.pending,
    txnId: result.txnId,
    message: result.message,
    amount: result.amount,
    currency: result.currency,
    error: result.error || null,
    code: result.code || undefined,
  });
}));

app.post('/api/v1/qr-code', merchantAuth, validateLinkRequest, idempotency, asyncHandler(async (req, res) => {
  const { amount, description } = req.body;
  const { query } = require('./config/database');
  const merchant = await query('SELECT currency FROM merchants WHERE merchant_id=$1', [req.user.merchantId]);
  const result = await orchestrator.generateQRPayload({
    merchantId: req.user.merchantId,
    amount,
    currency: merchant.rows[0]?.currency || 'XOF',
    description,
  });
  res.json(result);
}));

app.post('/api/v1/pay-link', merchantAuth, validateLinkRequest, idempotency, asyncHandler(async (req, res) => {
  const { amount, description } = req.body;
  const { query } = require('./config/database');
  const merchant = await query('SELECT currency FROM merchants WHERE merchant_id=$1', [req.user.merchantId]);
  const result = await orchestrator.generatePayLink({
    merchantId: req.user.merchantId,
    amount,
    currency: merchant.rows[0]?.currency || 'XOF',
    description,
  });
  res.json(result);
}));

app.post('/api/v1/pay-link/:id/send', merchantAuth, validatePayLinkSendRequest, asyncHandler(async (req, res) => {
  const { channel, phone } = req.body;
  const { query } = require('./config/database');
  const result = await query(
    `SELECT pay_link_id, short_id, amount, currency, description, short_url
     FROM pay_links
     WHERE merchant_id = $1 AND (pay_link_id::text = $2 OR short_id = $2)
     LIMIT 1`,
    [req.user.merchantId, req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: 'Lien de paiement introuvable', code: 'PAY_LINK_NOT_FOUND' });
  }

  const link = result.rows[0];
  const url = link.short_url || `${process.env.PAY_LINK_BASE_URL || 'https://pay.c-pay.global'}/${link.short_id}`;
  const text = `Paiement ${link.description || ''} ${link.amount} ${link.currency}: ${url}`.replace(/\s+/g, ' ').trim();
  const providerResult = channel === 'whatsapp'
    ? await sendWhatsAppText({ to: phone, text })
    : await sendSmsSmpp({ to: phone, text });

  res.json({ success: true, channel, linkId: link.pay_link_id, providerResult });
}));

app.post('/api/v1/webhooks/paymenthub', asyncHandler(async (req, res) => {
  // Fail-closed : sans jeton configuré, aucun callback n'est accepté
  if (!process.env.PAYMENTHUB_WEBHOOK_TOKEN || !timingSafeEqualStr(req.headers['x-paymenthub-token'], process.env.PAYMENTHUB_WEBHOOK_TOKEN)) {
    return res.status(401).json({ error: 'Webhook token invalide', code: 'INVALID_WEBHOOK_TOKEN' });
  }

  const payload = req.body?.data || req.body;
  const operation = payload?.operations?.[0] || {};
  const reference = operation.reference || payload?.reference;
  if (!reference) return res.status(422).json({ error: 'reference manquante', code: 'REFERENCE_REQUIRED' });

  const status = operation.status || payload?.status;
  const normalized = String(status || '').toLowerCase();
  const mappedStatus = ['completed', 'success', 'successful'].includes(normalized)
    ? 'authorized'
    : ['failed', 'rejected', 'cancelled'].includes(normalized)
      ? 'failed'
      : 'pending';

  const { query } = require('./config/database');
  if (mappedStatus === 'pending') return res.json({ success: true, updated: 0, status: 'pending' });
  const callbackAmount = Number(operation.amount ?? payload?.amount);
  const existing = await query(`SELECT amount, currency, status FROM transactions WHERE transaction_id = $1::uuid`, [reference]);
  if (!existing.rows.length) return res.status(404).json({ error: 'Transaction inconnue', code: 'TXN_NOT_FOUND' });
  if (Number.isFinite(callbackAmount) && callbackAmount > 0 && Math.abs(callbackAmount - Number(existing.rows[0].amount)) > 0.009) {
    logger.warn('PaymentHub callback: montant différent', { reference, callbackAmount, stored: existing.rows[0].amount });
    return res.status(409).json({ error: 'Montant du callback différent de la transaction', code: 'AMOUNT_MISMATCH' });
  }
  const updated = await query(
    `UPDATE transactions SET
       status = $1,
       gateway_payment_id = COALESCE($2, gateway_payment_id),
       gateway_name = COALESCE(gateway_name, 'paymenthub'),
       response_code = CASE WHEN $1 = 'authorized' THEN '00' ELSE response_code END,
       response_message = COALESCE($3, response_message),
       completed_at = CASE WHEN $1 = 'authorized' THEN NOW() ELSE completed_at END
     WHERE transaction_id = $4::uuid AND status = 'pending'
     RETURNING transaction_id, merchant_id`,
    [mappedStatus, payload?.id || operation.id || null, status || null, reference]
  );

  if (updated.rows.length) {
    await query(
      `INSERT INTO transaction_events (transaction_id, merchant_id, event_type, payload)
       VALUES ($1,$2,'PAYMENTHUB_CALLBACK',$3)`,
      [updated.rows[0].transaction_id, updated.rows[0].merchant_id, JSON.stringify(req.body)]
    );
  }

  res.json({ success: true, updated: updated.rows.length, status: mappedStatus });
}));

app.post('/api/v1/detect/phone', rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }), (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone requis', code: 'PHONE_REQUIRED' });
  res.json(detectFromPhone(phone));
});

app.post('/internal/settlement/run', asyncHandler(async (req, res) => {
  if (!process.env.INTERNAL_TOKEN) return res.status(503).json({ error: 'INTERNAL_TOKEN non configuré', code: 'INTERNAL_DISABLED' });
  if (!timingSafeEqualStr(req.headers['x-internal-token'], process.env.INTERNAL_TOKEN)) {
    return res.status(403).json({ error: 'Acces refuse', code: 'FORBIDDEN' });
  }
  res.json(await runSettlement(req.body?.cutoffDate));
}));

app.get('/live', (_req, res) => {
  res.json({ status: 'alive', version: require('../package.json').version, uptime: process.uptime() });
});

app.get('/ready', asyncHandler(async (_req, res) => {
  const dbOk = await require('./config/database').pool.query('SELECT 1').then(() => true).catch(() => false);
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ready' : 'not_ready',
    db: dbOk ? 'connected' : 'unreachable',
  });
}));

app.get('/metrics', metricsHandler);

// ─── PAY LINK PUBLIC — pages HTML (montées APRÈS les routes API et de santé, voir audit §3.1) ─────
app.get('/:shortId([A-Z0-9]{6,10})', async (req, res) => {
  try {
    const { shortId } = req.params;
    const r = await require('./config/database').query(
      `SELECT pl.*, m.business_name FROM pay_links pl
       JOIN merchants m ON m.merchant_id = pl.merchant_id
       WHERE pl.short_id = $1 AND pl.status = 'pending' AND pl.expires_at > NOW()`,
      [shortId]
    );
    if (!r.rows.length) {
      return res.status(404).send(`
        <!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/><title>Lien invalide</title>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
        <style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f4f8;}
        .box{text-align:center;padding:40px;background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);}
        h2{color:#ff3b30;}p{color:#5a6677;}</style></head>
        <body><div class="box"><h2>❌ Lien invalide ou expiré</h2><p>Ce lien de paiement n'est plus disponible.</p><a href="https://c-pay.global">c-pay.global</a></div></body></html>
      `);
    }
    const link = r.rows[0];
    const amt  = parseFloat(link.amount).toLocaleString('fr-FR');
    return res.send(`
      <!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/><title>Paiement ${esc(amt)} ${esc(link.currency)}</title>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Helvetica Neue',Arial,sans-serif;background:linear-gradient(135deg,#0a1628,#1d4f92);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
        .card{background:#fff;border-radius:20px;padding:32px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
        .logo{text-align:center;margin-bottom:20px}
        .logo img{height:48px;object-fit:contain}
        .merchant{text-align:center;font-size:14px;color:#5a6677;margin-bottom:4px}
        .amount{text-align:center;font-size:48px;font-weight:800;color:#1d4f92;margin:16px 0 4px}
        .currency{text-align:center;font-size:16px;color:#5a6677;margin-bottom:4px}
        .desc{text-align:center;font-size:13px;color:#8a9ab0;margin-bottom:24px;padding:0 16px}
        .methods{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px}
        .method{border:2px solid #dce3ed;border-radius:12px;padding:14px;text-align:center;cursor:pointer;transition:all .2s}
        .method:hover,.method.active{border-color:#12b6c7;background:#f0fbff}
        .method-icon{font-size:24px;margin-bottom:4px}
        .method-label{font-size:12px;font-weight:600;color:#1e2d3d}
        .inp{width:100%;border:1px solid #dce3ed;border-radius:8px;padding:12px;font-size:14px;margin-bottom:12px;outline:none}
        .inp:focus{border-color:#12b6c7}
        .btn{width:100%;background:#12b6c7;color:#fff;border:none;border-radius:10px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s}
        .btn:hover{background:#0fa3b3}
        .btn:disabled{background:#dce3ed;cursor:not-allowed}
        .secure{text-align:center;font-size:11px;color:#8a9ab0;margin-top:16px}
        .success{text-align:center;padding:20px}
        .success-icon{font-size:64px;margin-bottom:16px}
        .error-msg{color:#ff3b30;font-size:12px;margin-bottom:12px;text-align:center}
      </style></head>
      <body>
      <div class="card">
        <div class="logo"><img src="https://app.c-pay.global/logo-calculus.png" alt="C-Pay" onerror="this.style.display='none'"/></div>
        <div class="merchant">${esc(link.business_name)}</div>
        <div class="amount">${esc(amt)}</div>
        <div class="currency">${esc(link.currency)}</div>
        ${link.description ? `<div class="desc">${esc(link.description)}</div>` : ''}


        <div id="payForm">
          ${link.payment_method === 'card' ? `
          <div style="text-align:center;margin-bottom:16px">
            <span style="background:#1d4f9220;color:#1d4f92;border-radius:20px;padding:6px 16px;font-size:13px;font-weight:700">
              💳 ${link.psp === 'migs' ? 'Mastercard Gateway' : 'CyberSource'}
            </span>
          </div>
          <input id="cardNum" class="inp" type="text" placeholder="Numéro de carte" maxlength="19"
            oninput="this.value=this.value.replace(/[^0-9]/g,'').replace(/(.{4})/g,'$1 ').trim().substr(0,19)" />
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <input id="expiry" class="inp" type="text" placeholder="MM/AA" maxlength="5"
              oninput="var v=this.value.replace(/[^0-9]/g,'');if(v.length>2)v=v.substr(0,2)+'/'+v.substr(2);this.value=v" />
            <input id="cvv" class="inp" type="password" placeholder="CVV" maxlength="4" />
          </div>
          <input id="cardName" class="inp" type="text" placeholder="Nom sur la carte" />
          <div id="errMsg" class="error-msg" style="display:none"></div>
          <button class="btn" onclick="payCard()">💳 Payer ${esc(amt)} ${esc(link.currency)}</button>
          ` : `
          <div class="methods">
            <div class="method active" id="mtn" onclick="selectMethod('mtn')">
              <div class="method-icon">📱</div>
              <div class="method-label">MTN MoMo</div>
            </div>
            <div class="method" id="airtel" onclick="selectMethod('airtel')">
              <div class="method-icon">📲</div>
              <div class="method-label">Airtel Money</div>
            </div>
          </div>
          <input id="phone" class="inp" type="tel" placeholder="+242XXXXXXXXX — Numéro Mobile Money" />
          <div id="errMsg" class="error-msg" style="display:none"></div>
          <button class="btn" id="payBtn" onclick="pay()">💸 Payer ${esc(amt)} ${esc(link.currency)}</button>
          `}
        </div>

        <div id="success" style="display:none" class="success">
          <div class="success-icon">✅</div>
          <h2 style="color:#00c896;margin-bottom:8px">Paiement initié !</h2>
          <p style="color:#5a6677;font-size:13px">Confirmez le paiement sur votre téléphone Mobile Money.</p>
          <p style="color:#8a9ab0;font-size:11px;margin-top:12px">Réf: <span id="txnRef"></span></p>
        </div>

        <div class="secure">🔒 Paiement sécurisé · C-Pay PCI-DSS v4.0</div>
      </div>

      <script>
        let method = 'mtn';
        function selectMethod(m) {
          method = m;
          document.querySelectorAll('.method').forEach(el => el.classList.remove('active'));
          document.getElementById(m).classList.add('active');
          document.getElementById('phone').placeholder = m === 'mtn' ? '+242XXXXXXXXX — MTN MoMo' : '+242XXXXXXXXX — Airtel Money';
        }
        async function pay() {
          const phone = document.getElementById('phone').value.trim();
          const btn   = document.getElementById('payBtn');
          const err   = document.getElementById('errMsg');
          err.style.display = 'none';
          if (!phone) { err.textContent = 'Numéro de téléphone requis'; err.style.display = 'block'; return; }
          btn.disabled = true; btn.textContent = 'Traitement en cours…';
          try {
            const r = await fetch('/api/v1/pay/${esc(shortId)}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone, method })
            });
            const d = await r.json();
            if (d.success) {
              document.getElementById('payForm').style.display = 'none';
              document.getElementById('success').style.display = 'block';
              document.getElementById('txnRef').textContent = d.txnId || '—';
            } else {
              err.textContent = d.error || 'Erreur de paiement'; err.style.display = 'block';
              btn.disabled = false; btn.textContent = 'Payer ${esc(amt)} ${esc(link.currency)}';
            }
          } catch(e) {
            err.textContent = 'Erreur réseau'; err.style.display = 'block';
            btn.disabled = false; btn.textContent = 'Payer ${esc(amt)} ${esc(link.currency)}';
          }
        }
      </script>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Erreur serveur');
  }
});

// ─── PAY LINK PAYMENT ENDPOINT ───────────────────────────────────
// ─── Page paiement publique ───────────────────────────────────────
app.get('/:shortId', async (req, res) => {
  const { shortId } = req.params;
  // Ignorer les routes API et fichiers statiques
  if (shortId.startsWith('api') || shortId.includes('.')) return res.status(404).send('Not found');
  try {
    const r = await require('./config/database').query(
      `SELECT pl.*, m.business_name, m.country FROM pay_links pl
       JOIN merchants m ON m.merchant_id=pl.merchant_id
       WHERE pl.short_id=$1`,
      [shortId]
    );
    if (!r.rows.length) return res.status(404).send('<h1>Lien introuvable</h1>');
    const link = r.rows[0];
    const expired = new Date(link.expires_at) < new Date();
    const paid    = link.status === 'paid';
    const amount  = parseFloat(link.amount).toLocaleString('fr-FR');

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paiement — ${esc(link.business_name)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Century Gothic', Arial, sans-serif; background: #f0f4f8; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #fff; border-radius: 20px; padding: 32px; max-width: 420px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.1); }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo h2 { color: #12b6c7; font-size: 22px; }
    .amount { text-align: center; font-size: 36px; font-weight: 800; color: #1e2d3d; margin: 16px 0; }
    .merchant { text-align: center; color: #5a6677; font-size: 14px; margin-bottom: 24px; }
    .desc { background: #f0f4f8; border-radius: 10px; padding: 12px; font-size: 13px; color: #5a6677; margin-bottom: 20px; text-align: center; }
    .badge { display: inline-block; border-radius: 20px; padding: 4px 14px; font-size: 12px; font-weight: 700; margin-bottom: 20px; }
    .badge.pending { background: #ff950020; color: #ff9500; }
    .badge.paid { background: #00c89620; color: #00c896; }
    .badge.expired { background: #ff3b3020; color: #ff3b30; }
    .form input, .form select { width: 100%; padding: 12px; border: 1px solid #dce3ed; border-radius: 10px; font-size: 14px; margin-bottom: 12px; background: #f0f4f8; }
    .btn { width: 100%; padding: 14px; background: #12b6c7; color: #fff; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 8px; }
    .btn:hover { background: #0fa3b3; }
    .btn-momo { background: #ff9500; }
    .security { text-align: center; font-size: 11px; color: #5a6677; margin-top: 16px; }
    .result { text-align: center; padding: 20px 0; }
    .result .icon { font-size: 64px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <h2>⚡ Calculus Plus</h2>
      <p style="font-size:12px;color:#5a6677">Paiement sécurisé</p>
    </div>
    <div class="amount">${esc(amount)} ${esc(link.currency)}</div>
    <div class="merchant">🏪 ${esc(link.business_name)}</div>
    ${link.description ? `<div class="desc">${esc(link.description)}</div>` : ''}

    ${paid ? `
    <div class="result">
      <div class="icon">✅</div>
      <h2 style="color:#00c896;margin-bottom:8px">Paiement effectué !</h2>
      <p style="color:#5a6677">Ce lien a déjà été utilisé.</p>
    </div>` : expired ? `
    <div class="result">
      <div class="icon">⏰</div>
      <h2 style="color:#ff3b30;margin-bottom:8px">Lien expiré</h2>
      <p style="color:#5a6677">Ce lien de paiement a expiré.</p>
    </div>` : `
    <div style="text-align:center;margin-bottom:20px">
      <span class="badge pending">⏳ En attente de paiement</span>
    </div>

    <div id="choix" style="display:none"></div>

    ${link.payment_method === 'mobile_money' ? `
    <div class="form">
      <div style="text-align:center;margin-bottom:16px">
        <span style="background:#ff950020;color:#ff9500;border-radius:20px;padding:4px 14px;font-size:12px;font-weight:700">
          📱 ${link.psp === 'mtn' ? 'MTN MoMo' : 'Airtel Money'}
        </span>
      </div>
      <select id="operator">
        ${link.psp === 'mtn' ? '<option value="mtn">MTN MoMo</option>' : '<option value="airtel">Airtel Money</option>'}
      </select>
      <input id="phone" type="tel" placeholder="Numéro ex: 06XXXXXXXX" />
      <button class="btn btn-momo" onclick="payMomo()">💸 Payer ${esc(amount)} ${esc(link.currency)}</button>
    </div>` : `
    <div class="form">
      <div style="text-align:center;margin-bottom:16px">
        <span style="background:#1d4f9220;color:#1d4f92;border-radius:20px;padding:4px 14px;font-size:12px;font-weight:700">
          💳 ${link.psp === 'migs' ? 'Mastercard Gateway' : 'CyberSource'}
        </span>
      </div>
      <input id="cardNum" type="text" placeholder="Numéro de carte" maxlength="19"
        oninput="this.value=this.value.replace(/[^0-9]/g,'').replace(/(.{4})/g,'$1 ').trim()" />
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <input id="expiry" type="text" placeholder="MM/AA" maxlength="5"
          oninput="if(this.value.length==2&&!this.value.includes('/'))this.value+='/'" />
        <input id="cvv" type="password" placeholder="CVV" maxlength="4" />
      </div>
      <input id="cardName" type="text" placeholder="Nom sur la carte" />
      <button class="btn" onclick="payCard()">💳 Payer ${esc(amount)} ${esc(link.currency)}</button>
    </div>`}

    <div id="result" style="display:none" class="result">
      <div id="resultIcon" class="icon">⏳</div>
      <h2 id="resultTitle" style="margin-bottom:8px">Traitement…</h2>
      <p id="resultMsg" style="color:#5a6677"></p>
    </div>

    <div class="security">🔒 Paiement sécurisé PCI-DSS v4.0 · TLS 1.3</div>
    `}
  </div>

  <script>
    const shortId = '${esc(shortId)}';
    // Formulaire direct selon PSP choisi par le merchant

    function showResult(icon, title, msg, color) {
      document.getElementById('form-momo').style.display='none';
      document.getElementById('form-card').style.display='none';
      document.getElementById('choix').style.display='none';
      document.getElementById('result').style.display='block';
      document.getElementById('resultIcon').textContent=icon;
      document.getElementById('resultTitle').textContent=title;
      document.getElementById('resultTitle').style.color=color||'#1e2d3d';
      document.getElementById('resultMsg').textContent=msg;
    }

    async function payMomo() {
      const phone = document.getElementById('phone').value;
      const operator = document.getElementById('operator').value;
      if (!phone) return alert('Entrez votre numéro de téléphone');
      showResult('⏳', 'Traitement en cours…', 'Une demande de paiement a été envoyée à votre téléphone.');
      try {
        const r = await fetch('/api/v1/pay/' + shortId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, method: operator })
        });
        const d = await r.json();
        if (d.success) {
          showResult('✅', 'Paiement effectué !', 'Votre paiement a été confirmé. Merci !', '#00c896');
        } else {
          showResult('❌', 'Échec du paiement', d.error || d.message || 'Veuillez réessayer.', '#ff3b30');
        }
      } catch(e) {
        showResult('❌', 'Erreur', 'Veuillez réessayer.', '#ff3b30');
      }
    }

    async function payCard() {
      const cardNum = document.getElementById('cardNum').value.replace(/\s/g,'');
      const expiry  = document.getElementById('expiry').value;
      const cvv     = document.getElementById('cvv').value;
      const name    = document.getElementById('cardName').value;
      if (!cardNum || !expiry || !cvv) return alert('Remplissez tous les champs');
      showResult('⏳', 'Autorisation en cours…', 'Vérification de votre carte…');
      try {
        const r = await fetch('/api/v1/pay/' + shortId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'card', cardNum, expiry, cvv, name })
        });
        const d = await r.json();
        if (d.success) {
          showResult('✅', 'Paiement accepté !', 'Auth: ' + (d.authCode||'') + ' — Merci !', '#00c896');
        } else {
          showResult('❌', 'Paiement refusé', d.error || 'Veuillez réessayer.', '#ff3b30');
        }
      } catch(e) {
        showResult('❌', 'Erreur', 'Veuillez réessayer.', '#ff3b30');
      }
    }
  </script>
</body>
</html>`);
  } catch(err) {
    res.status(500).send('<h1>Erreur serveur</h1>');
  }
});


app.use(notFound);
app.use(errorHandler(logger));

let server;

const start = async () => {
  try {
    validateEnv();
  } catch (err) {
    logger.error('Configuration production invalide', { err: err.message, missing: err.missing });
    process.exit(1);
  }

  try {
    const { pool } = require('./config/database');
    await pool.query('SELECT 1');
    logger.info('Database connected');
  } catch (err) {
    logger.error('Database unreachable - starting anyway', { err: err.message });
  }

  server = app.listen(PORT, () => logger.info(`C-Pay ${require('../package.json').version} API started on :${PORT}`));

  // Reconciliation automatique des transactions pending (toutes les 2 min)
  try {
    const { reconcilePending } = require('./services/reconcile.service');
    setInterval(() => {
      reconcilePending({ maxAgeHours: 6, limit: 50 })
        .then(r => { if (r.summary.authorized || r.summary.failed) logger.info('[cron reconcile]', r.summary); })
        .catch(e => logger.error('[cron reconcile] ' + e.message));
    }, 120000);
    logger.info('Cron reconciliation actif (120s)');
  } catch (e) { logger.error('Cron reconcile init: ' + e.message); }
};

const shutdown = async (signal) => {
  logger.info('Shutdown requested', { signal });
  if (server) await new Promise((resolve) => server.close(resolve));
  await require('./config/database').pool.end();
  logger.info('Shutdown complete');
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM').catch((err) => {
  logger.error('Shutdown failed', { err: err.message });
  process.exit(1);
}));

process.on('SIGINT', () => shutdown('SIGINT').catch((err) => {
  logger.error('Shutdown failed', { err: err.message });
  process.exit(1);
}));

if (require.main === module) start();


module.exports = app;
