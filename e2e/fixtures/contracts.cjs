'use strict';
const M = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const CARD = '33333333-3333-4333-8333-333333333333';
const origins = { cardholder: 'http://127.0.0.1:4311', merchant: 'http://127.0.0.1:4312', admin: 'http://127.0.0.1:4313' };
function createScenario(portal) {
  const user = { userId: ID, merchantId: M, role: 'owner', country: 'CG', currency: 'XAF', businessName: 'Fixture Shop', email: 'fixture@example.test', firstName: 'Fixture', lastName: 'User' };
  const card = { cardId: CARD, balance: 25000, currency: 'XAF', status: 'active', cardMasked: '**** 0000', expiryMonth: 12, expiryYear: 2030 };
  const transfer = { transferId: ID, merchantId: M, merchant: 'Fixture Shop', reference: 'FIXTURE-PAY-1', direction: 'withdraw', destType: 'wallet', status: 'unknown',
    amount: 5000, fee: 50, net: 4950, currency: 'XAF', wallet: { operator: 'mtn_momo', phone: '+242060000001' },
    unknownSince: '2026-10-21T10:00:00Z', lastStatusCheckAt: '2026-10-21T10:01:00Z', createdAt: '2026-10-21T09:00:00Z', needsReview: true, events: [] };
  const state = { portal, user, card, transfer, authorized: false, expired: false, losePaymentResponse: false, refusePayment: false, pollStatus: 'unknown',
    posts: [], gets: [], effects: 0, outgoingCreated: false, paymentKeys: new Map(), failures: new Set() };
  const token = () => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: portal === 'merchant' ? user.userId : ID, merchantId: M, cardId: CARD,
    type: portal, role: portal === 'admin' ? 'ops_admin' : user.role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
  const session = () => ({ access_token: token(), mustChangePassword: false,
    user, admin: { adminId: ID, role: 'ops_admin', email: 'fixture@example.test', firstName: 'Fixture' },
    cardholder: { cardholderId: ID, firstName: 'Fixture', lastName: 'User', email: 'fixture@example.test' }, card });
  const summary = () => ({ currency: 'XAF', balance: { available: state.outgoingCreated && state.pollStatus !== 'failed' ? 95000 : 100000,
    reserved: state.outgoingCreated && state.pollStatus === 'unknown' ? 5000 : 0 }, fees: { withdraw: { percent: 1 }, transfer: { percent: 1 } },
    limits: { transferMin: 1000, withdrawDailyRemaining: state.outgoingCreated && state.pollStatus !== 'failed' ? 95000 : 100000, withdrawDailyLimit: 100000 } });
  async function handle(route) {
    const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname;
    const prefix = `/api/v1/${portal}`;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (state.failures.has(`${method} ${pathname}`)) return json({ error: 'Service de recette indisponible' }, 503);
    if (method === 'GET' && pathname === '/health') return json({ status: 'ok' });
    if (method === 'POST' && pathname === prefix + '/auth/login') { state.authorized = true; return json(session()); }
    if (method === 'POST' && pathname === prefix + '/auth/refresh') return state.authorized && !state.expired ? json(session()) : json({ error: 'Session expirée' }, 401);
    if (method === 'POST' && pathname === prefix + '/auth/logout') { state.authorized = false; return json({}); }
    if (method === 'GET' && pathname === '/api/v1/public/capabilities') return json({ countries: [{ code: 'CG', operations: { withdraw: { mobile_money: { status: 'active', operators: [{ operator: 'MTN_MOMO', status: 'active' }] } } } }] });
    const reads = ['/auth/me', '/auth/2fa/status', '/dashboard', '/cards/created', '/kyc', '/alerts', '/notifications', '/notifications/unread', '/cash/history', '/webhook-config', '/cash/summary', '/cash/wallet', '/bank-accounts', '/cash/transfers', `/cash/transfers/${ID}`, '/transactions', '/cash/stats', '/cash/reconcile/status', '/crm/stats', '/support/tickets', '/settlements/summary', '/stats/global', '/activity/live'];
    const writes = ['/payment', '/cash/withdraw', '/cash/transfers'];
    if (!(method === 'GET' && (pathname === '/api/v1/consent/check' || reads.some(p => pathname === prefix + p)))
      && !(method === 'POST' && writes.some(p => pathname === prefix + p))) return null;
    if (!state.authorized || state.expired) return json({ error: 'Session expirée' }, 401);
    if (method === 'GET') state.gets.push(pathname);
    if (pathname.endsWith('/auth/me')) return json(session());
    if (pathname === '/api/v1/consent/check') return json({ hasConsented: true });
    if (pathname.endsWith('/auth/2fa/status')) return json({ enabled: false, mfaEnabled: false });
    if (portal === 'cardholder' && pathname.endsWith('/cards/created')) return json({ data: [] });
    if (portal === 'cardholder' && pathname.endsWith('/kyc')) return json({ kyc_level: 2, documents: [{ status: 'approved' }] });
    if (pathname.endsWith('/dashboard')) return json({ balance: card.balance, currency: 'XAF', transactions: [], recentTransactions: [], stats: {}, card });
    if (pathname.endsWith('/notifications') || pathname.endsWith('/notifications/unread')) return json({ data: [], unread: 0, count: 0 });
    if (portal === 'cardholder' && pathname === '/api/v1/cardholder/payment' && method === 'POST') {
      const body = request.postDataJSON(), key = request.headers()['idempotency-key'];
      state.posts.push({ key, amount: body.amount, merchantId: body.merchantId }); // Never retain PIN or auth payload.
      if (state.refusePayment) return json({ error: 'Refus explicite de recette', code: 'INSUFFICIENT_BALANCE' }, 422);
      if (!key) return json({ error: 'Clé requise' }, 400);
      if (!state.paymentKeys.has(key)) {
        state.effects++; card.balance -= body.amount + Math.round(body.amount * 0.005);
        state.paymentKeys.set(key, { success: true, txn: { txnId: ID, reference: 'FIXTURE-COLLECT-1' }, newBalance: card.balance });
      }
      if (state.losePaymentResponse) { state.losePaymentResponse = false; return route.abort('connectionreset'); }
      return json(state.paymentKeys.get(key));
    }
    if (portal === 'merchant') {
      if (method === 'GET' && pathname === prefix + '/cash/history') return json({ data: [], total: 0 });
      if (method === 'GET' && pathname === prefix + '/webhook-config') return json({ webhook_url: null, webhook_secret: { configured: false } });
      if (pathname.endsWith('/cash/summary')) return json(summary());
      if (pathname.endsWith('/cash/wallet')) return json({ phone: '+242060000001', operator: 'mtn_momo', verified: true });
      if (pathname.endsWith('/bank-accounts')) return json({ data: [{ accountId: CARD, status: 'verified', accountNumber: 'FIXTURE-ACCOUNT', accountName: 'Fixture', institution: { name: 'Fixture Bank' } }] });
      if (method === 'POST' && ['/api/v1/merchant/cash/withdraw', '/api/v1/merchant/cash/transfers'].includes(pathname)) {
        const body = request.postDataJSON(); state.posts.push({ key: request.headers()['idempotency-key'], amount: body.amount });
        state.outgoingCreated = true;
        return json({ ...transfer, direction: pathname.endsWith('/withdraw') ? 'withdraw' : 'wallet_to_bank' }, 201);
      }
      if (pathname === `/api/v1/merchant/cash/transfers/${ID}`) return json({ ...transfer, status: state.pollStatus, needsReview: state.pollStatus === 'unknown' });
      if (pathname.endsWith('/cash/transfers') || pathname.endsWith('/transactions')) return json({ data: [], total: 0 });
    }
    if (portal === 'admin') {
      if (pathname.endsWith('/alerts')) return json({ data: [], total: 0 });
      if (pathname.endsWith('/crm/stats')) return json({});
      if (pathname.endsWith('/support/tickets')) return json({ data: [], total: 0 });
      if (pathname.endsWith('/settlements/summary')) return json({ pending: 0 });
      if (pathname.endsWith('/stats/global')) return json({});
      if (pathname.endsWith('/activity/live')) return json({ data: [] });
      if (pathname.endsWith('/cash/stats')) return json({ queues: { pendingManual: { count: 0, amount: 0 }, unknown: { count: 1, amount: 5000 }, needsReview: { count: 1, amount: 5000 } } });
      if (pathname.endsWith('/cash/reconcile/status')) return json({ enabled: true, scheduled: true, running: false, consecutiveFailures: 0, lastOutcome: 'success', lastSuccessfulAt: new Date().toISOString(), stages: { pending: { status: 'success' }, payouts: { status: 'success' }, repair: { status: 'success' } } });
      if (pathname === '/api/v1/admin/cash/transfers') return json({ data: [transfer], total: 1 });
      if (pathname === `/api/v1/admin/cash/transfers/${ID}`) return json(transfer);
    }
    return null;
  }
  return { state, handle, origin: origins[portal] };
}
module.exports = { createScenario, origins, M, ID };
