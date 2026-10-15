// C-Pay 2.6.0 — Admin Portal Enrichi
// Modules: Dashboard, Monitoring, Alerts, Fraud, Merchants, Transactions, Users, APIs, Audit

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import toast, { Toaster } from 'react-hot-toast';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { authApi, apiConfigsApi, merchantsApi, monitorApi, terminalsApi, auditApi } from './services/api';
import axios from 'axios';


// ─── i18n Admin ───────────────────────────────────────────────────
const TRANS = {
  fr: {
    dashboard:'Tableau de bord', monitoring:'Monitoring', alerts:'Alertes',
    fraud:'Fraude', merchants:'Marchands', transactions:'Transactions',
    users:'Utilisateurs', terminals:'Terminaux', apiConfigs:'APIs',
    audit:'Audit', logout:'Déconnexion', loading:'Chargement…',
    language:'🌐 English', login:'Connexion', email:'Email',
    password:'Mot de passe', loginBtn:'Se connecter',
    searchMerchant:'Rechercher un marchand…', searchTxn:'Rechercher…',
    refund:'Rembourser', activate:'Activer', deactivate:'Désactiver',
    resolve:'Résoudre', review:'Réviser', block:'Bloquer',
    allow:'Autoriser', save:'Enregistrer', cancel:'Annuler',
    create:'Créer', reset:'Réinitialiser', export:'Exporter',
    status:'Statut', amount:'Montant', date:'Date', actions:'Actions',
    merchant:'Marchand', type:'Type', description:'Description',
    noData:'Aucune donnée', error:'Erreur', success:'Succès',
    confirm:'Confirmer', back:'Retour', details:'Détails',
    total:'Total', pending:'En attente', active:'Actif',
    inactive:'Inactif', suspended:'Suspendu', name:'Nom',
    email2:'Email', country:'Pays', currency:'Devise',
    created:'Créé le', updated:'Mis à jour', level:'Niveau',
    riskScore:'Score risque', reason:'Raison', notes:'Notes',
    version:'Version', endpoint:'Endpoint', method:'Méthode',
    limit:'Limite', window:'Fenêtre', enabled:'Activé',
    disabled:'Désactivé', newUser:'Nouvel utilisateur',
    newTerminal:'Nouveau terminal', newApi:'Nouvelle API',
    username:'Nom utilisateur', role:'Rôle', phone:'Téléphone',
  },
  en: {
    dashboard:'Dashboard', monitoring:'Monitoring', alerts:'Alerts',
    fraud:'Fraud', merchants:'Merchants', transactions:'Transactions',
    users:'Users', terminals:'Terminals', apiConfigs:'APIs',
    audit:'Audit', logout:'Sign out', loading:'Loading…',
    language:'🌐 Français', login:'Sign in', email:'Email',
    password:'Password', loginBtn:'Sign in',
    searchMerchant:'Search merchant…', searchTxn:'Search…',
    refund:'Refund', activate:'Activate', deactivate:'Deactivate',
    resolve:'Resolve', review:'Review', block:'Block',
    allow:'Allow', save:'Save', cancel:'Cancel',
    create:'Create', reset:'Reset', export:'Export',
    status:'Status', amount:'Amount', date:'Date', actions:'Actions',
    merchant:'Merchant', type:'Type', description:'Description',
    noData:'No data', error:'Error', success:'Success',
    confirm:'Confirm', back:'Back', details:'Details',
    total:'Total', pending:'Pending', active:'Active',
    inactive:'Inactive', suspended:'Suspended', name:'Name',
    email2:'Email', country:'Country', currency:'Currency',
    created:'Created', updated:'Updated', level:'Level',
    riskScore:'Risk score', reason:'Reason', notes:'Notes',
    version:'Version', endpoint:'Endpoint', method:'Method',
    limit:'Limit', window:'Window', enabled:'Enabled',
    disabled:'Disabled', newUser:'New user',
    newTerminal:'New terminal', newApi:'New API',
    username:'Username', role:'Role', phone:'Phone',
  },
};
const LangContext = React.createContext({ lang:'fr', toggle:()=>{} });
const useT = () => {
  const { lang } = React.useContext(LangContext);
  return k => T[lang][k] || k;
};
const useLang = () => {
  const [lang, setLang] = React.useState(localStorage.getItem('admin_lang') || 'fr');
  const toggle = () => { const n = lang==='fr'?'en':'fr'; localStorage.setItem('admin_lang',n); setLang(n); };
  return { lang, toggle };
};


// ─── API enrichie ─────────────────────────────────────────────────
const apiBase = process.env.REACT_APP_API_BASE_URL || '';
const api = axios.create({ baseURL: `${apiBase}/api/v1/admin` });
api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('admin_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});
api.interceptors.response.use(r => r, err => {
  const st = err.response?.status;
  if (st === 401) { localStorage.removeItem('admin_token'); if (window.location.pathname !== '/login') window.location.href = '/login'; }
  else if (st === 403) { toast.error('Accès refusé'); } // droits insuffisants : pas de redirection
  return Promise.reject(err);
});

// ─── CRM / back-office assistant ──────────────────────────────────
// Contrat : backend/src/routes/crm-admin.routes.js, monte sur /api/v1/admin/crm.
//   GET  /crm/stats                      -> { leads:{new,total,last7d}, claims:{open,total,last7d}, conversations:{last7d,handoffs} }
//   GET  /crm/leads?status&q&page&limit  -> { data, total, page, limit }   PATCH /crm/leads/:id { status, assignedTo, notes } -> lead
//   GET  /crm/claims?status&category&q   -> { data, total, page, limit }   PATCH /crm/claims/:id { status, assignedTo, resolution } -> claim
//   GET  /crm/conversations?page&limit   -> { data, page, limit }          GET /crm/conversations/:id -> { ...conversation, messages[] }
const crmApi = {
  stats:         ()      => api.get('/crm/stats'),
  leads:         p       => api.get('/crm/leads', { params: p }),
  updateLead:    (id, d) => api.patch(`/crm/leads/${id}`, d),
  claims:        p       => api.get('/crm/claims', { params: p }),
  updateClaim:   (id, d) => api.patch(`/crm/claims/${id}`, d),
  conversations: p       => api.get('/crm/conversations', { params: p }),
  conversation:  id      => api.get(`/crm/conversations/${id}`),
};
const CRM_ROLES = ['super_admin', 'ops_admin', 'support_agent'];
const hasRole = (admin, roles) => !roles || roles.includes(admin?.role);

const fraudApi  = { events: p => api.get('/fraud/events', { params: p }), rules: () => api.get('/fraud/rules'), updateRule: (id, d) => api.put(`/fraud/rules/${id}`, d), createRule: d => api.post('/fraud/rules', d), review: (id, d) => api.patch(`/fraud/events/${id}/review`, d) };
const txnApi    = { list: p => api.get('/transactions', { params: p }), get: id => api.get(`/transactions/${id}`), refund: id => api.post(`/transactions/${id}/refund`) };
const usersApi  = { list: p => api.get('/users', { params: p }), create: d => api.post('/users', d), toggle: (id, d) => api.patch(`/users/${id}/status`, d), resetPwd: id => api.post(`/users/${id}/reset-password`) };
const alertsApi = { list: p => api.get('/alerts', { params: p }), resolve: (id, d) => api.patch(`/alerts/${id}/resolve`, d) };

// ─── Auth ─────────────────────────────────────────────────────────
const useAuth = () => {
  const token = localStorage.getItem('admin_token');
  const admin = token ? (() => { try { const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b.padEnd(b.length + (4 - b.length % 4) % 4, '='))); } catch { return null; } })() : null;
  return { isAuth: !!admin && admin.exp * 1000 > Date.now(), admin };
};
const useRole = () => useAuth();

const Guard = ({ children }) => { const { isAuth } = useAuth(); return isAuth ? children : <Navigate to="/login" replace />; };

// ─── Palette ──────────────────────────────────────────────────────
// ─── i18n simple ──────────────────────────────────────────────────
const LANG = localStorage.getItem('admin_lang') || 'fr';
const T = {
  fr: {
    dashboard:'Tableau de bord', monitoring:'Monitoring', alerts:'Alertes',
    fraud:'Fraude', merchants:'Marchands', transactions:'Transactions',
    users:'Utilisateurs', terminals:'Terminaux', apiConfigs:'APIs & Opérateurs',
    audit:'Audit Logs', logout:'Déconnexion', loading:'Chargement…',
    search:'Rechercher…', active:'Actif', inactive:'Inactif',
    suspended:'Suspendu', status:'Statut', amount:'Montant',
    date:'Date', actions:'Actions', save:'Enregistrer', cancel:'Annuler',
    create:'Créer', confirm:'Confirmer', back:'Retour', details:'Détails',
    name:'Nom', country:'Pays', currency:'Devise', level:'Niveau',
    email:'Email', role:'Rôle', phone:'Téléphone', version:'Version',
    enabled:'Activé', disabled:'Désactivé', risk:'Risques', config:'Config',
    management:'Gestion', noData:'Aucune donnée', error:'Erreur',
    activate:'Activer', deactivate:'Désactiver', refund:'Rembourser',
    resolve:'Résoudre', block:'Bloquer', allow:'Autoriser',
    administration:'Administration', language:'🌐 English',
  },
  en: {
    dashboard:'Dashboard', monitoring:'Monitoring', alerts:'Alerts',
    fraud:'Fraud', merchants:'Merchants', transactions:'Transactions',
    users:'Users', terminals:'Terminals', apiConfigs:'APIs & Operators',
    audit:'Audit Logs', logout:'Sign out', loading:'Loading…',
    search:'Search…', active:'Active', inactive:'Inactive',
    suspended:'Suspended', status:'Status', amount:'Amount',
    date:'Date', actions:'Actions', save:'Save', cancel:'Cancel',
    create:'Create', confirm:'Confirm', back:'Back', details:'Details',
    name:'Name', country:'Country', currency:'Currency', level:'Level',
    email:'Email', role:'Role', phone:'Phone', version:'Version',
    enabled:'Enabled', disabled:'Disabled', risk:'Risks', config:'Config',
    management:'Management', noData:'No data', error:'Error',
    activate:'Activate', deactivate:'Deactivate', refund:'Refund',
    resolve:'Resolve', block:'Block', allow:'Allow',
    administration:'Administration', language:'🌐 Français',
  },
};
const t = k => TRANS[LANG][k] || k;

const C = { primary: '#12b6c7', danger: '#ff3b30', warning: '#ff9500', success: '#00c896', blue: '#1d4f92', bg: '#f6f8fb', card: '#ffffff', border: '#d7dee8', text: '#243247', muted: '#5a6270' };
const sc = s => ({ active: C.success, inactive: C.muted, suspended: C.danger, authorized: C.success, failed: C.danger, pending: C.warning, block: C.danger, review: C.warning, allow: C.success, critical: C.danger, high: '#ff6b35', medium: C.warning, low: '#8bc34a', open: C.warning, resolved: C.success }[s] || C.muted);

// ─── Composants ───────────────────────────────────────────────────
const Card  = ({ children, style }) => <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, ...style }}>{children}</div>;
const Badge = ({ label, color = C.muted }) => <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: `${color}22`, color }}>{label}</span>;
const Spin  = () => { const t = useT(); return <div style={{ textAlign: 'center', padding: 40, color: C.muted }}>{t('loading')}</div>; };
const Stat  = ({ label, value, color, sub }) => (
  <Card><div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>{label}</div><div style={{ fontSize: 28, fontWeight: 700, color: color || C.text }}>{value}</div>{sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sub}</div>}</Card>
);
const Btn = ({ onClick, children, variant = 'primary', small, disabled, style: s }) => {
  const bg = { primary: C.primary, danger: C.danger, secondary: C.border, success: C.success, warning: C.warning, blue: C.blue }[variant] || C.primary;
  return <button onClick={onClick} disabled={disabled} style={{ background: bg, color: variant === 'secondary' ? C.text : '#fff', border: 'none', borderRadius: 8, padding: small ? '5px 12px' : '9px 18px', fontSize: small ? 12 : 14, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1, ...s }}>{children}</button>;
};
const _slugId = s => 'f-' + String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const Inp = ({ label, value, onChange, type = 'text', placeholder, id, name, autoComplete, required, inputMode }) => {
  const _id = id || _slugId(label);
  return (
  <div style={{ marginBottom: 12 }}>
    {label && <label htmlFor={_id} style={{ display: 'block', fontSize: 12, color: C.muted, marginBottom: 4 }}>{label}</label>}
    <input id={_id} name={name || _id} type={type} value={value || ''} onChange={e => onChange?.(e.target.value)} placeholder={placeholder} autoComplete={autoComplete} required={required} inputMode={inputMode}
      style={{ width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 12px', color: C.text, fontSize: 14, boxSizing: 'border-box', outline: 'none' }} />
  </div>
  );
};
const Sel = ({ label, value, onChange, options }) => (
  <div style={{ marginBottom: 12 }}>
    {label && <label style={{ display: 'block', fontSize: 12, color: C.muted, marginBottom: 4 }}>{label}</label>}
    <select value={value} onChange={e => onChange(e.target.value)} style={{ width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 12px', color: C.text, fontSize: 14, boxSizing: 'border-box' }}>
      {options.map(o => { const v = (o && typeof o === 'object') ? o.v : o; const l = (o && typeof o === 'object') ? o.l : o; return <option key={String(v)} value={v ?? ''}>{l}</option>; })}
    </select>
  </div>
);
const TH = ({ c }) => <th style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, color: C.muted, fontWeight: 600, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{c}</th>;
const TD = ({ children, style }) => <td style={{ padding: '11px 14px', fontSize: 13, borderBottom: `1px solid ${C.border}`, ...style }}>{children}</td>;
const Tbl = ({ heads, rows, empty = 'Aucune donnée' }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>{heads.map(h => <TH key={h} c={h} />)}</tr></thead>
      <tbody>{!rows.length ? <tr><td colSpan={heads.length} style={{ textAlign: 'center', padding: 32, color: C.muted }}>{empty}</td></tr> : rows}</tbody>
    </table>
  </div>
);
const Modal = ({ title, onClose, children, width = 520 }) => (
  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
    <Card style={{ width, maxHeight: '90vh', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 18, color: C.text }}>{title}</h2>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: C.muted }}>✕</button>
      </div>
      {children}
    </Card>
  </div>
);
const Tabs = ({ tabs, active, onChange }) => (
  <div style={{ display: 'flex', gap: 2, marginBottom: 20, background: C.bg, borderRadius: 10, padding: 4, width: 'fit-content', border: `1px solid ${C.border}` }}>
    {tabs.map(([v, l]) => <button key={v} onClick={() => onChange(v)} style={{ padding: '7px 20px', borderRadius: 8, border: 'none', background: active === v ? C.card : 'transparent', fontWeight: active === v ? 600 : 400, color: active === v ? C.primary : C.muted, cursor: 'pointer', fontSize: 13 }}>{l}</button>)}
  </div>
);

const fmt     = n  => parseFloat(n || 0).toLocaleString('fr-FR');
const fmtDate = d  => d ? new Date(d).toLocaleString('fr-FR') : '—';
const Pagination = ({ page, setPage, count, limit = 25 }) => (
  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
    <Btn small variant="secondary" onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1}>← Préc.</Btn>
    <span style={{ padding: '6px 12px', fontSize: 13, color: C.muted }}>Page {page}</span>
    <Btn small variant="secondary" onClick={() => setPage(p => p+1)} disabled={count < limit}>Suiv. →</Btn>
  </div>
);

// ─── LAYOUT ───────────────────────────────────────────────────────
// ─── NOTIFICATION BELL ────────────────────────────────────────────
const NotificationBell = () => {
  const [notifs, setNotifs] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api.get('/notifications').then(r => {
      setNotifs(r.data.data||[]);
      setUnread(r.data.unread||0);
    }).catch(()=>{});
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000); // Polling 30s
    return () => clearInterval(interval);
  }, [load]);

  const markRead = async (id) => {
    await api.patch(`/notifications/${id}/read`).catch(()=>{});
    load();
  };

  const markAllRead = async () => {
    await api.patch('/notifications/read-all').catch(()=>{});
    load();
  };

  const ICONS = { kyb_document_submitted:'📄', kyc_document_submitted:'🪪', default:'🔔' };
  const fmtAgo = d => {
    const diff = Date.now() - new Date(d);
    if (diff < 60000) return 'À l&apos;instant';
    if (diff < 3600000) return Math.floor(diff/60000) + ' min';
    if (diff < 86400000) return Math.floor(diff/3600000) + 'h';
    return Math.floor(diff/86400000) + 'j';
  };

  return (
    <div style={{ position:'relative', marginRight:12 }}>
      <button onClick={()=>setOpen(!open)}
        style={{ background:'none', border:'none', cursor:'pointer', position:'relative', fontSize:20, padding:'4px 8px' }}>
        🔔
        {unread > 0 && (
          <span style={{ position:'absolute', top:0, right:0, background:C.danger, color:'#fff', borderRadius:'50%', width:16, height:16, fontSize:10, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div style={{ position:'fixed', top:52, right:0, width:360, maxHeight:480, background:C.card, border:`1px solid ${C.border}`, borderRadius:'0 0 12px 12px', boxShadow:'0 8px 32px rgba(0,0,0,0.15)', zIndex:200, display:'flex', flexDirection:'column' }}
          onClick={e=>e.stopPropagation()}>
          <div style={{ padding:'12px 16px', borderBottom:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ fontSize:14, fontWeight:700 }}>🔔 Notifications {unread>0 && <span style={{ color:C.danger }}>({unread})</span>}</div>
            {unread > 0 && (
              <button onClick={markAllRead} style={{ background:'none', border:'none', color:C.primary, cursor:'pointer', fontSize:12 }}>
                Tout marquer lu
              </button>
            )}
          </div>
          <div style={{ flex:1, overflowY:'auto' }}>
            {notifs.length === 0 ? (
              <div style={{ textAlign:'center', padding:24, color:C.muted, fontSize:13 }}>Aucune notification</div>
            ) : notifs.map(n => (
              <div key={n.notification_id} onClick={()=>markRead(n.notification_id)}
                style={{ padding:'12px 16px', borderBottom:`1px solid ${C.border}`, cursor:'pointer', background:n.is_read?C.card:`${C.primary}05`,
                  transition:'background .15s' }}
                onMouseEnter={e=>e.currentTarget.style.background=C.bg}
                onMouseLeave={e=>e.currentTarget.style.background=n.is_read?C.card:`${C.primary}05`}>
                <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
                  <span style={{ fontSize:20, flexShrink:0 }}>{ICONS[n.type]||ICONS.default}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:n.is_read?400:700, marginBottom:2 }}>{n.title}</div>
                    <div style={{ fontSize:12, color:C.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{n.message}</div>
                    <div style={{ fontSize:10, color:C.muted, marginTop:4 }}>{fmtAgo(n.created_at)}</div>
                  </div>
                  {!n.is_read && <div style={{ width:8, height:8, borderRadius:'50%', background:C.primary, flexShrink:0, marginTop:4 }} />}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {open && <div style={{ position:'fixed', inset:0, zIndex:199 }} onClick={()=>setOpen(false)} />}
    </div>
  );
};


const Layout = ({ children }) => {
  const { lang } = React.useContext(LangContext);
  const t = useT();
  const { admin } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const logout = () => { localStorage.removeItem('admin_token'); navigate('/login'); };

  const sections = [
    { group: 'PRINCIPAL', items: [{ p: '/', l: '📊 Dashboard' }, { p: '/monitoring', l: '⚡ Monitoring Live' }, { p: '/alerts', l: '🔔 '+t('alerts') }] },
    { group: LANG==='fr'?'RISQUES':'RISKS', items: [{ p: '/fraud', l: '🛡️ '+t('fraud') }] },
    { group: LANG==='fr'?'GESTION':'MANAGEMENT', items: [{ p: '/merchants', l: '🏪 '+t('merchants') }, { p: '/cardholders', l: '🪪 Porteurs de carte' }, { p: '/transactions', l: '💳 '+t('transactions') }, { p: '/users', l: '👥 '+t('users') }, { p: '/terminals', l: '📱 '+t('terminals') }] },
    { group: LANG==='fr'?'PARTENAIRES':'PARTNERS', items: [{ p: '/banks', l: '🏦 Banques' }, { p: '/tenants', l: '🌐 Tenants' }, { p: '/partners-agencies', l: '🏢 Agences' }, { p: '/partners-agents', l: '👤 Agents' }], roles: ['super_admin','ops_admin'] },
    { group: LANG==='fr'?'CONFIG':'CONFIG', items: [{ p: '/api-configs', l: '🔌 '+t('apiConfigs') }, { p: '/audit', l: '📋 '+t('audit') }], roles: ['super_admin','ops_admin'] },
    { group: 'SUPPORT', items: [{ p: '/tickets', l: '🎫 Incidents' }], roles: ['super_admin','ops_admin','support_agent'] },
    { group: 'CRM', items: [{ p: '/crm/leads', l: '🎯 Leads' }, { p: '/crm/complaints', l: '📣 Réclamations' }, { p: '/crm/conversations', l: '💬 Conversations' }], roles: CRM_ROLES, gated: true },
    { group: 'FINANCE', items: [{ p: '/finance', l: '💰 Règlements' }], roles: ['super_admin','finance_admin'] },
    { group: 'ADMIN', items: [{ p: '/admin-users', l: '👥 Utilisateurs Admin' }], roles: ['super_admin'] },
  ];
  const isActive = p => p === '/' ? pathname === '/' : pathname.startsWith(p);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: C.bg, fontFamily: 'Arial, sans-serif', color: C.text }}>
      <aside style={{ width: 230, background: C.card, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', position: 'fixed', top: 0, bottom: 0, left: 0, zIndex: 100 }}>
        <div style={{ padding: '14px 16px 12px', borderBottom: `1px solid ${C.border}` }}>
          
          <img src="/logo-calculus.svg" alt="Calculus Plus" style={{ width: 200, height: 'auto', display: 'block', objectFit: 'contain' }} />
          <div style={{ fontSize: 10, color: C.muted, marginTop: 4, textAlign: 'center' }}>C-Pay — {t('administration')}</div>
        </div>
        <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {sections.filter(sec => !sec.gated || hasRole(admin, sec.roles)).map(({ group, items }) => (
            <div key={group}>
              <div style={{ padding: '10px 18px 4px', fontSize: 10, fontWeight: 700, color: C.muted, letterSpacing: 1, textTransform: 'uppercase' }}>{group}</div>
              {items.map(({ p, l }) => (
                <Link key={p} to={p} style={{ display: 'block', padding: '9px 18px', color: isActive(p) ? C.primary : C.muted, textDecoration: 'none', fontSize: 13, fontWeight: isActive(p) ? 600 : 400, background: isActive(p) ? `${C.primary}12` : 'transparent', borderLeft: `3px solid ${isActive(p) ? C.primary : 'transparent'}` }}>{l}</Link>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ padding: '12px 18px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{admin?.email}</div>
          <div style={{ fontSize: 11, color: C.primary, marginBottom: 8 }}>{admin?.role}</div>
          <button onClick={()=>{ const ctx = document.getElementById('lang-toggle'); if(ctx) ctx.click(); }}
            style={{ background:'none', border:`1px solid ${C.border}`, color:C.muted, padding:'5px 10px', borderRadius:6, cursor:'pointer', fontSize:11, width:'100%', marginBottom:6 }}>
            {T[lang]['language']}
          </button>
          <Btn variant="secondary" small onClick={logout}>{t('logout')}</Btn>
        </div>
      </aside>
      {/* Header fixe haut droite */}
      <div style={{ position:'fixed', top:0, left:230, right:0, height:48, background:C.card, borderBottom:`1px solid ${C.border}`, display:'flex', alignItems:'center', justifyContent:'flex-end', padding:'0 20px', zIndex:90 }}>
        <NotificationBell />
      </div>
      <main style={{ marginLeft: 230, flex: 1, padding: '68px 28px 28px' }}>{children}</main>
    </div>
  );
};

// ─── LOGIN ────────────────────────────────────────────────────────
const Login = () => {
  const [email, setEmail] = useState('');
  const [pwd, setPwd] = useState('');
  const [loading, setLoading] = useState(false);
  // Etapes supplementaires renvoyees par /auth/login (hotfix v1) :
  //   { mfaRequired:true, mfaToken } -> code TOTP 6 chiffres via POST /auth/2fa/validate { mfaToken, code }
  //   { mustChangePassword:true }    -> changement de mot de passe force avant d'entrer
  const [mfa, setMfa] = useState(null);
  const [code, setCode] = useState('');
  const [forcePwd, setForcePwd] = useState(false);
  const [newPwd, setNewPwd] = useState({ newPassword: '', confirm: '' });
  const navigate = useNavigate();
  const { isAuth } = useAuth();
  useEffect(() => { if (isAuth && !forcePwd) navigate('/'); }, [isAuth, forcePwd, navigate]);

  const finishLogin = (data) => {
    if (data.mfaRequired && data.mfaToken) { setMfa({ mfaToken: data.mfaToken }); return; }
    if (data.access_token) localStorage.setItem('admin_token', data.access_token);
    if (data.mustChangePassword) { setForcePwd(true); return; }
    navigate('/');
  };

  const submit = async () => {
    setLoading(true);
    try { const { data } = await authApi.login({ email, password: pwd }); finishLogin(data); }
    catch (err) { toast.error(err.response?.data?.error || 'Identifiants incorrects'); }
    finally { setLoading(false); }
  };

  const submitMfa = async () => {
    if (code.length !== 6) return toast.error('Code à 6 chiffres requis');
    setLoading(true);
    try { const { data } = await api.post('/auth/2fa/validate', { mfaToken: mfa.mfaToken, code }); finishLogin({ ...data, mfaRequired: false }); }
    catch (err) { toast.error(err.response?.data?.error || 'Code invalide'); }
    finally { setLoading(false); }
  };

  const submitPwd = async () => {
    if (newPwd.newPassword.length < 8) return toast.error('8 caractères minimum');
    if (newPwd.newPassword !== newPwd.confirm) return toast.error('Les mots de passe ne correspondent pas');
    setLoading(true);
    try {
      await api.post('/auth/change-password', { currentPassword: pwd, newPassword: newPwd.newPassword });
      toast.success('Mot de passe modifié ✅'); setForcePwd(false); navigate('/');
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setLoading(false); }
  };

  const onSubmit = e => { e.preventDefault(); if (loading) return; if (forcePwd) submitPwd(); else if (mfa) submitMfa(); else submit(); };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 380 }}>
      <Card>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img src="/logo-calculus.svg" alt="Calculus Plus" style={{ width: 200, height: "auto", display: "block", margin: "0 auto 8px", objectFit: "contain" }} />
          <div style={{ fontSize: 13, color: C.muted }}>C-Pay — Administration</div>
        </div>
        <form onSubmit={onSubmit}>
          {forcePwd ? (<>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>🔐 Nouveau mot de passe requis</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>Pour continuer, définissez un nouveau mot de passe (8 caractères minimum).</div>
            <Inp label="Nouveau mot de passe" value={newPwd.newPassword} onChange={v => setNewPwd(p => ({ ...p, newPassword: v }))} type="password" placeholder="••••••••" autoComplete="new-password" required />
            <Inp label="Confirmer" value={newPwd.confirm} onChange={v => setNewPwd(p => ({ ...p, confirm: v }))} type="password" placeholder="••••••••" autoComplete="new-password" required />
            <Btn disabled={loading} style={{ width: '100%', marginTop: 8 }}>{loading ? 'Enregistrement…' : 'Enregistrer'}</Btn>
          </>) : mfa ? (<>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>🔐 Vérification en deux étapes</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>Saisissez le code à 6 chiffres de votre application d&apos;authentification.</div>
            <Inp label="Code à 6 chiffres" value={code} onChange={v => setCode(String(v).replace(/[^0-9]/g, '').slice(0, 6))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" required />
            <Btn disabled={loading || code.length !== 6} style={{ width: '100%', marginTop: 8 }}>{loading ? 'Vérification…' : 'Valider'}</Btn>
            <button type="button" onClick={() => { setMfa(null); setCode(''); }} style={{ width: '100%', background: 'none', border: 'none', color: C.muted, cursor: 'pointer', marginTop: 10, fontSize: 12 }}>← Retour</button>
          </>) : (<>
            <Inp label="Email administrateur" value={email} onChange={setEmail} type="email" placeholder="admin@c-pay.global" autoComplete="username" required />
            <Inp label="Mot de passe" value={pwd} onChange={setPwd} type="password" placeholder="••••••••" autoComplete="current-password" required />
            <Btn disabled={loading} style={{ width: '100%', marginTop: 8 }}>{loading ? 'Connexion…' : 'Se connecter'}</Btn>
          </>)}
        </form>
      </Card>
      <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: C.muted }}>C-Pay est un produit de Calculus Plus SAS</div>
      </div>
    </div>
  );
};

// ─── DASHBOARD ────────────────────────────────────────────────────
const Dashboard = () => {
  const [stats, setStats] = useState(null);
  useEffect(() => { monitorApi.stats().then(r => setStats(r.data)).catch(() => {}); }, []);
  if (!stats) return <Spin />;
  const COLORS = [C.primary, C.blue, C.success, C.danger, '#a855f7'];
  const trend = Array.from({ length: 7 }, (_, i) => ({ day: ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'][i], volume: Math.floor(Math.random() * 5000000 + 500000) }));

  return (
    <div>
      <h1 style={{ margin: '0 0 20px', fontSize: 22, fontWeight: 700 }}>Dashboard</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        <Stat label="Transactions aujourd'hui" value={stats.today?.total || 0} />
        <Stat label="Approuvées" value={stats.today?.approved || 0} color={C.success} />
        <Stat label="Volume (XAF)" value={fmt(stats.today?.volume)} color={C.primary} />
        <Stat label="Marchands actifs" value={stats.merchants?.active || 0} color={C.blue} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginBottom: 16 }}>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Volume 7 jours</div>
          <ResponsiveContainer width="100%" height={170}>
            <AreaChart data={trend}>
              <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.primary} stopOpacity={0.3} /><stop offset="95%" stopColor={C.primary} stopOpacity={0} /></linearGradient></defs>
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: C.muted }} />
              <YAxis tick={{ fontSize: 11, fill: C.muted }} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }} />
              <Area type="monotone" dataKey="volume" stroke={C.primary} fill="url(#g)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Top Opérateurs</div>
          <ResponsiveContainer width="100%" height={170}>
            <PieChart>
              <Pie data={stats.topOperators?.length ? stats.topOperators : [{ operator: 'N/A', count: 1 }]} dataKey="count" nameKey="operator" cx="50%" cy="50%" outerRadius={60} label={({ percent }) => `${(percent * 100).toFixed(0)}%`}>
                {(stats.topOperators || []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Legend formatter={v => <span style={{ fontSize: 11 }}>{v}</span>} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </Card>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        <Stat label="Refusées aujourd'hui" value={stats.today?.failed || 0} color={C.danger} />
        <Stat label="Taux approbation" value={stats.today?.total ? `${Math.round((stats.today.approved / stats.today.total) * 100)}%` : '—'} color={C.success} />
        <Stat label="Total marchands" value={stats.merchants?.total || 0} />
        <Stat label="Gateways actifs" value={stats.gateways?.length || 0} color={C.blue} />
      </div>
      <CrmStatsBlock />
    </div>
  );
};

// Bloc CRM du tableau de bord : GET /admin/crm/stats (roles super_admin / ops_admin / support_agent)
const CrmStatsBlock = () => {
  const { admin } = useAuth();
  const [crm, setCrm] = useState(null);
  const [err, setErr] = useState(false);
  const allowed = hasRole(admin, CRM_ROLES);
  useEffect(() => { if (allowed) crmApi.stats().then(r => setCrm(r.data || {})).catch(() => setErr(true)); }, [allowed]);
  if (!allowed || err) return null;
  const L = crm?.leads || {}, K = crm?.claims || {}, V = crm?.conversations || {};
  return (
    <Card style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>🎯 CRM — leads, réclamations, assistant</div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link to="/crm/leads" style={{ fontSize: 12, color: C.primary, textDecoration: 'none' }}>Leads →</Link>
          <Link to="/crm/complaints" style={{ fontSize: 12, color: C.primary, textDecoration: 'none' }}>Réclamations →</Link>
          <Link to="/crm/conversations" style={{ fontSize: 12, color: C.primary, textDecoration: 'none' }}>Conversations →</Link>
        </div>
      </div>
      {!crm ? <Spin /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12 }}>
          {[
            ['Leads nouveaux',        L.new,     C.primary, `${fmt(L.total)} au total`],
            ['Leads (7 j)',           L.last7d,  C.blue,    null],
            ['Réclamations ouvertes', K.open,    C.warning, `${fmt(K.total)} au total`],
            ['Réclamations (7 j)',    K.last7d,  C.text,    null],
            ['Conversations (7 j)',   V.last7d,  C.success, null],
            ['Transferts humain',     V.handoffs, C.danger, 'handoff demandé'],
          ].map(([l, v, col, sub]) => (
            <div key={l} style={{ background: C.bg, borderRadius: 10, padding: '12px 14px' }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>{l}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: col }}>{fmt(v || 0)}</div>
              {sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{sub}</div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ─── MONITORING// ─── MONITORING ───────────────────────────────────────────────────
const Monitoring = () => {
  const [txns, setTxns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);
  const [filter, setFilter] = useState('all');
  const ref = useRef(null);

  const load = useCallback(() => {
    monitorApi.live().then(r => { setTxns(r.data.data || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    if (auto) { ref.current = setInterval(load, 8000); }
    return () => clearInterval(ref.current);
  }, [load, auto]);

  const shown = filter === 'all' ? txns : txns.filter(t => t.status === filter);
  const cnt = { all: txns.length, authorized: txns.filter(t => t.status === 'authorized').length, failed: txns.filter(t => t.status === 'failed').length, pending: txns.filter(t => t.status === 'pending').length };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Monitoring Live</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: C.muted, display: 'flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> Auto (8s)</label>
          <Btn small variant="secondary" onClick={load}>↻</Btn>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}>
        {[['Toutes', 'all', C.text], ['Approuvées', 'authorized', C.success], ['Refusées', 'failed', C.danger], ['En attente', 'pending', C.warning]].map(([l, f, color]) => (
          <Card key={f} style={{ cursor: 'pointer', border: `2px solid ${filter === f ? color : C.border}` }} onClick={() => setFilter(f)}>
            <div style={{ fontSize: 12, color: C.muted }}>{l}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color }}>{cnt[f]}</div>
          </Card>
        ))}
      </div>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Heure', 'Marchand', 'Pays', 'Méthode', 'Opérateur', 'Montant', 'Statut']}
            rows={shown.map(t => (
              <tr key={t.transaction_id}>
                <TD style={{ color: C.muted, fontSize: 11 }}>{fmtDate(t.initiated_at)}</TD>
                <TD style={{ fontWeight: 500 }}>{t.business_name}</TD>
                <TD>{t.country || '—'}</TD>
                <TD style={{ color: C.muted }}>{t.payment_method}</TD>
                <TD style={{ color: C.muted }}>{t.detected_operator || t.detected_network || '—'}</TD>
                <TD style={{ fontWeight: 600 }}>{fmt(t.amount)} {t.currency}</TD>
                <TD><Badge label={t.status} color={sc(t.status)} /></TD>
              </tr>
            ))} empty="Aucune transaction sur les dernières 24h" />
        </Card>
      )}
    </div>
  );
};

// ─── ALERTES ─────────────────────────────────────────────────────
const Alerts = () => {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [sev, setSev] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const [resolving, setResolving] = useState(null);
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    alertsApi.list({ page, limit: 25, severity: sev || undefined, resolved: showResolved })
      .then(r => { setAlerts(r.data.data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [page, sev, showResolved]);

  useEffect(() => { load(); }, [load]);

  const resolve = async () => {
    try { await alertsApi.resolve(resolving.alert_id, { note }); toast.success('Alerte résolue'); setResolving(null); setNote(''); load(); }
    catch { toast.error('Erreur'); }
  };

  const sevColors = { 1: '#8bc34a', 2: C.warning, 3: '#ff6b35', 4: C.danger };
  const sevLabels = { 1: 'Faible', 2: 'Moyen', 3: 'Élevé', 4: 'Critique' };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Alertes</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: C.muted, display: 'flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} /> Résolues</label>
          <Btn small variant="secondary" onClick={load}>↻</Btn>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[['', 'Toutes'], ['4', 'Critique'], ['3', 'Élevé'], ['2', 'Moyen'], ['1', 'Faible']].map(([v, l]) => (
          <button key={v} onClick={() => { setSev(v); setPage(1); }} style={{ padding: '6px 16px', borderRadius: 20, border: `1px solid ${sev === v ? C.primary : C.border}`, background: sev === v ? `${C.primary}14` : C.card, color: sev === v ? C.primary : C.muted, cursor: 'pointer', fontSize: 12, fontWeight: sev === v ? 600 : 400 }}>{l}</button>
        ))}
      </div>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Sévérité', 'Type', 'Marchand', 'Description', 'Date', 'Statut', 'Action']}
            rows={alerts.map(a => (
              <tr key={a.alert_id}>
                <TD><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: sevColors[a.severity], display: 'inline-block' }} /><span style={{ fontSize: 12, color: sevColors[a.severity], fontWeight: 600 }}>{sevLabels[a.severity]}</span></div></TD>
                <TD><Badge label={a.flag_type} color={C.blue} /></TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{a.merchant_id?.slice(0, 8)}…</TD>
                <TD style={{ maxWidth: 260, fontSize: 12 }}>{a.description}</TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{fmtDate(a.created_at)}</TD>
                <TD><Badge label={a.resolved ? 'Résolue' : 'Ouverte'} color={sc(a.resolved ? 'resolved' : 'open')} /></TD>
                <TD>{!a.resolved && <Btn small variant="success" onClick={() => setResolving(a)}>Résoudre</Btn>}</TD>
              </tr>
            ))} empty="Aucune alerte" />
          <Pagination page={page} setPage={setPage} count={alerts.length} />
        </Card>
      )}
      {resolving && (
        <Modal title="Résoudre l'alerte" onClose={() => { setResolving(null); setNote(''); }}>
          <p style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>{resolving.description}</p>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: C.muted, marginBottom: 4 }}>Note de résolution</label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="Décrire comment l'alerte a été traitée…" style={{ width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', color: C.text, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Btn variant="secondary" onClick={() => { setResolving(null); setNote(''); }}>Annuler</Btn>
            <Btn variant="success" onClick={resolve}>Confirmer</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── FRAUDE ───────────────────────────────────────────────────────
const Fraud = () => {
  const [tab, setTab] = useState('events');
  const [events, setEvents] = useState([]);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editRule, setEditRule] = useState(null);
  const [ruleForm, setRuleForm] = useState({});

  useEffect(() => {
    setLoading(true);
    if (tab === 'events') fraudApi.events({ limit: 50 }).then(r => { setEvents(r.data.data || []); setLoading(false); }).catch(() => setLoading(false));
    else fraudApi.rules().then(r => { setRules(r.data.data || []); setLoading(false); }).catch(() => setLoading(false));
  }, [tab]);

  const review = async (id, outcome) => {
    try { await fraudApi.review(id, { outcome }); toast.success('Mis à jour'); setEvents(e => e.map(ev => ev.event_id === id ? { ...ev, review_outcome: outcome } : ev)); }
    catch { toast.error('Erreur'); }
  };

  const toggleRule = async r => {
    try { await fraudApi.updateRule(r.rule_id, { is_active: !r.is_active }); toast.success('Règle mise à jour'); setRules(rs => rs.map(rl => rl.rule_id === r.rule_id ? { ...rl, is_active: !rl.is_active } : rl)); }
    catch { toast.error('Erreur'); }
  };

  const openRule = r => { setRuleForm({ rule_name: r.rule_name || '', rule_type: r.rule_type || 'velocity', action: r.action || 'review', risk_score_add: r.risk_score_add || 50, priority: r.priority || 100, conditions: JSON.stringify(r.conditions || {}, null, 2) }); setEditRule(r); };

  const saveRule = async () => {
    try {
      const payload = { ...ruleForm, conditions: JSON.parse(ruleForm.conditions) };
      if (editRule.rule_id) await fraudApi.updateRule(editRule.rule_id, payload);
      else await fraudApi.createRule(payload);
      toast.success('Règle sauvegardée'); setEditRule(null);
      fraudApi.rules().then(r => setRules(r.data.data || []));
    } catch { toast.error('Erreur (vérifier le JSON)'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Gestion de la Fraude</h1>
        {tab === 'rules' && <Btn onClick={() => openRule({})}>+ Nouvelle règle</Btn>}
      </div>
      <Tabs tabs={[['events', '🚨 Événements'], ['rules', '⚙️ Règles']]} active={tab} onChange={setTab} />
      {loading ? <Spin /> : tab === 'events' ? (
        <Card>
          <Tbl heads={['Heure', 'Transaction', 'Score', 'Action', 'Règles', 'Revue', 'Actions']}
            rows={events.map(e => (
              <tr key={e.event_id}>
                <TD style={{ fontSize: 11, color: C.muted }}>{fmtDate(e.created_at)}</TD>
                <TD style={{ fontFamily: 'monospace', fontSize: 11 }}>{(e.transaction_id || '').slice(0, 8)}…</TD>
                <TD><span style={{ fontWeight: 700, fontSize: 15, color: e.total_score >= 80 ? C.danger : e.total_score >= 40 ? C.warning : C.success }}>{e.total_score}</span></TD>
                <TD><Badge label={e.action_taken} color={sc(e.action_taken)} /></TD>
                <TD style={{ fontSize: 11, color: C.muted, maxWidth: 200 }}>{Array.isArray(e.rules_triggered) ? e.rules_triggered.map(r => r.ruleName).join(', ') : '—'}</TD>
                <TD><Badge label={e.review_outcome || 'pending'} color={sc(e.review_outcome || 'pending')} /></TD>
                <TD>{(!e.review_outcome || e.review_outcome === 'pending') && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Btn small variant="success" onClick={() => review(e.event_id, 'false_positive')}>FP</Btn>
                    <Btn small variant="danger" onClick={() => review(e.event_id, 'confirmed_fraud')}>Fraude</Btn>
                  </div>
                )}</TD>
              </tr>
            ))} empty="Aucun événement de fraude" />
        </Card>
      ) : (
        <Card>
          <Tbl heads={['Règle', 'Type', 'Action', 'Score', 'Priorité', 'Actif', 'Actions']}
            rows={rules.map(r => (
              <tr key={r.rule_id}>
                <TD style={{ fontWeight: 500 }}>{r.rule_name}</TD>
                <TD><Badge label={r.rule_type} color={C.blue} /></TD>
                <TD><Badge label={r.action} color={sc(r.action)} /></TD>
                <TD style={{ fontWeight: 600, color: r.risk_score_add >= 80 ? C.danger : r.risk_score_add >= 40 ? C.warning : C.muted }}>{r.risk_score_add}</TD>
                <TD>{r.priority}</TD>
                <TD><button onClick={() => toggleRule(r)} style={{ background: r.is_active ? C.success : C.border, color: '#fff', border: 'none', borderRadius: 20, padding: '3px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>{r.is_active ? 'Actif' : 'Inactif'}</button></TD>
                <TD><Btn small variant="secondary" onClick={() => openRule(r)}>Modifier</Btn></TD>
              </tr>
            ))} empty="Aucune règle" />
        </Card>
      )}
      {editRule && (
        <Modal title={editRule.rule_id ? 'Modifier la règle' : 'Nouvelle règle'} onClose={() => setEditRule(null)}>
          <Inp label="Nom" value={ruleForm.rule_name} onChange={v => setRuleForm(f => ({ ...f, rule_name: v }))} />
          <Sel label="Type" value={ruleForm.rule_type} onChange={v => setRuleForm(f => ({ ...f, rule_type: v }))} options={['velocity', 'amount', 'geo', 'device', 'pattern'].map(v => ({ v, l: v }))} />
          <Sel label="Action" value={ruleForm.action} onChange={v => setRuleForm(f => ({ ...f, action: v }))} options={['allow', 'review', 'block'].map(v => ({ v, l: v }))} />
          <Inp label="Score risque (0-100)" value={ruleForm.risk_score_add} onChange={v => setRuleForm(f => ({ ...f, risk_score_add: parseInt(v) || 0 }))} type="number" />
          <Inp label="Priorité" value={ruleForm.priority} onChange={v => setRuleForm(f => ({ ...f, priority: parseInt(v) || 100 }))} type="number" />
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: C.muted, marginBottom: 4 }}>Conditions (JSON)</label>
            <textarea value={ruleForm.conditions} onChange={e => setRuleForm(f => ({ ...f, conditions: e.target.value }))} rows={4} style={{ width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', color: C.text, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Btn variant="secondary" onClick={() => setEditRule(null)}>Annuler</Btn>
            <Btn onClick={saveRule}>Sauvegarder</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── MARCHANDS ────────────────────────────────────────────────────
const Merchants = () => {
  const [merchants, setMerchants] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusF, setStatusF] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    setLoading(true);
    merchantsApi.list({ page, limit: 20, search: search || undefined, status: statusF || undefined })
      .then(r => { setMerchants(r.data.data || []); setTotal(r.data.total || 0); })
      .finally(() => setLoading(false));
  }, [page, search, statusF]);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (id, status, reason) => {
    try { await merchantsApi.setStatus(id, { status, reason }); toast.success('Statut mis à jour'); load(); }
    catch { toast.error('Erreur'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Marchands <span style={{ fontSize: 14, color: C.muted }}>({total})</span></h1>
        <Btn onClick={() => setShowCreate(true)}>+ Créer</Btn>
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Rechercher…" style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 14px', fontSize: 14, color: C.text, outline: 'none' }} />
        <select value={statusF} onChange={e => { setStatusF(e.target.value); setPage(1); }} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 14px', fontSize: 13, color: C.text }}>
          <option value="">Tous statuts</option><option value="active">Actif</option><option value="suspended">Suspendu</option><option value="closed">Fermé</option>
        </select>
      </div>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Entreprise', 'Pays', 'Email', 'KYB', 'Statut', 'Txn', 'Volume', 'Actions']}
            rows={merchants.map(m => (
              <tr key={m.merchant_id}>
                <TD style={{ fontWeight: 500, cursor: 'pointer', color: C.primary }} onClick={() => navigate(`/merchants/${m.merchant_id}`)}>{m.business_name}</TD>
                <TD>{m.country} · {m.currency}</TD>
                <TD style={{ color: C.muted }}>{m.email}</TD>
                <TD><Badge label={`Niv.${m.kyb_level}`} color={[C.muted, C.warning, C.success][m.kyb_level] || C.muted} /></TD>
                <TD><Badge label={m.merchant_status} color={sc(m.merchant_status)} /></TD>
                <TD>{fmt(m.txn_count || 0)}</TD>
                <TD>{fmt(m.total_volume || 0)}</TD>
                <TD>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Btn small variant="secondary" onClick={() => navigate(`/merchants/${m.merchant_id}`)}>Détail</Btn>
                    {m.merchant_status === 'active'
                      ? <Btn small variant="danger" onClick={() => { const r = prompt('Raison :'); if (r) setStatus(m.merchant_id, 'suspended', r); }}>Suspendre</Btn>
                      : <Btn small variant="success" onClick={() => setStatus(m.merchant_id, 'active')}>Activer</Btn>}
                  </div>
                </TD>
              </tr>
            ))} empty="Aucun marchand" />
          <Pagination page={page} setPage={setPage} count={merchants.length} limit={20} />
        </Card>
      )}
      {showCreate && <CreateMerchantModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </div>
  );
};

const CreateMerchantModal = ({ onClose, onCreated }) => {
  const [form, setForm] = useState({ businessName: '', phone: '', email: '', password: '', country: 'CM', currency: 'XAF', settlementType: 'mobile_money', settlementAccount: '' });
  const [loading, setLoading] = useState(false);
  const f = k => v => setForm(p => ({ ...p, [k]: v }));
  const submit = async () => {
    setLoading(true);
    try { await api.post('/merchants/create', form); toast.success('Marchand créé'); onCreated(); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setLoading(false); }
  };
  return (
    <Modal title="Créer un marchand" onClose={onClose}>
      <Inp label="Nom entreprise *" value={form.businessName} onChange={f('businessName')} />
      <Inp label="Téléphone *" value={form.phone} onChange={f('phone')} placeholder="+237XXXXXXXXX" />
      <Inp label="Email *" value={form.email} onChange={f('email')} type="email" />
      <Inp label="Mot de passe *" value={form.password} onChange={f('password')} type="password" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Sel label="Pays" value={form.country} onChange={f('country')} options={[{ v: 'CM', l: 'Cameroun' }, { v: 'SN', l: 'Sénégal' }, { v: 'CI', l: "Côte d'Ivoire" }, { v: 'CG', l: 'Congo' }, { v: 'CD', l: 'RDC' }]} />
        <Sel label="Devise" value={form.currency} onChange={f('currency')} options={[{ v: 'XAF', l: 'XAF' }, { v: 'XOF', l: 'XOF' }, { v: 'CDF', l: 'CDF' }]} />
      </div>
      <Sel label="Règlement" value={form.settlementType} onChange={f('settlementType')} options={[{ v: 'mobile_money', l: 'Mobile Money' }, { v: 'bank', l: 'Banque' }]} />
      <Inp label="Compte règlement" value={form.settlementAccount} onChange={f('settlementAccount')} placeholder="Numéro ou IBAN" />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
        <Btn variant="secondary" onClick={onClose}>Annuler</Btn>
        <Btn onClick={submit} disabled={loading}>{loading ? 'Création…' : 'Créer'}</Btn>
      </div>
    </Modal>
  );
};


// ─── KYB TAB ─────────────────────────────────────────────────────
const KybTab = ({ merchantId, merchant, kybLevel, setKybLevel, updateKyb }) => {
  const [docs, setDocs] = useState([]);
  const [kyb, setKyb] = useState(null);
  const [kybNotes, setKybNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(null);

  const DOC_TYPES = [
    { v: 'rccm',          label: 'RCCM / Registre de commerce' },
    { v: 'nif',           label: 'NIF / Identifiant fiscal' },
    { v: 'id_card',       label: "Pièce d'identité dirigeant" },
    { v: 'bank_details',  label: 'RIB / Coordonnées bancaires' },
    { v: 'address_proof', label: "Justificatif d'adresse" },
    { v: 'contract',      label: 'Contrat signé' },
  ];

  const STATUS_COLORS = { pending: '#ff9500', approved: '#00c896', rejected: '#ff3b30' };
  const STATUS_LABELS = { pending: '⏳ En attente', approved: '✅ Approuvé', rejected: '❌ Rejeté' };

  useEffect(() => {
    api.get(`/merchants/${merchantId}/kyb`)
      .then(r => { setDocs(r.data.documents || []); setKyb(r.data.kyb); setKybNotes(r.data.kyb?.kyb_notes || ''); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [merchantId]);

  const reviewDoc = async (docId, status, reason) => {
    setUpdating(docId);
    try {
      await api.patch(`/merchants/${merchantId}/kyb/documents/${docId}`, { status, rejectionReason: reason });
      setDocs(prev => prev.map(d => d.doc_id === docId ? { ...d, status } : d));
      toast.success(status === 'approved' ? 'Document approuvé ✅' : 'Document rejeté');
    } catch { toast.error('Erreur'); }
    finally { setUpdating(null); }
  };

  const saveNotes = async () => {
    try {
      await api.patch(`/merchants/${merchantId}/kyb`, { kybNotes });
      toast.success('Notes sauvegardées');
    } catch { toast.error('Erreur'); }
  };

  if (loading) return <Spin />;

  const pending  = docs.filter(d => d.status === 'pending').length;
  const approved = docs.filter(d => d.status === 'approved').length;
  const rejected = docs.filter(d => d.status === 'rejected').length;

  return (
    <div>
      {/* Résumé KYB */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 20 }}>
        {[['⏳ En attente', pending, '#ff9500'], ['✅ Approuvés', approved, '#00c896'], ['❌ Rejetés', rejected, '#ff3b30']].map(([l,v,c]) => (
          <Card key={l} style={{ textAlign: 'center', padding: 16 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: c }}>{v}</div>
            <div style={{ fontSize: 12, color: '#5a6677', marginTop: 4 }}>{l}</div>
          </Card>
        ))}
      </div>

      {/* Progression KYB */}
      <Card style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>Niveau KYB & Plafonds</h3>
        {[[0,'Compte créé','500 000 XAF/j'], [1,'KYB validé','5 000 000 XAF/j'], [2,'Contrat signé','Illimité']].map(([l,label,limit]) => (
          <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ width: 28, height: 28, borderRadius: '50%', background: merchant.kyb_level >= l ? '#00c896' : C.border, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#fff', fontWeight: 700, flexShrink: 0 }}>{l}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: merchant.kyb_level >= l ? C.text : '#5a6677' }}>{label}</div>
              <div style={{ fontSize: 11, color: '#5a6677' }}>Plafond : {limit}</div>
            </div>
            {merchant.kyb_level >= l && <span style={{ color: '#00c896', fontSize: 16 }}>✓</span>}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
          <select value={kybLevel} onChange={e => setKybLevel(e.target.value)}
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, padding: '8px', borderRadius: 8, fontSize: 13, color: C.text }}>
            <option value="0">Niveau 0 — 500k/j</option>
            <option value="1">Niveau 1 — 5M/j (KYB validé)</option>
            <option value="2">Niveau 2 — Illimité (Contrat signé)</option>
          </select>
          <Btn small onClick={updateKyb}>Appliquer</Btn>
        </div>
      </Card>

      {/* Documents soumis */}
      <Card style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>Documents justificatifs</h3>
        {docs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 0', color: '#5a6677', fontSize: 13 }}>
            Aucun document soumis par le merchant
          </div>
        ) : docs.map(doc => (
          <div key={doc.doc_id} style={{ padding: '12px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {DOC_TYPES.find(t => t.v === doc.doc_type)?.label || doc.doc_type}
                </div>
                <div style={{ fontSize: 11, color: '#5a6677', marginTop: 2 }}>
                  {doc.file_name || 'Document'} · {new Date(doc.uploaded_at).toLocaleDateString('fr-FR')}
                </div>
                {doc.rejection_reason && (
                  <div style={{ fontSize: 11, color: '#ff3b30', marginTop: 4 }}>Motif : {doc.rejection_reason}</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                <span style={{ background: `${STATUS_COLORS[doc.status]}20`, color: STATUS_COLORS[doc.status], borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>
                  {STATUS_LABELS[doc.status]}
                </span>
                {doc.file_url && (
                  <a href={doc.file_url} target="_blank" rel="noreferrer"
                    style={{ background: '#f0f4f8', border: '1px solid #dce3ed', color: '#1e2d3d', padding: '4px 10px', borderRadius: 6, fontSize: 11, textDecoration: 'none', fontWeight: 600 }}>
                    👁️ Voir
                  </a>
                )}
                {doc.status === 'pending' && (
                  <>
                    <Btn small onClick={() => reviewDoc(doc.doc_id, 'approved')} disabled={updating === doc.doc_id}>
                      ✅ Approuver
                    </Btn>
                    <Btn small variant="danger" onClick={() => {
                      const reason = window.prompt('Motif de rejet :');
                      if (reason !== null) reviewDoc(doc.doc_id, 'rejected', reason);
                    }} disabled={updating === doc.doc_id}>
                      ❌ Rejeter
                    </Btn>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </Card>

      {/* Notes admin */}
      <Card>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Notes internes</h3>
        <textarea value={kybNotes} onChange={e => setKybNotes(e.target.value)} rows={4}
          placeholder="Notes sur le KYB de ce merchant (visible uniquement par les admins)..."
          style={{ width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, color: C.text, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }} />
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
          <Btn small onClick={saveNotes}>💾 Enregistrer les notes</Btn>
        </div>
      </Card>
    </div>
  );
};

const MerchantDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [merchant, setMerchant] = useState(null);
  const [kybLevel, setKybLevel] = useState('0');
  const [fees, setFees] = useState([]);
  const [savingFees, setSavingFees] = useState(false);
  const [velocity, setVelocity] = useState({});
  const [savingVelocity, setSavingVelocity] = useState(false);
  const [activeTab, setActiveTab] = useState('info');

  useEffect(() => {
    merchantsApi.get(id)
      .then(r => {
        setMerchant(r.data.merchant || r.data);
        setKybLevel(String((r.data.merchant || r.data).kyb_level || 0));
        if (r.data.fees) setFees(r.data.fees);
        const m = r.data.merchant || r.data;
        setVelocity({
          velocity_max_per_txn: m.velocity_max_per_txn || '',
          velocity_max_daily_amount: m.velocity_max_daily_amount || '',
          velocity_max_daily_count: m.velocity_max_daily_count || '',
          velocity_max_monthly_amount: m.velocity_max_monthly_amount || '',
          velocity_max_monthly_count: m.velocity_max_monthly_count || '',
        });
      })
      .catch(() => navigate('/merchants'));
  }, [id]);

  if (!merchant) return <Spin />;

  const updateKyb = async () => {
    try { await merchantsApi.setKyb(id, { kybLevel: parseInt(kybLevel) }); toast.success('KYB mis à jour'); }
    catch { toast.error('Erreur'); }
  };

  const updateFee = (idx, field, val) => {
    setFees(prev => prev.map((f, i) => i === idx ? { ...f, [field]: val } : f));
  };

  const saveFees = async () => {
    setSavingFees(true);
    try {
      await api.put(`/admin/merchants/${id}/fees`, { fees });
      toast.success('Frais mis à jour ✅');
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSavingFees(false); }
  };

  const saveVelocity = async () => {
    setSavingVelocity(true);
    try {
      await api.put(`/admin/merchants/${id}/velocity`, velocity);
      toast.success('Limites de vélocité mises à jour ✅');
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSavingVelocity(false); }
  };

  const FEE_LABELS = {
    card_cybersource: 'CyberSource (Visa)',
    card_migs:        'MIGS (Mastercard)',
    mtn_momo:         'MTN MoMo',
    airtel_money:     'Airtel Money',
  };
  const DIR_LABELS = { collection: '⬇️ Encaissement', disbursement: '⬆️ Décaissement' };
  const tabs = [
    { v: 'info', label: '📋 Informations' },
    { v: 'fees', label: '💰 Frais & Commissions' },
    { v: 'velocity', label: '⚡ Vélocité' },
    { v: 'kyb',  label: '🔐 KYB & Plafonds' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <Btn small variant="secondary" onClick={() => navigate('/merchants')}>← Retour</Btn>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{merchant.business_name}</h1>
        <Badge label={merchant.merchant_status} color={sc(merchant.merchant_status)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 18 }}>
        <Stat label="Transactions totales" value={fmt(merchant.total_txn || 0)} />
        <Stat label="Volume total" value={`${fmt(merchant.total_volume || 0)} ${merchant.currency || 'XAF'}`} color={C.primary} />
        <Stat label="Terminaux" value={merchant.terminal_count || 0} color={C.blue} />
      </div>

      {/* Onglets */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: `2px solid ${C.border}` }}>
        {tabs.map(t => (
          <button key={t.v} onClick={() => setActiveTab(t.v)}
            style={{ padding: '10px 24px', border: 'none', background: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer',
              color: activeTab === t.v ? C.primary : C.muted,
              borderBottom: `3px solid ${activeTab === t.v ? C.primary : 'transparent'}`,
              marginBottom: -2, transition: 'all .2s' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Informations */}
      {activeTab === 'info' && (
        <Card>
          <h3 style={{ margin: '0 0 14px', fontSize: 15 }}>Informations marchands</h3>
          {[['Pays', `${merchant.country} — ${merchant.currency || 'XAF'}`],
            ['Email', merchant.email],
            ['Téléphone', merchant.phone],
            ['RCCM', merchant.rccm || '—'],
            ['NIF', merchant.nif || '—'],
            ['Règlement', `${merchant.settlement_type || '—'} — ${merchant.settlement_account || '—'}`],
            ['Statut', merchant.merchant_status],
            ['Inscription', fmtDate(merchant.created_at)]
          ].map(([l, v]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
              <span style={{ color: C.muted }}>{l}</span><span>{v}</span>
            </div>
          ))}
        </Card>
      )}

      {/* Tab Frais */}
      {activeTab === 'fees' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 15 }}>Frais & Commissions</h3>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Définissez les frais par type de paiement et direction pour ce merchant</div>
            </div>
            <Btn small onClick={saveFees} disabled={savingFees}>
              {savingFees ? 'Sauvegarde…' : '💾 Enregistrer'}
            </Btn>
          </div>

          {['collection', 'disbursement'].map(dir => (
            <Card key={dir} style={{ marginBottom: 16 }}>
              <h4 style={{ margin: '0 0 14px', fontSize: 14, color: dir === 'collection' ? C.success : C.warning || '#ff9500' }}>
                {DIR_LABELS[dir]}
              </h4>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${C.border}`, color: C.muted }}>
                    {['Moyen de paiement', 'Taux (%)', 'Fixe (XAF)', 'Min (XAF)', 'Max (XAF)', 'Actif'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {fees.filter(f => f.direction === dir).map((fee, idx) => {
                    const globalIdx = fees.indexOf(fee);
                    return (
                      <tr key={fee.fee_id || idx} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ padding: '10px 10px', fontWeight: 600 }}>{FEE_LABELS[fee.payment_type] || fee.payment_type}</td>
                        <td style={{ padding: '8px 6px' }}>
                          <input type="number" step="0.01" min="0" max="100"
                            value={(parseFloat(fee.fee_rate || 0) * 100).toFixed(2)}
                            onChange={e => updateFee(globalIdx, 'fee_rate', parseFloat(e.target.value) / 100)}
                            style={{ width: 70, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 13, color: C.text }} />
                          <span style={{ color: C.muted, marginLeft: 4 }}>%</span>
                        </td>
                        <td style={{ padding: '8px 6px' }}>
                          <input type="number" min="0"
                            value={parseFloat(fee.fee_fixed || 0)}
                            onChange={e => updateFee(globalIdx, 'fee_fixed', parseFloat(e.target.value))}
                            style={{ width: 80, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 13, color: C.text }} />
                        </td>
                        <td style={{ padding: '8px 6px' }}>
                          <input type="number" min="0"
                            value={parseFloat(fee.fee_min || 0)}
                            onChange={e => updateFee(globalIdx, 'fee_min', parseFloat(e.target.value))}
                            style={{ width: 80, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 13, color: C.text }} />
                        </td>
                        <td style={{ padding: '8px 6px' }}>
                          <input type="number" min="0"
                            value={fee.fee_max || ''}
                            placeholder="Illimité"
                            onChange={e => updateFee(globalIdx, 'fee_max', e.target.value ? parseFloat(e.target.value) : null)}
                            style={{ width: 90, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 13, color: C.text }} />
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <input type="checkbox" checked={fee.is_active !== false}
                            onChange={e => updateFee(globalIdx, 'is_active', e.target.checked)}
                            style={{ width: 16, height: 16, cursor: 'pointer' }} />
                        </td>
                      </tr>
                    );
                  })}
                  {fees.filter(f => f.direction === dir).length === 0 && (
                    <tr><td colSpan={6} style={{ padding: '20px 10px', textAlign: 'center', color: C.muted }}>Aucun frais configuré</td></tr>
                  )}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}

      {/* Tab Vélocité */}
      {activeTab === 'velocity' && (
        <div>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>⚡ Limites de vélocité</h3>
              <Btn small onClick={saveVelocity} disabled={savingVelocity}>
                {savingVelocity ? 'Enregistrement...' : 'Enregistrer'}
              </Btn>
            </div>
            <p style={{ fontSize: 12, color: C.muted, marginBottom: 16 }}>
              Laisser vide = aucune limite. Les montants sont en XAF.
            </p>
            {[
              ['velocity_max_per_txn', 'Montant max par transaction', 'XAF'],
              ['velocity_max_daily_amount', 'Montant cumulé max / jour', 'XAF'],
              ['velocity_max_daily_count', 'Nombre max de transactions / jour', 'txn'],
              ['velocity_max_monthly_amount', 'Montant cumulé max / mois', 'XAF'],
              ['velocity_max_monthly_count', 'Nombre max de transactions / mois', 'txn'],
            ].map(([key, label, unit]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
                <label style={{ fontSize: 13, color: C.text }}>{label}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="number" value={velocity[key] ?? ''}
                    onChange={e => setVelocity(v => ({ ...v, [key]: e.target.value }))}
                    placeholder="illimité"
                    style={{ width: 140, padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, textAlign: 'right', background: C.card, color: C.text }} />
                  <span style={{ fontSize: 12, color: C.muted, width: 32 }}>{unit}</span>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* Tab KYB */}
      {activeTab === 'kyb' && (
        <KybTab merchantId={id} merchant={merchant} kybLevel={kybLevel} setKybLevel={setKybLevel} updateKyb={updateKyb} />
      )}
    </div>
  );
};

// ─── TRANSACTIONS ─────────────────────────────────────────────────
const Transactions = () => {
  const [txns, setTxns] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ status: '', type: '', method: '' });
  const [selected, setSelected] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    txnApi.list({ page, limit: 25, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) })
      .then(r => { setTxns(r.data.data || []); setTotal(r.data.total || 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, filters]);
  useEffect(() => { load(); }, [load]);

  const refund = async id => {
    if (!window.confirm('Confirmer le remboursement ?')) return;
    try { await txnApi.refund(id); toast.success('Remboursement initié'); load(); }
    catch (err) {
      // Hotfix v1 : POST /transactions/:id/refund repond 501 REFUND_NOT_IMPLEMENTED
      if (err.response?.status === 501 || err.response?.data?.code === 'REFUND_NOT_IMPLEMENTED') toast('Remboursement manuel via l\u2019opérateur', { icon: 'ℹ️', duration: 6000 });
      else toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  // Reconciliation manuelle des transactions pending : POST /api/v1/admin/reconcile (super_admin / ops_admin)
  const { admin } = useAuth();
  const [reconciling, setReconciling] = useState(false);
  const reconcile = async () => {
    if (!window.confirm('Lancer la réconciliation des transactions en attente (24 h) auprès des opérateurs ?')) return;
    setReconciling(true);
    try {
      const { data } = await api.post('/reconcile', { maxAgeHours: 24 });
      const sum = data || {};
      toast.success(`Réconciliation : ${sum.checked ?? sum.total ?? '?'} vérifiée(s), ${sum.updated ?? sum.changed ?? 0} mise(s) à jour`, { duration: 6000 });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur réconciliation'); }
    finally { setReconciling(false); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Transactions <span style={{ fontSize: 14, color: C.muted }}>({fmt(total)})</span></h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {hasRole(admin, ['super_admin', 'ops_admin']) && <Btn small variant="blue" onClick={reconcile} disabled={reconciling}>{reconciling ? 'Réconciliation…' : '🔄 Réconcilier les pending'}</Btn>}
          <Btn small variant="secondary" onClick={load}>↻</Btn>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[['status', [['', 'Tous statuts'], ['authorized', 'Approuvé'], ['failed', 'Refusé'], ['pending', 'En attente']]],
          ['type', [['', 'Tous types'], ['collect', 'Encaissement'], ['payout', 'Retrait']]],
          ['method', [['', 'Toutes méthodes'], ['mobile_money', 'Mobile Money'], ['card_nfc', 'Carte NFC']]]].map(([k, opts]) => (
          <select key={k} value={filters[k]} onChange={e => { setFilters(f => ({ ...f, [k]: e.target.value })); setPage(1); }} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: C.text }}>
            {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ))}
      </div>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Date', 'Type', 'Méthode', 'Montant', 'Frais', 'Net', 'Statut', 'Règlement', 'Auth', 'Actions']}
            rows={txns.map(t => (
              <tr key={t.transaction_id} style={{ cursor: 'pointer' }} onClick={() => setSelected(t)}>
                <TD style={{ fontSize: 11, color: C.muted }}>{fmtDate(t.initiated_at)}</TD>
                <TD><Badge label={t.type} color={t.type === 'collect' ? C.success : C.blue} /></TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{t.payment_method}</TD>
                <TD style={{ fontWeight: 600 }}>{fmt(t.amount)} {t.currency}</TD>
                <TD style={{ color: C.danger }}>{t.fee_amount ? `-${fmt(t.fee_amount)}` : '—'}</TD>
                <TD style={{ color: C.success, fontWeight: 600 }}>{t.net_amount ? fmt(t.net_amount) : '—'}</TD>
                <TD><Badge label={t.status} color={sc(t.status)} /></TD>
                <TD>{(() => {
                  const mp = { regle: ['Réglé', C.success], en_cours: ['En cours', C.warning || '#f5a623'], echec: ['Échec', C.danger], non_regle: ['Non réglé', C.muted] };
                  const [lbl, col] = mp[t.settlement_status] || mp.non_regle;
                  return <Badge label={lbl} color={col} />;
                })()}</TD>
                <TD style={{ fontFamily: 'monospace', fontSize: 11 }}>{t.auth_code || '—'}</TD>
                <TD onClick={e => e.stopPropagation()}>{t.status === 'authorized' && <Btn small variant="warning" onClick={() => refund(t.transaction_id)}>Rembourser</Btn>}</TD>
              </tr>
            ))} empty="Aucune transaction" />
          <Pagination page={page} setPage={setPage} count={txns.length} />
        </Card>
      )}
      {selected && (
        <Modal title="Détail transaction" onClose={() => setSelected(null)}>
          {[['ID', selected.transaction_id], ['Type', selected.type], ['Méthode', selected.payment_method], ['Montant', `${fmt(selected.amount)} ${selected.currency}`], ['Frais', selected.fee_amount ? `${fmt(selected.fee_amount)} ${selected.currency}` : '—'], ['Net', selected.net_amount ? `${fmt(selected.net_amount)} ${selected.currency}` : '—'], ['Statut', selected.status], ['Auth Code', selected.auth_code || '—'], ['Opérateur', selected.detected_operator || '—'], ['Réseau', selected.detected_network || '—'], ['Pays', selected.detected_country || '—'], ['Description', selected.description || '—'], ['Terminal', selected.device_id || '—'], ['Initié le', fmtDate(selected.initiated_at)], ['Complété le', fmtDate(selected.completed_at)]].map(([l, v]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
              <span style={{ color: C.muted }}>{l}</span>
              <span style={{ fontFamily: l === 'ID' ? 'monospace' : 'inherit', fontSize: l === 'ID' ? 11 : 13, maxWidth: 260, textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
};

// ─── UTILISATEURS ─────────────────────────────────────────────────
const Users = () => {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    usersApi.list({ page, limit: 20, search: search || undefined })
      .then(r => { setUsers(r.data.data || []); setTotal(r.data.total || 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, search]);
  useEffect(() => { load(); }, [load]);

  const toggle = async (id, is_active) => { try { await usersApi.toggle(id, { is_active: !is_active }); toast.success('Statut mis à jour'); load(); } catch { toast.error('Erreur'); } };
  const resetPwd = async id => { try { await usersApi.resetPwd(id); toast.success('Email de réinitialisation envoyé'); } catch { toast.error('Erreur'); } };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Utilisateurs <span style={{ fontSize: 14, color: C.muted }}>({total})</span></h1>
        <Btn onClick={() => setShowCreate(true)}>+ Nouvel utilisateur</Btn>
      </div>
      <div style={{ marginBottom: 14 }}>
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Rechercher par email ou nom…" style={{ width: 320, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '9px 14px', fontSize: 14, color: C.text, outline: 'none' }} />
      </div>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Nom', 'Email', 'Téléphone', 'Marchand', 'Rôle', 'Statut', 'Dernière connexion', 'Actions']}
            rows={users.map(u => (
              <tr key={u.user_id}>
                <TD style={{ fontWeight: 500 }}>{u.first_name} {u.last_name}</TD>
                <TD style={{ color: C.muted }}>{u.email}</TD>
                <TD style={{ color: C.muted }}>{u.phone || '—'}</TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{u.business_name || '—'}</TD>
                <TD><Badge label={u.role} color={u.role === 'owner' ? C.blue : C.muted} /></TD>
                <TD><Badge label={u.is_active ? 'Actif' : 'Inactif'} color={u.is_active ? C.success : C.muted} /></TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{fmtDate(u.last_login_at)}</TD>
                <TD>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Btn small variant={u.is_active ? 'danger' : 'success'} onClick={() => toggle(u.user_id, u.is_active)}>{u.is_active ? 'Désactiver' : 'Activer'}</Btn>
                    <Btn small variant="secondary" onClick={() => resetPwd(u.user_id)}>Reset MDP</Btn>
                  </div>
                </TD>
              </tr>
            ))} empty="Aucun utilisateur" />
          <Pagination page={page} setPage={setPage} count={users.length} limit={20} />
        </Card>
      )}
      {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </div>
  );
};

const CreateUserModal = ({ onClose, onCreated }) => {
  const [form, setForm] = useState({ email: '', phone: '', firstName: '', lastName: '', password: '', role: 'cashier', merchantId: '' });
  const [loading, setLoading] = useState(false);
  const f = k => v => setForm(p => ({ ...p, [k]: v }));
  const submit = async () => {
    setLoading(true);
    try { await usersApi.create(form); toast.success('Utilisateur créé'); onCreated(); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setLoading(false); }
  };
  return (
    <Modal title="Nouvel utilisateur" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Inp label="Prénom" value={form.firstName} onChange={f('firstName')} />
        <Inp label="Nom" value={form.lastName} onChange={f('lastName')} />
      </div>
      <Inp label="Email *" value={form.email} onChange={f('email')} type="email" />
      <Inp label="Téléphone" value={form.phone} onChange={f('phone')} placeholder="+237XXXXXXXXX" />
      <Inp label="Mot de passe *" value={form.password} onChange={f('password')} type="password" />
      <Sel label="Rôle" value={form.role} onChange={f('role')} options={[{ v: 'owner', l: 'Propriétaire' }, { v: 'cashier', l: 'Caissier' }, { v: 'viewer', l: 'Lecteur' }]} />
      <Inp label="ID Marchand (UUID)" value={form.merchantId} onChange={f('merchantId')} placeholder="UUID du marchand" />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
        <Btn variant="secondary" onClick={onClose}>Annuler</Btn>
        <Btn onClick={submit} disabled={loading}>{loading ? 'Création…' : 'Créer'}</Btn>
      </div>
    </Modal>
  );
};

// ─── APIS & OPÉRATEURS ────────────────────────────────────────────
// Affichage d'un secret masque { configured, last4 } renvoye par le backend (hotfix v1)
const SecretHint = ({ masked }) => {
  if (!masked || typeof masked !== 'object') return null;
  return masked.configured
    ? <div style={{ fontSize:11, color:C.success, marginTop:3 }}>✅ configuré ••••{masked.last4 || '????'} — laisser vide pour conserver, saisir pour remplacer</div>
    : <div style={{ fontSize:11, color:C.muted, marginTop:3 }}>non configuré</div>;
};
// Resume des secrets d'une configuration API : api_key / api_secret / extra_params masques
const SecretSummary = ({ data }) => {
  if (!data) return null;
  const rows = [];
  if (data.api_key && typeof data.api_key === 'object') rows.push(['api_key', data.api_key]);
  if (data.api_secret && typeof data.api_secret === 'object') rows.push(['api_secret', data.api_secret]);
  Object.entries(data.extra_params || {}).forEach(([k, v]) => { if (v && typeof v === 'object' && 'configured' in v) rows.push([k, v]); });
  if (!rows.length) return null;
  return (
    <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:10, padding:12, marginBottom:14 }}>
      <div style={{ fontSize:12, fontWeight:700, marginBottom:6 }}>🔒 Secrets enregistrés (jamais affichés en clair)</div>
      <div style={{ fontSize:11, color:C.muted, marginBottom:6 }}>Laissez les champs secrets vides pour conserver les valeurs actuelles ; saisissez une valeur pour la remplacer.</div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display:'flex', justifyContent:'space-between', fontSize:12, padding:'3px 0' }}>
          <code style={{ color:C.text }}>{k}</code>
          <span style={{ color: v.configured ? C.success : C.muted }}>{v.configured ? `configuré ••••${v.last4 || '????'}` : 'non configuré'}</span>
        </div>
      ))}
    </div>
  );
};

const ApiConfigs = () => {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [testing, setTesting] = useState(null);
  const [activeCountry, setActiveCountry] = useState('cd');
  const [activeTab, setActiveTab] = useState('operators');
  const [notifConfig, setNotifConfig] = useState({ smpp_host:'', smpp_port:'2775', smpp_user:'', smpp_pass:'', smpp_src:'C-Pay', smtp_host:'', smtp_port:'587', smtp_user:'', smtp_pass:'', smtp_from:'noreply@c-pay.global', smtp_secure:'tls', wa_token:'', wa_phone_id:'', wa_verify_token:'' });
  const [savingNotif, setSavingNotif] = useState(false);
  // Hotfix v1 : GET /notification-configs renvoie les secrets sous la forme
  // { configured, last4 } (jamais la valeur). notifMeta garde cet etat pour l'affichage ;
  // le champ reste vide = conserver, saisir = remplacer.
  const [notifMeta, setNotifMeta] = useState({});
  const NOTIF_SECRETS = ['smpp_pass', 'smtp_pass', 'wa_token', 'wa_verify_token'];
  const loadNotifConfig = useCallback(() => {
    api.get('/notification-configs').then(r => {
      const d = r.data || {}; const meta = {}; const vals = {};
      Object.entries(d).forEach(([k, v]) => {
        if (v && typeof v === 'object' && 'configured' in v) { meta[k] = v; vals[k] = ''; }
        else if (typeof v !== 'object' && v != null) vals[k] = String(v);
      });
      setNotifMeta(meta);
      setNotifConfig(p => ({ ...p, ...vals }));
    }).catch(() => {});
  }, []);
  useEffect(() => { loadNotifConfig(); }, [loadNotifConfig]);

  const saveNotifConfig = async (section) => {
    setSavingNotif(true);
    try {
      const payload = { section };
      Object.entries(notifConfig).forEach(([k, v]) => {
        if (typeof v === 'object') return;
        if (NOTIF_SECRETS.includes(k) && (v === '' || v == null)) return; // vide = conserver le secret stocke
        payload[k] = v;
      });
      await api.post('/notification-configs', payload); toast.success('Sauvegardé ✅');
      setNotifConfig(p => { const n = { ...p }; NOTIF_SECRETS.forEach(k => { n[k] = ''; }); return n; });
      loadNotifConfig();
    }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSavingNotif(false); }
  };

  const testNotifConfig = async (section) => {
    setSavingNotif(true);
    try {
      const r = await api.post('/notification-configs/test', { section });
      toast.success(r.data.message || 'Connexion OK ✅');
    } catch(err){ toast.error(err.response?.data?.error || 'Connexion échouée ❌'); }
    finally { setSavingNotif(false); }
  };

  const [testTo, setTestTo] = useState({ smpp:'', smtp:'', whatsapp:'' });
  const sendTest = async (section) => {
    const to = testTo[section];
    if (!to) return toast.error('Entrez un destinataire');
    setSavingNotif(true);
    try {
      const r = await api.post('/notification-configs/send-test', { section, to });
      toast.success(r.data.message || 'Envoyé ✅');
    } catch(err){ toast.error(err.response?.data?.error || 'Échec envoi ❌'); }
    finally { setSavingNotif(false); }
  };


  const [envStatus, setEnvStatus] = useState({});
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data }, envRes] = await Promise.all([
        apiConfigsApi.list({}),
        api.get('/api-configs/env-status').catch(()=>({ data:{} }))
      ]);
      setConfigs(data.data || []);
      setEnvStatus(envRes.data || {});
    }
    catch { toast.error('Erreur chargement'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openEdit = async config => {
    try {
      let data = config;
      if (config.config_id) { const res = await apiConfigsApi.get(config.config_id); data = { ...config, ...(res.data?.data || res.data) }; }
      // Les secrets arrivent masques ({configured,last4}) : les champs restent vides (= conserver)
      setForm({
        displayName: data.display_name || config.display_name || '',
        baseUrlSandbox: data.extra_params?.base_url_sandbox || '',
        baseUrlProd: data.base_url || '',
        apiKeySandbox: '', apiKeyProd: '',
        apiSecretSandbox: '', apiSecretProd: '',
        merchantIdSandbox: data.extra_params?.merchant_id_sandbox || '',
        merchantIdProd: data.extra_params?.merchant_id_prod || '',
        status: data.status || 'inactive',
        environment: data.extra_params?.environment || 'sandbox',
        notes: data.notes || '',
        colApiUserProd: '', colApiKeyProd: '', colSubKeyProd: '', colSubKey2Prod: '',
        disApiUserProd: '', disApiKeyProd: '', disSubKeyProd: '', disSubKey2Prod: '',
        colClientIdProd: '', colClientSecretProd: '', colCountryProd: 'CG',
        disClientIdProd: '', disClientSecretProd: '', disCountryProd: 'CG',
      });
      setEditing(data);
    } catch { toast.error('Erreur'); }
  };

  const save = async () => {
    if (!editing) return;
    try {
      const payload = { baseUrl: form.baseUrlProd || undefined, notes: form.notes, status: form.status, extraParams: { environment: form.environment, base_url_sandbox: form.baseUrlSandbox, merchant_id_sandbox: form.merchantIdSandbox, merchant_id_prod: form.merchantIdProd } };
      if (form.apiKeyProd) payload.apiKey = form.apiKeyProd;
      if (form.apiSecretProd) payload.apiSecret = form.apiSecretProd;
      if (editing.config_id) { await apiConfigsApi.update(editing.provider_key, payload); }
      else { await api.post('/api-configs', { providerKey: editing.provider_key, ...payload }); }
      toast.success('Configuration sauvegardée ✅');
      setEditing(null); load();
    } catch { toast.error('Erreur sauvegarde'); }
  };

  const testConn = async key => {
    setTesting(key);
    try { const { data } = await apiConfigsApi.test(key); toast[data.ok ? 'success' : 'error'](`${key}: ${data.ok ? 'OK ✓' : (data.reason || 'Échec')}`); load(); }
    catch { toast.error('Erreur test'); } finally { setTesting(null); }
  };

  const COUNTRIES = [
    { code: 'cd', flag: '🇨🇩', name: 'RDC — Congo Kinshasa' },
    { code: 'cm', flag: '🇨🇲', name: 'Cameroun' },
    { code: 'cg', flag: '🇨🇬', name: 'Congo Brazzaville' },
  ];

  const PROVIDERS = {
    cd: { mobile: [{ key:'airtel_money',key2:'airtel',name:'Airtel Money',icon:'🔴',color:'#E40000'},{key:'afrimoney',key2:'afrimoney',name:'Afrimoney',icon:'🟠',color:'#FF6600'},{key:'mpesa',key2:'mpesa',name:'M-Pesa',icon:'🟢',color:'#00A86B'},{key:'orange_money_cd',key2:'orange',name:'Orange Money',icon:'🟡',color:'#FF7900'}], psp:[{key:'cybersource',key2:'cybersource',name:'CyberSource',icon:'💳',color:'#1565C0',desc:'Toutes cartes'}]},
    cm: { mobile:[{key:'orange_money_cm',key2:'orange',name:'Orange Money',icon:'🟡',color:'#FF7900'},{key:'mtn_momo_cm',key2:'mtn',name:'MTN MoMo',icon:'🟡',color:'#FFC000'}], psp:[{key:'cybersource',key2:'cybersource',name:'CyberSource',icon:'💳',color:'#1565C0',desc:'Toutes cartes'}]},
    cg: { mobile:[{key:'airtel_money_cg',key2:'airtel',name:'Airtel Money',icon:'🔴',color:'#E40000'},{key:'mtn_momo_cg',key2:'mtn',name:'MTN MoMo',icon:'🟡',color:'#FFC000'}], psp:[{key:'cybersource',key2:'cybersource',name:'CyberSource',icon:'💳',color:'#1565C0',desc:'Toutes cartes'},{key:'migs',key2:'migs',name:'Mastercard Gateway',icon:'🔵',color:'#EB001B',desc:'Toutes cartes'}]},
  };

  const getConfig = key => configs.find(c => c.provider_key === key);
  const sc2 = s => ({ active:'#00c896', inactive:'#ff3b30', testing:'#ff9500' })[s] || C.muted;

  const ProviderCard = ({ provider }) => {
    const cfg = getConfig(provider.key);
    const status = cfg?.status || 'inactive';
    const env = cfg?.extra_params?.environment || cfg?.extra_params?.env || 'sandbox';
    const lastTestOk = cfg?.last_test_ok;
    const lastTested = cfg?.last_tested_at;
    const [testing, setTesting] = useState(false);

    const testProvider = async () => {
      setTesting(true);
      try {
        const r = await api.post(`/api-configs/${provider.key}/test`);
        toast[r.data.ok ? 'success' : 'error'](`${provider.name}: ${r.data.ok ? 'Connecté ✅' : (r.data.reason || 'Échec')}`);
        load();
      } catch { toast.error(`${provider.name}: Erreur test`); }
      finally { setTesting(false); }
    };

    return (
      <div style={{ background:C.card, border:`1px solid ${lastTestOk===true?'#00c896':lastTestOk===false?'#ff3b30':status==='active'?provider.color:C.border}`, borderRadius:12, padding:16, marginBottom:10, borderLeft:`4px solid ${provider.color}` }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:24 }}>{provider.icon}</span>
            <div>
              <div style={{ fontSize:14, fontWeight:700 }}>{provider.name}</div>
              {provider.desc && <div style={{ fontSize:11, color:C.muted }}>{provider.desc}</div>}
              <div style={{ display:'flex', gap:6, marginTop:4, flexWrap:'wrap' }}>
                <Badge label={status==='active'?'✅ Actif':'⛔ Inactif'} color={sc2(status)} />
                {cfg && <Badge label={env==='production'?'🟢 Production':'🔵 Sandbox'} color={env==='production'?'#00c896':'#1565C0'} />}
                {lastTestOk === true && <Badge label='🔌 Connecté' color='#00c896' />}
                {lastTestOk === false && <Badge label='❌ Déconnecté' color='#ff3b30' />}
                {lastTested && <span style={{ fontSize:10, color:C.muted }}>Testé: {new Date(lastTested).toLocaleString('fr-FR')}</span>}
              </div>
            </div>
          </div>
          <div style={{ display:'flex', gap:6 }}>
              <Btn small onClick={() => openEdit(cfg || { config_id:null, provider_key:provider.key, display_name:provider.name, status:'inactive', extra_params:{} })}>⚙️ Configurer</Btn>
              <Btn small outline onClick={testProvider} disabled={testing}>{testing?'…':'🔌 Tester'}</Btn>
          </div>
        </div>
      </div>
    );
  };

  const SectionBox = ({ color, title, children }) => (
    <div style={{ background:`${color}08`, border:`1px solid ${color}30`, borderRadius:10, padding:14, marginBottom:14 }}>
      <div style={{ fontSize:13, fontWeight:700, color, marginBottom:10 }}>{title}</div>
      {children}
    </div>
  );

  const isMTN  = editing?.provider_key?.includes('mtn');
  const isAirtel = editing?.provider_key?.includes('airtel');
  const isCS   = editing?.provider_key?.includes('cybersource');
  const isMIGS = editing?.provider_key?.includes('migs');
  const isOrange = editing?.provider_key?.includes('orange');
  const isMpesa  = editing?.provider_key?.includes('mpesa');
  const isAfri   = editing?.provider_key?.includes('afrimoney');

  return (
    <div>
      <h1 style={{ margin:'0 0 8px', fontSize:22, fontWeight:700 }}>APIs & Configuration</h1>
      <p style={{ color:C.muted, fontSize:13, marginBottom:16 }}>Configurez les opérateurs, PSP et canaux de notification</p>

      <div style={{ display:'flex', gap:0, marginBottom:24, borderBottom:`2px solid ${C.border}` }}>
        {[['operators','⚡ APIs & Opérateurs'],['notifications','🔔 Notifications (SMS / WhatsApp / Email)']].map(([v,l])=>(
          <button key={v} onClick={()=>setActiveTab(v)}
            style={{ padding:'10px 24px', border:'none', background:'none', fontSize:14, fontWeight:700, cursor:'pointer', color:activeTab===v?C.primary:C.muted, borderBottom:`3px solid ${activeTab===v?C.primary:'transparent'}`, marginBottom:-2 }}>
            {l}
          </button>
        ))}
      </div>

      {activeTab==='operators' && (<>
        <div style={{ display:'flex', gap:0, marginBottom:20, borderBottom:`1px solid ${C.border}` }}>
          {COUNTRIES.map(c=>(
            <button key={c.code} onClick={()=>setActiveCountry(c.code)}
              style={{ padding:'8px 20px', border:'none', background:'none', fontSize:13, fontWeight:700, cursor:'pointer', color:activeCountry===c.code?C.primary:C.muted, borderBottom:`3px solid ${activeCountry===c.code?C.primary:'transparent'}`, marginBottom:-1 }}>
              {c.flag} {c.name}
            </button>
          ))}
        </div>
        {loading ? <Spin /> : (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
            <div>
              <div style={{ fontSize:15, fontWeight:700, marginBottom:12 }}>📱 Monnaie Mobile</div>
              {PROVIDERS[activeCountry].mobile.map(p => <ProviderCard key={p.key} provider={p} />)}
            </div>
            <div>
              <div style={{ fontSize:15, fontWeight:700, marginBottom:12 }}>💳 Processeurs de Paiement (PSP)</div>
              {PROVIDERS[activeCountry].psp.map(p => <ProviderCard key={p.key} provider={p} />)}
            </div>
          </div>
        )}
      </>)}

      {activeTab==='notifications' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>
          <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:20 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}><span style={{ fontSize:28 }}>📱</span><div><div style={{ fontSize:15, fontWeight:700 }}>SMS — Protocole SMPP</div><div style={{ fontSize:11, color:C.muted }}>Envoi SMS via SMPP</div></div></div>
            {[['smpp_host','Hôte SMPP *','smpp.operateur.com','text'],['smpp_port','Port','2775','text'],['smpp_user','Utilisateur *','smpp_user','text'],['smpp_pass','Mot de passe *','','password'],['smpp_src','Nom expéditeur','C-Pay','text']].map(([k,l,ph,t])=>(
              <div key={k} style={{ marginBottom:10 }}>
                <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:4 }}>{l}</label>
                <input type={t} value={notifConfig[k]||''} onChange={e=>setNotifConfig(p=>({...p,[k]:e.target.value}))} placeholder={NOTIF_SECRETS.includes(k) && notifMeta[k]?.configured ? 'Laisser vide pour conserver' : ph}
                  style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text, boxSizing:'border-box' }} />
                {NOTIF_SECRETS.includes(k) && <SecretHint masked={notifMeta[k]} />}
              </div>
            ))}
            <div style={{ display:'flex', gap:8, marginBottom:10 }}>
              <Btn onClick={()=>saveNotifConfig('smpp')} disabled={savingNotif} color='#1d4f92' style={{ flex:1 }}>{savingNotif?'Sauvegarde…':'💾 Sauvegarder'}</Btn>
              <Btn onClick={()=>testNotifConfig('smpp')} disabled={savingNotif} outline style={{ flex:1 }}>🔌 Tester</Btn>
            </div>
            <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:10 }}>
              <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:4 }}>📤 Envoyer SMS test</label>
              <div style={{ display:'flex', gap:8 }}>
                <input value={testTo.smpp} onChange={e=>setTestTo(p=>({...p,smpp:e.target.value}))} placeholder="+242XXXXXXXXX"
                  style={{ flex:1, background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text }} />
                <Btn onClick={()=>sendTest('smpp')} disabled={savingNotif} color='#00c896'>📤 Envoyer</Btn>
              </div>
            </div>
          </div>
          <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:20 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}><span style={{ fontSize:28 }}>💬</span><div><div style={{ fontSize:15, fontWeight:700 }}>WhatsApp Business API</div><div style={{ fontSize:11, color:C.muted }}>Meta Cloud API</div></div></div>
            {[['wa_token','Token accès permanent *','EAAxxxxxxx…','password'],['wa_phone_id','Phone Number ID *','123456789012345','text'],['wa_verify_token','Verify Token','mon_token_secret','text']].map(([k,l,ph,t])=>(
              <div key={k} style={{ marginBottom:10 }}>
                <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:4 }}>{l}</label>
                <input type={t} value={notifConfig[k]||''} onChange={e=>setNotifConfig(p=>({...p,[k]:e.target.value}))} placeholder={NOTIF_SECRETS.includes(k) && notifMeta[k]?.configured ? 'Laisser vide pour conserver' : ph}
                  style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text, boxSizing:'border-box' }} />
                {NOTIF_SECRETS.includes(k) && <SecretHint masked={notifMeta[k]} />}
              </div>
            ))}
            <div style={{ display:'flex', gap:8, marginBottom:10 }}>
              <Btn onClick={()=>saveNotifConfig('whatsapp')} disabled={savingNotif} color='#25D366' style={{ flex:1 }}>{savingNotif?'Sauvegarde…':'💾 Sauvegarder'}</Btn>
              <Btn onClick={()=>testNotifConfig('whatsapp')} disabled={savingNotif} outline style={{ flex:1 }}>🔌 Tester</Btn>
            </div>
            <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:10 }}>
              <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:4 }}>📤 Envoyer WhatsApp test</label>
              <div style={{ display:'flex', gap:8 }}>
                <input value={testTo.whatsapp} onChange={e=>setTestTo(p=>({...p,whatsapp:e.target.value}))} placeholder="+242XXXXXXXXX"
                  style={{ flex:1, background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text }} />
                <Btn onClick={()=>sendTest('whatsapp')} disabled={savingNotif} color='#25D366'>📤 Envoyer</Btn>
              </div>
            </div>
          </div>
          <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:20, gridColumn:'1 / -1' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}><span style={{ fontSize:28 }}>📧</span><div><div style={{ fontSize:15, fontWeight:700 }}>Email — Protocole SMTP</div><div style={{ fontSize:11, color:C.muted }}>Gmail, SendGrid, OVH Mail…</div></div></div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:10 }}>
              {[['smtp_host','Hôte SMTP *','smtp.gmail.com'],['smtp_user','Utilisateur *','user@gmail.com'],['smtp_from','Email expéditeur','noreply@c-pay.global']].map(([k,l,ph])=>(
                <div key={k}><label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:4 }}>{l}</label>
                <input value={notifConfig[k]||''} onChange={e=>setNotifConfig(p=>({...p,[k]:e.target.value}))} placeholder={ph}
                  style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text, boxSizing:'border-box' }} /></div>
              ))}
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:14 }}>
              <div><label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:4 }}>Mot de passe *</label>
              <input type='password' value={notifConfig.smtp_pass||''} onChange={e=>setNotifConfig(p=>({...p,smtp_pass:e.target.value}))} placeholder={notifMeta.smtp_pass?.configured ? 'Laisser vide pour conserver' : '••••••••'}
                style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text, boxSizing:'border-box' }} />
              <SecretHint masked={notifMeta.smtp_pass} /></div>
              <div><label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:4 }}>Port *</label>
              <select value={notifConfig.smtp_port||'587'} onChange={e=>setNotifConfig(p=>({...p,smtp_port:e.target.value}))}
                style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text }}>
                <option value='587'>587 (TLS)</option><option value='465'>465 (SSL)</option><option value='25'>25 (SMTP)</option></select></div>
              <div><label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:4 }}>Sécurité</label>
              <select value={notifConfig.smtp_secure||'tls'} onChange={e=>setNotifConfig(p=>({...p,smtp_secure:e.target.value}))}
                style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text }}>
                <option value='tls'>STARTTLS</option><option value='ssl'>SSL/TLS</option><option value='none'>Aucune</option></select></div>
            </div>
            <div style={{ display:'flex', gap:8, marginBottom:10 }}>
              <Btn onClick={()=>saveNotifConfig('smtp')} disabled={savingNotif} color='#1d4f92' style={{ flex:1 }}>{savingNotif?'Sauvegarde…':'💾 Sauvegarder'}</Btn>
              <Btn onClick={()=>testNotifConfig('smtp')} disabled={savingNotif} outline style={{ flex:1 }}>🔌 Tester</Btn>
            </div>
            <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:10 }}>
              <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:4 }}>📤 Envoyer Email test</label>
              <div style={{ display:'flex', gap:8 }}>
                <input value={testTo.smtp} onChange={e=>setTestTo(p=>({...p,smtp:e.target.value}))} placeholder="email@exemple.com" type="email"
                  style={{ flex:1, background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text }} />
                <Btn onClick={()=>sendTest('smtp')} disabled={savingNotif} color='#00c896'>📤 Envoyer</Btn>
              </div>
            </div>
          </div>
        </div>
      )}


      {editing && (
        <Modal title={`⚙️ ${editing.display_name || editing.provider_key}`} onClose={() => setEditing(null)}>
          <SecretSummary data={editing} />
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:6 }}>Environnement actif</label>
            <div style={{ display:'flex', gap:8 }}>
              {[['sandbox','🔵 Sandbox'],['production','🟢 Production']].map(([v,l]) => (
                <button key={v} onClick={() => setForm(p=>({...p,environment:v}))}
                  style={{ flex:1, padding:'10px', border:`2px solid ${form.environment===v?C.primary:C.border}`, borderRadius:8, background:form.environment===v?`${C.primary}10`:C.bg, cursor:'pointer', fontSize:13, fontWeight:form.environment===v?700:400 }}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          {isMTN && (
            <div>
              <div style={{ background:'#FFC00015', border:'1px solid #FFC00040', borderRadius:10, padding:12, marginBottom:14, fontSize:12 }}>
                <div style={{ fontWeight:700, marginBottom:4 }}>⚠️ Credentials séparés Collection / Disbursement</div>
                <div style={{ color:C.muted }}>Portail: momodeveloper.mtn.com · Sandbox: sandbox.momodeveloper.mtn.com</div>
              </div>
              <SectionBox color={C.primary} title="⬇️ Collection (Encaissement)">
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:C.primary, marginBottom:8 }}>🔵 Sandbox</div>
                    <Inp label="API User (UUID)" value={form.apiKeySandbox} onChange={v=>setForm(p=>({...p,apiKeySandbox:v}))} placeholder="UUID /v1_0/apiuser" />
                    <Inp label="API Key" value={form.apiSecretSandbox} onChange={v=>setForm(p=>({...p,apiSecretSandbox:v}))} type="password" placeholder="••••••••" />
                    <Inp label="Subscription Key Primaire" value={form.merchantIdSandbox} onChange={v=>setForm(p=>({...p,merchantIdSandbox:v}))} placeholder="Ocp-Apim-Subscription-Key" />
                    <Inp label="Subscription Key Secondaire" value={form.baseUrlSandbox} onChange={v=>setForm(p=>({...p,baseUrlSandbox:v}))} placeholder="Backup key" />
                  </div>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:'#00c896', marginBottom:8 }}>🟢 Production</div>
                    <Inp label="API User (UUID)" value={form.colApiUserProd} onChange={v=>setForm(p=>({...p,colApiUserProd:v}))} placeholder="UUID prod" />
                    <Inp label="API Key" value={form.colApiKeyProd} onChange={v=>setForm(p=>({...p,colApiKeyProd:v}))} type="password" placeholder="••••••••" />
                    <Inp label="Subscription Key Primaire" value={form.colSubKeyProd} onChange={v=>setForm(p=>({...p,colSubKeyProd:v}))} placeholder="Clé primaire prod" />
                    <Inp label="Subscription Key Secondaire" value={form.colSubKey2Prod} onChange={v=>setForm(p=>({...p,colSubKey2Prod:v}))} placeholder="Clé secondaire prod" />
                  </div>
                </div>
                <div style={{ background:`${C.primary}10`, borderRadius:8, padding:'8px 12px', fontSize:11, color:C.muted, marginTop:8 }}>
                  Callback: https://api.c-pay.global/api/v1/webhooks/mtn · Target Env Sandbox: sandbox
                </div>
              </SectionBox>
              <SectionBox color="#9b59b6" title="⬆️ Disbursement (Décaissement)">
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:'#9b59b6', marginBottom:8 }}>🔵 Sandbox</div>
                    <Inp label="API User (UUID)" value={form.apiKeyProd} onChange={v=>setForm(p=>({...p,apiKeyProd:v}))} placeholder="UUID /v1_0/apiuser" />
                    <Inp label="API Key" value={form.apiSecretProd} onChange={v=>setForm(p=>({...p,apiSecretProd:v}))} type="password" placeholder="••••••••" />
                    <Inp label="Subscription Key Primaire" value={form.merchantIdProd} onChange={v=>setForm(p=>({...p,merchantIdProd:v}))} placeholder="Ocp-Apim-Subscription-Key" />
                    <Inp label="Subscription Key Secondaire" value={form.baseUrlProd} onChange={v=>setForm(p=>({...p,baseUrlProd:v}))} placeholder="Backup key" />
                  </div>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:'#00c896', marginBottom:8 }}>🟢 Production</div>
                    <Inp label="API User (UUID)" value={form.disApiUserProd} onChange={v=>setForm(p=>({...p,disApiUserProd:v}))} placeholder="UUID prod" />
                    <Inp label="API Key" value={form.disApiKeyProd} onChange={v=>setForm(p=>({...p,disApiKeyProd:v}))} type="password" placeholder="••••••••" />
                    <Inp label="Subscription Key Primaire" value={form.disSubKeyProd} onChange={v=>setForm(p=>({...p,disSubKeyProd:v}))} placeholder="Clé primaire prod" />
                    <Inp label="Subscription Key Secondaire" value={form.disSubKey2Prod} onChange={v=>setForm(p=>({...p,disSubKey2Prod:v}))} placeholder="Clé secondaire prod" />
                  </div>
                </div>
              </SectionBox>
            </div>
          )}

          {isAirtel && (
            <div>
              <div style={{ background:'#E4000015', border:'1px solid #E4000040', borderRadius:10, padding:12, marginBottom:14, fontSize:12 }}>
                <div style={{ fontWeight:700, marginBottom:4 }}>⚠️ Credentials séparés Collection / Disbursement</div>
                <div style={{ color:C.muted }}>Staging: openapiuat.airtel.cg · Production: openapi.airtel.cg · Auth: POST /auth/oauth2/token · expires: 180s</div>
              </div>
              <SectionBox color="#E40000" title="⬇️ Collection — POST /merchant/v1/payments/">
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:'#E40000', marginBottom:8 }}>🔵 Staging</div>
                    <Inp label="Client ID" value={form.apiKeySandbox} onChange={v=>setForm(p=>({...p,apiKeySandbox:v}))} placeholder="client_id_collection" />
                    <Inp label="Client Secret" value={form.apiSecretSandbox} onChange={v=>setForm(p=>({...p,apiSecretSandbox:v}))} type="password" placeholder="••••••••" />
                    <Inp label="X-Country" value={form.merchantIdSandbox} onChange={v=>setForm(p=>({...p,merchantIdSandbox:v}))} placeholder="CG" />
                  </div>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:'#00c896', marginBottom:8 }}>🟢 Production</div>
                    <Inp label="Client ID" value={form.colClientIdProd} onChange={v=>setForm(p=>({...p,colClientIdProd:v}))} placeholder="client_id_collection_prod" />
                    <Inp label="Client Secret" value={form.colClientSecretProd} onChange={v=>setForm(p=>({...p,colClientSecretProd:v}))} type="password" placeholder="••••••••" />
                    <Inp label="X-Country" value={form.colCountryProd} onChange={v=>setForm(p=>({...p,colCountryProd:v}))} placeholder="CG" />
                  </div>
                </div>
                <div style={{ background:'#E4000010', borderRadius:8, padding:'8px 12px', fontSize:11, color:C.muted, marginTop:8 }}>
                  MSISDN sans indicatif · X-Currency: XAF · Callback: https://api.c-pay.global/api/v1/webhooks/airtel
                </div>
              </SectionBox>
              <SectionBox color="#9b59b6" title="⬆️ Disbursement — POST /standard/v3/disbursements">
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:'#9b59b6', marginBottom:8 }}>🔵 Staging</div>
                    <Inp label="Client ID" value={form.apiKeyProd} onChange={v=>setForm(p=>({...p,apiKeyProd:v}))} placeholder="client_id_disbursement" />
                    <Inp label="Client Secret" value={form.apiSecretProd} onChange={v=>setForm(p=>({...p,apiSecretProd:v}))} type="password" placeholder="••••••••" />
                    <Inp label="X-Country" value={form.merchantIdProd} onChange={v=>setForm(p=>({...p,merchantIdProd:v}))} placeholder="CG" />
                  </div>
                  <div>
                    <div style={{ fontSize:12, fontWeight:700, color:'#00c896', marginBottom:8 }}>🟢 Production</div>
                    <Inp label="Client ID" value={form.disClientIdProd} onChange={v=>setForm(p=>({...p,disClientIdProd:v}))} placeholder="client_id_disbursement_prod" />
                    <Inp label="Client Secret" value={form.disClientSecretProd} onChange={v=>setForm(p=>({...p,disClientSecretProd:v}))} type="password" placeholder="••••••••" />
                    <Inp label="X-Country" value={form.disCountryProd} onChange={v=>setForm(p=>({...p,disCountryProd:v}))} placeholder="CG" />
                  </div>
                </div>
                <div style={{ background:'#9b59b615', borderRadius:8, padding:'8px 12px', fontSize:11, color:C.muted, marginTop:8 }}>
                  Headers optionnels: x-signature · x-key (AES) · Requis: payee.wallet_type · pin (AES)
                </div>
              </SectionBox>
            </div>
          )}

          {isCS && (
            <div>
              <div style={{ background:'#f0f4f8', borderRadius:10, padding:12, marginBottom:14, fontSize:12 }}>
                <div style={{ fontWeight:700, marginBottom:4 }}>Auth: HTTP Signature HMAC-SHA256</div>
                <div style={{ color:C.muted }}>Chaque requête signée avec v-c-merchant-id + Shared Secret Key ID + Shared Secret Key</div>
              </div>
              <SectionBox color={C.primary} title="🔵 Sandbox (apitest.cybersource.com)">
                <Inp label="Merchant ID (v-c-merchant-id)" value={form.merchantIdSandbox} onChange={v=>setForm(p=>({...p,merchantIdSandbox:v}))} placeholder="testrest" />
                <Inp label="Shared Secret Key ID (keyId)" value={form.apiKeySandbox} onChange={v=>setForm(p=>({...p,apiKeySandbox:v}))} placeholder="Key ID portail CyberSource" />
                <Inp label="Shared Secret Key" value={form.apiSecretSandbox} onChange={v=>setForm(p=>({...p,apiSecretSandbox:v}))} type="password" placeholder="••••••••" />
                <div style={{ background:`${C.primary}10`, borderRadius:8, padding:'8px 12px', fontSize:11, color:C.muted, marginTop:8 }}>
                  Webhook: https://api.c-pay.global/api/v1/webhooks/psp/cybersource
                </div>
              </SectionBox>
              <SectionBox color="#00c896" title="🟢 Production (api.cybersource.com)">
                <Inp label="Merchant ID Production" value={form.merchantIdProd} onChange={v=>setForm(p=>({...p,merchantIdProd:v}))} placeholder="Merchant ID prod" />
                <Inp label="Shared Secret Key ID Production" value={form.apiKeyProd} onChange={v=>setForm(p=>({...p,apiKeyProd:v}))} placeholder="Key ID prod" />
                <Inp label="Shared Secret Key Production" value={form.apiSecretProd} onChange={v=>setForm(p=>({...p,apiSecretProd:v}))} type="password" placeholder="••••••••" />
                <div style={{ background:'#00c89610', borderRadius:8, padding:'8px 12px', fontSize:11, color:C.muted, marginTop:8 }}>
                  Cartes: Visa · Mastercard · Amex · Discover · JCB · UnionPay
                </div>
              </SectionBox>
            </div>
          )}

          {isMIGS && (
            <div>
              <SectionBox color="#EB001B" title="🔵 Mastercard Gateway — Sandbox (test-gateway.mastercard.com)">
                <Inp label="Merchant ID Sandbox" value={form.merchantIdSandbox} onChange={v=>setForm(p=>({...p,merchantIdSandbox:v}))} placeholder="TEST_merchant_001" />
                <Inp label="API Username" value={form.apiKeySandbox} onChange={v=>setForm(p=>({...p,apiKeySandbox:v}))} placeholder="merchant.TEST_merchant_001" />
                <Inp label="API Password" value={form.apiSecretSandbox} onChange={v=>setForm(p=>({...p,apiSecretSandbox:v}))} type="password" placeholder="••••••••" />
                <div style={{ background:'#EB001B10', borderRadius:8, padding:'8px 12px', fontSize:11, color:C.muted, marginTop:8 }}>
                  Webhook: https://api.c-pay.global/api/v1/webhooks/psp/migs
                </div>
              </SectionBox>
              <SectionBox color="#00c896" title="🟢 Production (gateway.mastercard.com)">
                <Inp label="Merchant ID Production" value={form.merchantIdProd} onChange={v=>setForm(p=>({...p,merchantIdProd:v}))} placeholder="Merchant ID prod" />
                <Inp label="API Username Production" value={form.apiKeyProd} onChange={v=>setForm(p=>({...p,apiKeyProd:v}))} placeholder="merchant.prod_id" />
                <Inp label="API Password Production" value={form.apiSecretProd} onChange={v=>setForm(p=>({...p,apiSecretProd:v}))} type="password" placeholder="••••••••" />
              </SectionBox>
            </div>
          )}

          {!isMTN && !isAirtel && !isCS && !isMIGS && (
            <div>
              <SectionBox color={C.primary} title="🔵 Sandbox">
                <Inp label="Base URL Sandbox" value={form.baseUrlSandbox} onChange={v=>setForm(p=>({...p,baseUrlSandbox:v}))} placeholder="https://api-sandbox.provider.com" />
                <Inp label="API Key Sandbox" value={form.apiKeySandbox} onChange={v=>setForm(p=>({...p,apiKeySandbox:v}))} placeholder="key_sandbox" />
                <Inp label="API Secret Sandbox" value={form.apiSecretSandbox} onChange={v=>setForm(p=>({...p,apiSecretSandbox:v}))} type="password" placeholder="••••••••" />
                <Inp label="Merchant ID Sandbox" value={form.merchantIdSandbox} onChange={v=>setForm(p=>({...p,merchantIdSandbox:v}))} placeholder="merchant_001" />
              </SectionBox>
              <SectionBox color="#00c896" title="🟢 Production">
                <Inp label="Base URL Production" value={form.baseUrlProd} onChange={v=>setForm(p=>({...p,baseUrlProd:v}))} placeholder="https://api.provider.com" />
                <Inp label="API Key Production" value={form.apiKeyProd} onChange={v=>setForm(p=>({...p,apiKeyProd:v}))} placeholder="key_prod" />
                <Inp label="API Secret Production" value={form.apiSecretProd} onChange={v=>setForm(p=>({...p,apiSecretProd:v}))} type="password" placeholder="••••••••" />
                <Inp label="Merchant ID Production" value={form.merchantIdProd} onChange={v=>setForm(p=>({...p,merchantIdProd:v}))} placeholder="merchant_001" />
              </SectionBox>
            </div>
          )}

          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>Statut</label>
            <select value={form.status} onChange={e=>setForm(p=>({...p,status:e.target.value}))}
              style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:C.text }}>
              <option value="active">✅ Actif</option>
              <option value="inactive">⛔ Inactif</option>
              <option value="testing">🔵 Test</option>
            </select>
          </div>
          <Inp label="Notes internes" value={form.notes} onChange={v=>setForm(p=>({...p,notes:v}))} placeholder="Informations complémentaires..." />
          <div style={{ display:'flex', gap:10, marginTop:8 }}>
            <Btn onClick={save} style={{ flex:1 }}>💾 Sauvegarder</Btn>
            <Btn outline onClick={() => setEditing(null)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
};


// ─── APP ──────────────────────────────────────────────────────────

// ─── TERMINAUX ────────────────────────────────────────────────────
const Terminals = () => {
  const [terminals, setTerminals] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    api.get('/terminals').then(r => setTerminals(r.data.data || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  const setStatus = async (id, status) => {
    try { await api.patch(`/terminals/${id}/status`, { status }); load(); } catch { toast.error('Erreur'); }
  };
  return (
    <div>
      <h1 style={{ margin: '0 0 20px', fontSize: 22, fontWeight: 700 }}>Terminaux</h1>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Code', 'Nom', 'Marchand', 'Appairage', 'Android ID', 'Modele', 'Version', 'Vu le', 'Statut', 'Actions']}
            rows={terminals.map(t => (
              <tr key={t.terminal_id}>
                <TD style={{ fontFamily: 'monospace', fontSize: 11, color: C.primary }}>{t.terminal_code}</TD>
                <TD style={{ fontWeight: 500 }}>{t.terminal_name}</TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{t.business_name}</TD>
                <TD>{t.paired_at
                  ? <Badge label="Appairé" color={sc('active')} />
                  : (t.pairing_code
                      ? <span style={{ fontFamily:'monospace', fontWeight:700, letterSpacing:1, color:C.primary }}>{t.pairing_code}</span>
                      : <span style={{ fontSize:11, color:C.muted }}>---</span>)}</TD>
                <TD style={{ fontFamily:'monospace', fontSize: 10, color: C.muted }}>{t.android_id || '---'}</TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{t.device_model || '---'}</TD>
                <TD>{t.app_version || '---'}</TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{t.last_seen_at ? fmtDate(t.last_seen_at) : 'Jamais'}</TD>
                <TD><Badge label={t.status} color={sc(t.status)} /></TD>
                <TD>{t.status === 'active' ? <Btn small variant="danger" onClick={() => setStatus(t.terminal_id, 'blocked')}>Bloquer</Btn> : <Btn small variant="success" onClick={() => setStatus(t.terminal_id, 'active')}>Activer</Btn>}</TD>
              </tr>
            ))} empty="Aucun terminal" />
        </Card>
      )}
    </div>
  );
};

// ─── BANKS ───────────────────────────────────────────────────────
const Banks = () => {
  const [banks, setBanks]     = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [form, setForm] = useState({
    bankName:'', bankCode:'', country:'CG', contactEmail:'', contactPhone:'',
    address:'', city:'', swift:'', status:'active',
    adminFirstName:'', adminLastName:'', adminEmail:'', adminPhone:''
  });
  const [newBankResult, setNewBankResult] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/partners/banks').then(r=>{ setBanks(r.data.data||[]); setTotal(r.data.total||0); }).catch(()=>{}).finally(()=>setLoading(false));
  }, []);
  useEffect(()=>{ load(); }, [load]);

  const create = async () => {
    if (!form.bankName || !form.bankCode) return toast.error('Nom et code banque requis');
    if (!form.adminFirstName || !form.adminEmail) return toast.error('Prénom et email admin requis');
    setSaving(true);
    try {
      const r = await api.post('/partners/banks', form);
      setNewBankResult(r.data);
      setShowNew(false);
      load();
    }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  const toggle = async (id, status) => {
    try { await api.patch(`/partners/banks/${id}/status`, { status: status==='active'?'suspended':'active' }); load(); toast.success('Statut mis à jour ✅'); }
    catch { toast.error('Erreur'); }
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>🏦 Banques Partenaires</h1>
        <div style={{ display:'flex', gap:10, alignItems:'center' }}>
          <span style={{ fontSize:13, color:C.muted }}>{total} banque(s)</span>
          <Btn onClick={()=>setShowNew(true)}>+ Nouvelle banque</Btn>
        </div>
      </div>

      {showNew && (
        <Modal title="🏦 Créer une banque partenaire" onClose={()=>setShowNew(false)}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            {/* Infos banque */}
            <div style={{ gridColumn:'1/-1', fontSize:13, fontWeight:700, color:C.primary, padding:'8px 0', borderBottom:`1px solid ${C.border}`, marginBottom:4 }}>🏦 Informations de la banque</div>
            <div style={{ gridColumn:'1/-1' }}>
              <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>Nom de la banque *</label>
              <input value={form.bankName} onChange={e=>setForm(p=>({...p,bankName:e.target.value}))} placeholder="Banque Commerciale du Congo"
                style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:C.text, boxSizing:'border-box' }} />
            </div>
            {[['bankCode','Code banque *','BCK-001'],['swift','Code SWIFT','BCOMCGBR'],['city','Ville','Brazzaville'],['address','Adresse','Avenue de la Paix']].map(([k,l,ph])=>(
              <div key={k}>
                <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>{l}</label>
                <input value={form[k]||''} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} placeholder={ph}
                  style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:C.text, boxSizing:'border-box' }} />
              </div>
            ))}
            <div>
              <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>Pays</label>
              <select value={form.country||'CG'} onChange={e=>setForm(p=>({...p,country:e.target.value}))}
                style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:C.text }}>
                <option value="CG">🇨🇬 Congo Brazzaville</option>
                <option value="CD">🇨🇩 RDC</option>
                <option value="CM">🇨🇲 Cameroun</option>
              </select>
            </div>
            {[['contactEmail','Email contact banque','contact@banque.cg'],['contactPhone','Téléphone banque','+242060000000']].map(([k,l,ph])=>(
              <div key={k}>
                <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>{l}</label>
                <input value={form[k]||''} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} placeholder={ph}
                  style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:C.text, boxSizing:'border-box' }} />
              </div>
            ))}

            {/* Admin banque */}
            <div style={{ gridColumn:'1/-1', fontSize:13, fontWeight:700, color:C.primary, padding:'8px 0', borderBottom:`1px solid ${C.border}`, marginTop:8, marginBottom:4 }}>👤 Administrateur de la banque</div>
            <div style={{ gridColumn:'1/-1', background:`${C.primary}08`, border:`1px solid ${C.primary}20`, borderRadius:8, padding:10, fontSize:12, color:C.muted }}>
              Un compte administrateur sera créé automatiquement avec un mot de passe temporaire.
            </div>
            {[['adminFirstName','Prénom admin *','Jean'],['adminLastName','Nom admin','Dupont'],['adminEmail','Email admin *','admin@banque.cg'],['adminPhone','Téléphone admin','+242060000001']].map(([k,l,ph])=>(
              <div key={k}>
                <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>{l}</label>
                <input value={form[k]||''} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} placeholder={ph}
                  style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:C.text, boxSizing:'border-box' }} />
              </div>
            ))}
          </div>
          <div style={{ display:'flex', gap:10, marginTop:16 }}>
            <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Création…':'✅ Créer la banque'}</Btn>
            <Btn outline onClick={()=>setShowNew(false)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Modal>
      )}

      {/* Modal résultat création banque */}
      {newBankResult && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:C.card, borderRadius:16, padding:28, width:500, maxWidth:'100%' }}>
            <div style={{ textAlign:'center', marginBottom:20 }}>
              <div style={{ fontSize:48, marginBottom:8 }}>🎉</div>
              <div style={{ fontSize:18, fontWeight:700, color:'#00c896' }}>Banque créée avec succès !</div>
            </div>
            <div style={{ background:C.bg, borderRadius:10, padding:16, marginBottom:16 }}>
              {[['Banque', newBankResult.bank?.bank_name],['Code', newBankResult.bank?.bank_code],['Pays', newBankResult.bank?.country]].map(([k,v])=>(
                <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${C.border}`, fontSize:13 }}>
                  <span style={{ color:C.muted }}>{k}</span><strong>{v}</strong>
                </div>
              ))}
            </div>
            <div style={{ background:'#ff950010', border:'1px solid #ff950040', borderRadius:10, padding:16, marginBottom:16 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'#ff9500', marginBottom:10 }}>⚠️ Credentials Admin — À conserver en lieu sûr</div>
              {[['Email', newBankResult.admin?.email],['Mot de passe temporaire', newBankResult.admin?.tempPassword],['Rôle', 'Bank Admin']].map(([k,v])=>(
                <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid #ff950020`, fontSize:13 }}>
                  <span style={{ color:C.muted }}>{k}</span>
                  <strong style={{ fontFamily:k.includes('passe')?'monospace':'inherit', color:k.includes('passe')?'#ff9500':C.text }}>{v}</strong>
                </div>
              ))}
            </div>
            <div style={{ fontSize:12, color:C.muted, marginBottom:16 }}>
              🔑 URL de connexion: <strong>https://partners.c-pay.global</strong>
            </div>
            <Btn onClick={()=>setNewBankResult(null)} style={{ width:'100%' }}>✅ J'ai noté les credentials</Btn>
          </div>
        </div>
      )}

      {loading ? <Spin /> : banks.length===0 ? (
        <Card style={{ textAlign:'center', padding:40 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>🏦</div>
          <div style={{ color:C.muted }}>Aucune banque partenaire</div>
        </Card>
      ) : (
        <div style={{ display:'grid', gap:12 }}>
          {banks.map(b => (
            <Card key={b.bank_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                    <div style={{ width:40, height:40, background:`${C.primary}15`, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22 }}>🏦</div>
                    <div>
                      <div style={{ fontSize:16, fontWeight:700 }}>{b.bank_name}</div>
                      <div style={{ fontSize:12, color:C.muted }}>Code: <strong>{b.bank_code}</strong> {b.swift ? `· SWIFT: ${b.swift}` : ''}</div>
                    </div>
                    <span style={{ background:b.status==='active'?'#00c89620':'#ff3b3020', color:b.status==='active'?'#00c896':'#ff3b30', borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>
                      {b.status==='active'?'✅ Active':'⛔ Suspendue'}
                    </span>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))', gap:8, fontSize:13, color:C.muted }}>
                    {[['📍 Pays', b.country], ['🏙️ Ville', b.city||'—'], ['📧', b.contact_email||'—'], ['📞', b.contact_phone||'—'],
                      ['🏢 Agences', b.agency_count||0], ['👤 Agents', b.agent_count||0],
                      ['📅 Créé le', b.created_at?new Date(b.created_at).toLocaleDateString('fr-FR'):'—']
                    ].map(([k,v])=>(
                      <div key={k} style={{ padding:'6px 10px', background:C.bg, borderRadius:6 }}>
                        <span style={{ color:C.muted }}>{k}: </span><strong style={{ color:C.text }}>{v}</strong>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ display:'flex', gap:8, flexShrink:0, marginLeft:16 }}>
                  <Link to={`/banks/${b.bank_id}`}
                    style={{ background:`${C.primary}15`, color:C.primary, border:`1px solid ${C.primary}30`, borderRadius:6, padding:'6px 12px', fontSize:12, fontWeight:700, textDecoration:'none' }}>
                    Détail →
                  </Link>
                  <button onClick={()=>toggle(b.bank_id, b.status)}
                    style={{ background:b.status==='active'?'#ff3b3010':'#00c89610', border:`1px solid ${b.status==='active'?'#ff3b30':'#00c896'}30`, color:b.status==='active'?'#ff3b30':'#00c896', borderRadius:6, padding:'6px 12px', fontSize:12, fontWeight:700, cursor:'pointer' }}>
                    {b.status==='active'?'Suspendre':'Activer'}
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── BANK DETAIL ──────────────────────────────────────────────────
const BankDetail = () => {
  const { id } = useParams();
  const [bank, setBank]       = useState(null);
  const [agencies, setAgencies] = useState([]);
  const [agents, setAgents]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState('info');
  const [editMode, setEditMode] = useState(false);
  const [form, setForm]       = useState({});
  const [saving, setSaving]   = useState(false);

  useEffect(() => {
    Promise.all([
      api.get(`/partners/banks/${id}`),
      api.get(`/partners/banks/${id}/agencies`),
      api.get(`/partners/banks/${id}/agents`),
    ]).then(([bRes, aRes, agRes]) => {
      setBank(bRes.data); setForm(bRes.data);
      setAgencies(aRes.data.data||[]);
      setAgents(agRes.data.data||[]);
    }).catch(()=>{}).finally(()=>setLoading(false));
  }, [id]);

  const save = async () => {
    setSaving(true);
    try { await api.patch(`/partners/banks/${id}`, form); toast.success('Banque mise à jour ✅'); setBank(form); setEditMode(false); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  if (loading) return <Spin />;
  if (!bank) return <div style={{ color:C.muted, padding:32 }}>Banque introuvable</div>;

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
        <Link to="/banks" style={{ color:C.muted, textDecoration:'none', fontSize:13 }}>← Banques</Link>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>🏦 {bank.bank_name}</h1>
        <span style={{ background:bank.status==='active'?'#00c89620':'#ff3b3020', color:bank.status==='active'?'#00c896':'#ff3b30', borderRadius:20, padding:'4px 12px', fontSize:12, fontWeight:700 }}>
          {bank.status==='active'?'✅ Active':'⛔ Suspendue'}
        </span>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, marginBottom:20, borderBottom:`2px solid ${C.border}` }}>
        {[['info','📋 Informations'],['agencies','🏢 Agences ('+agencies.length+')'],['agents','👤 Agents ('+agents.length+')']].map(([v,l])=>(
          <button key={v} onClick={()=>setTab(v)}
            style={{ padding:'10px 20px', border:'none', background:'none', fontSize:13, fontWeight:700, cursor:'pointer', color:tab===v?C.primary:C.muted, borderBottom:`3px solid ${tab===v?C.primary:'transparent'}`, marginBottom:-2 }}>
            {l}
          </button>
        ))}
      </div>

      {tab==='info' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <Card>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:14 }}>
              <div style={{ fontSize:14, fontWeight:700 }}>Informations générales</div>
              <button onClick={()=>setEditMode(!editMode)} style={{ background:'none', border:`1px solid ${C.border}`, borderRadius:6, padding:'4px 10px', cursor:'pointer', fontSize:12, color:C.muted }}>
                {editMode?'Annuler':'✏️ Modifier'}
              </button>
            </div>
            {editMode ? (
              <>
                {[['bankName','Nom *'],['bankCode','Code *'],['swift','SWIFT'],['city','Ville'],['address','Adresse'],['contactEmail','Email'],['contactPhone','Téléphone']].map(([k,l])=>(
                  <div key={k} style={{ marginBottom:10 }}>
                    <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:3 }}>{l}</label>
                    <input value={form[k]||''} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))}
                      style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text, boxSizing:'border-box' }} />
                  </div>
                ))}
                <Btn onClick={save} disabled={saving} style={{ width:'100%' }}>{saving?'Sauvegarde…':'💾 Sauvegarder'}</Btn>
              </>
            ) : (
              [['Nom', bank.bank_name],['Code', bank.bank_code],['SWIFT', bank.swift||'—'],['Pays', bank.country],['Ville', bank.city||'—'],
               ['Adresse', bank.address||'—'],['Email', bank.contact_email||'—'],['Téléphone', bank.contact_phone||'—'],
               ['Créé le', bank.created_at?new Date(bank.created_at).toLocaleDateString('fr-FR'):'—']
              ].map(([k,v])=>(
                <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:`1px solid ${C.border}`, fontSize:13 }}>
                  <span style={{ color:C.muted }}>{k}</span><strong>{v}</strong>
                </div>
              ))
            )}
          </Card>
          <Card>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Statistiques</div>
            {[['🏢 Agences', agencies.length],['👤 Agents', agents.length],['✅ Agents actifs', agents.filter(a=>a.status==='active').length]].map(([k,v])=>(
              <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'10px 0', borderBottom:`1px solid ${C.border}`, fontSize:14 }}>
                <span style={{ color:C.muted }}>{k}</span><strong style={{ fontSize:20, color:C.primary }}>{v}</strong>
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab==='agencies' && (
        <div style={{ display:'grid', gap:10 }}>
          {agencies.length===0 ? <Card style={{ textAlign:'center', padding:32 }}><div style={{ color:C.muted }}>Aucune agence</div></Card>
          : agencies.map(a=>(
            <Card key={a.agency_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>🏢 {a.agency_name}</div>
                  <div style={{ fontSize:12, color:C.muted }}>Code: {a.agency_code} · {a.city||'—'} · Float: <strong style={{ color:'#00c896' }}>{parseFloat(a.float_balance||0).toLocaleString('fr-FR')} XAF</strong></div>
                </div>
                <span style={{ background:a.status==='active'?'#00c89615':'#ff3b3015', color:a.status==='active'?'#00c896':'#ff3b30', borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>
                  {a.status==='active'?'Active':'Suspendue'}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}

      {tab==='agents' && (
        <div style={{ display:'grid', gap:10 }}>
          {agents.length===0 ? <Card style={{ textAlign:'center', padding:32 }}><div style={{ color:C.muted }}>Aucun agent</div></Card>
          : agents.map(a=>(
            <Card key={a.agent_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>👤 {a.first_name} {a.last_name}</div>
                  <div style={{ fontSize:12, color:C.muted }}>{a.email} · {a.agency_name} · Float: <strong style={{ color:'#00c896' }}>{parseFloat(a.float_balance||0).toLocaleString('fr-FR')} XAF</strong></div>
                </div>
                <span style={{ background:a.status==='active'?'#00c89615':'#ff3b3015', color:a.status==='active'?'#00c896':'#ff3b30', borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>
                  {a.status==='active'?'Actif':'Suspendu'}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── PARTNERS AGENCIES ────────────────────────────────────────────
const PartnersAgencies = () => {
  const [agencies, setAgencies] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');

  useEffect(()=>{
    api.get('/partners/agencies/all').then(r=>setAgencies(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false));
  }, []);

  const filtered = agencies.filter(a =>
    a.agency_name.toLowerCase().includes(search.toLowerCase()) ||
    a.agency_code.toLowerCase().includes(search.toLowerCase()) ||
    (a.bank_name||'').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>🏢 Toutes les Agences</h1>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Rechercher par nom, code, banque…"
        style={{ width:'100%', background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 14px', fontSize:13, color:C.text, marginBottom:16, boxSizing:'border-box' }} />
      {loading ? <Spin /> : (
        <Card style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13, minWidth:700 }}>
            <thead>
              <tr style={{ borderBottom:`2px solid ${C.border}`, color:C.muted }}>
                {['Agence','Code','Banque','Ville','Agents','Float','Statut'].map(h=>(
                  <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontWeight:600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length===0 ? <tr><td colSpan={7} style={{ textAlign:'center', padding:32, color:C.muted }}>Aucune agence</td></tr>
              : filtered.map(a=>(
                <tr key={a.agency_id} style={{ borderBottom:`1px solid ${C.border}` }}>
                  <td style={{ padding:'10px 12px', fontWeight:600 }}>🏢 {a.agency_name}</td>
                  <td style={{ padding:'10px 12px', fontFamily:'monospace' }}>{a.agency_code}</td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>🏦 {a.bank_name||'—'}</td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>{a.city||'—'}</td>
                  <td style={{ padding:'10px 12px', textAlign:'center' }}>{a.agent_count||0}</td>
                  <td style={{ padding:'10px 12px', color:'#00c896', fontWeight:700 }}>{parseFloat(a.float_balance||0).toLocaleString('fr-FR')} XAF</td>
                  <td style={{ padding:'10px 12px' }}>
                    <span style={{ background:a.status==='active'?'#00c89615':'#ff3b3015', color:a.status==='active'?'#00c896':'#ff3b30', borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>
                      {a.status==='active'?'Active':'Suspendue'}
                    </span>
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

// ─── PARTNERS AGENTS ──────────────────────────────────────────────
const PartnersAgents = () => {
  const [agents, setAgents]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');

  useEffect(()=>{
    api.get('/partners/agents/all').then(r=>setAgents(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false));
  }, []);

  const filtered = agents.filter(a =>
    `${a.first_name} ${a.last_name}`.toLowerCase().includes(search.toLowerCase()) ||
    a.email.toLowerCase().includes(search.toLowerCase()) ||
    (a.agency_name||'').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>👤 Tous les Agents</h1>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Rechercher par nom, email, agence…"
        style={{ width:'100%', background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 14px', fontSize:13, color:C.text, marginBottom:16, boxSizing:'border-box' }} />
      {loading ? <Spin /> : (
        <Card style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13, minWidth:750 }}>
            <thead>
              <tr style={{ borderBottom:`2px solid ${C.border}`, color:C.muted }}>
                {['Agent','Email','Agence','Banque','Float','Limite','Statut'].map(h=>(
                  <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontWeight:600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length===0 ? <tr><td colSpan={7} style={{ textAlign:'center', padding:32, color:C.muted }}>Aucun agent</td></tr>
              : filtered.map(a=>(
                <tr key={a.agent_id} style={{ borderBottom:`1px solid ${C.border}` }}>
                  <td style={{ padding:'10px 12px', fontWeight:600 }}>👤 {a.first_name} {a.last_name}</td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>{a.email}</td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>🏢 {a.agency_name||'—'}</td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>🏦 {a.bank_name||'—'}</td>
                  <td style={{ padding:'10px 12px', color:'#00c896', fontWeight:700 }}>{parseFloat(a.float_balance||0).toLocaleString('fr-FR')} XAF</td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>{parseFloat(a.float_limit||0).toLocaleString('fr-FR')} XAF</td>
                  <td style={{ padding:'10px 12px' }}>
                    <span style={{ background:a.status==='active'?'#00c89615':'#ff3b3015', color:a.status==='active'?'#00c896':'#ff3b30', borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>
                      {a.status==='active'?'✅ Actif':'⛔ Suspendu'}
                    </span>
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

// ─── TENANTS ─────────────────────────────────────────────────────
const Tenants = () => {
  const [tenants, setTenants] = useState([]);
  const [banks, setBanks]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving]   = useState(false);
  const [form, setForm] = useState({
    bankId:'', subdomain:'', displayName:'',
    primaryColor:'#12b6c7', secondaryColor:'#1d4f92', accentColor:'#00c896',
    logoUrl:'', supportEmail:'', supportPhone:''
  });

  const load = useCallback(()=>{
    Promise.all([api.get('/tenants'), api.get('/partners/banks')])
      .then(([t,b])=>{ setTenants(t.data.data||[]); setBanks(b.data.data||[]); })
      .catch(()=>{}).finally(()=>setLoading(false));
  }, []);
  useEffect(()=>{ load(); }, [load]);

  const create = async () => {
    if (!form.bankId || !form.subdomain || !form.displayName) return toast.error('Banque, subdomain et nom requis');
    setSaving(true);
    try { await api.post('/tenants', form); toast.success('Tenant créé ✅'); setShowNew(false); load(); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  const update = async () => {
    setSaving(true);
    try {
      await api.patch(`/tenants/${editing.tenant_id}`, {
        displayName: form.displayName, primaryColor: form.primaryColor,
        secondaryColor: form.secondaryColor, accentColor: form.accentColor,
        logoUrl: form.logoUrl, supportEmail: form.supportEmail, supportPhone: form.supportPhone
      });
      toast.success('Tenant mis à jour ✅'); setEditing(null); load();
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  const openEdit = (t) => {
    setEditing(t);
    setForm({ ...form, displayName:t.display_name, primaryColor:t.primary_color, secondaryColor:t.secondary_color,
      accentColor:t.accent_color, logoUrl:t.logo_url||'', supportEmail:t.support_email||'', supportPhone:t.support_phone||'' });
  };

  const Inp2 = ({label, k, ph, type='text'}) => (
    <div style={{ marginBottom:10 }}>
      <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:3 }}>{label}</label>
      <input type={type} value={form[k]||''} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} placeholder={ph||''}
        style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text, boxSizing:'border-box' }} />
    </div>
  );

  const ColorPicker = ({label, k}) => (
    <div style={{ marginBottom:10 }}>
      <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:3 }}>{label}</label>
      <div style={{ display:'flex', gap:8, alignItems:'center' }}>
        <input type="color" value={form[k]||'#12b6c7'} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))}
          style={{ width:44, height:36, border:`1px solid ${C.border}`, borderRadius:6, cursor:'pointer', padding:2 }} />
        <input value={form[k]||''} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} placeholder="#12b6c7"
          style={{ flex:1, background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13, color:C.text, fontFamily:'monospace' }} />
        <div style={{ width:36, height:36, background:form[k]||'#12b6c7', borderRadius:6, border:`1px solid ${C.border}` }} />
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>🌐 Tenants Partenaires</h1>
        <Btn onClick={()=>setShowNew(true)}>+ Nouveau tenant</Btn>
      </div>

      {/* Info */}
      <div style={{ background:`${C.primary}08`, border:`1px solid ${C.primary}20`, borderRadius:10, padding:14, marginBottom:20, fontSize:13, color:C.muted }}>
        <strong>🌐 Multi-tenant</strong> — Chaque banque partenaire accède à son portail via son propre sous-domaine :<br/>
        <code style={{ background:C.bg, padding:'2px 6px', borderRadius:4, fontSize:12 }}>subdomain.partners.c-pay.global</code>
        {' '}— avec son logo, ses couleurs et son nom propre.
      </div>

      {/* Modal création */}
      {showNew && (
        <Modal title="🌐 Créer un tenant" onClose={()=>setShowNew(false)} width={560}>
          <div style={{ marginBottom:10 }}>
            <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:3 }}>Banque partenaire *</label>
            <select value={form.bankId} onChange={e=>setForm(p=>({...p,bankId:e.target.value}))}
              style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'8px 10px', fontSize:13 }}>
              <option value="">— Choisir une banque —</option>
              {banks.filter(b=>!tenants.find(t=>t.bank_id===b.bank_id)).map(b=>(
                <option key={b.bank_id} value={b.bank_id}>{b.bank_name} ({b.bank_code})</option>
              ))}
            </select>
          </div>
          <Inp2 label="Sous-domaine * (ex: bcplus)" k="subdomain" ph="bcplus" />
          <div style={{ background:`${C.primary}08`, borderRadius:6, padding:'6px 10px', fontSize:11, color:C.muted, marginBottom:10 }}>
            URL: <strong>{form.subdomain||'subdomain'}.partners.c-pay.global</strong>
          </div>
          <Inp2 label="Nom d'affichage *" k="displayName" ph="Banque Commerciale du Congo" />
          <Inp2 label="URL Logo" k="logoUrl" ph="https://banque.cg/logo.png" />
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:10 }}>
            <ColorPicker label="Couleur principale" k="primaryColor" />
            <ColorPicker label="Couleur secondaire" k="secondaryColor" />
            <ColorPicker label="Couleur accent" k="accentColor" />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <Inp2 label="Email support" k="supportEmail" ph="support@banque.cg" />
            <Inp2 label="Téléphone support" k="supportPhone" ph="+242060000000" />
          </div>
          <div style={{ display:'flex', gap:10, marginTop:12 }}>
            <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Création…':'✅ Créer le tenant'}</Btn>
            <Btn outline onClick={()=>setShowNew(false)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Modal>
      )}

      {/* Modal édition */}
      {editing && (
        <Modal title={`✏️ Modifier — ${editing.display_name}`} onClose={()=>setEditing(null)} width={560}>
          <Inp2 label="Nom d'affichage *" k="displayName" ph="Nom de la banque" />
          <Inp2 label="URL Logo" k="logoUrl" ph="https://banque.cg/logo.png" />
          {form.logoUrl && (
            <div style={{ textAlign:'center', marginBottom:10 }}>
              <img src={form.logoUrl} alt="Logo preview" style={{ height:48, objectFit:'contain', border:`1px solid ${C.border}`, borderRadius:8, padding:8 }} />
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10, marginBottom:10 }}>
            <ColorPicker label="Couleur principale" k="primaryColor" />
            <ColorPicker label="Couleur secondaire" k="secondaryColor" />
            <ColorPicker label="Couleur accent" k="accentColor" />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <Inp2 label="Email support" k="supportEmail" ph="support@banque.cg" />
            <Inp2 label="Téléphone support" k="supportPhone" ph="+242060000000" />
          </div>
          {/* Preview */}
          <div style={{ background:`linear-gradient(135deg, ${form.secondaryColor||'#1d4f92'}, ${form.primaryColor||'#12b6c7'})`, borderRadius:10, padding:16, marginTop:12, textAlign:'center' }}>
            <div style={{ color:'#fff', fontSize:13, fontWeight:700 }}>Aperçu login</div>
            {form.logoUrl && <img src={form.logoUrl} alt="preview" style={{ height:32, marginTop:8, objectFit:'contain' }} />}
            <div style={{ color:'rgba(255,255,255,0.9)', fontSize:11, marginTop:4 }}>{form.displayName}</div>
          </div>
          <div style={{ display:'flex', gap:10, marginTop:12 }}>
            <Btn onClick={update} disabled={saving} style={{ flex:1 }}>{saving?'Sauvegarde…':'💾 Sauvegarder'}</Btn>
            <Btn outline onClick={()=>setEditing(null)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Modal>
      )}

      {/* Liste tenants */}
      {loading ? <Spin /> : tenants.length===0 ? (
        <Card style={{ textAlign:'center', padding:40 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>🌐</div>
          <div style={{ color:C.muted }}>Aucun tenant configuré</div>
        </Card>
      ) : (
        <div style={{ display:'grid', gap:12 }}>
          {tenants.map(t => (
            <Card key={t.tenant_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                  {/* Preview couleurs */}
                  <div style={{ width:48, height:48, background:`linear-gradient(135deg, ${t.secondary_color||'#1d4f92'}, ${t.primary_color||'#12b6c7'})`, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    {t.logo_url
                      ? <img src={t.logo_url} alt="" style={{ width:36, height:36, objectFit:'contain' }} />
                      : <span style={{ color:'#fff', fontSize:20 }}>🏦</span>
                    }
                  </div>
                  <div>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                      <div style={{ fontSize:15, fontWeight:700 }}>{t.display_name}</div>
                      <span style={{ background:t.is_active?'#00c89615':'#ff3b3015', color:t.is_active?'#00c896':'#ff3b30', borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700 }}>
                        {t.is_active?'✅ Actif':'⛔ Inactif'}
                      </span>
                    </div>
                    <div style={{ fontSize:12, color:C.muted, marginBottom:4 }}>
                      🏦 {t.bank_name} · 
                      🌐 <a href={`https://${t.subdomain}.partners.c-pay.global`} target="_blank" rel="noreferrer"
                        style={{ color:C.primary, textDecoration:'none', fontWeight:600 }}>
                        {t.subdomain}.partners.c-pay.global
                      </a>
                    </div>
                    <div style={{ display:'flex', gap:10, fontSize:12, color:C.muted }}>
                      <span>👤 {t.user_count||0} utilisateurs</span>
                      <span>🤝 {t.agent_count||0} agents</span>
                      {t.support_email && <span>📧 {t.support_email}</span>}
                    </div>
                    {/* Palette couleurs */}
                    <div style={{ display:'flex', gap:4, marginTop:6 }}>
                      {[t.primary_color, t.secondary_color, t.accent_color].map((c,i)=>(
                        <div key={i} style={{ width:16, height:16, background:c||'#ccc', borderRadius:4, border:`1px solid ${C.border}` }} title={c} />
                      ))}
                    </div>
                  </div>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <Btn small onClick={()=>openEdit(t)}>✏️ Modifier</Btn>
                  <Btn small outline color={t.is_active?'#ff3b30':'#00c896'}
                    onClick={async()=>{ await api.patch(`/tenants/${t.tenant_id}`,{isActive:!t.is_active}); load(); }}>
                    {t.is_active?'Suspendre':'Activer'}
                  </Btn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── CARDHOLDERS ─────────────────────────────────────────────────
const Cardholders = () => {
  const [cardholders, setCardholders] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/cardholders', { params:{ page, limit:20, search:search||undefined } })
      .then(r => { setCardholders(r.data.data||[]); setTotal(r.data.total||0); })
      .catch(()=>{})
      .finally(()=>setLoading(false));
  }, [page, search]);
  useEffect(()=>{ load(); }, [load]);

  const KYC_COLORS = { 0:'#ff9500', 1:'#12b6c7', 2:'#00c896' };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>🪪 Porteurs de Carte</h1>
        <div style={{ fontSize:13, color:C.muted }}>{total} porteur(s)</div>
      </div>
      <div style={{ marginBottom:16 }}>
        <input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}
          placeholder="Rechercher par nom, email, téléphone…"
          style={{ width:'100%', background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 14px', fontSize:13, color:C.text, boxSizing:'border-box' }} />
      </div>
      {loading ? <Spin /> : (
        <Card style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13, minWidth:700 }}>
            <thead>
              <tr style={{ borderBottom:`2px solid ${C.border}`, color:C.muted }}>
                {['Nom','Email','Téléphone','Pays','KYC','Créé le','Actions'].map(h=>(
                  <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontWeight:600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cardholders.length===0 ? (
                <tr><td colSpan={7} style={{ textAlign:'center', padding:32, color:C.muted }}>Aucun porteur</td></tr>
              ) : cardholders.map(ch => (
                <tr key={ch.cardholder_id} style={{ borderBottom:`1px solid ${C.border}` }}>
                  <td style={{ padding:'10px 12px', fontWeight:600 }}>{ch.first_name} {ch.last_name}</td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>{ch.email}</td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>{ch.phone||'—'}</td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>{ch.country||'—'}</td>
                  <td style={{ padding:'10px 12px' }}>
                    <span style={{ background:`${KYC_COLORS[ch.kyc_level]||C.muted}20`, color:KYC_COLORS[ch.kyc_level]||C.muted, borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>
                      KYC {ch.kyc_level||0}
                    </span>
                  </td>
                  <td style={{ padding:'10px 12px', color:C.muted }}>{ch.created_at ? new Date(ch.created_at).toLocaleDateString('fr-FR') : '—'}</td>
                  <td style={{ padding:'10px 12px' }}>
                    <Link to={`/cardholders/${ch.cardholder_id}`}
                      style={{ background:`${C.primary}15`, color:C.primary, border:`1px solid ${C.primary}30`, borderRadius:6, padding:'4px 10px', fontSize:11, fontWeight:600, textDecoration:'none' }}>
                      Voir →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > 20 && (
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12 }}>
              <Btn small outline onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1}>◀</Btn>
              <span style={{ padding:'6px 12px', fontSize:13, color:C.muted }}>Page {page} / {Math.ceil(total/20)}</span>
              <Btn small outline onClick={()=>setPage(p=>p+1)} disabled={page>=Math.ceil(total/20)}>▶</Btn>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

// ─── CARDHOLDER DETAIL ────────────────────────────────────────────
const CardholderDetail = () => {
  const { id } = useParams();
  const [ch, setCh] = useState(null);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('info');
  const [rejReason, setRejReason] = useState('');
  const [reviewing, setReviewing] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get(`/cardholders/${id}`),
      api.get(`/cardholders/${id}/kyc-documents`)
    ]).then(([chRes, docsRes]) => {
      setCh(chRes.data);
      setDocs(docsRes.data.documents||[]);
    }).catch(()=>{}).finally(()=>setLoading(false));
  }, [id]);

  const reviewDoc = async (docId, status) => {
    setReviewing(docId);
    try {
      await api.patch(`/cardholders/${id}/kyc/documents/${docId}`, { status, rejectionReason: rejReason||undefined });
      toast.success(status==='approved'?'Document approuvé ✅':'Document rejeté ❌');
      setRejReason('');
      const r = await api.get(`/cardholders/${id}/kyc-documents`);
      setDocs(r.data.documents||[]);
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setReviewing(null); }
  };

  const updateKycLevel = async (level) => {
    try {
      await api.patch(`/cardholders/${id}/kyc`, { kycLevel: level });
      toast.success(`KYC niveau ${level} ✅`);
      const r = await api.get(`/cardholders/${id}`);
      setCh(r.data);
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
  };

  if (loading) return <Spin />;
  if (!ch) return <div style={{ color:C.muted, padding:32 }}>Porteur introuvable</div>;

  const STATUS_COLORS = { pending:'#ff9500', approved:'#00c896', rejected:'#ff3b30' };

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
        <Link to="/cardholders" style={{ color:C.muted, textDecoration:'none', fontSize:13 }}>← Porteurs</Link>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>{ch.first_name} {ch.last_name}</h1>
        <span style={{ background:`${STATUS_COLORS[ch.kyc_status]||C.muted}20`, color:STATUS_COLORS[ch.kyc_status]||C.muted, borderRadius:20, padding:'4px 14px', fontSize:12, fontWeight:700 }}>
          KYC Niveau {ch.kyc_level||0}
        </span>
      </div>

      {/* Onglets */}
      <div style={{ display:'flex', gap:0, marginBottom:20, borderBottom:`2px solid ${C.border}` }}>
        {[['info','📋 Informations'],['kyc','🔐 Documents KYC']].map(([v,l])=>(
          <button key={v} onClick={()=>setTab(v)}
            style={{ padding:'10px 20px', border:'none', background:'none', fontSize:13, fontWeight:700, cursor:'pointer', color:tab===v?C.primary:C.muted, borderBottom:`3px solid ${tab===v?C.primary:'transparent'}`, marginBottom:-2 }}>
            {l}
          </button>
        ))}
      </div>

      {/* Informations */}
      {tab==='info' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
          <Card>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Informations personnelles</div>
            {[['Prénom', ch.first_name], ['Nom', ch.last_name], ['Email', ch.email], ['Téléphone', ch.phone||'—'], ['Date naissance', ch.date_of_birth?new Date(ch.date_of_birth).toLocaleDateString('fr-FR'):'—'], ['Nationalité', ch.nationality||'—'], ['Pays', ch.country||'—'], ['Ville', ch.city||'—']].map(([k,v])=>(
              <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:`1px solid ${C.border}`, fontSize:13 }}>
                <span style={{ color:C.muted }}>{k}</span>
                <span style={{ fontWeight:500 }}>{v||'—'}</span>
              </div>
            ))}
          </Card>
          <Card>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Statut KYC</div>
            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:12, color:C.muted, marginBottom:8 }}>Niveau actuel</div>
              <div style={{ display:'flex', gap:8 }}>
                {[0,1,2].map(l=>(
                  <button key={l} onClick={()=>updateKycLevel(l)}
                    style={{ flex:1, padding:'10px', border:`2px solid ${ch.kyc_level===l?C.primary:C.border}`, background:ch.kyc_level===l?`${C.primary}15`:C.bg, borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:700, color:ch.kyc_level===l?C.primary:C.muted }}>
                    Niveau {l}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ fontSize:12, color:C.muted }}>
              {[['Niveau 0','Non vérifié — Limites minimales'],['Niveau 1','KYC validé — Limites standards'],['Niveau 2','KYC complet — Limites maximales']].map(([n,d])=>(
                <div key={n} style={{ padding:'6px 0', borderBottom:`1px solid ${C.border}` }}>
                  <strong>{n}</strong> — {d}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Documents KYC */}
      {tab==='kyc' && (
        <div>
          {docs.length===0 ? (
            <Card style={{ textAlign:'center', padding:40 }}>
              <div style={{ fontSize:40, marginBottom:12 }}>📄</div>
              <div style={{ color:C.muted }}>Aucun document soumis</div>
            </Card>
          ) : docs.map(doc => (
            <Card key={doc.doc_id} style={{ marginBottom:12 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>{doc.doc_label||doc.doc_type}</div>
                  <div style={{ fontSize:12, color:C.muted }}>{doc.file_name} · {doc.uploaded_at?new Date(doc.uploaded_at).toLocaleString('fr-FR'):'—'}</div>
                  {doc.rejection_reason && <div style={{ fontSize:12, color:'#ff3b30', marginTop:4 }}>⚠️ {doc.rejection_reason}</div>}
                </div>
                <span style={{ background:`${STATUS_COLORS[doc.status]||C.muted}20`, color:STATUS_COLORS[doc.status]||C.muted, borderRadius:20, padding:'4px 12px', fontSize:11, fontWeight:700 }}>
                  {doc.status==='approved'?'✅ Approuvé':doc.status==='rejected'?'❌ Rejeté':'⏳ En attente'}
                </span>
              </div>
              {doc.file_url && (
                <div style={{ marginTop:10 }}>
                  <a href={doc.file_url} target="_blank" rel="noreferrer"
                    style={{ color:C.primary, fontSize:12, textDecoration:'none' }}>📎 Voir le document</a>
                </div>
              )}
              {doc.status === 'pending' && (
                <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${C.border}` }}>
                  <input value={rejReason} onChange={e=>setRejReason(e.target.value)}
                    placeholder="Raison du rejet (optionnel)"
                    style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'7px 10px', fontSize:12, marginBottom:8, boxSizing:'border-box', color:C.text }} />
                  <div style={{ display:'flex', gap:8 }}>
                    <Btn small color="#00c896" onClick={()=>reviewDoc(doc.doc_id,'approved')} disabled={reviewing===doc.doc_id}>
                      ✅ Approuver
                    </Btn>
                    <Btn small color="#ff3b30" onClick={()=>reviewDoc(doc.doc_id,'rejected')} disabled={reviewing===doc.doc_id}>
                      ❌ Rejeter
                    </Btn>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};


// ─── CRM : LEADS / RÉCLAMATIONS / CONVERSATIONS ───────────────────
// Contrat : backend/src/routes/crm-admin.routes.js (docs/ASSISTANT-API.md, back office).
// Roles : super_admin, ops_admin, support_agent (403 sinon -> toast « Accès refusé »).
const CrmGuard = ({ children }) => {
  const { admin } = useAuth();
  if (!hasRole(admin, CRM_ROLES)) return <Card><div style={{ color:C.muted, padding:20, textAlign:'center' }}>⛔ Accès réservé aux rôles super_admin, ops_admin et support_agent.</div></Card>;
  return children;
};
const LEAD_STATUSES = [['new','Nouveau'],['contacted','Contacté'],['qualified','Qualifié'],['converted','Converti'],['lost','Perdu']];
const leadColor = st => ({ new:C.primary, contacted:C.warning, qualified:C.blue, converted:C.success, lost:C.danger }[st] || C.muted);
const LEAD_INTERESTS = { merchant:'Marchand', partner:'Partenaire', developer:'Développeur', other:'Autre' };
const CLAIM_STATUSES = [['open','Ouverte'],['in_progress','En cours'],['resolved','Résolue'],['closed','Fermée']];
const claimColor = st => ({ open:C.danger, in_progress:C.warning, resolved:C.success, closed:C.muted }[st] || C.muted);
const CLAIM_CATEGORIES = [['payment','Paiement'],['settlement','Règlement'],['account','Compte'],['fraud','Fraude'],['other','Autre']];
const Drawer = ({ title, onClose, children, width = 520 }) => (
  <div style={{ position:'fixed', inset:0, zIndex:1000 }}>
    <div onClick={onClose} style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.35)' }} />
    <div style={{ position:'absolute', top:0, right:0, bottom:0, width, maxWidth:'100%', background:C.card, borderLeft:`1px solid ${C.border}`, boxShadow:'-8px 0 32px rgba(0,0,0,0.12)', display:'flex', flexDirection:'column' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'16px 20px', borderBottom:`1px solid ${C.border}` }}>
        <h2 style={{ margin:0, fontSize:16 }}>{title}</h2>
        <button onClick={onClose} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:C.muted }}>✕</button>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding:20 }}>{children}</div>
    </div>
  </div>
);
const KV = ({ l, v }) => (
  <div style={{ display:'flex', justifyContent:'space-between', gap:12, padding:'7px 0', borderBottom:`1px solid ${C.border}`, fontSize:13 }}>
    <span style={{ color:C.muted, whiteSpace:'nowrap' }}>{l}</span><span style={{ textAlign:'right', wordBreak:'break-word' }}>{v || '—'}</span>
  </div>
);
// Liste des admins pour l'assignation (GET /admin-users)
const useAdminUsers = () => {
  const [users, setUsers] = useState([]);
  useEffect(() => { api.get('/admin-users').then(r => setUsers(r.data?.data || (Array.isArray(r.data) ? r.data : []))).catch(() => {}); }, []);
  const label = id => { const u = users.find(x => x.admin_id === id); return u ? (`${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email) : null; };
  return { users, label };
};
const AssigneeSelect = ({ value, onChange, users }) => (
  <Sel label="Assigné à" value={value || ''} onChange={onChange}
    options={[{ v:'', l:'— Non assigné —' }, ...users.map(u => ({ v: u.admin_id, l: `${u.first_name || ''} ${u.last_name || ''} (${u.email})`.trim() }))]} />
);

const CrmLeads = () => {
  const LIMIT = 25;
  const [leads, setLeads] = useState([]); const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(''); const [search, setSearch] = useState(''); const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);
  const [notes, setNotes] = useState(''); const [saving, setSaving] = useState(false);
  const { users, label: userLabel } = useAdminUsers();

  const load = useCallback(() => {
    setLoading(true);
    const params = { page, limit: LIMIT }; if (status) params.status = status; if (q) params.q = q;
    crmApi.leads(params).then(r => { setLeads(r.data?.data || []); setTotal(r.data?.total || 0); })
      .catch(err => { if (err.response?.status !== 403) toast.error(err.response?.data?.error || 'Erreur chargement leads'); })
      .finally(() => setLoading(false));
  }, [page, status, q]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const h = setTimeout(() => { setQ(search.trim()); setPage(1); }, 350); return () => clearTimeout(h); }, [search]);

  const open = lead => { setSelected(lead); setNotes(lead.notes || ''); };
  const patch = async (fields, okMsg) => {
    setSaving(true);
    try {
      const r = await crmApi.updateLead(selected.lead_id, fields);
      const updated = r.data?.lead_id ? r.data : { ...selected, ...fields };
      setSelected(updated); setNotes(updated.notes || '');
      setLeads(ls => ls.map(l => l.lead_id === updated.lead_id ? updated : l));
      toast.success(okMsg || 'Lead mis à jour');
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSaving(false); }
  };
  const stLabel = st => (LEAD_STATUSES.find(([v]) => v === st) || [st, st])[1];

  return (
    <CrmGuard>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>🎯 Leads <span style={{ fontSize:14, color:C.muted }}>({fmt(total)})</span></h1>
        <Btn small variant="secondary" onClick={load}>↻</Btn>
      </div>
      <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Rechercher (nom, email, société)…"
          style={{ flex:1, minWidth:240, background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:C.text }} />
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:C.text }}>
          <option value="">Tous statuts</option>
          {LEAD_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Date', 'Nom', 'Contact', 'Société', 'Intérêt', 'Source', 'Statut', 'Assigné']}
            rows={leads.map(l => (
              <tr key={l.lead_id} style={{ cursor:'pointer' }} onClick={() => open(l)}>
                <TD style={{ fontSize:11, color:C.muted }}>{fmtDate(l.created_at)}</TD>
                <TD style={{ fontWeight:600 }}>{l.name || '—'}</TD>
                <TD style={{ fontSize:12 }}>{l.email || '—'}<br/><span style={{ color:C.muted }}>{l.phone || ''}</span></TD>
                <TD>{l.company || '—'}{l.country ? <span style={{ color:C.muted, fontSize:11 }}> · {l.country}</span> : null}</TD>
                <TD style={{ fontSize:12 }}>{LEAD_INTERESTS[l.interest] || l.interest || '—'}</TD>
                <TD style={{ fontSize:12, color:C.muted }}>{l.source || '—'}</TD>
                <TD><Badge label={stLabel(l.status)} color={leadColor(l.status)} /></TD>
                <TD style={{ fontSize:12 }}>{userLabel(l.assigned_to) || (l.assigned_to ? String(l.assigned_to).slice(0, 8) : '—')}</TD>
              </tr>
            ))} empty="Aucun lead" />
          <Pagination page={page} setPage={setPage} count={leads.length} limit={LIMIT} />
        </Card>
      )}
      {selected && (
        <Drawer title={`Lead — ${selected.name || selected.email || ''}`} onClose={() => setSelected(null)}>
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:14 }}>
            {LEAD_STATUSES.filter(([v]) => v !== 'new').map(([v, l]) => (
              <Btn key={v} small disabled={saving || selected.status === v} variant={v === 'lost' ? 'danger' : v === 'converted' ? 'success' : 'blue'} onClick={() => patch({ status: v }, `Lead marqué « ${l} »`)}>{l}</Btn>
            ))}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Sel label="Statut" value={selected.status || 'new'} onChange={v => patch({ status: v })} options={LEAD_STATUSES.map(([v, l]) => ({ v, l }))} />
            <AssigneeSelect value={selected.assigned_to} users={users} onChange={v => v ? patch({ assignedTo: v }, 'Lead assigné') : toast('Le backend ne permet pas de désassigner (COALESCE) — réassignez à un autre admin.', { icon: 'ℹ️' })} />
          </div>
          <KV l="Email" v={selected.email} /><KV l="Téléphone" v={selected.phone} />
          <KV l="Société" v={selected.company} /><KV l="Pays" v={selected.country} />
          <KV l="Intérêt" v={LEAD_INTERESTS[selected.interest] || selected.interest} /><KV l="Source" v={selected.source} />
          <KV l="Conversation" v={selected.conversation_id ? <Link to="/crm/conversations" style={{ color:C.primary }}>{String(selected.conversation_id).slice(0, 8)}…</Link> : null} />
          <KV l="Consentement" v={fmtDate(selected.consent_at)} /><KV l="Créé le" v={fmtDate(selected.created_at)} /><KV l="Mis à jour" v={fmtDate(selected.updated_at)} />
          {selected.message && (<>
            <div style={{ marginTop:14, fontSize:13, fontWeight:700, marginBottom:6 }}>Message</div>
            <div style={{ fontSize:13, background:C.bg, borderRadius:8, padding:12, whiteSpace:'pre-wrap' }}>{selected.message}</div>
          </>)}
          <div style={{ marginTop:18, fontSize:13, fontWeight:700, marginBottom:6 }}>📝 Notes internes</div>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes de suivi (visibles par l'équipe uniquement)…" rows={5}
            style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'9px 12px', fontSize:13, color:C.text, boxSizing:'border-box', resize:'vertical' }} />
          <Btn small onClick={() => patch({ notes }, 'Notes enregistrées')} disabled={saving || notes === (selected.notes || '')} style={{ marginTop:8 }}>Enregistrer les notes</Btn>
        </Drawer>
      )}
    </CrmGuard>
  );
};

const CrmComplaints = () => {
  const LIMIT = 25;
  const [items, setItems] = useState([]); const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState(''); const [category, setCategory] = useState('');
  const [search, setSearch] = useState(''); const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);
  const [resolution, setResolution] = useState(''); const [saving, setSaving] = useState(false);
  const { users, label: userLabel } = useAdminUsers();

  const load = useCallback(() => {
    setLoading(true);
    const params = { page, limit: LIMIT }; if (status) params.status = status; if (category) params.category = category; if (q) params.q = q;
    crmApi.claims(params).then(r => { setItems(r.data?.data || []); setTotal(r.data?.total || 0); })
      .catch(err => { if (err.response?.status !== 403) toast.error(err.response?.data?.error || 'Erreur chargement réclamations'); })
      .finally(() => setLoading(false));
  }, [page, status, category, q]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const h = setTimeout(() => { setQ(search.trim()); setPage(1); }, 350); return () => clearTimeout(h); }, [search]);

  const open = c => { setSelected(c); setResolution(c.resolution || ''); };
  const save = async (fields, okMsg) => {
    setSaving(true);
    try {
      const r = await crmApi.updateClaim(selected.claim_id, fields);
      const updated = r.data?.claim_id ? r.data : { ...selected, ...fields };
      setSelected(updated); setResolution(updated.resolution || '');
      setItems(ls => ls.map(c => c.claim_id === updated.claim_id ? updated : c));
      toast.success(okMsg || 'Réclamation mise à jour');
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSaving(false); }
  };
  const stLabel = st => (CLAIM_STATUSES.find(([v]) => v === st) || [st, st])[1];
  const catLabel = ct => (CLAIM_CATEGORIES.find(([v]) => v === ct) || [ct, ct || '—'])[1];

  return (
    <CrmGuard>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>📣 Réclamations <span style={{ fontSize:14, color:C.muted }}>({fmt(total)})</span></h1>
        <Btn small variant="secondary" onClick={load}>↻</Btn>
      </div>
      <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Référence REC-…, nom, email, réf. transaction"
          style={{ flex:1, minWidth:240, background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:C.text }} />
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:C.text }}>
          <option value="">Tous statuts</option>{CLAIM_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={category} onChange={e => { setCategory(e.target.value); setPage(1); }} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:C.text }}>
          <option value="">Toutes catégories</option>{CLAIM_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Référence', 'Date', 'Catégorie', 'Plaignant', 'Description', 'Statut', 'Assigné']}
            rows={items.map(c => (
              <tr key={c.claim_id} style={{ cursor:'pointer' }} onClick={() => open(c)}>
                <TD style={{ fontFamily:'monospace', fontSize:12, fontWeight:600 }}>{c.reference}</TD>
                <TD style={{ fontSize:11, color:C.muted }}>{fmtDate(c.created_at)}</TD>
                <TD><Badge label={catLabel(c.category)} color={c.category === 'fraud' ? C.danger : C.blue} /></TD>
                <TD style={{ fontSize:12 }}>{c.name}<br/><span style={{ color:C.muted }}>{c.email || c.phone || ''}</span></TD>
                <TD style={{ maxWidth:300, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.description}</TD>
                <TD><Badge label={stLabel(c.status)} color={claimColor(c.status)} /></TD>
                <TD style={{ fontSize:12 }}>{userLabel(c.assigned_to) || (c.assigned_to ? String(c.assigned_to).slice(0, 8) : '—')}</TD>
              </tr>
            ))} empty="Aucune réclamation" />
          <Pagination page={page} setPage={setPage} count={items.length} limit={LIMIT} />
        </Card>
      )}
      {selected && (
        <Drawer title={`Réclamation ${selected.reference}`} onClose={() => setSelected(null)}>
          <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:14 }}>
            <Badge label={stLabel(selected.status)} color={claimColor(selected.status)} />
            <Badge label={catLabel(selected.category)} color={selected.category === 'fraud' ? C.danger : C.blue} />
            {selected.resolved_at && <span style={{ fontSize:11, color:C.muted }}>résolue le {fmtDate(selected.resolved_at)}</span>}
          </div>
          <KV l="Référence" v={<code>{selected.reference}</code>} /><KV l="Créée le" v={fmtDate(selected.created_at)} />
          <KV l="Plaignant" v={selected.name} /><KV l="Email" v={selected.email} /><KV l="Téléphone" v={selected.phone} />
          <KV l="Réf. marchand" v={selected.merchant_ref} /><KV l="Réf. transaction" v={selected.transaction_ref} />
          <KV l="Source" v={selected.source} />
          <KV l="Conversation" v={selected.conversation_id ? <Link to="/crm/conversations" style={{ color:C.primary }}>{String(selected.conversation_id).slice(0, 8)}…</Link> : null} />
          <div style={{ marginTop:14, fontSize:13, fontWeight:700, marginBottom:6 }}>Description</div>
          <div style={{ fontSize:13, background:C.bg, borderRadius:8, padding:12, whiteSpace:'pre-wrap', marginBottom:14 }}>{selected.description || '—'}</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Sel label="Statut" value={selected.status || 'open'} onChange={v => save({ status: v }, `Statut : ${stLabel(v)}`)} options={CLAIM_STATUSES.map(([v, l]) => ({ v, l }))} />
            <AssigneeSelect value={selected.assigned_to} users={users} onChange={v => v ? save({ assignedTo: v }, 'Réclamation assignée') : toast('Le backend ne permet pas de désassigner (COALESCE) — réassignez à un autre admin.', { icon: 'ℹ️' })} />
          </div>
          <div style={{ fontSize:12, color:C.muted, marginBottom:4 }}>Résolution</div>
          <textarea value={resolution} onChange={e => setResolution(e.target.value)} rows={4} placeholder="Décrire la résolution apportée…"
            style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'9px 12px', fontSize:13, color:C.text, boxSizing:'border-box', resize:'vertical' }} />
          <div style={{ display:'flex', gap:8, marginTop:8 }}>
            <Btn small onClick={() => save({ resolution }, 'Résolution enregistrée')} disabled={saving || !resolution.trim()}>Enregistrer la résolution</Btn>
            <Btn small variant="success" onClick={() => save({ resolution, status: 'resolved' }, 'Réclamation résolue')} disabled={saving || !resolution.trim() || selected.status === 'resolved'}>✓ Résoudre</Btn>
          </div>
        </Drawer>
      )}
    </CrmGuard>
  );
};

const CrmConversations = () => {
  const LIMIT = 25;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null); const [msgs, setMsgs] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    crmApi.conversations({ page, limit: LIMIT }).then(r => setItems(r.data?.data || []))
      .catch(err => { if (err.response?.status !== 403) toast.error(err.response?.data?.error || 'Erreur chargement conversations'); })
      .finally(() => setLoading(false));
  }, [page]);
  useEffect(() => { load(); }, [load]);

  const open = async (c) => {
    setSelected(c); setMsgs(null);
    try { const r = await crmApi.conversation(c.conversation_id); setSelected(p => ({ ...p, ...r.data })); setMsgs(Array.isArray(r.data?.messages) ? r.data.messages : []); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); setMsgs([]); }
  };
  const isUser = m => (m.role || '').toLowerCase() === 'user';
  const text = m => typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(b => b?.text || '').join('\n') : JSON.stringify(m.content || '');

  return (
    <CrmGuard>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>💬 Conversations de l&apos;assistant</h1>
        <Btn small variant="secondary" onClick={load}>↻</Btn>
      </div>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Dernier message', 'Page', 'Langue', 'Messages', 'Transfert humain', 'Lead / Réclamation']}
            rows={items.map(c => (
              <tr key={c.conversation_id} style={{ cursor:'pointer' }} onClick={() => open(c)}>
                <TD style={{ fontSize:11, color:C.muted }}>{fmtDate(c.last_message_at || c.created_at)}</TD>
                <TD style={{ fontSize:12 }}>{c.page || '—'}</TD>
                <TD><Badge label={(c.locale || 'fr').toUpperCase()} color={C.blue} /></TD>
                <TD>{c.message_count ?? '—'}</TD>
                <TD>{c.handoff_requested ? <Badge label={`Oui${c.handoff_team ? ' · ' + c.handoff_team : ''}`} color={C.warning} /> : <span style={{ color:C.muted }}>—</span>}</TD>
                <TD style={{ fontSize:11 }}>{c.lead_id && <Badge label="Lead" color={C.primary} />} {c.claim_id && <Badge label="Réclamation" color={C.danger} />}{!c.lead_id && !c.claim_id && <span style={{ color:C.muted }}>—</span>}</TD>
              </tr>
            ))} empty="Aucune conversation" />
          <Pagination page={page} setPage={setPage} count={items.length} limit={LIMIT} />
        </Card>
      )}
      {selected && (
        <Drawer title={`Conversation ${String(selected.conversation_id).slice(0, 8)}…`} onClose={() => setSelected(null)} width={620}>
          <div style={{ fontSize:11, color:C.muted, marginBottom:12 }}>
            Lecture seule · {selected.locale || 'fr'} · page {selected.page || '—'} · {fmtDate(selected.created_at)}
            {selected.handoff_requested && <> · <span style={{ color:C.warning }}>transfert humain demandé{selected.handoff_team ? ` (${selected.handoff_team})` : ''}</span></>}
          </div>
          {msgs === null ? <Spin /> : msgs.length === 0 ? <div style={{ color:C.muted, fontSize:13 }}>Transcript vide.</div> : msgs.map(m => (
            <div key={m.message_id} style={{ display:'flex', justifyContent: isUser(m) ? 'flex-end' : 'flex-start', marginBottom:10 }}>
              <div style={{ maxWidth:'82%', background: isUser(m) ? `${C.primary}18` : C.bg, border:`1px solid ${isUser(m) ? C.primary + '40' : C.border}`, borderRadius:12, padding:'8px 12px', fontSize:13 }}>
                <div style={{ fontSize:10, color:C.muted, marginBottom:3 }}>{isUser(m) ? '👤 visiteur' : '🤖 ' + (m.role || 'assistant')} · {fmtDate(m.created_at)}</div>
                <div style={{ whiteSpace:'pre-wrap' }}>{text(m)}</div>
                {Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && <div style={{ fontSize:10, color:C.muted, marginTop:4 }}>🔧 {m.tool_calls.map(tc => tc.name || tc.function?.name || 'outil').join(', ')}</div>}
              </div>
            </div>
          ))}
        </Drawer>
      )}
    </CrmGuard>
  );
};

// ─── AUDIT LOGS ───────────────────────────────────────────────────
const AuditLogs = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { auditApi.list().then(r => { setLogs(r.data.data || []); setLoading(false); }).catch(() => setLoading(false)); }, []);
  return (
    <div>
      <h1 style={{ margin: '0 0 20px', fontSize: 22, fontWeight: 700 }}>Audit Logs</h1>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Date', 'Admin', 'Action', 'Entite', 'IP']}
            rows={logs.map((l, i) => (
              <tr key={i}>
                <TD style={{ fontSize: 11, color: C.muted }}>{fmtDate(l.created_at)}</TD>
                <TD style={{ fontSize: 12 }}>{l.admin_email || '---'}</TD>
                <TD style={{ fontSize: 12, fontFamily: 'monospace', color: C.warning }}>{l.action}</TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{l.entity_type || '---'}</TD>
                <TD style={{ fontSize: 11, color: C.muted }}>{l.ip_address || '---'}</TD>
              </tr>
            ))} empty="Aucun log" />
        </Card>
      )}
    </div>
  );
};

// ─── SUPPORT TICKETS ─────────────────────────────────────────────
const SupportTickets = () => {
  const { user } = useAuth();
  const [tickets, setTickets] = useState([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState({ open:0, pending_admin:0, pending_merchant:0, resolved:0, closed:0 });
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [reply, setReply] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [replying, setReplying] = useState(false);
  const [newStatus, setNewStatus] = useState('');
  const [resolution, setResolution] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [showEscalade, setShowEscalade] = useState(false);
  const [agents, setAgents] = useState([]);
  const [escaladeForm, setEscaladeForm] = useState({ escalateTo:'', escalationLevel:'2', escalationNotes:'' });
  const [escalading, setEscalading] = useState(false);
  const messagesEndRef = React.useRef(null);

  useEffect(() => {
    api.get('/support/agents').then(r => setAgents(r.data.data||[])).catch(()=>{});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/support/tickets', { params: { limit:100 } })
      .then(r => {
        const all = r.data.data || [];
        setTickets(filter ? all.filter(t => t.status === filter) : all);
        setTotal(all.length);
        setStats({
          open:             all.filter(t=>t.status==='open').length,
          pending_admin:    all.filter(t=>t.status==='pending_admin').length,
          pending_merchant: all.filter(t=>t.status==='pending_merchant').length,
          resolved:         all.filter(t=>t.status==='resolved').length,
          closed:           all.filter(t=>t.status==='closed').length,
        });
      }).catch(()=>{}).finally(()=>setLoading(false));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const openTicket = async (ticket) => {
    if (msgLoading) return;
    setSelected(ticket); setNewStatus(ticket.status);
    setResolution(ticket.resolution||''); setAdminNotes(ticket.admin_notes||'');
    setMessages([]); setAttachments([]);
    setMsgLoading(true);
    try {
      const r = await api.get('/support/tickets/' + ticket.ticket_id);
      const msgs = Array.isArray(r.data.messages) ? r.data.messages : [];
      setMessages(msgs);
      const fresh = { ...ticket, ...r.data }; delete fresh.messages;
      setSelected(fresh);
      setResolution(fresh.resolution||''); setAdminNotes(fresh.admin_notes||'');
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior:'smooth' }), 100);
    } catch { setMessages([]); } finally { setMsgLoading(false); }
  };

  const assignToMe = async () => {
    if (!selected) return;
    setAssigning(true);
    try {
      await api.patch('/support/tickets/' + selected.ticket_id + '/assign');
      toast.success('Ticket pris en charge');
      const r = await api.get('/support/tickets/' + selected.ticket_id);
      const fresh = { ...selected, ...r.data }; delete fresh.messages;
      setSelected(fresh); setNewStatus(fresh.status);
      load();
    } catch { toast.error('Erreur'); } finally { setAssigning(false); }
  };

  const handleAttach = (e) => {
    Array.from(e.target.files).forEach(file => {
      if (file.size > 5*1024*1024) return toast.error('Max 5MB');
      const reader = new FileReader();
      reader.onload = ev => setAttachments(prev=>[...prev,{name:file.name,url:ev.target.result,type:file.type}]);
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const sendReply = async () => {
    if ((!reply.trim() && attachments.length===0) || !selected) return;
    setReplying(true);
    try {
      await api.post('/support/tickets/'+selected.ticket_id+'/messages', { message:reply||'[Fichier joint]', attachments });
      setReply(''); setAttachments([]);
      const r = await api.get('/support/tickets/'+selected.ticket_id);
      setMessages(Array.isArray(r.data.messages)?r.data.messages:[]);
      setTimeout(()=>messagesEndRef.current?.scrollIntoView({behavior:'smooth'}),100);
      toast.success('Message envoye');
    } catch { toast.error('Erreur'); } finally { setReplying(false); }
  };

  const updateStatus = async () => {
    if (!selected) return;
    try {
      await api.patch('/support/tickets/'+selected.ticket_id+'/status', { status:newStatus, resolution:resolution||undefined, adminNotes:adminNotes||undefined });
      toast.success('Statut mis a jour');
      setSelected(prev=>({...prev, status:newStatus, resolution, admin_notes:adminNotes}));
      load();
    } catch { toast.error('Erreur'); }
  };

  const escalade = async () => {
    if (!escaladeForm.escalateTo) return toast.error('Choisir un destinataire');
    setEscalading(true);
    try {
      const r = await api.post('/support/tickets/'+selected.ticket_id+'/escalate', escaladeForm);
      toast.success('Ticket escalade');
      setShowEscalade(false);
      setEscaladeForm({ escalateTo:'', escalationLevel:'2', escalationNotes:'' });
      openTicket(selected); load();
    } catch(err) { toast.error(err.response?.data?.error||'Erreur'); }
    finally { setEscalading(false); }
  };

  const SC = { open:C.danger, pending_admin:C.warning, pending_merchant:C.blue, resolved:C.success, closed:C.muted };
  const SL = { open:'Ouvert', pending_admin:'En cours', pending_merchant:'Attente merchant', resolved:'Resolu', closed:'Ferme' };
  const PC = { high:C.danger, normal:C.warning, low:C.success };
  const PL = { high:'Critique', normal:'Normal', low:'Faible' };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'calc(100vh - 80px)' }}>

      {/* Modal Escalade */}
      {showEscalade && selected && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:C.card, borderRadius:16, padding:28, width:480, maxWidth:'100%' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <div style={{ fontSize:16, fontWeight:700 }}>Escalader le ticket</div>
              <button onClick={()=>setShowEscalade(false)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:C.muted }}>x</button>
            </div>
            <div style={{ background:`${C.primary}10`, borderRadius:8, padding:10, marginBottom:14, fontSize:12 }}>
              {selected.ticket_number} — {selected.subject}
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>Niveau</label>
              <select value={escaladeForm.escalationLevel} onChange={e=>setEscaladeForm(p=>({...p,escalationLevel:e.target.value,escalateTo:''}))}
                style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'9px 12px', fontSize:13, color:C.text }}>
                <option value="2">N2 — Ops Admin (technique)</option>
                <option value="3">N3 — Finance (transaction, reglement)</option>
                <option value="4">N4 — Super Admin (arbitrage final)</option>
              </select>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>Assigner a *</label>
              <select value={escaladeForm.escalateTo} onChange={e=>setEscaladeForm(p=>({...p,escalateTo:e.target.value}))}
                style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'9px 12px', fontSize:13, color:C.text }}>
                <option value="">-- Choisir --</option>
                {agents.filter(a => {
                  const lvl = String(escaladeForm.escalationLevel);
                  if (lvl==='2') return a.role==='ops_admin'||a.role==='super_admin';
                  if (lvl==='3') return a.role==='finance_admin'||a.role==='super_admin';
                  return a.role==='super_admin';
                }).map(a=>(
                  <option key={a.admin_id} value={a.admin_id}>{a.first_name} {a.last_name} ({a.email})</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom:16 }}>
              <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>Note d escalade</label>
              <textarea value={escaladeForm.escalationNotes} onChange={e=>setEscaladeForm(p=>({...p,escalationNotes:e.target.value}))} rows={3}
                placeholder="Raison de l escalade et informations collectees..."
                style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'9px 12px', fontSize:12, resize:'none', boxSizing:'border-box', fontFamily:'inherit', color:C.text }} />
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <Btn onClick={escalade} disabled={escalading||!escaladeForm.escalateTo} color="#9b59b6" style={{ flex:1 }}>
                {escalading?'...':'Confirmer'}
              </Btn>
              <Btn outline onClick={()=>setShowEscalade(false)} style={{ flex:1 }}>Annuler</Btn>
            </div>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div style={{ flexShrink:0, marginBottom:14 }}>
        <h1 style={{ margin:'0 0 14px', fontSize:22, fontWeight:700 }}>Gestion des Incidents</h1>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:10, marginBottom:14 }}>
          {[
            ['Ouverts',          stats.open,             C.danger,  'open'],
            ['En cours',         stats.pending_admin,    C.warning, 'pending_admin'],
            ['Attente merchant', stats.pending_merchant, C.blue,    'pending_merchant'],
            ['Resolus',          stats.resolved,         C.success, 'resolved'],
            ['Fermes',           stats.closed,           C.muted,   'closed'],
          ].map(([label,val,color,f]) => (
            <div key={f} onClick={()=>setFilter(filter===f?'':f)}
              style={{ background:filter===f?`${color}20`:C.card, border:`2px solid ${filter===f?color:C.border}`, borderRadius:10, padding:'10px', cursor:'pointer', textAlign:'center' }}>
              <div style={{ fontSize:20, fontWeight:800, color }}>{val}</div>
              <div style={{ fontSize:11, color:C.muted }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Contenu */}
      <div style={{ display:'flex', gap:16, flex:1, minHeight:0 }}>
        {/* Liste */}
        <div style={{ width:360, flexShrink:0, overflowY:'auto' }}>
          {loading ? <Spin /> : tickets.length===0 ? (
            <div style={{ textAlign:'center', padding:32, color:C.muted }}>Aucun ticket</div>
          ) : tickets.map(tk => (
            <div key={tk.ticket_id} onClick={(e)=>{e.stopPropagation();openTicket(tk);}}
              style={{ padding:'10px 12px', borderRadius:8, marginBottom:6, cursor:'pointer', background:selected?.ticket_id===tk.ticket_id?`${C.primary}15`:C.card, border:`1px solid ${selected?.ticket_id===tk.ticket_id?C.primary:C.border}`, borderLeft:`4px solid ${SC[tk.status]||C.muted}` }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                <span style={{ fontFamily:'monospace', fontSize:10, color:C.muted }}>{tk.ticket_number}</span>
                <Badge label={PL[tk.priority]||tk.priority} color={PC[tk.priority]||C.muted} />
              </div>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:3 }}>{tk.subject}</div>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div style={{ fontSize:11, color:C.muted }}>{tk.business_name}</div>
                <Badge label={SL[tk.status]||tk.status} color={SC[tk.status]||C.muted} />
              </div>
            </div>
          ))}
        </div>

        {/* Détail */}
        {selected ? (
          <div style={{ flex:1, border:`1px solid ${C.border}`, borderRadius:12, background:C.card, display:'flex', flexDirection:'column', minHeight:0, overflow:'hidden' }}>
            {/* Header */}
            <div style={{ padding:'12px 16px', borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                    <span style={{ fontFamily:'monospace', fontSize:11, color:C.muted }}>{selected.ticket_number}</span>
                    <Badge label={SL[selected.status]||selected.status} color={SC[selected.status]||C.muted} />
                    <Badge label={PL[selected.priority]||selected.priority} color={PC[selected.priority]||C.muted} />
                  </div>
                  <div style={{ fontSize:14, fontWeight:700 }}>{selected.subject}</div>
                  <div style={{ fontSize:11, color:C.muted }}>{selected.business_name} · {fmtDate(selected.created_at)}</div>
                  {selected.escalation_level > 1 && (
                    <span style={{ background:'#9b59b620', color:'#9b59b6', borderRadius:6, padding:'2px 8px', fontSize:11, fontWeight:700 }}>
                      N{selected.escalation_level} — {['','','Ops Admin','Finance','Super Admin'][selected.escalation_level]||'Admin'}
                    </span>
                  )}
                </div>
                <div style={{ display:'flex', gap:6 }}>
                  {selected.status==='open' && !selected.assigned_admin_id && (
                    <Btn small onClick={assignToMe} disabled={assigning} color={C.warning}>
                      {assigning?'...':'Prendre en charge'}
                    </Btn>
                  )}
                  {selected.assigned_admin_id && !['resolved','closed'].includes(selected.status) && (
                    <Btn small onClick={()=>setShowEscalade(true)} color="#9b59b6">Escalader</Btn>
                  )}
                  <button onClick={()=>setSelected(null)} style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:C.muted }}>x</button>
                </div>
              </div>
            </div>

            {/* Zone scrollable unique */}
            <div style={{ flex:1, overflowY:'auto', padding:'14px 16px' }}>

              {/* Historique */}
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.muted, marginBottom:10, paddingBottom:6, borderBottom:`1px solid ${C.border}` }}>
                  Historique ({messages.length})
                </div>
                {msgLoading ? <div style={{ textAlign:'center', padding:16, color:C.muted }}>Chargement...</div>
                : messages.length===0 ? (
                  <div style={{ textAlign:'center', padding:16, color:C.muted, fontSize:12, background:C.bg, borderRadius:8 }}>Aucun message</div>
                ) : messages.map((msg,idx) => (
                  <div key={msg.message_id||idx} style={{ marginBottom:10, display:'flex', flexDirection:'column', alignItems:msg.sender_type==='admin'?'flex-end':'flex-start' }}>
                    <div style={{ fontSize:10, color:C.muted, marginBottom:2 }}>
                      {msg.sender_type==='admin'?'Admin':'Merchant'} — {msg.sender_name} — {fmtDate(msg.created_at)}
                    </div>
                    <div style={{ background:msg.sender_type==='admin'?`${C.primary}20`:'#fff', border:`1px solid ${msg.sender_type==='admin'?C.primary:C.border}`, borderRadius:8, padding:'8px 12px', maxWidth:'80%', fontSize:12 }}>
                      {msg.message}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Repondre */}
              <div style={{ marginBottom:16, paddingTop:12, borderTop:`1px solid ${C.border}` }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.muted, marginBottom:8 }}>Repondre</div>
                {attachments.length>0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:8 }}>
                    {attachments.map((a,i)=>(
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:4, background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'2px 8px', fontSize:11 }}>
                        {a.name}<button onClick={()=>setAttachments(p=>p.filter((_,j)=>j!==i))} style={{ background:'none', border:'none', cursor:'pointer', color:C.danger }}>x</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display:'flex', gap:8 }}>
                  <textarea value={reply} onChange={e=>setReply(e.target.value)} rows={3} placeholder="Votre reponse..."
                    style={{ flex:1, background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'8px 10px', fontSize:12, resize:'none', fontFamily:'inherit', color:C.text }} />
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    <label style={{ cursor:'pointer', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'7px 9px', fontSize:13, textAlign:'center' }}>
                      📎<input type="file" multiple accept="image/*,.pdf" onChange={handleAttach} style={{ display:'none' }} />
                    </label>
                    <Btn small onClick={sendReply} disabled={replying||(!reply.trim()&&attachments.length===0)}>
                      {replying?'...':'Envoyer'}
                    </Btn>
                  </div>
                </div>
              </div>

              {/* Arbitrage */}
              <div style={{ paddingTop:12, borderTop:`1px solid ${C.border}` }}>
                <div style={{ fontSize:12, fontWeight:700, color:C.muted, marginBottom:10 }}>Arbitrage et Statut</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
                  <div>
                    <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:3 }}>Statut</label>
                    <select value={newStatus} onChange={e=>setNewStatus(e.target.value)}
                      style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'7px 10px', fontSize:12, color:C.text }}>
                      {[['open','Ouvert'],['pending_admin','En cours'],['pending_merchant','Attente merchant'],['resolved','Resolu'],['closed','Ferme']].map(([v,l])=>(
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:3 }}>Resolution</label>
                    <input value={resolution} onChange={e=>setResolution(e.target.value)} placeholder="Resume..."
                      style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'7px 10px', fontSize:12, color:C.text, boxSizing:'border-box' }} />
                  </div>
                </div>
                <div style={{ marginBottom:8 }}>
                  <label style={{ display:'block', fontSize:11, color:C.muted, marginBottom:3 }}>Notes internes</label>
                  <textarea value={adminNotes} onChange={e=>setAdminNotes(e.target.value)} rows={2}
                    style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:'7px 10px', fontSize:12, resize:'none', boxSizing:'border-box', fontFamily:'inherit', color:C.text }}
                    placeholder="Notes non visibles par le merchant..." />
                </div>
                <Btn small onClick={updateStatus} style={{ width:'100%' }}>Appliquer</Btn>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:C.card, border:`1px solid ${C.border}`, borderRadius:12 }}>
            <div style={{ textAlign:'center', color:C.muted }}>
              <div style={{ fontSize:48, marginBottom:8 }}>🎫</div>
              <div>Selectionnez un ticket</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── AUDIT LOGS ───────────────────────────────────────────────────
const AdminUsers = () => {
  const { isSuperAdmin } = useRole();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ email:'', password:'', firstName:'', lastName:'', role:'support_agent' });
  const [saving, setSaving] = useState(false);
  const ROLE_COLORS = { super_admin:'#1565C0', ops_admin:'#9b59b6', finance_admin:'#00c896', support_agent:'#ff9500' };
  const ROLE_LABELS = { super_admin:'Super Admin', ops_admin:'Ops Admin', finance_admin:'Finance', support_agent:'Customer Care' };
  const load = useCallback(() => {
    api.get('/admin-users').then(r => setUsers(r.data.data || [])).catch(()=>{}).finally(()=>setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  const create = async () => {
    if (!form.email || !form.password) return toast.error('Email et mot de passe requis');
    setSaving(true);
    try {
      await api.post('/admin-users', form);
      toast.success('Utilisateur créé ✅');
      setShowNew(false);
      setForm({ email:'', password:'', firstName:'', lastName:'', role:'support_agent' });
      load();
    } catch(err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSaving(false); }
  };
  const toggleActive = async (id, isActive) => {
    try { await api.patch('/admin-users/'+id, { isActive: !isActive }); load(); toast.success('Statut mis à jour'); }
    catch { toast.error('Erreur'); }
  };
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>👥 Gestion Utilisateurs Admin</h1>
        {isSuperAdmin && <Btn onClick={() => setShowNew(true)}>+ Nouvel utilisateur</Btn>}
      </div>
      {showNew && (
        <Modal title="Créer un utilisateur admin" onClose={() => setShowNew(false)}>
          <Inp label="Prénom" value={form.firstName} onChange={v=>setForm(p=>({...p,firstName:v}))} placeholder="Jean" />
          <Inp label="Nom" value={form.lastName} onChange={v=>setForm(p=>({...p,lastName:v}))} placeholder="Dupont" />
          <Inp label="Email *" value={form.email} onChange={v=>setForm(p=>({...p,email:v}))} placeholder="user@c-pay.global" />
          <Inp label="Mot de passe *" value={form.password} onChange={v=>setForm(p=>({...p,password:v}))} type="password" placeholder="••••••••" />
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:12, color:C.muted, marginBottom:4 }}>Role *</label>
            <select value={form.role} onChange={e=>setForm(p=>({...p,role:e.target.value}))}
              style={{ width:'100%', background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:C.text }}>
              <option value="support_agent">Customer Care</option>
              <option value="finance_admin">Finance</option>
              <option value="ops_admin">Ops Admin</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Création…':'Créer'}</Btn>
            <Btn outline onClick={() => setShowNew(false)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Modal>
      )}
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Nom','Email','Role','Statut','Derniere connexion','Actions']}
            rows={users.map(u => (
              <tr key={u.admin_id}>
                <TD style={{ fontWeight:600 }}>{u.first_name} {u.last_name}</TD>
                <TD style={{ fontSize:12, color:C.muted }}>{u.email}</TD>
                <TD><span style={{ background:`${ROLE_COLORS[u.role]||C.muted}20`, color:ROLE_COLORS[u.role]||C.muted, borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>{ROLE_LABELS[u.role]||u.role}</span></TD>
                <TD><Badge label={u.is_active?'Actif':'Inactif'} color={u.is_active?C.success:C.danger} /></TD>
                <TD style={{ fontSize:11, color:C.muted }}>{u.last_login_at?fmtDate(u.last_login_at):'Jamais'}</TD>
                <TD>{isSuperAdmin && u.email !== 'admin@c-pay.global' && (
                  <Btn small variant={u.is_active?'danger':'success'} onClick={() => toggleActive(u.admin_id, u.is_active)}>
                    {u.is_active?'Désactiver':'Activer'}
                  </Btn>
                )}</TD>
              </tr>
            ))} empty="Aucun utilisateur" />
        </Card>
      )}
    </div>
  );
};

// ─── FINANCE ──────────────────────────────────────────────────────
const Finance = () => {
  const [settlements, setSettlements] = useState([]);
  const [summary, setSummary] = useState({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [txns, setTxns] = useState([]);
  const [txnLoading, setTxnLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [refNote, setRefNote] = useState('');
  const STATUS_COLOR = { pending:'#ff9500', submitted:'#1565C0', completed:'#00c896', failed:'#ff3b30' };
  const STATUS_LABEL = { pending:'En attente', submitted:'Soumis', completed:'Verse', failed:'Echoue' };
  const fmt2 = n => parseFloat(n||0).toLocaleString('fr-FR');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/finance/settlements', { params: { status:filter||undefined, limit:50 } })
      .then(r => { setSettlements(r.data.data||[]); setSummary(r.data.summary||{}); setTotal(r.data.total||0); })
      .catch(()=>{}).finally(()=>setLoading(false));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const openDetail = async (s) => {
    setSelected(s); setTxns([]); setRefNote('');
    setTxnLoading(true);
    try {
      const r = await api.get('/settlements/'+s.batch_id+'/transactions');
      setTxns(r.data.transactions||[]);
    } catch { setTxns([]); } finally { setTxnLoading(false); }
  };

  const validate = async () => {
    if (!selected) return;
    setValidating(true);
    try {
      await api.patch('/finance/settlements/'+selected.batch_id+'/validate', { reference: refNote });
      toast.success('Reglement valide ✅');
      setSelected(null); load();
    } catch { toast.error('Erreur'); } finally { setValidating(false); }
  };

  const reject = async () => {
    if (!selected || !window.confirm('Rejeter ce reglement ?')) return;
    try {
      await api.patch('/finance/settlements/'+selected.batch_id+'/reject', { reason: refNote });
      toast.success('Reglement rejete');
      setSelected(null); load();
    } catch { toast.error('Erreur'); }
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>Reglements Merchants</h1>
        <Btn small onClick={() => window.open('/api/v1/admin/finance/settlements/export','_blank')}>Export CSV</Btn>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
        {[['Total',total,C.primary],['Volume brut',fmt2(summary.total_gross)+' XAF',C.blue],['Net',fmt2(summary.total_net)+' XAF',C.success],['En attente',settlements.filter(s=>s.status==='pending'||s.status==='submitted').length,C.warning]].map(([l,v,c])=>(
          <Card key={l} style={{ textAlign:'center', padding:14, borderTop:`3px solid ${c}` }}>
            <div style={{ fontSize:15, fontWeight:800, color:c }}>{v}</div>
            <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>{l}</div>
          </Card>
        ))}
      </div>
      <div style={{ display:'flex', gap:8, marginBottom:14 }}>
        {[['','Tous'],['pending','En attente'],['submitted','Soumis'],['completed','Verses'],['failed','Echoues']].map(([v,l])=>(
          <button key={v} onClick={()=>setFilter(v)}
            style={{ padding:'6px 14px', borderRadius:20, border:`1px solid ${filter===v?C.primary:C.border}`, background:filter===v?C.primary:C.card, color:filter===v?'#fff':C.muted, cursor:'pointer', fontSize:12 }}>
            {l}
          </button>
        ))}
      </div>
      {loading ? <Spin /> : (
        <Card>
          <Tbl heads={['Date','Merchant','Compte','Txns','Brut','Frais','Net','Statut','Actions']}
            rows={settlements.map(s => (
              <tr key={s.batch_id}>
                <TD style={{ fontSize:11, color:C.muted }}>{fmtDate(s.batch_date)}</TD>
                <TD style={{ fontWeight:600 }}>{s.business_name}</TD>
                <TD style={{ fontSize:11, color:C.muted }}>{s.settlement_account}</TD>
                <TD style={{ textAlign:'center' }}>{s.txn_count}</TD>
                <TD>{fmt2(s.total_gross)} XAF</TD>
                <TD style={{ color:C.danger }}>-{fmt2(s.total_fees)} XAF</TD>
                <TD style={{ fontWeight:700, color:C.success }}>{fmt2(s.total_net)} XAF</TD>
                <TD><Badge label={STATUS_LABEL[s.status]||s.status} color={STATUS_COLOR[s.status]||C.muted} /></TD>
                <TD>{(s.status==='pending'||s.status==='submitted') && <Btn small onClick={()=>openDetail(s)}>Traiter</Btn>}</TD>
              </tr>
            ))} empty="Aucun reglement" />
        </Card>
      )}
      {selected && (
        <Modal title={`Reglement — ${selected.business_name}`} onClose={()=>setSelected(null)}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:16 }}>
            {[['Brut',fmt2(selected.total_gross)+' XAF',C.primary],['Frais','-'+fmt2(selected.total_fees)+' XAF',C.danger],['Net',fmt2(selected.total_net)+' XAF',C.success]].map(([l,v,c])=>(
              <div key={l} style={{ background:C.bg, borderRadius:8, padding:12, textAlign:'center' }}>
                <div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>{l}</div>
                <div style={{ fontSize:15, fontWeight:800, color:c }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ background:`${C.primary}08`, borderRadius:8, padding:10, marginBottom:14, fontSize:12 }}>
            Compte: <strong>{selected.settlement_account}</strong> · {selected.txn_count} transactions
          </div>
          {txnLoading ? <Spin /> : txns.length === 0 ? (
            <div style={{ textAlign:'center', padding:16, color:C.muted }}>Aucune transaction</div>
          ) : (
            <div style={{ maxHeight:180, overflowY:'auto', marginBottom:14 }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr style={{ borderBottom:`2px solid ${C.border}`, color:C.muted }}>
                  {['Date','Type','Montant','Frais','Net'].map(h=><th key={h} style={{ padding:'5px 8px', textAlign:'left' }}>{h}</th>)}
                </tr></thead>
                <tbody>{txns.map(t=>(
                  <tr key={t.txn_id||t.transaction_id} style={{ borderBottom:`1px solid ${C.border}` }}>
                    <td style={{ padding:'5px 8px', color:C.muted }}>{fmtDate(t.initiated_at)}</td>
                    <td style={{ padding:'5px 8px' }}>{t.type}</td>
                    <td style={{ padding:'5px 8px', fontWeight:600 }}>{fmt2(t.amount)} XAF</td>
                    <td style={{ padding:'5px 8px', color:C.danger }}>{fmt2(t.fee_amount||0)} XAF</td>
                    <td style={{ padding:'5px 8px', color:C.success }}>{fmt2(t.net_amount||t.amount)} XAF</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {(selected.status==='pending'||selected.status==='submitted') && (
            <div>
              <Inp label="Reference / Note" value={refNote} onChange={setRefNote} placeholder="REF-VIREMENT-001" />
              <div style={{ display:'flex', gap:10 }}>
                <Btn onClick={validate} disabled={validating} color={C.success} style={{ flex:1 }}>{validating?'…':'Valider'}</Btn>
                <Btn onClick={reject} variant="danger" style={{ flex:1 }}>Rejeter</Btn>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
};

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-right" toastOptions={{ style: { background: C.card, color: C.text, border: `1px solid ${C.border}`, fontSize: 13 } }} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<Guard><Layout><Routes>
          <Route path="/"              element={<Dashboard />} />
          <Route path="/monitoring"    element={<Monitoring />} />
          <Route path="/alerts"        element={<Alerts />} />
          <Route path="/fraud"         element={<Fraud />} />
          <Route path="/merchants"     element={<Merchants />} />
          <Route path="/merchants/:id" element={<MerchantDetail />} />
          <Route path="/transactions"  element={<Transactions />} />
          <Route path="/users"         element={<Users />} />
          <Route path="/terminals"     element={<Terminals />} />
          <Route path="/cardholders"   element={<Cardholders />} />
          <Route path="/cardholders/:id" element={<CardholderDetail />} />
          <Route path="/banks"             element={<Banks />} />
          <Route path="/banks/:id"         element={<BankDetail />} />
          <Route path="/partners-agencies" element={<PartnersAgencies />} />
          <Route path="/tenants"           element={<Tenants />} />
          <Route path="/partners-agents"   element={<PartnersAgents />} />
          <Route path="/api-configs"   element={<ApiConfigs />} />
          <Route path="/tickets"       element={<SupportTickets />} />
          <Route path="/crm/leads"         element={<CrmLeads />} />
          <Route path="/crm/complaints"    element={<CrmComplaints />} />
          <Route path="/crm/conversations" element={<CrmConversations />} />
          <Route path="/finance"       element={<Finance />} />
          <Route path="/admin-users"   element={<AdminUsers />} />
          <Route path="/audit"         element={<AuditLogs />} />
          <Route path="*"              element={<Navigate to="/" replace />} />
        </Routes></Layout></Guard>} />
      </Routes>
    </BrowserRouter>
  );
}
