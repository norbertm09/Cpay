/**
 * Tests HOTFIX WAVE-1 — orchestrateur, providers Mobile Money, réconciliation, transferts
 *  - payout par carte refusé AVANT tout appel gateway
 *  - résultat provider pending → statut pending (jamais failed), pas de settlement
 *  - settlement enfilé uniquement pour les encaissements autorisés
 *  - Airtel / MTN / Vodacom / Orange : pending sur acceptation / timeout
 *  - réconciliation : filtre opérateur legacy + orchestrateur, jamais failed sur erreur réseau
 *  - client MTN : TLS vérifié par défaut
 */
'use strict';

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/database', () => ({ query: jest.fn(), withTransaction: jest.fn(), pool: { query: jest.fn() } }));
jest.mock('../services/detection/detection.engine', () => ({
  detectFromPhone: jest.fn((phone) => ({ success: true, operator: 'MTN_MOMO', gateway: 'mtn_cm', country: 'CM', currency: 'XAF', phone, name: 'MTN MoMo' })),
  detectFromAid:   jest.fn(() => ({ success: true, paymentMethod: 'card_nfc', network: 'VISA', acquirer: 'cybersource' })),
  detectFromCard:  jest.fn(),
}));
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({ processPayment: jest.fn(), sendPayout: jest.fn() }));
jest.mock('../services/gateways/card.router', () => ({ processCard: jest.fn() }));
jest.mock('../services/settlement/settlement.queue', () => ({ enqueue: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/integrations/integration.service', () => ({ deliverEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/pilot/pilot-control.service', () => ({ evaluateFeature: jest.fn().mockResolvedValue({ allowed: true }) }));
jest.mock('../services/fraud/fraud.engine', () => ({ evaluate: jest.fn().mockResolvedValue({ action: 'allow', score: 0 }) }));

const db         = require('../config/database');
const mmRouter   = require('../services/mobilemoney/mobilemoney.router');
const cardRouter = require('../services/gateways/card.router');
const settlement = require('../services/settlement/settlement.queue');

const setupDb = () => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/FROM merchants WHERE merchant_id/.test(sql)) {
      return { rows: [{ merchant_id: 'M-1', currency: 'XAF', kyb_level: 2, merchant_status: 'active' }], rowCount: 1 };
    }
    if (/daily_volume/.test(sql)) return { rows: [{ daily_volume: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
};
const sqlCalls = (re) => db.query.mock.calls.filter(([sql]) => re.test(sql));

// ─── ORCHESTRATEUR ────────────────────────────────────────────────

describe('Orchestrator — payout carte refusé', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDb(); });
  const orchestrator = require('../services/orchestration/orchestrator');

  test('payout + aidDetected → PAYOUT_CARD_UNSUPPORTED, aucun appel gateway ni INSERT', async () => {
    const r = await orchestrator.processTransaction({ merchantId: 'M-1', type: 'payout', amount: 5000, aidDetected: 'A0000000031010' });
    expect(r.success).toBe(false);
    expect(r.code).toBe('PAYOUT_CARD_UNSUPPORTED');
    expect(r.statusCode).toBe(422);
    expect(cardRouter.processCard).not.toHaveBeenCalled();
    expect(mmRouter.sendPayout).not.toHaveBeenCalled();
    expect(sqlCalls(/INSERT INTO transactions/)).toHaveLength(0);
    expect(settlement.enqueue).not.toHaveBeenCalled();
  });

  test('payout + emvPayload → refusé de la même façon', async () => {
    const r = await orchestrator.processTransaction({ merchantId: 'M-1', type: 'payout', amount: 5000, emvPayload: 'EMV...' });
    expect(r.code).toBe('PAYOUT_CARD_UNSUPPORTED');
    expect(cardRouter.processCard).not.toHaveBeenCalled();
  });

  test('collect par carte reste possible', async () => {
    cardRouter.processCard.mockResolvedValue({ approved: true, authCode: 'A1', responseCode: '00', _gateway: 'cybersource' });
    const r = await orchestrator.processTransaction({ merchantId: 'M-1', type: 'collect', amount: 5000, aidDetected: 'A0000000031010' });
    expect(r.success).toBe(true);
    expect(r.status).toBe('authorized');
    expect(cardRouter.processCard).toHaveBeenCalledTimes(1);
  });
});

describe('Orchestrator — pending et settlement', () => {
  beforeEach(() => { jest.clearAllMocks(); setupDb(); });
  const orchestrator = require('../services/orchestration/orchestrator');

  test('payout MM : provider pending → status pending, pas failed, pas de settlement', async () => {
    mmRouter.sendPayout.mockResolvedValue({ approved: false, pending: true, responseCode: '09', declineReason: 'PENDING', _operator: 'MTN_MOMO' });
    const r = await orchestrator.processTransaction({ merchantId: 'M-1', type: 'payout', amount: 5000, customerPhone: '+237670000000' });
    expect(r.success).toBe(false);
    expect(r.pending).toBe(true);
    expect(r.status).toBe('pending');
    const upd = sqlCalls(/UPDATE transactions SET/);
    expect(upd).toHaveLength(1);
    expect(upd[0][1][0]).toBe('pending');
    expect(settlement.enqueue).not.toHaveBeenCalled();
    const evt = sqlCalls(/INSERT INTO transaction_events/);
    expect(evt[0][1][2]).toBe('GATEWAY_PENDING');
  });

  test('collect MM : provider pending (timeout polling) → pending, pas de settlement', async () => {
    mmRouter.processPayment.mockResolvedValue({ approved: false, pending: true, responseCode: '09', declineReason: 'En attente', retryable: false, _operator: 'MTN_MOMO' });
    const r = await orchestrator.processTransaction({ merchantId: 'M-1', type: 'collect', amount: 5000, customerPhone: '+237670000000' });
    expect(r.status).toBe('pending');
    expect(r.message).toMatch(/attente/i);
    expect(settlement.enqueue).not.toHaveBeenCalled();
  });

  test('payout MM autorisé → authorized mais JAMAIS enfilé en settlement', async () => {
    mmRouter.sendPayout.mockResolvedValue({ approved: true, pending: false, authCode: 'FT1', responseCode: '00', _operator: 'MTN_MOMO' });
    const r = await orchestrator.processTransaction({ merchantId: 'M-1', type: 'payout', amount: 5000, customerPhone: '+237670000000' });
    expect(r.status).toBe('authorized');
    expect(settlement.enqueue).not.toHaveBeenCalled();
  });

  test('collect MM autorisé → settlement enfilé', async () => {
    mmRouter.processPayment.mockResolvedValue({ approved: true, pending: false, authCode: 'FT1', responseCode: '00', _operator: 'MTN_MOMO' });
    const r = await orchestrator.processTransaction({ merchantId: 'M-1', type: 'collect', amount: 5000, customerPhone: '+237670000000' });
    expect(r.status).toBe('authorized');
    expect(settlement.enqueue).toHaveBeenCalledTimes(1);
    expect(settlement.enqueue).toHaveBeenCalledWith(expect.objectContaining({ merchantId: 'M-1', amount: 5000 }));
  });

  test('collect MM refusé → failed', async () => {
    mmRouter.processPayment.mockResolvedValue({ approved: false, pending: false, responseCode: '05', declineReason: 'Refusé', _operator: 'MTN_MOMO' });
    const r = await orchestrator.processTransaction({ merchantId: 'M-1', type: 'collect', amount: 5000, customerPhone: '+237670000000' });
    expect(r.status).toBe('failed');
    expect(r.success).toBe(false);
    expect(settlement.enqueue).not.toHaveBeenCalled();
  });
});

// ─── PROVIDERS ────────────────────────────────────────────────────

const mockHttp = (responses) => {
  const https = require('https');
  let idx = 0;
  jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
    const resp = responses[Math.min(idx, responses.length - 1)];
    idx++;
    const mockRes = {
      statusCode: resp.statusCode || 200,
      headers: {},
      on: (ev, h) => { if (ev === 'data') h(JSON.stringify(resp.body || {})); if (ev === 'end') h(); return mockRes; },
    };
    return { write: jest.fn(), end: jest.fn(() => cb(mockRes)), on: jest.fn().mockReturnThis(), destroy: jest.fn() };
  });
};

describe('Airtel provider — pending tant que non confirmé', () => {
  beforeEach(() => { jest.restoreAllMocks(); });
  const cfg = { baseUrl: 'https://openapi.airtel.africa', apiKey: 'k', apiSecret: 's' };

  test('collectPayment : TIP (push accepté) → pending:true, success:false', async () => {
    jest.isolateModules(() => {});
    mockHttp([
      { body: { access_token: 'tok' } },
      { body: { status: { success: true, code: '200' }, data: { transaction: { id: 'AT-1', status: 'TIP' } } } },
    ]);
    const airtel = require('../services/mobilemoney/providers/airtel.provider');
    const r = await airtel.collectPayment({ txnId: 'T1', amount: 1000, currency: 'XAF', phone: '242040000000', config: cfg });
    expect(r.success).toBe(false);
    expect(r.pending).toBe(true);
    expect(r.transactionId).toBe('AT-1');
  });

  test('collectPayment : TS → success:true', async () => {
    mockHttp([
      { body: { access_token: 'tok' } },
      { body: { status: { success: true, code: '200' }, data: { transaction: { id: 'AT-2', status: 'TS' } } } },
    ]);
    const airtel = require('../services/mobilemoney/providers/airtel.provider');
    const r = await airtel.collectPayment({ txnId: 'T2', amount: 1000, currency: 'XAF', phone: '242040000000', config: cfg });
    expect(r.success).toBe(true);
    expect(r.pending).toBe(false);
  });

  test('collectPayment : TF → échec (ni success ni pending)', async () => {
    mockHttp([
      { body: { access_token: 'tok' } },
      { body: { status: { success: true, code: '200' }, data: { transaction: { id: 'AT-3', status: 'TF' } } } },
    ]);
    const airtel = require('../services/mobilemoney/providers/airtel.provider');
    const r = await airtel.collectPayment({ txnId: 'T3', amount: 1000, currency: 'XAF', phone: '242040000000', config: cfg });
    expect(r.success).toBe(false);
    expect(r.pending).toBe(false);
  });

  test('sendPayout : TIP → pending', async () => {
    mockHttp([
      { body: { access_token: 'tok' } },
      { body: { status: { success: true, code: '200' }, data: { transaction: { id: 'AD-1', status: 'TIP' } } } },
    ]);
    const airtel = require('../services/mobilemoney/providers/airtel.provider');
    const r = await airtel.sendPayout({ txnId: 'T4', amount: 1000, currency: 'XAF', phone: '242040000000', config: { ...cfg, pin: '1234' } });
    expect(r.success).toBe(false);
    expect(r.pending).toBe(true);
  });
});

describe('MTN provider — timeout = pending, jamais failed', () => {
  beforeEach(() => { jest.restoreAllMocks(); });
  const cfg = { baseUrl: 'https://sandbox.momodeveloper.mtn.com', apiKey: 'k', apiSecret: 's', subscriptionKey: 'sub' };

  test('pollStatus : PENDING jusqu\'au timeout → pending:true, reason TIMEOUT, retryable:false', async () => {
    mockHttp([{ body: { status: 'PENDING' } }]);
    const mtn = require('../services/mobilemoney/providers/mtn.provider');
    const r = await mtn.pollStatus(cfg, 'REF-1', 'tok', 20, 1);
    expect(r.success).toBe(false);
    expect(r.pending).toBe(true);
    expect(r.reason).toBe('TIMEOUT');
    expect(r.retryable).toBe(false);
  });

  test('pollDisbursementStatus : PENDING → pending:true', async () => {
    mockHttp([{ body: { status: 'PENDING' } }]);
    const mtn = require('../services/mobilemoney/providers/mtn.provider');
    const r = await mtn.pollDisbursementStatus(cfg, 'REF-2', 'tok', 1);
    expect(r.success).toBe(false);
    expect(r.pending).toBe(true);
  });

  test('pollDisbursementStatus : SUCCESSFUL → success', async () => {
    mockHttp([{ body: { status: 'SUCCESSFUL', financialTransactionId: 'FT-9' } }]);
    const mtn = require('../services/mobilemoney/providers/mtn.provider');
    const r = await mtn.pollDisbursementStatus(cfg, 'REF-3', 'tok', 1);
    expect(r.success).toBe(true);
    expect(r.financialTransactionId).toBe('FT-9');
  });

  test('getRequestStatus / getTransferStatus renvoient le statut réel MTN avec montant/devise', async () => {
    mockHttp([
      { body: { access_token: 'tok' } },
      { body: { status: 'SUCCESSFUL', amount: '5000', currency: 'XAF', financialTransactionId: 'FT-1' } },
      { body: { access_token: 'tok' } },
      { body: { status: 'FAILED', reason: 'PAYEE_NOT_FOUND' } },
    ]);
    const mtn = require('../services/mobilemoney/providers/mtn.provider');
    const a = await mtn.getRequestStatus(cfg, 'REF-1');
    expect(a).toMatchObject({ status: 'SUCCESSFUL', amount: 5000, currency: 'XAF', financialTransactionId: 'FT-1' });
    const b = await mtn.getTransferStatus(cfg, 'REF-2');
    expect(b).toMatchObject({ status: 'FAILED', reason: 'PAYEE_NOT_FOUND' });
  });

  test('getRequestStatus : HTTP 500 → lève (la réconciliation laisse pending)', async () => {
    mockHttp([{ body: { access_token: 'tok' } }, { statusCode: 500, body: {} }]);
    const mtn = require('../services/mobilemoney/providers/mtn.provider');
    await expect(mtn.getRequestStatus(cfg, 'REF-1')).rejects.toThrow(/500/);
  });
});

describe('Vodacom / Orange providers', () => {
  beforeEach(() => { jest.restoreAllMocks(); });

  test('Vodacom INS-0 à l\'initiate → pending, pas success', async () => {
    mockHttp([{ body: { access_token: 'tok' } }, { body: { output_ResponseCode: 'INS-0', output_TransactionID: 'VT-1' } }]);
    const voda = require('../services/mobilemoney/providers/vodacom.provider');
    const r = await voda.collectPayment({ txnId: 'T1', amount: 1000, currency: 'CDF', phone: '243810000000', config: { apiKey: 'k', apiSecret: 's' } });
    expect(r.success).toBe(false);
    expect(r.pending).toBe(true);
    expect(r.transactionId).toBe('VT-1');
  });

  test('Vodacom INS-0 avec statut Completed explicite → success', async () => {
    mockHttp([{ body: { access_token: 'tok' } }, { body: { output_ResponseCode: 'INS-0', output_TransactionID: 'VT-2', output_TransactionStatus: 'Completed' } }]);
    const voda = require('../services/mobilemoney/providers/vodacom.provider');
    const r = await voda.collectPayment({ txnId: 'T2', amount: 1000, currency: 'CDF', phone: '243810000000', config: { apiKey: 'k', apiSecret: 's' } });
    expect(r.success).toBe(true);
    expect(r.pending).toBe(false);
  });

  test('Orange sendPayout : HTTP 200 sans indicateur de succès → pas success', async () => {
    mockHttp([{ statusCode: 200, body: { txnid: 'OM-1' } }]);
    const orange = require('../services/mobilemoney/providers/orange.provider');
    const r = await orange.sendPayout({ txnId: 'T1', amount: 1000, currency: 'XOF', phone: '221770000000', config: { baseUrl: 'https://api.orange.com', apiKey: 'k' } });
    expect(r.success).toBe(false);
    expect(r.pending).toBe(true);
  });

  test('Orange sendPayout : HTTP 200 + status SUCCESS + txnid → success', async () => {
    mockHttp([{ statusCode: 200, body: { status: 'SUCCESS', txnid: 'OM-2' } }]);
    const orange = require('../services/mobilemoney/providers/orange.provider');
    const r = await orange.sendPayout({ txnId: 'T2', amount: 1000, currency: 'XOF', phone: '221770000000', config: { baseUrl: 'https://api.orange.com', apiKey: 'k' } });
    expect(r.success).toBe(true);
  });

  test('Orange sendPayout : HTTP 200 + status FAILED → échec', async () => {
    mockHttp([{ statusCode: 200, body: { status: 'FAILED', txnid: 'OM-3', message: 'Insufficient funds' } }]);
    const orange = require('../services/mobilemoney/providers/orange.provider');
    const r = await orange.sendPayout({ txnId: 'T3', amount: 1000, currency: 'XOF', phone: '221770000000', config: { baseUrl: 'https://api.orange.com', apiKey: 'k' } });
    expect(r.success).toBe(false);
    expect(r.pending).toBe(false);
  });
});

describe('Mobile Money router normalize()', () => {
  test('pending:true → approved:false, pending:true (même si success:true par erreur)', () => {
    const { normalize } = jest.requireActual('../services/mobilemoney/mobilemoney.router');
    expect(normalize({ success: false, pending: true, transactionId: 'X' }, 'MTN_MOMO')).toMatchObject({ approved: false, pending: true });
    expect(normalize({ success: true, pending: true }, 'MTN_MOMO')).toMatchObject({ approved: false, pending: true });
    expect(normalize({ success: true }, 'MTN_MOMO')).toMatchObject({ approved: true, pending: false, responseCode: '00' });
  });
});

// ─── RÉCONCILIATION ───────────────────────────────────────────────

describe('Reconciliation', () => {
  beforeEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  test('le filtre SQL couvre mtn/airtel legacy et MTN_MOMO/AIRTEL_MONEY', async () => {
    const db2 = require('../config/database');
    db2.query.mockReset();
    db2.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { reconcilePending, opKind } = require('../services/reconcile.service');
    await reconcilePending({ maxAgeHours: 6, limit: 10 });
    const sql = db2.query.mock.calls[0][0];
    expect(sql).toMatch(/LOWER\(detected_operator\) LIKE 'mtn%'/);
    expect(sql).toMatch(/LOWER\(detected_operator\) LIKE 'airtel%'/);
    expect(sql).not.toMatch(/IN \('mtn','airtel'\)/);
    expect(opKind('MTN_MOMO')).toBe('mtn');
    expect(opKind('mtn')).toBe('mtn');
    expect(opKind('AIRTEL_MONEY')).toBe('airtel');
    expect(opKind('orange')).toBeNull();
  });

  test('erreur réseau provider → transaction laissée pending (jamais failed)', async () => {
    jest.doMock('../services/rails/mtn-momo.client', () => ({
      getCollectionStatus: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')),
      getDisbursementStatus: jest.fn(),
    }));
    jest.doMock('../services/mobilemoney/mobilemoney.router', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
    const db2 = require('../config/database');
    db2.query.mockReset();
    db2.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { reconcileOne } = require('../services/reconcile.service');
    const r = await reconcileOne({ transaction_id: 'T-1', type: 'collect', amount: '5000', currency: 'XAF', detected_operator: 'MTN_MOMO', detected_country: 'CM', gateway_payment_id: 'REF-1' });
    expect(r.still).toBe('pending');
    expect(db2.query.mock.calls.filter(([s]) => /UPDATE/.test(s))).toHaveLength(0);
  });

  test('MTN SUCCESSFUL (statut réel) → authorized avec garde status=pending', async () => {
    jest.doMock('../services/rails/mtn-momo.client', () => ({
      getCollectionStatus: jest.fn().mockResolvedValue({ status: 'SUCCESSFUL', financialTxnId: 'FT-1', amount: 5000, currency: 'XAF' }),
      getDisbursementStatus: jest.fn(),
    }));
    jest.doMock('../services/mobilemoney/mobilemoney.router', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
    jest.doMock('../services/settlement.service', () => ({ settleTransaction: jest.fn().mockResolvedValue(undefined) }));
    const db2 = require('../config/database');
    db2.query.mockReset();
    db2.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const { reconcileOne } = require('../services/reconcile.service');
    const r = await reconcileOne({ transaction_id: 'T-1', type: 'collect', amount: '5000', currency: 'XAF', detected_operator: 'mtn', detected_country: 'CG', gateway_payment_id: 'REF-1' });
    expect(r.updated).toBe('authorized');
    const upd = db2.query.mock.calls.find(([s]) => /UPDATE transactions SET status='authorized'/.test(s));
    expect(upd[0]).toMatch(/AND status='pending'/);
  });

  test('MTN SUCCESSFUL mais montant différent → laissé pending', async () => {
    jest.doMock('../services/rails/mtn-momo.client', () => ({
      getCollectionStatus: jest.fn().mockResolvedValue({ status: 'SUCCESSFUL', amount: 1, currency: 'XAF' }),
      getDisbursementStatus: jest.fn(),
    }));
    jest.doMock('../services/mobilemoney/mobilemoney.router', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
    const db2 = require('../config/database');
    db2.query.mockReset();
    db2.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const { reconcileOne } = require('../services/reconcile.service');
    const r = await reconcileOne({ transaction_id: 'T-1', type: 'collect', amount: '5000', currency: 'XAF', detected_operator: 'mtn', detected_country: 'CG', gateway_payment_id: 'REF-1' });
    expect(r.still).toBe('pending');
    expect(r.mismatch).toBe(true);
    expect(db2.query.mock.calls.filter(([s]) => /UPDATE/.test(s))).toHaveLength(0);
  });
});

// ─── TRANSFERTS ───────────────────────────────────────────────────

describe('Transfer service — jamais completed si une étape a échoué', () => {
  beforeEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  const flush = () => new Promise(r => setTimeout(r, 30));

  const setupTransferDb = () => {
    const db2 = require('../config/database');
    db2.query.mockReset();
    db2.query.mockImplementation(async (sql) => {
      if (/FROM bank_accounts/.test(sql)) return { rows: [{ account_id: 'A-1', inst_name: 'Bank', inst_code: 'BK', account_number: '12345678', account_name: 'X' }], rowCount: 1 };
      if (/FROM gtp_cards/.test(sql))     return { rows: [{ gtp_card_id: 'G-1', last4: '1111' }], rowCount: 1 };
      if (/FROM cardholders/.test(sql))   return { rows: [{ email: null, phone: '242060000000' }], rowCount: 1 };
      if (/FROM cardholder_wallets/.test(sql)) return { rows: [{ wallet_id: 'W-1', operator: 'mtn', phone: '242060000000' }], rowCount: 1 };
      if (/INSERT INTO bank_transfers/.test(sql)) return { rows: [{ transfer_id: 'TR-1' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    return db2;
  };

  test('from_bank vers wallet : mtn.transfer lève après déchargement carte → needs_reversal', async () => {
    jest.doMock('../services/rails/gtp-card.service', () => ({
      bankToCard: jest.fn().mockResolvedValue({ transactionId: 'B2C-1', newBalance: 100 }),
      unload:     jest.fn().mockResolvedValue({ transactionId: 'UNL-1' }),
      topUp: jest.fn(), cardToBank: jest.fn(),
    }));
    jest.doMock('../services/rails/mtn-momo.client', () => ({
      transfer: jest.fn().mockRejectedValue(new Error('MTN transfer failed: 500')),
      requestToPay: jest.fn(), getCollectionStatus: jest.fn(),
    }));
    jest.doMock('../services/notifications/email.service', () => ({ sendTransferNotice: jest.fn().mockResolvedValue(undefined) }));
    const db2 = setupTransferDb();
    const transfer = require('../services/transfer/transfer.service');
    const r = await transfer.initiate({ cardholderId: 'CH-1', direction: 'from_bank', sourceType: 'wallet', sourceId: 'W-1', accountId: 'A-1', amount: 5000 });
    expect(r.transferId).toBe('TR-1');
    await flush();
    const statuses = db2.query.mock.calls.filter(([s]) => /UPDATE bank_transfers/.test(s)).map(([, p]) => p[1]);
    expect(statuses).toContain('needs_reversal');
    expect(statuses).not.toContain('completed');
    const logger = require('../config/logger');
    expect(logger.error).toHaveBeenCalled();
  });

  test('to_bank : cardToBank lève après topUp réussi → needs_reversal (pas failed, pas completed)', async () => {
    jest.doMock('../services/rails/gtp-card.service', () => ({
      topUp:      jest.fn().mockResolvedValue({ transactionId: 'TOP-1' }),
      cardToBank: jest.fn().mockRejectedValue(new Error('GTP timeout')),
      bankToCard: jest.fn(), unload: jest.fn(),
    }));
    jest.doMock('../services/rails/mtn-momo.client', () => ({
      requestToPay: jest.fn().mockResolvedValue({ referenceId: 'RTP-1', status: 'PENDING' }),
      getCollectionStatus: jest.fn().mockResolvedValue({ status: 'SUCCESSFUL', financialTxnId: 'FT-1' }),
      transfer: jest.fn(),
    }));
    jest.doMock('../services/notifications/email.service', () => ({ sendTransferNotice: jest.fn().mockResolvedValue(undefined) }));
    const db2 = setupTransferDb();
    const transfer = require('../services/transfer/transfer.service');
    // waitMomo attend 3 s avant le premier poll : on raccourcit via un spy sur setTimeout
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 5), ...a));
    try {
      await transfer.initiate({ cardholderId: 'CH-1', direction: 'to_bank', sourceType: 'wallet', sourceId: 'W-1', accountId: 'A-1', amount: 5000 });
      await new Promise(r => realSetTimeout(r, 100));
    } finally {
      global.setTimeout.mockRestore();
    }
    const statuses = db2.query.mock.calls.filter(([s]) => /UPDATE bank_transfers/.test(s)).map(([, p]) => p[1]);
    expect(statuses).toContain('needs_reversal');
    expect(statuses).not.toContain('completed');
    expect(statuses).not.toContain('failed');
  });

  test('to_bank : MoMo refusé avant tout mouvement → failed (pas needs_reversal)', async () => {
    jest.doMock('../services/rails/gtp-card.service', () => ({ topUp: jest.fn(), cardToBank: jest.fn(), bankToCard: jest.fn(), unload: jest.fn() }));
    jest.doMock('../services/rails/mtn-momo.client', () => ({
      requestToPay: jest.fn().mockResolvedValue({ referenceId: 'RTP-1', status: 'PENDING' }),
      getCollectionStatus: jest.fn().mockResolvedValue({ status: 'FAILED', reason: 'REJECTED' }),
      transfer: jest.fn(),
    }));
    jest.doMock('../services/notifications/email.service', () => ({ sendTransferNotice: jest.fn() }));
    const db2 = setupTransferDb();
    const transfer = require('../services/transfer/transfer.service');
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 5), ...a));
    try {
      await transfer.initiate({ cardholderId: 'CH-1', direction: 'to_bank', sourceType: 'wallet', sourceId: 'W-1', accountId: 'A-1', amount: 5000 });
      await new Promise(r => realSetTimeout(r, 100));
    } finally {
      global.setTimeout.mockRestore();
    }
    const statuses = db2.query.mock.calls.filter(([s]) => /UPDATE bank_transfers/.test(s)).map(([, p]) => p[1]);
    expect(statuses).toContain('failed');
    expect(statuses).not.toContain('needs_reversal');
  });
});

// ─── CLIENT MTN (rails) — TLS ─────────────────────────────────────

describe('rails/mtn-momo.client — TLS vérifié par défaut', () => {
  beforeEach(() => { jest.resetModules(); jest.restoreAllMocks(); delete process.env.MTN_TLS_INSECURE; });

  test('rejectUnauthorized n\'est plus forcé à false ; timeout appliqué', async () => {
    const https = require('https');
    const captured = [];
    jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
      captured.push(opts);
      const res = { statusCode: 200, on: (ev, h) => { if (ev === 'data') h('{"access_token":"t","expires_in":3600}'); if (ev === 'end') h(); return res; } };
      return { write: jest.fn(), end: jest.fn(() => cb(res)), on: jest.fn().mockReturnThis(), destroy: jest.fn() };
    });
    process.env.MTN_CG_TIMEOUT_MS = '12345';
    const mtn = jest.requireActual('../services/rails/mtn-momo.client');
    await mtn.getToken('collections');
    expect(captured[0].rejectUnauthorized).toBeUndefined();
    expect(captured[0].timeout).toBe(12345);
  });

  test('MTN_TLS_INSECURE=true (sandbox explicite) → rejectUnauthorized:false', async () => {
    process.env.MTN_TLS_INSECURE = 'true';
    const https = require('https');
    const captured = [];
    jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
      captured.push(opts);
      const res = { statusCode: 200, on: (ev, h) => { if (ev === 'data') h('{"access_token":"t"}'); if (ev === 'end') h(); return res; } };
      return { write: jest.fn(), end: jest.fn(() => cb(res)), on: jest.fn().mockReturnThis(), destroy: jest.fn() };
    });
    const mtn = jest.requireActual('../services/rails/mtn-momo.client');
    await mtn.getToken('disbursements');
    expect(captured[0].rejectUnauthorized).toBe(false);
  });
});
