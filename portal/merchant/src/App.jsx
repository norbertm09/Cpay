// CPlus 2.0 — Merchant Portal
// Pages: Login, Dashboard, Transactions, TransactionDetail, Settlements, Account, Terminals

import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import toast, { Toaster } from 'react-hot-toast';

// ─── API service ──────────────────────────────────────────────────
const api = axios.create({ baseURL: '/api/v1/merchant' });
api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('merchant_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});
api.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) { localStorage.removeItem('merchant_token'); window.location.href = '/login'; }
  return Promise.reject(err);
});

// ─── Auth ─────────────────────────────────────────────────────────
const useAuth = () => {
  const token = localStorage.getItem('merchant_token');
  const user  = token ? (() => { try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; } })() : null;
  return { isAuth: !!user && user.exp * 1000 > Date.now(), user };
};
const Guard = ({ children }) => { const { isAuth } = useAuth(); return isAuth ? children : <Navigate to="/login" replace />; };

// ─── Palette ──────────────────────────────────────────────────────
const G = '#00c896', BG = '#0a0c10', CARD = '#141820', BORDER = '#1c2130', TEXT = '#f0f4ff', MUTED = '#8a94a8';

// ─── Composants ───────────────────────────────────────────────────
const Card = ({ children, style }) => <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, ...style }}>{children}</div>;
const Badge = ({ label, color = MUTED }) => <span style={{ display:'inline-block', padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:600, background:`${color}20`, color }}>{label}</span>;
const Spinner = () => <div style={{ textAlign:'center', padding:40, color:MUTED }}>Chargement…</div>;
const Btn = ({ children, onClick, variant='primary', small, disabled }) => {
  const c = { primary:G, danger:'#ff3b30', secondary:BORDER, outline:'transparent' }[variant];
  return <button onClick={onClick} disabled={disabled} style={{ background:c, color:variant==='outline'?G:variant==='secondary'?TEXT:BG, border:`1px solid ${variant==='outline'?G:c}`, borderRadius:8, padding:small?'6px 14px':'10px 20px', fontSize:small?12:14, fontWeight:600, cursor:disabled?'not-allowed':'pointer', opacity:disabled?0.6:1 }}>{children}</button>;
};
const statusColor = s => ({ authorized:'#00c896', failed:'#ff3b30', pending:'#ff9500', active:'#00c896', inactive:MUTED, blocked:'#ff3b30' }[s]||MUTED);

// ─── Layout ────────────────────────────────────────────────────────
const Layout = ({ children }) => {
  const { user } = useAuth();
  const navigate  = useNavigate();
  const decoded   = user ? JSON.parse(atob(localStorage.getItem('merchant_token').split('.')[1])) : {};
  const [bizName, setBizName] = useState(decoded.businessName || '');

  useEffect(() => { api.get('/account').then(r => setBizName(r.data.business_name)).catch(() => {}); }, []);

  const nav = [
    { path:'/',             label:'📊 Dashboard' },
    { path:'/transactions', label:'💳 Transactions' },
    { path:'/settlements',  label:'🏦 Règlements' },
    { path:'/terminals',    label:'📱 Terminaux' },
    { path:'/account',      label:'⚙️ Mon compte' },
  ];

  return (
    <div style={{ display:'flex', minHeight:'100vh', background:BG, color:TEXT, fontFamily:'system-ui, sans-serif' }}>
      <aside style={{ width:220, background:CARD, borderRight:`1px solid ${BORDER}`, padding:'24px 0', display:'flex', flexDirection:'column' }}>
        <div style={{ padding:'0 20px 20px', borderBottom:`1px solid ${BORDER}` }}>
          <div style={{ fontSize:18, fontWeight:800, color:G }}>CPlus 2.0</div>
          <div style={{ fontSize:12, color:MUTED, marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{bizName}</div>
        </div>
        <nav style={{ flex:1, padding:'12px 0' }}>
          {nav.map(n => <Link key={n.path} to={n.path} style={{ display:'block', padding:'10px 20px', color:window.location.pathname===n.path?G:MUTED, textDecoration:'none', fontSize:14, fontWeight:window.location.pathname===n.path?600:400, background:window.location.pathname===n.path?`${G}10`:'transparent' }}>{n.label}</Link>)}
        </nav>
        <div style={{ padding:'16px 20px', borderTop:`1px solid ${BORDER}` }}>
          <button onClick={() => { localStorage.removeItem('merchant_token'); navigate('/login'); }} style={{ background:'none', border:`1px solid ${BORDER}`, color:MUTED, padding:'6px 12px', borderRadius:6, cursor:'pointer', fontSize:12 }}>Déconnexion</button>
        </div>
      </aside>
      <main style={{ flex:1, padding:28, overflowY:'auto' }}>{children}</main>
    </div>
  );
};

// ─── LOGIN ─────────────────────────────────────────────────────────
const Login = () => {
  const [creds, setCreds] = useState({ emailOrPhone:'', password:'' });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { isAuth } = useAuth();
  useEffect(() => { if (isAuth) navigate('/'); }, [isAuth, navigate]);

  const submit = async () => {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', creds);
      localStorage.setItem('merchant_token', data.access_token);
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Identifiants incorrects');
    } finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight:'100vh', background:BG, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ width:380 }}>
        <div style={{ textAlign:'center', marginBottom:28 }}>
          <div style={{ fontSize:26, fontWeight:800, color:G }}>CPlus 2.0</div>
          <div style={{ color:MUTED, marginTop:4 }}>Espace Marchand</div>
        </div>
        <Card>
          {[['Email ou téléphone','emailOrPhone','text'],['Mot de passe','password','password']].map(([l,k,t]) => (
            <div key={k} style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{l}</label>
              <input type={t} value={creds[k]} onChange={e => setCreds(c => ({ ...c, [k]:e.target.value }))}
                style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'9px 12px', color:TEXT, fontSize:14, boxSizing:'border-box' }} />
            </div>
          ))}
          <Btn onClick={submit} disabled={loading} style={{ width:'100%', marginTop:4 }}>{loading?'Connexion…':'Se connecter'}</Btn>
        </Card>
      </div>
    </div>
  );
};

// ─── DASHBOARD ─────────────────────────────────────────────────────
const Dashboard = () => {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/dashboard').then(r => setData(r.data)).catch(() => {}); }, []);
  if (!data) return <Spinner />;

  const cards = [
    { label:"Transactions aujourd'hui", value:data.today?.txn_count||0 },
    { label:"Volume aujourd'hui",        value:`${parseFloat(data.today?.volume||0).toLocaleString()}`, color:G },
    { label:"Volume ce mois",            value:`${parseFloat(data.thisMonth?.volume||0).toLocaleString()}` },
    { label:"Règlement J+1",             value:`${parseFloat(data.settlingTomorrow||0).toLocaleString()}`, color:'#ff9500' },
  ];

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>Tableau de bord</h1>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:20 }}>
        {cards.map((c,i) => (
          <Card key={i}>
            <div style={{ fontSize:12, color:MUTED, marginBottom:6 }}>{c.label}</div>
            <div style={{ fontSize:26, fontWeight:700, color:c.color||TEXT }}>{c.value}</div>
          </Card>
        ))}
      </div>
      <div style={{ display:'flex', gap:14 }}>
        <Card style={{ flex:1 }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:12 }}>Accès rapide</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {[['💳 Transactions','/transactions'],['🏦 Règlements','/settlements'],['📱 Terminaux','/terminals'],['⚙️ Compte','/account']].map(([l,p]) => (
              <Link key={p} to={p} style={{ display:'block', padding:'12px', background:BG, borderRadius:8, color:TEXT, textDecoration:'none', fontSize:13, fontWeight:500 }}>{l}</Link>
            ))}
          </div>
        </Card>
        <Card style={{ width:220 }}>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:12 }}>Terminaux actifs</div>
          <div style={{ fontSize:40, fontWeight:800, color:'#0066ff' }}>{data.activeTerminals}</div>
          <Link to="/terminals" style={{ fontSize:12, color:G, textDecoration:'none' }}>Gérer les terminaux →</Link>
        </Card>
      </div>
    </div>
  );
};

// ─── TRANSACTIONS ─────────────────────────────────────────────────
const Transactions = () => {
  const [txns, setTxns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage]   = useState(1);
  const [filters, setFilters] = useState({ status:'', type:'' });
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const load = useCallback(() => {
    setLoading(true);
    api.get('/transactions', { params: { page, limit:25, ...filters } })
      .then(r => { setTxns(r.data.data); setTotal(r.data.total); })
      .finally(() => setLoading(false));
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>Transactions <span style={{ fontSize:14, color:MUTED }}>({total})</span></h1>
        <div style={{ display:'flex', gap:10 }}>
          {[['status',['','authorized','failed','pending']],['type',['','collect','payout']]].map(([f, opts]) => (
            <select key={f} value={filters[f]} onChange={e => { setFilters(v => ({ ...v, [f]:e.target.value })); setPage(1); }}
              style={{ background:CARD, border:`1px solid ${BORDER}`, color:TEXT, padding:'8px 12px', borderRadius:8, fontSize:13 }}>
              {opts.map(o => <option key={o} value={o}>{o || (f==='status'?'Tous statuts':'Tous types')}</option>)}
            </select>
          ))}
        </div>
      </div>

      {loading ? <Spinner /> : (
        <Card>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ borderBottom:`1px solid ${BORDER}` }}>
                {['Date','Type','Méthode','Description','Montant','Frais','Net','Statut'].map(h => (
                  <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:12, color:MUTED }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {txns.map(t => (
                <tr key={t.transaction_id} style={{ borderBottom:`1px solid ${BORDER}`, cursor:'pointer' }} onClick={() => navigate(`/transactions/${t.transaction_id}`)}>
                  <td style={{ padding:'11px 12px', fontSize:12, color:MUTED }}>{new Date(t.initiated_at).toLocaleString('fr')}</td>
                  <td style={{ padding:'11px 12px', fontSize:12 }}><Badge label={t.type} color={t.type==='collect'?G:'#0066ff'} /></td>
                  <td style={{ padding:'11px 12px', fontSize:12, color:MUTED }}>{t.payment_method}</td>
                  <td style={{ padding:'11px 12px', fontSize:13 }}>{t.description || '—'}</td>
                  <td style={{ padding:'11px 12px', fontSize:13, fontWeight:600 }}>{parseFloat(t.amount).toLocaleString()} {t.currency}</td>
                  <td style={{ padding:'11px 12px', fontSize:12, color:'#ff3b30' }}>{t.fee_amount ? `-${parseFloat(t.fee_amount).toLocaleString()}` : '—'}</td>
                  <td style={{ padding:'11px 12px', fontSize:13, fontWeight:600, color:G }}>{t.net_amount ? parseFloat(t.net_amount).toLocaleString() : '—'}</td>
                  <td style={{ padding:'11px 12px' }}><Badge label={t.status} color={statusColor(t.status)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12 }}>
            <Btn small variant="secondary" onClick={() => setPage(p => Math.max(1,p-1))} disabled={page===1}>← Préc.</Btn>
            <span style={{ padding:'6px 12px', fontSize:13, color:MUTED }}>Page {page}</span>
            <Btn small variant="secondary" onClick={() => setPage(p => p+1)} disabled={txns.length<25}>Suiv. →</Btn>
          </div>
        </Card>
      )}
    </div>
  );
};

// ─── DÉTAIL TRANSACTION ────────────────────────────────────────────
const TransactionDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [txn, setTxn] = useState(null);
  useEffect(() => { api.get(`/transactions/${id}`).then(r => setTxn(r.data)).catch(() => { toast.error('Introuvable'); navigate('/transactions'); }); }, [id]);
  if (!txn) return <Spinner />;

  const fields = [
    ['Référence', txn.transaction_id], ['Type', txn.type], ['Méthode', txn.payment_method],
    ['Montant', `${parseFloat(txn.amount).toLocaleString()} ${txn.currency}`],
    ['Frais', txn.fee_amount ? `${parseFloat(txn.fee_amount).toLocaleString()} ${txn.currency}` : '—'],
    ['Net', txn.net_amount ? `${parseFloat(txn.net_amount).toLocaleString()} ${txn.currency}` : '—'],
    ['Code auth', txn.auth_code || '—'], ['Description', txn.description || '—'],
    ['Initié le', new Date(txn.initiated_at).toLocaleString('fr')],
    ['Complété le', txn.completed_at ? new Date(txn.completed_at).toLocaleString('fr') : '—'],
  ];

  return (
    <div>
      <div style={{ display:'flex', gap:12, alignItems:'center', marginBottom:20 }}>
        <Btn small variant="secondary" onClick={() => navigate('/transactions')}>← Retour</Btn>
        <h1 style={{ margin:0, fontSize:18, fontWeight:700 }}>Transaction</h1>
        <Badge label={txn.status} color={statusColor(txn.status)} />
      </div>
      <Card style={{ maxWidth:560 }}>
        {fields.map(([l,v]) => (
          <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'10px 0', borderBottom:`1px solid ${BORDER}`, fontSize:13 }}>
            <span style={{ color:MUTED }}>{l}</span>
            <span style={{ fontFamily:l==='Référence'?'monospace':'inherit', fontSize:l==='Référence'?12:13 }}>{v}</span>
          </div>
        ))}
      </Card>
    </div>
  );
};

// ─── RÈGLEMENTS ────────────────────────────────────────────────────
const Settlements = () => {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api.get('/settlements').then(r => { setData(r.data.data); setLoading(false); }).catch(() => setLoading(false)); }, []);

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>Règlements J+1</h1>
      {loading ? <Spinner /> : (
        <Card>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ borderBottom:`1px solid ${BORDER}` }}>
                {['Date','Transactions','Volume brut','Frais','Net reçu','Statut'].map(h => <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontSize:12, color:MUTED }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.map(s => (
                <tr key={s.batch_id} style={{ borderBottom:`1px solid ${BORDER}` }}>
                  <td style={{ padding:'12px', fontSize:13, fontWeight:500 }}>{s.batch_date}</td>
                  <td style={{ padding:'12px', fontSize:13 }}>{s.txn_count}</td>
                  <td style={{ padding:'12px', fontSize:13 }}>{parseFloat(s.total_gross).toLocaleString()} {s.currency}</td>
                  <td style={{ padding:'12px', fontSize:13, color:'#ff3b30' }}>-{parseFloat(s.total_fees).toLocaleString()}</td>
                  <td style={{ padding:'12px', fontSize:14, fontWeight:700, color:G }}>{parseFloat(s.total_net).toLocaleString()} {s.currency}</td>
                  <td style={{ padding:'12px' }}><Badge label={s.status} color={statusColor(s.status)} /></td>
                </tr>
              ))}
              {data.length === 0 && <tr><td colSpan={6} style={{ textAlign:'center', padding:32, color:MUTED }}>Aucun règlement</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
};

// ─── TERMINAUX ─────────────────────────────────────────────────────
const Terminals = () => {
  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ terminalName:'', deviceModel:'', androidId:'' });

  const load = () => { api.get('/terminals').then(r => { setTerminals(r.data.data); setLoading(false); }).catch(() => setLoading(false)); };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!form.terminalName) return toast.error('Nom requis');
    try {
      await api.post('/terminals', form);
      toast.success('Terminal créé');
      setShowNew(false); setForm({ terminalName:'', deviceModel:'', androidId:'' });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
  };

  const deactivate = async (id) => {
    await api.delete(`/terminals/${id}`);
    toast.success('Terminal désactivé');
    load();
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>Mes Terminaux</h1>
        <Btn onClick={() => setShowNew(true)}>+ Nouveau terminal</Btn>
      </div>

      {loading ? <Spinner /> : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:16 }}>
          {terminals.map(t => (
            <Card key={t.terminal_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12 }}>
                <div>
                  <div style={{ fontWeight:600, fontSize:15 }}>{t.terminal_name}</div>
                  <div style={{ fontSize:12, color:G, fontFamily:'monospace', marginTop:2 }}>{t.terminal_code}</div>
                </div>
                <Badge label={t.status} color={statusColor(t.status)} />
              </div>
              {t.device_model && <div style={{ fontSize:12, color:MUTED, marginBottom:4 }}>📱 {t.device_model}</div>}
              {t.app_version && <div style={{ fontSize:12, color:MUTED, marginBottom:4 }}>Version: {t.app_version}</div>}
              <div style={{ fontSize:12, color:MUTED, marginBottom:12 }}>
                Dernière activité: {t.last_seen_at ? new Date(t.last_seen_at).toLocaleString('fr') : 'Jamais'}
              </div>
              {t.status === 'active' && (
                <Btn small variant="danger" onClick={() => deactivate(t.terminal_id)}>Désactiver</Btn>
              )}
            </Card>
          ))}
          {terminals.length === 0 && (
            <div style={{ gridColumn:'1/-1', textAlign:'center', padding:40, color:MUTED }}>
              Aucun terminal — créez-en un pour commencer
            </div>
          )}
        </div>
      )}

      {showNew && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <Card style={{ width:440 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h2 style={{ margin:0, fontSize:18 }}>Nouveau terminal</h2>
              <button onClick={() => setShowNew(false)} style={{ background:'none', border:'none', color:MUTED, cursor:'pointer', fontSize:20 }}>✕</button>
            </div>
            {[['Nom du terminal *','terminalName','text','Ex: Caisse principale'],['Modèle d\'appareil','deviceModel','text','Ex: Samsung Galaxy A54'],['Android ID','androidId','text','Identifiant unique de l\'appareil']].map(([l,k,t,p]) => (
              <div key={k} style={{ marginBottom:12 }}>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{l}</label>
                <input type={t} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]:e.target.value }))} placeholder={p}
                  style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'9px 12px', color:TEXT, fontSize:14, boxSizing:'border-box' }} />
              </div>
            ))}
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:16 }}>
              <Btn variant="secondary" onClick={() => setShowNew(false)}>Annuler</Btn>
              <Btn onClick={create}>Créer le terminal</Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

// ─── COMPTE ────────────────────────────────────────────────────────
const Account = () => {
  const [account, setAccount] = useState(null);
  const [form, setForm]       = useState({});
  const [editing, setEditing] = useState(false);

  useEffect(() => { api.get('/account').then(r => { setAccount(r.data); setForm({ firstName:r.data.first_name, lastName:r.data.last_name, phone:r.data.phone, settlementAccount:r.data.settlement_account, settlementProvider:r.data.settlement_provider }); }).catch(() => {}); }, []);

  const save = async () => {
    try { await api.put('/account', form); toast.success('Compte mis à jour'); setEditing(false); api.get('/account').then(r => setAccount(r.data)); }
    catch { toast.error('Erreur'); }
  };

  if (!account) return <Spinner />;

  const KYB_LABELS = ['Compte créé (500 000 XAF/j)', 'KYB validé (5 000 000 XAF/j)', 'Contrat (plafond personnalisé)'];

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>Mon compte</h1>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        <Card>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
            <h3 style={{ margin:0, fontSize:15 }}>Informations</h3>
            <Btn small variant="outline" onClick={() => setEditing(!editing)}>{editing ? 'Annuler' : 'Modifier'}</Btn>
          </div>
          {editing ? (
            <div>
              {[['Prénom','firstName'],['Nom','lastName'],['Téléphone','phone'],['Compte de règlement','settlementAccount'],['Opérateur règlement','settlementProvider']].map(([l,k]) => (
                <div key={k} style={{ marginBottom:10 }}>
                  <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{l}</label>
                  <input value={form[k]||''} onChange={e => setForm(f => ({ ...f, [k]:e.target.value }))}
                    style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', color:TEXT, fontSize:13, boxSizing:'border-box' }} />
                </div>
              ))}
              <Btn onClick={save} style={{ width:'100%' }}>Enregistrer</Btn>
            </div>
          ) : (
            <div>
              {[['Entreprise',account.business_name],['Prénom',account.first_name],['Nom',account.last_name],['Email',account.email],['Téléphone',account.phone||'—'],['Pays',`${account.country} — ${account.currency}`],['Règlement',`${account.settlement_type} — ${account.settlement_account||'—'}`]].map(([l,v]) => (
                <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:`1px solid ${BORDER}`, fontSize:13 }}>
                  <span style={{ color:MUTED }}>{l}</span><span>{v}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ margin:'0 0 16px', fontSize:15 }}>Niveau KYB</h3>
          {[0,1,2].map(l => (
            <div key={l} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 0', borderBottom:`1px solid ${BORDER}` }}>
              <span style={{ width:24, height:24, borderRadius:'50%', background:account.kyb_level>=l?G:'#1c2130', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, color:account.kyb_level>=l?BG:MUTED, fontWeight:700 }}>{l}</span>
              <span style={{ fontSize:13, flex:1, color:account.kyb_level>=l?TEXT:MUTED }}>{KYB_LABELS[l]}</span>
              {account.kyb_level >= l && <span style={{ color:G }}>✓</span>}
            </div>
          ))}
          {account.kyb_level < 2 && (
            <div style={{ marginTop:14, padding:12, background:`${G}10`, borderRadius:8, fontSize:12, color:G }}>
              Pour augmenter votre plafond, contactez le support avec vos documents KYB.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

// ─── APP ───────────────────────────────────────────────────────────
export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-right" toastOptions={{ style:{ background:CARD, color:TEXT, border:`1px solid ${BORDER}` } }} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<Guard><Layout><Routes>
          <Route path="/"                    element={<Dashboard />} />
          <Route path="/transactions"         element={<Transactions />} />
          <Route path="/transactions/:id"     element={<TransactionDetail />} />
          <Route path="/settlements"          element={<Settlements />} />
          <Route path="/terminals"            element={<Terminals />} />
          <Route path="/account"              element={<Account />} />
        </Routes></Layout></Guard>} />
      </Routes>
    </BrowserRouter>
  );
}
