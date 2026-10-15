'use strict';
/** Vague 2 — assistant vitrine, leads, réclamations, back office CRM (SDK Anthropic et DB mockés) */
process.env.ANTHROPIC_API_KEY = 'test-key';
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() }));

const mockQuery = jest.fn();
jest.mock('../config/database', () => ({ query: (...a) => mockQuery(...a), withTransaction: jest.fn() }));

// Faux SDK : séquence de réponses programmable
const scripted = { responses: [], calls: [] };
const makeStream = (msg) => {
  const handlers = {};
  return {
    on: (ev, fn) => { handlers[ev] = fn; return this; },
    abort: jest.fn(),
    finalMessage: async () => {
      for (const b of msg.content) if (b.type === 'text' && handlers.text) handlers.text(b.text);
      return msg;
    },
  };
};
jest.mock('@anthropic-ai/sdk', () => {
  function Anthropic() {
    const stream = (params) => { scripted.calls.push(params); return makeStream(scripted.responses.shift()); };
    this.messages = { stream };
    this.beta = { messages: { stream } };
  }
  return Anthropic;
});

jest.mock('../middleware/auth', () => ({
  requireRole: (...roles) => (req, res, next) => {
    const role = req.headers['x-test-role'];
    if (!role) return res.status(401).json({ error: 'no auth' });
    if (!roles.includes(role)) return res.status(403).json({ error: 'role' });
    req.user = { sub: 'a1', role, type: 'admin' }; next();
  },
}));

const express = require('express');
const request = require('supertest');
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/api/v1/public', require('../routes/public-crm.routes'));
app.use('/api/v1/admin/crm', require('../routes/crm-admin.routes'));

const CONV = '11111111-1111-4111-8111-111111111111';
const dbDefault = async (sql) => {
  if (sql.includes('INSERT INTO assistant_conversations')) return { rows: [{ conversation_id: CONV }] };
  if (sql.includes('SELECT message_count FROM assistant_conversations')) return { rows: [{ message_count: 2 }] };
  if (sql.includes('SELECT conversation_id FROM assistant_conversations')) return { rows: [{ conversation_id: CONV }] };
  if (sql.includes('FROM assistant_messages WHERE conversation_id = $1 AND role IN')) return { rows: [{ role: 'user', content: 'Bonjour' }] };
  if (sql.includes('INSERT INTO assistant_messages')) return { rows: [{ message_id: 'm-1' }] };
  if (sql.includes('INSERT INTO crm_leads')) return { rows: [{ lead_id: 'lead-1' }] };
  if (sql.includes('INSERT INTO crm_claims')) return { rows: [{ claim_id: 'claim-1' }] };
  return { rows: [], rowCount: 1 };
};
beforeEach(() => { mockQuery.mockReset(); mockQuery.mockImplementation(dbDefault); scripted.responses = []; scripted.calls = []; });

const textMsg = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } });
const toolMsg = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name, input }], usage: { input_tokens: 10, output_tokens: 5 } });

describe('assistant', () => {
  test('création de conversation', async () => {
    const r = await request(app).post('/api/v1/public/assistant/conversations').send({ locale: 'fr', page: '/' });
    expect(r.status).toBe(201); expect(r.body.conversationId).toBe(CONV);
  });
  test('réponse simple (non stream), prompt système caché, outils stricts, repli serveur', async () => {
    scripted.responses = [textMsg('Bonjour, comment puis-je vous aider ?')];
    const r = await request(app).post(`/api/v1/public/assistant/conversations/${CONV}/messages?stream=0`).send({ message: 'Bonjour' });
    expect(r.status).toBe(200); expect(r.body.reply).toContain('Bonjour');
    const p = scripted.calls[0];
    expect(p.model).toBe('claude-opus-5-5'); expect(p.output_config.effort).toBe('low');
    expect(p.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(p.tools.every(t => t.strict === true && t.input_schema.additionalProperties === false)).toBe(true);
    expect(p.betas).toContain('server-side-fallback-2026-07-01'); expect(p.fallbacks).toBe('default');
    expect(p.messages[p.messages.length - 1]).toEqual({ role: 'user', content: 'Bonjour' });
    expect(JSON.stringify(p.system)).not.toMatch(/PCI DSS certifi/);
  });
  test('boucle outil : create_lead avec consentement → lead enregistré et renvoyé', async () => {
    scripted.responses = [
      toolMsg('create_lead', { name: 'Awa Diop', email: 'awa@ex.com', phone: '', company: 'Boutique Awa', country: 'sn', interest: 'merchant', summary: 'Encaissement MoMo', consent: true }),
      textMsg('Merci Awa, un conseiller vous recontactera.'),
    ];
    const r = await request(app).post(`/api/v1/public/assistant/conversations/${CONV}/messages?stream=0`).send({ message: 'oui je suis d’accord' });
    expect(r.status).toBe(200); expect(r.body.leadId).toBe('lead-1');
    const ins = mockQuery.mock.calls.find(c => c[0].includes('INSERT INTO crm_leads'));
    expect(ins[1]).toEqual(expect.arrayContaining(['Awa Diop', 'awa@ex.com', 'SN', 'merchant', CONV]));
    // le résultat de l'outil est renvoyé au modèle
    const second = scripted.calls[1].messages;
    expect(second[second.length - 1].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1' });
  });
  test('create_lead sans consentement → outil en erreur, aucun INSERT', async () => {
    scripted.responses = [toolMsg('create_lead', { name: 'X', email: 'x@y.z', phone: '', company: '', country: '', interest: 'other', summary: 's', consent: false }), textMsg('Puis-je vous recontacter ?')];
    await request(app).post(`/api/v1/public/assistant/conversations/${CONV}/messages?stream=0`).send({ message: 'infos' });
    expect(mockQuery.mock.calls.some(c => c[0].includes('INSERT INTO crm_leads'))).toBe(false);
    const second = scripted.calls[1].messages; expect(second[second.length - 1].content[0].is_error).toBe(true);
  });
  test('create_claim → référence REC-', async () => {
    scripted.responses = [toolMsg('create_claim', { name: 'Paul', email: 'p@ex.com', phone: '', category: 'payment', description: 'Débité deux fois le 12/10', merchantRef: '', transactionRef: '' }), textMsg('Votre réclamation est ouverte.')];
    const r = await request(app).post(`/api/v1/public/assistant/conversations/${CONV}/messages?stream=0`).send({ message: 'réclamation' });
    expect(r.body.claimId).toBe('claim-1'); expect(r.body.claimReference).toMatch(/^REC-[A-Z2-9]{6}$/);
  });
  test('refus du modèle → message de repli, pas de crash', async () => {
    scripted.responses = [{ stop_reason: 'refusal', content: [], usage: {} }];
    const r = await request(app).post(`/api/v1/public/assistant/conversations/${CONV}/messages?stream=0`).send({ message: '…' });
    expect(r.status).toBe(200); expect(r.body.reply).toContain('support@c-pay.global');
  });
  test('flux SSE : événements token puis done', async () => {
    scripted.responses = [textMsg('Salut !')];
    const r = await request(app).post(`/api/v1/public/assistant/conversations/${CONV}/messages`).send({ message: 'hey' });
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    expect(r.text).toContain('event: token'); expect(r.text).toContain('"text":"Salut !"'); expect(r.text).toContain('event: done');
  });
  test('validation et limites', async () => {
    expect((await request(app).post(`/api/v1/public/assistant/conversations/${CONV}/messages?stream=0`).send({ message: '' })).status).toBe(422);
    expect((await request(app).post(`/api/v1/public/assistant/conversations/not-a-uuid/messages`).send({ message: 'x' })).status).toBe(404);
    mockQuery.mockImplementation(async (sql) => sql.includes('SELECT message_count') ? { rows: [{ message_count: 500 }] } : dbDefault(sql));
    expect((await request(app).post(`/api/v1/public/assistant/conversations/${CONV}/messages?stream=0`).send({ message: 'x' })).status).toBe(429);
  });
  test('assistant désactivé sans clé API → 503', async () => {
    const key = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    expect((await request(app).post('/api/v1/public/assistant/conversations').send({})).status).toBe(503);
    process.env.ANTHROPIC_API_KEY = key;
  });
});

describe('formulaires', () => {
  test('lead : validation puis succès', async () => {
    const bad = await request(app).post('/api/v1/public/leads').send({ name: 'A', email: 'nope' });
    expect(bad.status).toBe(422); expect(bad.body.details.map(d => d.path)).toEqual(expect.arrayContaining(['name', 'email', 'consent']));
    const ok = await request(app).post('/api/v1/public/leads').send({ name: 'Moussa K', email: 'M@Ex.com', country: 'cm', interest: 'merchant', consent: true, source: 'hero' });
    expect(ok.status).toBe(201); expect(ok.body.leadId).toBe('lead-1');
    const ins = mockQuery.mock.calls.find(c => c[0].includes('INSERT INTO crm_leads')); expect(ins[1]).toEqual(expect.arrayContaining(['m@ex.com', 'CM', 'hero']));
  });
  test('honeypot : pas d’insertion', async () => {
    const r = await request(app).post('/api/v1/public/leads').send({ name: 'Bot', email: 'b@b.co', consent: true, website: 'http://spam' });
    expect(r.status).toBe(201); expect(mockQuery).not.toHaveBeenCalled();
  });
  test('réclamation : référence renvoyée', async () => {
    const r = await request(app).post('/api/v1/public/claims').send({ name: 'Fatou', email: 'f@ex.com', category: 'settlement', description: 'Règlement du 10/10 non reçu', consent: true });
    expect(r.status).toBe(201); expect(r.body.reference).toMatch(/^REC-/);
  });
});

describe('back office CRM', () => {
  test('rôles : support_agent OK, autre rôle 403, sans auth 401', async () => {
    mockQuery.mockResolvedValue({ rows: [{ new: 1, total: 2, last7d: 1, open: 0, handoffs: 0 }] });
    expect((await request(app).get('/api/v1/admin/crm/stats').set('x-test-role', 'support_agent')).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/crm/stats').set('x-test-role', 'finance_admin')).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/crm/stats')).status).toBe(401);
  });
  test('liste et mise à jour des leads', async () => {
    mockQuery.mockImplementation(async (sql) => sql.includes('COUNT(*)') ? { rows: [{ n: 1 }] } : { rows: [{ lead_id: 'lead-1', status: 'new' }] });
    const list = await request(app).get('/api/v1/admin/crm/leads?status=new&q=awa&limit=500').set('x-test-role', 'ops_admin');
    expect(list.status).toBe(200); expect(list.body.limit).toBe(100); expect(list.body.total).toBe(1);
    expect((await request(app).patch('/api/v1/admin/crm/leads/' + CONV).set('x-test-role', 'ops_admin').send({ status: 'bogus' })).status).toBe(422);
    expect((await request(app).patch('/api/v1/admin/crm/leads/' + CONV).set('x-test-role', 'ops_admin').send({ status: 'contacted', notes: 'appelé' })).status).toBe(200);
  });

  // WAVE-3 : PATCH — absent = inchangé, null/"" = effacé, valeur = remplacée (plus de COALESCE)
  const ADMIN = '33333333-3333-4333-8333-333333333333';
  const patchLead = (body) => request(app).patch('/api/v1/admin/crm/leads/' + CONV).set('x-test-role', 'ops_admin').send(body);
  const patchClaim = (body) => request(app).patch('/api/v1/admin/crm/claims/' + CONV).set('x-test-role', 'ops_admin').send(body);
  const lastUpdate = () => mockQuery.mock.calls.filter(([s]) => /^UPDATE crm_/.test(s)).at(-1);

  test('leads : assignedTo null → assigned_to = NULL ; absent → inchangé ; uuid → remplacé ; notes "" → NULL', async () => {
    mockQuery.mockResolvedValue({ rows: [{ lead_id: 'lead-1' }] });
    expect((await patchLead({ assignedTo: null })).status).toBe(200);
    let [sql, params] = lastUpdate();
    expect(sql).toMatch(/SET assigned_to = \$1::uuid, updated_at = NOW\(\) WHERE lead_id = \$2/);
    expect(sql).not.toMatch(/COALESCE/); expect(params).toEqual([null, CONV]);

    expect((await patchLead({ status: 'contacted' })).status).toBe(200);
    [sql, params] = lastUpdate();
    expect(sql).not.toMatch(/assigned_to|notes/); expect(params).toEqual(['contacted', CONV]);

    expect((await patchLead({ assignedTo: ADMIN, notes: '' })).status).toBe(200);
    [sql, params] = lastUpdate();
    expect(sql).toMatch(/assigned_to = \$1::uuid, notes = \$2/); expect(params).toEqual([ADMIN, null, CONV]);

    expect((await patchLead({ assignedTo: 'nope' })).status).toBe(422);
    expect((await patchLead({ notes: 42 })).status).toBe(422);
    expect((await patchLead({})).status).toBe(422);
  });

  test('réclamations : désassignation, resolution null, resolved_at posé sur resolved/closed', async () => {
    mockQuery.mockResolvedValue({ rows: [{ claim_id: 'claim-1' }] });
    expect((await patchClaim({ status: 'resolved', assignedTo: null, resolution: null })).status).toBe(200);
    const [sql, params] = lastUpdate();
    expect(sql).toMatch(/status = \$1, assigned_to = \$2::uuid, resolution = \$3, resolved_at = COALESCE\(resolved_at, NOW\(\)\), updated_at = NOW\(\)/);
    expect(params).toEqual(['resolved', null, null, CONV]);
    expect((await patchClaim({ status: 'in_progress' })).status).toBe(200);
    expect(lastUpdate()[0]).not.toMatch(/resolved_at = COALESCE/);
    mockQuery.mockResolvedValue({ rows: [] });
    expect((await patchClaim({ assignedTo: null })).status).toBe(404);
  });
});
