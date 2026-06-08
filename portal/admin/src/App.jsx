// CPlus 2.0 — Admin Portal
// pages: Login, Dashboard, ApiConfigs, Merchants, MerchantDetail, Terminals, Activity, AuditLogs

import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useParams, useNavigate } from 'react-router-dom';
import toast, { Toaster } from 'react-hot-toast';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { authApi, apiConfigsApi, merchantsApi, monitorApi, terminalsApi, auditApi } from './services/api';

// ─── Auth guard ────────────────────────────────────────────────────
const useAuth = () => {
  const token = localStorage.getItem('admin_token');
  const admin = token ? (() => { try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; } })() : null;
  return { isAuth: !!admin && admin.exp * 1000 > Date.now(), admin };
};

const Guard = ({ children }) => {
  const { isAuth } = useAuth();
  return isAuth ? children : <Navigate to="/login" replace />;
};

// ─── Layout ────────────────────────────────────────────────────────
const Layout = ({ children }) => {
  const { admin } = useAuth();
  const navigate = useNavigate();
  const logout = () => { localStorage.removeItem('admin_token'); navigate('/login'); };

  const nav = [
    { path: '/',          label: '📊 Dashboard' },
    { path: '/api-configs', label: '🔌 APIs & Opérateurs' },
    { path: '/merchants', label: '🏪 Marchands' },
    { path: '/terminals', label: '📱 Terminaux' },
    { path: '/activity',  label: '⚡ Activité Live' },
    { path: '/audit',     label: '📋 Audit Logs' },
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0a0c10', color: '#f0f4ff', fontFamily: 'system-ui, sans-serif' }}>
      {/* Sidebar */}
      <aside style={{ width: 240, background: '#141820', borderRight: '1px solid #1c2130', padding: '24px 0', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '0 20px 24px', borderBottom: '1px solid #1c2130' }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: '#00c896' }}>CPlus 2.0</div>
          <div style={{ fontSize: 12, color: '#8a94a8' }}>Administration</div>
        </div>
        <nav style={{ flex: 1, padding: '16px 0' }}>
          {nav.map(n => (
            <Link key={n.path} to={n.path} style={{
              display: 'block', padding: '10px 20px', color: window.location.pathname === n.path ? '#00c896' : '#8a94a8',
              textDecoration: 'none', fontSize: 14, fontWeight: window.location.pathname === n.path ? 600 : 400,
              background: window.location.pathname === n.path ? 'rgba(0,200,150,0.1)' : 'transparent',
            }}>{n.label}</Link>
          ))}
        </nav>
        <div style={{ padding: '16px 20px', borderTop: '1px solid #1c2130', fontSize: 13, color: '#8a94a8' }}>
          <div>{admin?.email}</div>
          <div style={{ color: '#00c896', fontSize: 11 }}>{admin?.role}</div>
          <button onClick={logout} style={{ marginTop: 8, background: 'none', border: '1px solid #2a3040', color: '#8a94a8', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Déconnexion</button>
        </div>
      </aside>

      {/* Main */}
      <main style={{ flex: 1, padding: 32, overflowY: 'auto' }}>{children}</main>
    </div>
  );
};

// ─── Composants communs ────────────────────────────────────────────
const Card = ({ children, style }) => (
  <div style={{ background: '#141820', border: '1px solid #1c2130', borderRadius: 12, padding: 20, ...style }}>{children}</div>
);

const Badge = ({ label, color }) => (
  <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: `${color}20`, color }}>{label}</span>
);

const statusColor = s => ({ active: '#00c896', inactive: '#8a94a8', testing: '#ff9500', error: '#ff3b30', suspended: '#ff3b30' }[s] || '#8a94a8');

const Spinner = () => <div style={{ textAlign: 'center', padding: 40, color: '#8a94a8' }}>Chargement…</div>;

const Input = ({ label, value, onChange, type = 'text', placeholder, readOnly }) => (
  <div style={{ marginBottom: 12 }}>
    {label && <label style={{ display: 'block', fontSize: 12, color: '#8a94a8', marginBottom: 4 }}>{label}</label>}
    <input type={type} value={value || ''} onChange={e => onChange?.(e.target.value)} placeholder={placeholder}
      readOnly={readOnly}
      style={{ width: '100%', background: '#0a0c10', border: '1px solid #2a3040', borderRadius: 8, padding: '8px 12px', color: readOnly ? '#8a94a8' : '#f0f4ff', fontSize: 14, boxSizing: 'border-box' }} />
  </div>
);

const Btn = ({ onClick, children, variant = 'primary', small, disabled }) => {
  const colors = { primary: '#00c896', danger: '#ff3b30', secondary: '#1c2130', warning: '#ff9500' };
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ background: colors[variant], color: variant === 'secondary' ? '#f0f4ff' : '#0a0c10', border: 'none', borderRadius: 8, padding: small ? '6px 14px' : '10px 20px', fontSize: small ? 12 : 14, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
      {children}
    </button>
  );
};

// ─── LOGIN ─────────────────────────────────────────────────────────
const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { isAuth } = useAuth();

  useEffect(() => { if (isAuth) navigate('/'); }, [isAuth, navigate]);

  const submit = async () => {
    setLoading(true);
    try {
      const { data } = await authApi.login({ email, password });
      localStorage.setItem('admin_token', data.access_token);
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Identifiants incorrects');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0a0c10', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#00c896' }}>CPlus 2.0</div>
          <div style={{ color: '#8a94a8', marginTop: 4 }}>Administration Platform</div>
        </div>
        <Card>
          <Input label="Email administrateur" value={email} onChange={setEmail} type="email" placeholder="admin@cplus.africa" />
          <Input label="Mot de passe" value={password} onChange={setPassword} type="password" placeholder="••••••••" />
          <Btn onClick={submit} disabled={loading} style={{ width: '100%', marginTop: 8 }}>
            {loading ? 'Connexion…' : 'Se connecter'}
          </Btn>
          <p style={{ fontSize: 12, color: '#8a94a8', marginTop: 12, textAlign: 'center' }}>
            Compte par défaut : admin@cplus.africa / Admin@CPlus2024
          </p>
        </Card>
      </div>
    </div>
  );
};

// ─── DASHBOARD ─────────────────────────────────────────────────────
const Dashboard = () => {
  const [stats, setStats] = useState(null);
  useEffect(() => { monitorApi.stats().then(r => setStats(r.data)).catch(() => {}); }, []);
  if (!stats) return <Spinner />;

  const COLORS = ['#00c896', '#0066ff', '#ff9500', '#ff3b30', '#a855f7'];

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24, fontWeight: 700 }}>Dashboard</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: "Transactions aujourd'hui", value: stats.today?.total || 0 },
          { label: 'Approuvées', value: stats.today?.approved || 0, color: '#00c896' },
          { label: 'Volume (aujourd\'hui)', value: `${(stats.today?.volume || 0).toLocaleString()} XAF` },
          { label: 'Marchands actifs', value: stats.merchants?.active || 0, color: '#0066ff' },
        ].map((s, i) => (
          <Card key={i}>
            <div style={{ fontSize: 12, color: '#8a94a8', marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color || '#f0f4ff' }}>{s.value}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Top Opérateurs (7 jours)</div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={stats.topOperators || []}>
              <XAxis dataKey="operator" tick={{ fill: '#8a94a8', fontSize: 11 }} />
              <YAxis tick={{ fill: '#8a94a8', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#141820', border: '1px solid #1c2130' }} />
              <Bar dataKey="count" fill="#00c896" radius={[4,4,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Répartition gateways</div>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={stats.gateways || []} dataKey="count" nameKey="gateway" cx="50%" cy="50%" outerRadius={70} label={({ gateway, percent }) => `${gateway} ${(percent*100).toFixed(0)}%`}>
                {(stats.gateways || []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: '#141820', border: '1px solid #1c2130' }} />
            </PieChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  );
};

// ─── API CONFIGS ───────────────────────────────────────────────────
const ApiConfigs = () => {
  const [configs, setConfigs] = useState([]);
  const [filter, setFilter] = useState({ type: '', country: '' });
  const [editing, setEditing] = useState(null);
  const [form, setForm]   = useState({});
  const [testing, setTesting] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await apiConfigsApi.list(filter); setConfigs(data.data); }
    catch { toast.error('Erreur chargement'); } finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const openEdit = async (config) => {
    try {
      const { data } = await apiConfigsApi.get(config.config_id);
      setForm({ baseUrl: data.base_url, apiKey: '', apiSecret: '', notes: data.notes, status: data.status, extraParams: JSON.stringify(data.extra_params || {}, null, 2) });
      setEditing(data);
    } catch { toast.error('Erreur'); }
  };

  const save = async () => {
    try {
      const payload = { baseUrl: form.baseUrl || undefined, notes: form.notes, status: form.status };
      if (form.apiKey)    payload.apiKey    = form.apiKey;
      if (form.apiSecret) payload.apiSecret = form.apiSecret;
      if (form.extraParams) { try { payload.extraParams = JSON.parse(form.extraParams); } catch { toast.error('JSON invalide'); return; } }
      await apiConfigsApi.update(editing.provider_key, payload);
      toast.success('Configuration sauvegardée');
      setEditing(null);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur sauvegarde'); }
  };

  const testConnection = async (key) => {
    setTesting(key);
    try {
      const { data } = await apiConfigsApi.test(key);
      toast[data.ok ? 'success' : 'error'](`${key}: ${data.ok ? 'Connexion OK' : (data.reason || 'Échec')}`);
      load();
    } catch { toast.error('Erreur test'); } finally { setTesting(null); }
  };

  const COUNTRIES = ['', 'SN', 'CI', 'CM', 'CG', 'CD'];

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24, fontWeight: 700 }}>APIs & Opérateurs</h1>

      {/* Filtres */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <select value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}
          style={{ background: '#141820', border: '1px solid #2a3040', color: '#f0f4ff', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>
          <option value="">Tous les types</option>
          <option value="mobile_money">Mobile Money</option>
          <option value="card_gateway">Gateways carte</option>
        </select>
        <select value={filter.country} onChange={e => setFilter(f => ({ ...f, country: e.target.value }))}
          style={{ background: '#141820', border: '1px solid #2a3040', color: '#f0f4ff', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>
          {COUNTRIES.map(c => <option key={c} value={c}>{c || 'Tous les pays'}</option>)}
        </select>
      </div>

      {/* Tableau */}
      {loading ? <Spinner /> : (
        <Card>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1c2130' }}>
                {['Provider', 'Pays', 'Type', 'URL de base', 'Clé API', 'Statut', 'Dernier test', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 12, color: '#8a94a8', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {configs.map(c => (
                <tr key={c.config_id} style={{ borderBottom: '1px solid #1c2130' }}>
                  <td style={{ padding: '12px', fontSize: 13, fontWeight: 500 }}>{c.display_name}</td>
                  <td style={{ padding: '12px', fontSize: 13, color: '#8a94a8' }}>{c.country || '🌍'}</td>
                  <td style={{ padding: '12px', fontSize: 12, color: '#8a94a8' }}>{c.provider_type}</td>
                  <td style={{ padding: '12px', fontSize: 12, color: '#8a94a8', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.base_url || '—'}</td>
                  <td style={{ padding: '12px', fontSize: 12, color: '#8a94a8' }}>{c.api_key_masked || '—'}</td>
                  <td style={{ padding: '12px' }}><Badge label={c.status} color={statusColor(c.status)} /></td>
                  <td style={{ padding: '12px', fontSize: 11, color: '#8a94a8' }}>
                    {c.last_tested_at ? new Date(c.last_tested_at).toLocaleString('fr') : '—'}
                    {c.last_tested_at && <span style={{ color: c.last_test_ok ? '#00c896' : '#ff3b30', marginLeft: 4 }}>{c.last_test_ok ? '✓' : '✗'}</span>}
                  </td>
                  <td style={{ padding: '12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Btn small onClick={() => openEdit(c)} variant="secondary">Configurer</Btn>
                      <Btn small onClick={() => testConnection(c.provider_key)} disabled={testing === c.provider_key} variant="warning">
                        {testing === c.provider_key ? '…' : 'Tester'}
                      </Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Modal édition */}
      {editing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <Card style={{ width: 520, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Configurer : {editing.display_name}</h2>
              <button onClick={() => setEditing(null)} style={{ background: 'none', border: 'none', color: '#8a94a8', cursor: 'pointer', fontSize: 20 }}>✕</button>
            </div>

            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#0a0c10', borderRadius: 6, fontSize: 12, color: '#8a94a8' }}>
              Provider : <span style={{ color: '#00c896' }}>{editing.provider_key}</span> · Pays : {editing.country || 'Global'}
            </div>

            <Input label="URL de base" value={form.baseUrl} onChange={v => setForm(f => ({ ...f, baseUrl: v }))} placeholder="https://api.example.com" />
            <Input label="Clé API (laisser vide pour ne pas modifier)" value={form.apiKey} onChange={v => setForm(f => ({ ...f, apiKey: v }))} type="password" placeholder="Nouvelle clé API" />
            <Input label="Secret API (laisser vide pour ne pas modifier)" value={form.apiSecret} onChange={v => setForm(f => ({ ...f, apiSecret: v }))} type="password" placeholder="Nouveau secret" />

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#8a94a8', marginBottom: 4 }}>Paramètres additionnels (JSON)</label>
              <textarea value={form.extraParams} onChange={e => setForm(f => ({ ...f, extraParams: e.target.value }))}
                rows={4} style={{ width: '100%', background: '#0a0c10', border: '1px solid #2a3040', borderRadius: 8, padding: '8px 12px', color: '#f0f4ff', fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#8a94a8', marginBottom: 4 }}>Statut</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                style={{ background: '#0a0c10', border: '1px solid #2a3040', color: '#f0f4ff', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>
                <option value="inactive">Inactif</option>
                <option value="active">Actif</option>
                <option value="testing">Test</option>
              </select>
            </div>

            <Input label="Notes internes" value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} placeholder="Remarques, contacts, etc." />

            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
              <Btn variant="secondary" onClick={() => setEditing(null)}>Annuler</Btn>
              <Btn onClick={save}>Sauvegarder</Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

// ─── MARCHANDS ─────────────────────────────────────────────────────
const Merchants = () => {
  const [merchants, setMerchants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [page, setPage]       = useState(1);
  const [total, setTotal]     = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    merchantsApi.list({ page, limit: 20, search: search || undefined })
      .then(r => { setMerchants(r.data.data); setTotal(r.data.total); })
      .catch(() => toast.error('Erreur'))
      .finally(() => setLoading(false));
  }, [page, search]);

  const setStatus = async (id, status) => {
    const reason = status === 'suspended' ? prompt('Raison de la suspension :') : undefined;
    try {
      await merchantsApi.setStatus(id, { status, reason });
      toast.success('Statut mis à jour');
      merchantsApi.list({ page, limit: 20 }).then(r => setMerchants(r.data.data));
    } catch { toast.error('Erreur'); }
  };

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24, fontWeight: 700 }}>Marchands <span style={{ fontSize: 16, color: '#8a94a8' }}>({total})</span></h1>

      <div style={{ marginBottom: 16 }}>
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Rechercher par nom, email, téléphone…"
          style={{ width: 320, background: '#141820', border: '1px solid #2a3040', color: '#f0f4ff', padding: '10px 14px', borderRadius: 8, fontSize: 14 }} />
      </div>

      {loading ? <Spinner /> : (
        <Card>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1c2130' }}>
                {['Entreprise', 'Pays', 'Email', 'KYB', 'Statut', 'Transactions', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 12, color: '#8a94a8' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {merchants.map(m => (
                <tr key={m.merchant_id} style={{ borderBottom: '1px solid #1c2130' }}>
                  <td style={{ padding: '12px', fontSize: 13, fontWeight: 500 }}>{m.business_name}</td>
                  <td style={{ padding: '12px', fontSize: 13 }}>{m.country} · {m.currency}</td>
                  <td style={{ padding: '12px', fontSize: 12, color: '#8a94a8' }}>{m.email}</td>
                  <td style={{ padding: '12px' }}><Badge label={`Niveau ${m.kyb_level}`} color={['#8a94a8','#ff9500','#00c896'][m.kyb_level] || '#8a94a8'} /></td>
                  <td style={{ padding: '12px' }}><Badge label={m.merchant_status} color={statusColor(m.merchant_status)} /></td>
                  <td style={{ padding: '12px', fontSize: 13 }}>{parseInt(m.txn_count || 0).toLocaleString()}</td>
                  <td style={{ padding: '12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Btn small variant="secondary" onClick={() => navigate(`/merchants/${m.merchant_id}`)}>Détail</Btn>
                      {m.merchant_status === 'active' ? (
                        <Btn small variant="danger" onClick={() => setStatus(m.merchant_id, 'suspended')}>Suspendre</Btn>
                      ) : (
                        <Btn small onClick={() => setStatus(m.merchant_id, 'active')}>Activer</Btn>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <Btn small variant="secondary" onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1}>← Préc.</Btn>
            <span style={{ padding: '6px 12px', fontSize: 13, color: '#8a94a8' }}>Page {page}</span>
            <Btn small variant="secondary" onClick={() => setPage(p => p+1)} disabled={merchants.length < 20}>Suiv. →</Btn>
          </div>
        </Card>
      )}
    </div>
  );
};

// ─── MERCHANT DETAIL ───────────────────────────────────────────────
const MerchantDetail = () => {
  const { id } = useParams();
  const [merchant, setMerchant] = useState(null);
  const [kybLevel, setKybLevel] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    merchantsApi.get(id).then(r => { setMerchant(r.data); setKybLevel(String(r.data.kyb_level)); }).catch(() => toast.error('Introuvable'));
  }, [id]);

  const updateKyb = async () => {
    try { await merchantsApi.setKyb(id, { kybLevel: parseInt(kybLevel) }); toast.success('KYB mis à jour'); }
    catch { toast.error('Erreur'); }
  };

  if (!merchant) return <Spinner />;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <Btn small variant="secondary" onClick={() => navigate('/merchants')}>← Retour</Btn>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{merchant.business_name}</h1>
        <Badge label={merchant.merchant_status} color={statusColor(merchant.merchant_status)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 20 }}>
        {[
          { label: 'Transactions totales', value: merchant.total_txn || 0 },
          { label: 'Volume total', value: `${parseFloat(merchant.total_volume || 0).toLocaleString()} ${merchant.currency}` },
          { label: 'Terminaux', value: merchant.terminal_count || 0, color: '#0066ff' },
        ].map((s, i) => (
          <Card key={i}>
            <div style={{ fontSize: 12, color: '#8a94a8', marginBottom: 4 }}>{s.label}</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: s.color || '#f0f4ff' }}>{s.value}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card>
          <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>Informations</h3>
          {[['Pays', `${merchant.country} — ${merchant.currency}`], ['Email', merchant.email], ['Téléphone', merchant.phone], ['RCCM', merchant.rccm || '—'], ['NIF', merchant.nif || '—'], ['Règlement', `${merchant.settlement_type} — ${merchant.settlement_account || '—'}`]].map(([l, v]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #1c2130', fontSize: 13 }}>
              <span style={{ color: '#8a94a8' }}>{l}</span>
              <span>{v}</span>
            </div>
          ))}
        </Card>

        <Card>
          <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>KYB & Niveaux</h3>
          <div style={{ marginBottom: 12 }}>
            {[0,1,2].map(l => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #1c2130' }}>
                <span style={{ fontSize: 13, flex: 1 }}>Niveau {l} — {['Compte créé (500k XAF/j)', 'KYB validé (5M XAF/j)', 'Contrat (illimité)'][l]}</span>
                {parseInt(merchant.kyb_level) >= l && <span style={{ color: '#00c896' }}>✓</span>}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <select value={kybLevel} onChange={e => setKybLevel(e.target.value)}
              style={{ flex: 1, background: '#0a0c10', border: '1px solid #2a3040', color: '#f0f4ff', padding: '8px', borderRadius: 8 }}>
              <option value="0">Niveau 0</option>
              <option value="1">Niveau 1</option>
              <option value="2">Niveau 2</option>
            </select>
            <Btn small onClick={updateKyb}>Appliquer</Btn>
          </div>
        </Card>
      </div>
    </div>
  );
};

// ─── ACTIVITÉ LIVE ─────────────────────────────────────────────────
const Activity = () => {
  const [txns, setTxns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(() => {
    monitorApi.live().then(r => { setTxns(r.data.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load, autoRefresh]);

  const statusCl = s => ({ authorized: '#00c896', failed: '#ff3b30', pending: '#ff9500' }[s] || '#8a94a8');

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>Activité Live</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#8a94a8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            Actualisation auto (10s)
          </label>
          <Btn small variant="secondary" onClick={load}>↻ Actualiser</Btn>
        </div>
      </div>

      {loading ? <Spinner /> : (
        <Card>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1c2130' }}>
                {['Heure', 'Marchand', 'Pays', 'Méthode', 'Opérateur/Réseau', 'Montant', 'Statut'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 12, color: '#8a94a8' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {txns.map(t => (
                <tr key={t.transaction_id} style={{ borderBottom: '1px solid #1c2130' }}>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#8a94a8' }}>{new Date(t.initiated_at).toLocaleTimeString('fr')}</td>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>{t.business_name}</td>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>{t.country || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#8a94a8' }}>{t.payment_method}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#8a94a8' }}>{t.detected_operator || t.detected_network || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600 }}>{parseFloat(t.amount).toLocaleString()} {t.currency}</td>
                  <td style={{ padding: '10px 12px' }}><Badge label={t.status} color={statusCl(t.status)} /></td>
                </tr>
              ))}
              {txns.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#8a94a8' }}>Aucune transaction sur les dernières 24h</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
};

// ─── TERMINAUX (admin) ─────────────────────────────────────────────
const Terminals = () => {
  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    terminalsApi.list().then(r => { setTerminals(r.data.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const setStatus = async (id, status) => {
    await terminalsApi.setStatus(id, { status });
    toast.success('Statut mis à jour');
    terminalsApi.list().then(r => setTerminals(r.data.data));
  };

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24, fontWeight: 700 }}>Terminaux</h1>
      {loading ? <Spinner /> : (
        <Card>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1c2130' }}>
                {['Code', 'Nom', 'Marchand', 'Modèle', 'Version App', 'Vu le', 'Statut', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 12, color: '#8a94a8' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {terminals.map(t => (
                <tr key={t.terminal_id} style={{ borderBottom: '1px solid #1c2130' }}>
                  <td style={{ padding: '10px 12px', fontSize: 12, fontFamily: 'monospace', color: '#00c896' }}>{t.terminal_code}</td>
                  <td style={{ padding: '10px 12px', fontSize: 13 }}>{t.terminal_name}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#8a94a8' }}>{t.business_name}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#8a94a8' }}>{t.device_model || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}>{t.app_version || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#8a94a8' }}>{t.last_seen_at ? new Date(t.last_seen_at).toLocaleString('fr') : 'Jamais'}</td>
                  <td style={{ padding: '10px 12px' }}><Badge label={t.status} color={statusColor(t.status)} /></td>
                  <td style={{ padding: '10px 12px' }}>
                    {t.status === 'active' ?
                      <Btn small variant="danger" onClick={() => setStatus(t.terminal_id, 'blocked')}>Bloquer</Btn> :
                      <Btn small onClick={() => setStatus(t.terminal_id, 'active')}>Activer</Btn>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
};

// ─── AUDIT LOGS ────────────────────────────────────────────────────
const AuditLogs = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    auditApi.list().then(r => { setLogs(r.data.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 style={{ margin: '0 0 24px', fontSize: 24, fontWeight: 700 }}>Audit Logs</h1>
      {loading ? <Spinner /> : (
        <Card>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #1c2130' }}>
                {['Date', 'Acteur', 'Rôle', 'Action', 'Entité', 'IP'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 12, color: '#8a94a8' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.log_id} style={{ borderBottom: '1px solid #1c2130' }}>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#8a94a8' }}>{new Date(l.created_at).toLocaleString('fr')}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}>{l.actor_email || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 11 }}><Badge label={l.actor_type} color="#0066ff" /></td>
                  <td style={{ padding: '10px 12px', fontSize: 12, fontFamily: 'monospace', color: '#ff9500' }}>{l.action}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#8a94a8' }}>{l.entity_type || '—'}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: '#8a94a8' }}>{l.ip_address || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
};

// ─── APP ───────────────────────────────────────────────────────────
export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-right" toastOptions={{ style: { background: '#141820', color: '#f0f4ff', border: '1px solid #1c2130' } }} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<Guard><Layout><Routes>
          <Route path="/"              element={<Dashboard />} />
          <Route path="/api-configs"   element={<ApiConfigs />} />
          <Route path="/merchants"     element={<Merchants />} />
          <Route path="/merchants/:id" element={<MerchantDetail />} />
          <Route path="/terminals"     element={<Terminals />} />
          <Route path="/activity"      element={<Activity />} />
          <Route path="/audit"         element={<AuditLogs />} />
        </Routes></Layout></Guard>} />
      </Routes>
    </BrowserRouter>
  );
}
