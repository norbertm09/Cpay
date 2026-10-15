import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';
import axios from 'axios';
import { BrowserRouter, Routes, Route, Link, useNavigate, Navigate, useLocation } from 'react-router-dom';
import { Toaster, toast } from 'react-hot-toast';

const BASE = process.env.REACT_APP_API_BASE_URL || '';
const api  = axios.create({ baseURL: `${BASE}/api/v1/partners` });
api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('pt_token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});
api.interceptors.response.use(r => r, e => {
  const st = e.response?.status;
  if (st === 401) {
    // Purge token ET utilisateur, sinon AuthProvider relit pt_user -> boucle /login -> / -> 401
    localStorage.removeItem('pt_token'); localStorage.removeItem('pt_user');
    if (window.location.pathname !== '/login') window.location = '/login';
  } else if (st === 403) {
    toast.error('Accès refusé');
  } else if (st === 410 || e.response?.data?.code === 'FEATURE_DISABLED') {
    toast.error('Fonctionnalité en cours d\u2019intégration'); // collect / disburse partenaires (hotfix v1)
  }
  return Promise.reject(e);
});

// Session valide uniquement si le JWT n'est pas expire (base64url -> base64).
const tokenValid = (t) => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b.padEnd(b.length + (4 - b.length % 4) % 4, '=')));
    return !!payload.exp && payload.exp * 1000 > Date.now();
  } catch { return false; }
};

const FONT = "Inter, 'Century Gothic', 'URW Gothic', Jost, system-ui, sans-serif";
const FONT_TITRE = "Jost, 'Century Gothic', 'URW Gothic', Questrial, system-ui, sans-serif";
const P='#12b6c7',BLUE='#1d4f92',G='#00c896',R='#ff3b30',O='#ff9500';
const BG='#f0f4f8',CARD='#fff',BORDER='#dce3ed',TEXT='#1e2d3d',MUTED='#5a6677';
const fmtNum = n => parseFloat(n||0).toLocaleString('fr-FR');
const fmtDate = d => d ? new Date(d).toLocaleString('fr-FR') : '—';

const AuthCtx   = createContext(null);
const TenantCtx = createContext(null);
const useAuth   = () => useContext(AuthCtx);
const useTenant = () => useContext(TenantCtx);

// ─── TENANT PROVIDER ─────────────────────────────────────────────
const TenantProvider = ({ children }) => {
  const [tenant, setTenant] = useState({
    display_name:    'C-Pay Partenaires',
    primary_color:   '#12b6c7',
    secondary_color: '#1d4f92',
    accent_color:    '#00c896',
    logo_url:        null,
    subdomain:       null,
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(()=>{
    api.get('/tenant/config')
      .then(r=>{ setTenant(r.data); setLoaded(true); })
      .catch(()=>setLoaded(true));
  }, []);

  // Appliquer les couleurs CSS dynamiques
  useEffect(()=>{
    document.documentElement.style.setProperty('--tenant-primary',   tenant.primary_color);
    document.documentElement.style.setProperty('--tenant-secondary', tenant.secondary_color);
    document.documentElement.style.setProperty('--tenant-accent',    tenant.accent_color);
    if (tenant.favicon_url) {
      const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
      link.rel = 'icon'; link.href = tenant.favicon_url;
      document.head.appendChild(link);
    }
    if (tenant.display_name) document.title = tenant.display_name + ' — Espace Partenaires';
  }, [tenant]);

  if (!loaded) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#f0f4f8' }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ width:40, height:40, border:'3px solid #dce3ed', borderTopColor:'#12b6c7', borderRadius:'50%', animation:'spin 1s linear infinite', margin:'0 auto 16px' }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <div style={{ color:'#5a6677', fontSize:13 }}>Chargement…</div>
      </div>
    </div>
  );

  return <TenantCtx.Provider value={tenant}>{children}</TenantCtx.Provider>;
};

const Spin = () => (
  <div style={{ display:'flex', justifyContent:'center', padding:40 }}>
    <div style={{ width:32, height:32, border:`3px solid ${BORDER}`, borderTopColor:P, borderRadius:'50%', animation:'spin 1s linear infinite' }} />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </div>
);

const Card = ({ children, style={} }) => (
  <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, padding:20, ...style }}>{children}</div>
);

const Btn = ({ children, onClick, disabled, color=P, outline=false, small=false, style={} }) => (
  <button onClick={onClick} disabled={disabled}
    style={{ background:outline?'transparent':color, color:outline?color:'#fff', border:`2px solid ${color}`,
      borderRadius:8, padding:small?'6px 12px':'10px 20px', fontSize:small?12:14, fontWeight:700,
      cursor:disabled?'not-allowed':'pointer', fontFamily:FONT, opacity:disabled?0.6:1, ...style }}>
    {children}
  </button>
);

const Badge = ({ label, color }) => (
  <span style={{ background:`${color}20`, color, borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>{label}</span>
);

const KpiCard = ({ icon, label, value, color=P, sub }) => (
  <Card>
    <div style={{ display:'flex', alignItems:'center', gap:12 }}>
      <div style={{ width:48, height:48, background:`${color}15`, borderRadius:12, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>{icon}</div>
      <div>
        <div style={{ fontSize:12, color:MUTED, marginBottom:2 }}>{label}</div>
        <div style={{ fontSize:22, fontWeight:800, color:TEXT }}>{value}</div>
        {sub && <div style={{ fontSize:11, color:MUTED }}>{sub}</div>}
      </div>
    </div>
  </Card>
);

const Modal = ({ title, onClose, children, width=480 }) => (
  <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
    <div style={{ background:CARD, borderRadius:16, padding:28, width, maxWidth:'100%' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>{title}</div>
        <button onClick={onClose} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:MUTED }}>×</button>
      </div>
      {children}
    </div>
  </div>
);

const _slugId = s => 'f-' + String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const Inp = ({ label, value, onChange, placeholder='', type='text', disabled=false, id, name, autoComplete, required, inputMode }) => {
  const _id = id || _slugId(label);
  return (
  <div style={{ marginBottom:14 }}>
    {label && <label htmlFor={_id} style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>{label}</label>}
    <input id={_id} name={name || _id} type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} disabled={disabled} autoComplete={autoComplete} required={required} inputMode={inputMode}
      style={{ width:'100%', background:disabled?BG:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box' }} />
  </div>
  );
};

const ROLE_CONFIG = {
  bank_admin:   { label:'Banque Admin',  color:BLUE, icon:'🏦' },
  bank_user:    { label:'Banque',        color:BLUE, icon:'🏦' },
  agency_admin: { label:'Agence Admin',  color:P,    icon:'🏢' },
  agency_user:  { label:'Agence',        color:P,    icon:'🏢' },
  agent:        { label:'Agent',         color:G,    icon:'👤' },
};

const getNav = (role) => [
  { p:'/',              l:'📊 Dashboard',      roles:['bank_admin','bank_user','agency_admin','agency_user','agent','caissier_maker','caissier_checker','controleur','financier','customer_care'] },
  { p:'/mes-agences',   l:'🏢 Mes Agences',    roles:['bank_admin','bank_user','agency_admin','agency_user'] },
  { p:'/collect',       l:'💳 Encaissement',   roles:['agent','caissier_maker'] },
  { p:'/disburse',      l:'💸 Décaissement',   roles:['agent','caissier_maker'] },
  { p:'/mes-transactions', l:'📋 Mes Transactions', roles:['bank_admin','bank_user','agency_admin','agency_user','agent','caissier_maker','caissier_checker','controleur','financier'] },
  { p:'/mes-utilisateurs', l:'👥 Mes Utilisateurs', roles:['bank_admin','agency_admin'] },
  { p:'/profile',       l:'👤 Mon Profil',     roles:['bank_admin','bank_user','agency_admin','agency_user','agent','caissier_maker','caissier_checker','controleur','financier','customer_care'] },
].filter(i => i.roles.includes(role));

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    try {
      const t = localStorage.getItem('pt_token');
      if (!t || !tokenValid(t)) { localStorage.removeItem('pt_token'); localStorage.removeItem('pt_user'); return null; }
      return JSON.parse(localStorage.getItem('pt_user'));
    } catch { return null; }
  });
  const login  = (token, u) => { localStorage.setItem('pt_token', token); localStorage.setItem('pt_user', JSON.stringify(u)); setUser(u); };
  const logout = () => { localStorage.removeItem('pt_token'); localStorage.removeItem('pt_user'); setUser(null); };
  return <AuthCtx.Provider value={{ user, login, logout }}>{children}</AuthCtx.Provider>;
};

const Guard = ({ children }) => { const { user } = useAuth(); return user ? children : <Navigate to="/login" />; };


// ─── CONSENT MODAL ────────────────────────────────────────────────
const ConsentModal = ({ userId, tenantName, onAccepted }) => {
  const [cgu, setCgu]         = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [saving, setSaving]   = useState(false);
  const accept = async () => {
    if (!cgu || !privacy) return toast.error('Acceptez les CGU et la politique de confidentialite');
    setSaving(true);
    try {
      await fetch((process.env.REACT_APP_API_BASE_URL||'') + '/api/v1/consent/accept', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ userId, userType:'partner', portal:'partners', cguAccepted:true, privacyAccepted:true })
      });
      onAccepted();
    } catch(e){ toast.error('Erreur'); }
    finally { setSaving(false); }
  };
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.85)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, padding:28, width:500, maxWidth:'100%', maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ textAlign:'center', marginBottom:20 }}>
          <div style={{ fontSize:40, marginBottom:8 }}>📋</div>
          <div style={{ fontSize:18, fontWeight:800, color:'#1d4f92' }}>Conditions d&apos;utilisation</div>
          {tenantName && <div style={{ fontSize:13, color:'#12b6c7', marginTop:4, fontWeight:600 }}>{tenantName}</div>}
        </div>
        <div style={{ background:'#f0f4f8', borderRadius:10, padding:14, marginBottom:12, fontSize:13, maxHeight:150, overflowY:'auto' }}>
          <strong style={{ color:'#1d4f92' }}>CGU — Calculus Plus SAS</strong>
          <ul style={{ marginTop:8, paddingLeft:16 }}>
            <li>Acces reserve aux partenaires agrees</li>
            <li>Usage strictement professionnel — transactions conformes CEMAC</li>
            <li>Confidentialite des credentials obligatoire</li>
          </ul>
          <a href="https://c-pay.global/legal/cgu.html" target="_blank" rel="noreferrer" style={{ color:'#12b6c7', fontSize:12 }}>Lire les CGU completes</a>
        </div>
        <div style={{ background:'#f0f4f8', borderRadius:10, padding:14, marginBottom:16, fontSize:13, maxHeight:120, overflowY:'auto' }}>
          <strong style={{ color:'#1d4f92' }}>Politique de Confidentialite</strong>
          <ul style={{ marginTop:8, paddingLeft:16 }}>
            <li>Donnees conservees 10 ans (obligations LCB-FT COBAC)</li>
            <li>Contact : legal@c-pay.global</li>
          </ul>
          <a href="https://c-pay.global/legal/confidentialite.html" target="_blank" rel="noreferrer" style={{ color:'#12b6c7', fontSize:12 }}>Lire la politique complete</a>
        </div>
        <label style={{ display:'flex', alignItems:'flex-start', gap:10, marginBottom:10, cursor:'pointer' }}>
          <input type="checkbox" checked={cgu} onChange={e=>setCgu(e.target.checked)} style={{ width:18, height:18, marginTop:2 }} />
          <span style={{ fontSize:13 }}>J&apos;accepte les CGU de C-Pay *</span>
        </label>
        <label style={{ display:'flex', alignItems:'flex-start', gap:10, marginBottom:16, cursor:'pointer' }}>
          <input type="checkbox" checked={privacy} onChange={e=>setPrivacy(e.target.checked)} style={{ width:18, height:18, marginTop:2 }} />
          <span style={{ fontSize:13 }}>J&apos;accepte la Politique de Confidentialite *</span>
        </label>
        <button onClick={accept} disabled={saving||!cgu||!privacy}
          style={{ width:'100%', background:cgu&&privacy?'#12b6c7':'#dce3ed', color:cgu&&privacy?'#fff':'#8a9ab0',
            border:'none', borderRadius:10, padding:'14px', fontSize:15, fontWeight:700, cursor:'pointer' }}>
          {saving?'Enregistrement...':'Accepter et continuer'}
        </button>
      </div>
    </div>
  );
};

const Login = () => {
  const tenant = useTenant();
  const { login } = useAuth();
  const navigate  = useNavigate();
  const [creds, setCreds]         = useState({ email:'', password:'' });
  const [loading, setLoading]     = useState(false);
  const [showPwd, setShowPwd]     = useState(false);
  const [view, setView]           = useState('login');
  const [resetStep, setResetStep] = useState('email');
  const [resetData, setResetData] = useState({ email:'', code:'', newPassword:'', confirm:'' });
  // Etapes supplementaires renvoyees par /auth/login :
  //   { mfaRequired:true, mfaToken } -> code TOTP via POST /auth/2fa/validate { mfaToken, code }
  //   { mustChangePassword:true }    -> changement de mot de passe force
  const [mfa, setMfa]           = useState(null);
  const [code, setCode]         = useState('');
  const [forcePwd, setForcePwd] = useState(null); // { token, user }
  const [pwd, setPwd]           = useState({ newPassword:'', confirm:'' });

  const finishLogin = (data) => {
    if (data.mfaRequired && data.mfaToken) { setMfa({ mfaToken: data.mfaToken }); setView('mfa'); return; }
    if (data.mustChangePassword) {
      // Token pose pour autoriser /auth/change-password, mais l'utilisateur n'est
      // "connecte" (AuthProvider) qu'une fois le mot de passe change.
      localStorage.setItem('pt_token', data.access_token);
      setForcePwd({ token: data.access_token, user: data.user }); setView('password'); return;
    }
    login(data.access_token, data.user); navigate('/');
  };

  const submit = async () => {
    if (!creds.email || !creds.password) return toast.error('Email et mot de passe requis');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', creds);
      finishLogin(data);
    }
    catch(err){ toast.error(err.response?.data?.error || 'Identifiants incorrects'); }
    finally { setLoading(false); }
  };

  const submitMfa = async () => {
    if (code.length !== 6) return toast.error('Code à 6 chiffres requis');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/2fa/validate', { mfaToken: mfa.mfaToken, code });
      finishLogin({ ...data, mfaRequired:false });
    }
    catch(err){ toast.error(err.response?.data?.error || 'Code invalide'); }
    finally { setLoading(false); }
  };

  const submitForcedPwd = async () => {
    if (pwd.newPassword.length < 8) return toast.error('8 caractères minimum');
    if (pwd.newPassword !== pwd.confirm) return toast.error('Mots de passe différents');
    setLoading(true);
    try {
      await api.post('/auth/change-password', { currentPassword: creds.password, newPassword: pwd.newPassword });
      toast.success('Mot de passe modifié ✅');
      login(forcePwd.token, forcePwd.user); navigate('/');
    }
    catch(err){ toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setLoading(false); }
  };


  const sendCode = async () => {
    if (!resetData.email) return toast.error('Email requis');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email: resetData.email });
      toast.success('Code envoyé par email ✅'); setResetStep('code');
    }
    catch(err){ toast.error(err.response?.data?.error || 'Email introuvable'); }
    finally { setLoading(false); }
  };

  const doReset = async () => {
    if (!resetData.code || !resetData.newPassword) return toast.error('Champs requis');
    if (resetData.newPassword !== resetData.confirm) return toast.error('Mots de passe différents');
    if (resetData.newPassword.length < 8) return toast.error('8 caractères minimum');
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { email: resetData.email, code: resetData.code, newPassword: resetData.newPassword });
      toast.success('Mot de passe réinitialisé ✅');
      setView('login'); setResetStep('email'); setResetData({ email:'', code:'', newPassword:'', confirm:'' });
    }
    catch(err){ toast.error(err.response?.data?.error || 'Code invalide ou expiré'); }
    finally { setLoading(false); }
  };

  const boxStyle = { width:'100%', background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box' };

  return (
    <div style={{ minHeight:'100vh', background:`linear-gradient(135deg, var(--tenant-secondary, ${BLUE}), var(--tenant-primary, ${P}))`, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:CARD, borderRadius:20, padding:36, width:420, maxWidth:'100%', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ textAlign:'center', marginBottom:24 }}>
          {tenant?.logo_url
            ? <img src={tenant.logo_url} alt={tenant.display_name} style={{ height:52, marginBottom:12, objectFit:'contain' }} />
            : <img src="/logo-calculus.svg" alt="Calculus Plus" style={{ height:48, marginBottom:12 }} />
          }
          <div style={{ fontSize:20, fontWeight:800, color:BLUE }}>
            {view==='forgot' ? '🔐 Réinitialisation' : view==='mfa' ? '🔐 Vérification en deux étapes' : view==='password' ? '🔐 Nouveau mot de passe requis' : (tenant?.display_name || 'C-Pay — Espace Partenaires')}
          </div>
        </div>

        {view==='mfa' && (
          <form onSubmit={e=>{ e.preventDefault(); if (!loading) submitMfa(); }}>
            <p style={{ fontSize:13, color:MUTED, marginBottom:16, textAlign:'center' }}>Saisissez le code à 6 chiffres de votre application d&apos;authentification.</p>
            <Inp label="Code à 6 chiffres" value={code} onChange={v=>setCode(String(v).replace(/[^0-9]/g,'').slice(0,6))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" required />
            <Btn disabled={loading || code.length!==6} style={{ width:'100%' }}>{loading?'Vérification…':'Valider'}</Btn>
            <button type="button" onClick={()=>{ setMfa(null); setCode(''); setView('login'); }}
              style={{ width:'100%', background:'none', border:'none', color:MUTED, cursor:'pointer', marginTop:12, fontSize:13, fontFamily:FONT }}>← Retour à la connexion</button>
          </form>
        )}

        {view==='password' && (
          <form onSubmit={e=>{ e.preventDefault(); if (!loading) submitForcedPwd(); }}>
            <p style={{ fontSize:13, color:MUTED, marginBottom:16, textAlign:'center' }}>Pour continuer, définissez un nouveau mot de passe (8 caractères minimum).</p>
            <Inp label="Nouveau mot de passe *" value={pwd.newPassword} onChange={v=>setPwd(p=>({...p,newPassword:v}))} type="password" placeholder="••••••••" autoComplete="new-password" required />
            <Inp label="Confirmer *" value={pwd.confirm} onChange={v=>setPwd(p=>({...p,confirm:v}))} type="password" placeholder="••••••••" autoComplete="new-password" required />
            <Btn disabled={loading} style={{ width:'100%' }}>{loading?'Enregistrement…':'🔐 Enregistrer'}</Btn>
          </form>
        )}

        {view==='login' && (<form onSubmit={e=>{ e.preventDefault(); if (!loading) submit(); }}>
          <Inp label="Email" value={creds.email} onChange={v=>setCreds(p=>({...p,email:v}))} type="email" placeholder="email@exemple.com" />
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>Mot de passe</label>
            <div style={{ position:'relative' }}>
              <input type={showPwd?'text':'password'} value={creds.password}
                onChange={e=>setCreds(p=>({...p,password:e.target.value}))}
                autoComplete="current-password" required
                placeholder="••••••••" style={{ ...boxStyle, paddingRight:42 }} />
              <button type="button" onClick={()=>setShowPwd(!showPwd)}
                style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:MUTED, padding:0, display:'flex', alignItems:'center' }}>
                {showPwd
                  ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                }
              </button>
            </div>
          </div>
          <Btn disabled={loading} style={{ width:'100%' }}>{loading?'Connexion…':'Se connecter'}</Btn>
          <div style={{ textAlign:'center', marginTop:12 }}>
            <button type="button" onClick={()=>setView('forgot')}
              style={{ background:'none', border:'none', color:P, cursor:'pointer', fontSize:13, fontFamily:FONT }}>
              Mot de passe oublié ?
            </button>
          </div>
        </form>)}



        {view==='forgot' && (<>
          {resetStep==='email' && (<>
            <p style={{ fontSize:13, color:MUTED, marginBottom:16, textAlign:'center' }}>
              Entrez votre email pour recevoir un code de réinitialisation.
            </p>
            <Inp label="Email *" value={resetData.email} onChange={v=>setResetData(p=>({...p,email:v}))} type="email" placeholder="email@banque.cg" />
            <Btn onClick={sendCode} disabled={loading} style={{ width:'100%' }}>
              {loading?'Envoi…':'📧 Envoyer le code'}
            </Btn>
          </>)}
          {resetStep==='code' && (<>
            <p style={{ fontSize:13, color:MUTED, marginBottom:16, textAlign:'center' }}>
              Code envoyé à <strong>{resetData.email}</strong>
            </p>
            <Inp label="Code reçu *" value={resetData.code} onChange={v=>setResetData(p=>({...p,code:v}))} placeholder="123456" />
            <Btn onClick={()=>setResetStep('password')} style={{ width:'100%' }}>Continuer →</Btn>
          </>)}
          {resetStep==='password' && (<>
            <div style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>Nouveau mot de passe *</label>
              <div style={{ position:'relative' }}>
                <input type={showPwd?'text':'password'} value={resetData.newPassword}
                  onChange={e=>setResetData(p=>({...p,newPassword:e.target.value}))}
                  placeholder="••••••••" style={{ ...boxStyle, paddingRight:42 }} />
                <button onClick={()=>setShowPwd(!showPwd)}
                  style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:MUTED, padding:0, display:'flex', alignItems:'center' }}>
                  {showPwd
                    ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              </div>
            </div>
            <Inp label="Confirmer *" value={resetData.confirm} onChange={v=>setResetData(p=>({...p,confirm:v}))} type="password" placeholder="••••••••" />
            <Btn onClick={doReset} disabled={loading} style={{ width:'100%' }}>
              {loading?'Réinitialisation…':'🔐 Réinitialiser'}
            </Btn>
          </>)}
          <button onClick={()=>{setView('login');setResetStep('email');}}
            style={{ width:'100%', background:'none', border:'none', color:MUTED, cursor:'pointer', marginTop:12, fontSize:13, fontFamily:FONT }}>
            ← Retour à la connexion
          </button>
        </>)}

        <div style={{ textAlign:'center', marginTop:20, fontSize:12, color:MUTED }}>
          Accès réservé aux partenaires C-Pay<br/>
          <a href="https://c-pay.global" style={{ color:P }}>← Retour à c-pay.global</a>
          <div style={{ marginTop:8, fontSize:11 }}>C-Pay est un produit de Calculus Plus SAS</div>
        </div>
      </div>
    </div>
  );
};

// ─── 2FA REMINDER ────────────────────────────────────────────────
const TwoFAReminder = () => {
  const navigate = useNavigate();
  const [status, setStatus]     = useState(null);
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem('2fa_dismissed') === '1'
  );

  useEffect(()=>{
    api.get('/auth/2fa/status').then(r=>setStatus(r.data)).catch(()=>{});
  }, []);

  if (!status || status.mfaEnabled || dismissed) return null;

  return (
    <div style={{
      background:'linear-gradient(135deg,#ff9500,#ff6b35)',
      borderRadius:12, padding:'14px 18px', marginBottom:20,
      display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
      boxShadow:'0 4px 12px rgba(255,149,0,0.3)'
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <div style={{ fontSize:28 }}>🔐</div>
        <div>
          <div style={{ color:'#fff', fontWeight:700, fontSize:14, marginBottom:2 }}>
            Sécurisez votre compte avec la double authentification (2FA)
          </div>
          <div style={{ color:'rgba(255,255,255,0.85)', fontSize:12 }}>
            Protégez votre accès avec Google Authenticator ou Authy.
          </div>
        </div>
      </div>
      <div style={{ display:'flex', gap:8, flexShrink:0 }}>
        <button onClick={()=>navigate('/profile?tab=security')}
          style={{ background:'#fff', color:'#ff9500', border:'none', borderRadius:8,
            padding:'8px 16px', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT }}>
          Activer →
        </button>
        <button onClick={()=>{ setDismissed(true); sessionStorage.setItem('2fa_dismissed','1'); }}
          style={{ background:'rgba(255,255,255,0.2)', border:'none', color:'#fff',
            borderRadius:8, padding:'8px 10px', cursor:'pointer', fontSize:16, lineHeight:1 }}>
          ×
        </button>
      </div>
    </div>
  );
};

const Layout = ({ children }) => {
  const tenant = useTenant();
  const { user, logout } = useAuth();
  const [showConsent, setShowConsent]       = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  useEffect(()=>{
    if (user?.id && !consentChecked) {
      fetch((process.env.REACT_APP_API_BASE_URL||'') + '/api/v1/consent/check?userId=' + user.id + '&userType=partner&portal=partners')
        .then(r=>r.json())
        .then(d=>{ if (!d.hasConsented) setShowConsent(true); setConsentChecked(true); })
        .catch(()=>setConsentChecked(true));
    }
  }, [user, consentChecked]);
  const navigate  = useNavigate();
  const location  = useLocation();
  const rc  = ROLE_CONFIG[user?.role] || {};
  const nav = getNav(user?.role || '');
  return (
    <div style={{ display:'flex', minHeight:'100vh', background:BG, fontFamily:FONT }}>
      <aside style={{ width:230, background:CARD, borderRight:`1px solid ${BORDER}`, display:'flex', flexDirection:'column', position:'fixed', top:0, bottom:0, left:0, zIndex:100, overflowY:'auto' }}>
        <div style={{ padding:'20px 16px', borderBottom:`1px solid ${BORDER}` }}>
          {tenant?.logo_url
            ? <img src={tenant.logo_url} alt={tenant.display_name} style={{ height:36, marginBottom:16, display:'block', objectFit:'contain', maxWidth:160 }} />
            : <img src="/logo-calculus.svg" alt="Calculus Plus" style={{ height:36, marginBottom:16, display:'block' }} />
          }
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ width:38, height:38, background:`${rc.color||P}20`, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>{rc.icon||'👤'}</div>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:TEXT }}>{user?.name}</div>
              <div style={{ fontSize:11, color:rc.color||P, fontWeight:600 }}>{rc.label}</div>
              {user?.bankName   && <div style={{ fontSize:10, color:MUTED }}>{user.bankName}</div>}
              {user?.agencyName && <div style={{ fontSize:10, color:MUTED }}>{user.agencyName}</div>}
            </div>
          </div>
        </div>
        <nav style={{ flex:1, padding:'12px 8px' }}>
          {nav.map(item => (
            <Link key={item.p} to={item.p} style={{ display:'flex', alignItems:'center', padding:'10px 12px', borderRadius:8, textDecoration:'none', marginBottom:4,
              background:location.pathname===item.p?`${rc.color||P}12`:'transparent',
              color:location.pathname===item.p?(rc.color||P):MUTED, fontWeight:location.pathname===item.p?700:400, fontSize:13 }}>
              {item.l}
            </Link>
          ))}
        </nav>
        {user?.role==='agent' && (
          <div style={{ padding:'12px 16px', borderTop:`1px solid ${BORDER}`, background:`${G}08` }}>
            <div style={{ fontSize:11, color:MUTED }}>Solde flottant</div>
            <div style={{ fontSize:18, fontWeight:800, color:G }}>{fmtNum(user.floatBalance)} XAF</div>
          </div>
        )}
        <div style={{ padding:'12px 16px', borderTop:`1px solid ${BORDER}` }}>
          <button onClick={()=>{ logout(); navigate('/login'); }}
            style={{ width:'100%', background:'none', border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px', color:MUTED, cursor:'pointer', fontSize:12, fontFamily:FONT }}>
            ⏻ Déconnexion
          </button>
          <div style={{ marginTop:12, paddingTop:10, borderTop:`1px solid ${BORDER}`, fontSize:10, color:MUTED, textAlign:'center' }}>
            <a href="https://c-pay.global/legal/cgu.html" target="_blank" rel="noreferrer" style={{ color:MUTED, display:'block', marginBottom:2 }}>CGU</a>
            <a href="https://c-pay.global/legal/confidentialite.html" target="_blank" rel="noreferrer" style={{ color:MUTED }}>Confidentialité</a>
          </div>
        </div>
      </aside>
      <main style={{ marginLeft:230, flex:1, padding:28 }}>
        {showConsent && <ConsentModal userId={user?.id} tenantName={tenant?.display_name} onAccepted={()=>setShowConsent(false)} />}
        <TwoFAReminder />
        {children}
      </main>
    </div>
  );
};

// ─── MINI BAR CHART ──────────────────────────────────────────────
const MiniBar = ({ data=[], color=P, height=60 }) => {
  const max = Math.max(...data.map(d=>d.value), 1);
  return (
    <div style={{ display:'flex', alignItems:'flex-end', gap:4, height, paddingTop:8 }}>
      {data.map((d,i) => (
        <div key={i} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
          <div style={{ width:'100%', borderRadius:4, position:'relative', height:height-20, background:`${color}15` }}>
            <div style={{ position:'absolute', bottom:0, width:'100%', background:color, borderRadius:4, height:`${(d.value/max)*100}%`, transition:'height .5s' }} />
          </div>
          <div style={{ fontSize:9, color:MUTED, whiteSpace:'nowrap' }}>{d.label}</div>
        </div>
      ))}
    </div>
  );
};

const Dashboard = () => {
  const { user } = useAuth();
  const [stats, setStats]           = useState(null);
  const [loading, setLoading]       = useState(true);
  const [filterAgency, setFilterAgency] = useState('');
  const [filterAgent, setFilterAgent]   = useState('');
  const [agencies, setAgencies]     = useState([]);
  const [agents, setAgents]         = useState([]);
  const [txnHistory, setTxnHistory] = useState([]);

  const loadStats = useCallback(() => {
    const params = {};
    if (filterAgency) params.agencyId = filterAgency;
    if (filterAgent)  params.agentId  = filterAgent;
    api.get('/dashboard', { params }).then(r=>setStats(r.data)).catch(()=>{}).finally(()=>setLoading(false));
  }, [filterAgency, filterAgent]);

  useEffect(() => { loadStats(); }, [loadStats]);

  useEffect(() => {
    if (['bank_admin','bank_user'].includes(user?.role)) {
      api.get('/agencies').then(r=>setAgencies(r.data.data||[])).catch(()=>{});
    }
    if (['bank_admin','bank_user','agency_admin','agency_user'].includes(user?.role)) {
      api.get('/agents').then(r=>setAgents(r.data.data||[])).catch(()=>{});
      api.get('/transactions', { params:{ limit:100 } }).then(r=>{
        const txns = r.data.data || [];
        const days = Array.from({length:7}, (_,i) => {
          const d = new Date(); d.setDate(d.getDate()-6+i);
          const label = d.toLocaleDateString('fr-FR',{weekday:'short'});
          const dateStr = d.toISOString().slice(0,10);
          const value = txns.filter(t=>t.initiated_at?.startsWith(dateStr)).reduce((s,t)=>s+parseFloat(t.amount||0),0);
          return { label, value };
        });
        setTxnHistory(days);
      }).catch(()=>{});
    }
  }, [user]);

  if (loading) return <Spin />;
  const rc = ROLE_CONFIG[user?.role] || {};

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20, flexWrap:'wrap', gap:12 }}>
        <div>
          <h1 style={{ margin:0, fontSize:24, fontWeight:800 }}>{rc.icon} Dashboard</h1>
          <div style={{ color:MUTED, fontSize:13, marginTop:4 }}>{new Date().toLocaleDateString('fr-FR',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div>
        </div>
        {['bank_admin','bank_user'].includes(user?.role) && (
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <select value={filterAgency} onChange={e=>{setFilterAgency(e.target.value);setFilterAgent('');}}
              style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:12, color:TEXT }}>
              <option value="">🏢 Toutes les agences</option>
              {agencies.map(a=><option key={a.agency_id} value={a.agency_id}>{a.agency_name}</option>)}
            </select>
            <select value={filterAgent} onChange={e=>setFilterAgent(e.target.value)}
              style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:12, color:TEXT }}>
              <option value="">👤 Tous les agents</option>
              {agents.filter(a=>!filterAgency||a.agency_id===filterAgency).map(a=>(
                <option key={a.agent_id} value={a.agent_id}>{a.first_name} {a.last_name}</option>
              ))}
            </select>
            {(filterAgency||filterAgent) && (
              <button onClick={()=>{setFilterAgency('');setFilterAgent('');}}
                style={{ background:`${R}10`, border:`1px solid ${R}30`, color:R, borderRadius:8, padding:'8px 12px', cursor:'pointer', fontSize:12 }}>
                ✕ Réinitialiser
              </button>
            )}
          </div>
        )}
        {['agency_admin','agency_user'].includes(user?.role) && agents.length>0 && (
          <select value={filterAgent} onChange={e=>setFilterAgent(e.target.value)}
            style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:12, color:TEXT }}>
            <option value="">👤 Tous les agents</option>
            {agents.map(a=><option key={a.agent_id} value={a.agent_id}>{a.first_name} {a.last_name}</option>)}
          </select>
        )}
      </div>

      {/* KPIs Bank */}
      {['bank_admin','bank_user'].includes(user?.role) && stats && (<>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:12, marginBottom:16 }}>
          <KpiCard icon="🏢" label="Agences" value={stats.agencies} color={BLUE} />
          <KpiCard icon="👤" label="Agents" value={stats.agents} color={P} />
          <KpiCard icon="💳" label="Txns aujourd'hui" value={fmtNum(stats.txnsToday)} color={G} />
          <KpiCard icon="💰" label="Volume aujourd'hui" value={fmtNum(stats.volumeToday)+' XAF'} color={O} />
          <KpiCard icon="📈" label="Volume 30 jours" value={fmtNum(stats.volumeMonth)+' XAF'} color={BLUE} />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:16, marginBottom:16 }}>
          <Card>
            <div style={{ fontSize:13, fontWeight:700, marginBottom:4 }}>📊 Volume 7 derniers jours (XAF)</div>
            <MiniBar data={txnHistory} color={P} height={90} />
          </Card>
          <Card>
            <div style={{ fontSize:13, fontWeight:700, marginBottom:12 }}>🥧 Opérations</div>
            {[['📥 Encaissements', 65, P],['📤 Décaissements', 35, O]].map(([l,v,c])=>(
              <div key={l} style={{ marginBottom:10 }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:3 }}>
                  <span style={{ color:MUTED }}>{l}</span><span style={{ color:c, fontWeight:700 }}>{v}%</span>
                </div>
                <div style={{ background:BG, borderRadius:20, height:8 }}>
                  <div style={{ width:`${v}%`, background:c, height:'100%', borderRadius:20 }} />
                </div>
              </div>
            ))}
          </Card>
        </div>
      </>)}

      {/* KPIs Agency */}
      {['agency_admin','agency_user'].includes(user?.role) && stats && (<>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:12, marginBottom:16 }}>
          <KpiCard icon="👤" label="Agents" value={stats.agents} color={P} />
          <KpiCard icon="💳" label="Txns aujourd'hui" value={fmtNum(stats.txnsToday)} color={G} />
          <KpiCard icon="💰" label="Volume aujourd'hui" value={fmtNum(stats.volumeToday)+' XAF'} color={O} />
          <KpiCard icon="🏦" label="Solde flottant" value={fmtNum(stats.floatBalance)+' XAF'} color={BLUE} />
        </div>
        <Card style={{ marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, marginBottom:4 }}>📊 Volume 7 derniers jours</div>
          <MiniBar data={txnHistory} color={P} height={80} />
        </Card>
      </>)}

      {/* Agent */}
      {user?.role==='agent' && stats && (<>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:12, marginBottom:16 }}>
          <KpiCard icon="🏦" label="Solde flottant" value={fmtNum(stats.floatBalance)+' XAF'} color={G} sub={`Limite: ${fmtNum(stats.floatLimit)} XAF`} />
          <KpiCard icon="📥" label="Encaissements" value={fmtNum(stats.collectToday)+' XAF'} color={P} />
          <KpiCard icon="📤" label="Décaissements" value={fmtNum(stats.disburseToday)+' XAF'} color={O} />
          <KpiCard icon="🔢" label="Transactions" value={stats.txnsToday} color={BLUE} />
        </div>
        <Card style={{ marginBottom:16 }}>
          <div style={{ fontSize:13, fontWeight:700, marginBottom:8 }}>Utilisation du solde flottant</div>
          <div style={{ background:BG, borderRadius:20, height:12, overflow:'hidden' }}>
            <div style={{ width:`${Math.min(100,(stats.floatBalance/Math.max(stats.floatLimit,1))*100)}%`, background:G, height:'100%', borderRadius:20 }} />
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:6, fontSize:12 }}>
            <span style={{ color:G, fontWeight:700 }}>{fmtNum(stats.floatBalance)} XAF</span>
            <span style={{ color:MUTED }}>Limite: {fmtNum(stats.floatLimit)} XAF</span>
          </div>
        </Card>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
          <Link to="/collect" style={{ textDecoration:'none' }}>
            <Card style={{ textAlign:'center', padding:28, cursor:'pointer', border:`2px solid ${P}` }}>
              <div style={{ fontSize:40, marginBottom:8 }}>💳</div>
              <div style={{ fontSize:16, fontWeight:700, color:P }}>Encaissement</div>
            </Card>
          </Link>
          <Link to="/disburse" style={{ textDecoration:'none' }}>
            <Card style={{ textAlign:'center', padding:28, cursor:'pointer', border:`2px solid ${O}` }}>
              <div style={{ fontSize:40, marginBottom:8 }}>💸</div>
              <div style={{ fontSize:16, fontWeight:700, color:O }}>Décaissement</div>
            </Card>
          </Link>
        </div>
      </>)}
    </div>
  );

};
const Agencies = () => {
  const [agencies, setAgencies] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [form, setForm] = useState({ agencyName:'', agencyCode:'', city:'', address:'', contactPhone:'', floatBalance:0 });
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => { api.get('/agencies').then(r=>setAgencies(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false)); }, []);
  useEffect(()=>{ load(); }, [load]);
  const create = async () => {
    if (!form.agencyName || !form.agencyCode) return toast.error('Nom et code requis');
    setSaving(true);
    try { await api.post('/agencies', form); toast.success('Agence créée ✅'); setShowNew(false); load(); setForm({ agencyName:'', agencyCode:'', city:'', address:'', contactPhone:'', floatBalance:0 }); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };
  const toggle = async (id, status) => {
    try { await api.patch(`/agencies/${id}/status`, { status: status==='active'?'suspended':'active' }); load(); }
    catch { toast.error('Erreur'); }
  };
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:800 }}>🏢 Agences</h1>
        <Btn onClick={()=>setShowNew(true)}>+ Nouvelle agence</Btn>
      </div>
      {showNew && (
        <Modal title="➕ Créer une agence" onClose={()=>setShowNew(false)}>
          <Inp label="Nom *" value={form.agencyName} onChange={v=>setForm(p=>({...p,agencyName:v}))} placeholder="Agence Brazzaville Centre" />
          <Inp label="Code *" value={form.agencyCode} onChange={v=>setForm(p=>({...p,agencyCode:v.toUpperCase()}))} placeholder="AGC-BZV-001" />
          <Inp label="Ville" value={form.city} onChange={v=>setForm(p=>({...p,city:v}))} placeholder="Brazzaville" />
          <Inp label="Adresse" value={form.address} onChange={v=>setForm(p=>({...p,address:v}))} placeholder="Avenue de l'Indépendance" />
          <Inp label="Téléphone" value={form.contactPhone} onChange={v=>setForm(p=>({...p,contactPhone:v}))} placeholder="+242060000001" />
          <Inp label="Float initial (XAF)" value={form.floatBalance} onChange={v=>setForm(p=>({...p,floatBalance:parseFloat(v)||0}))} type="number" />
          <div style={{ display:'flex', gap:10, marginTop:8 }}>
            <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Création…':'✅ Créer'}</Btn>
            <Btn outline onClick={()=>setShowNew(false)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Modal>
      )}
      {loading ? <Spin /> : agencies.length===0 ? (
        <Card style={{ textAlign:'center', padding:40 }}><div style={{ fontSize:48 }}>🏢</div><div style={{ color:MUTED }}>Aucune agence</div></Card>
      ) : (
        <div style={{ display:'grid', gap:12 }}>
          {agencies.map(a => (
            <Card key={a.agency_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                    <div style={{ fontSize:15, fontWeight:700 }}>🏢 {a.agency_name}</div>
                    <Badge label={a.status==='active'?'✅ Active':'⛔ Suspendue'} color={a.status==='active'?G:R} />
                  </div>
                  <div style={{ display:'flex', gap:16, fontSize:13, color:MUTED, flexWrap:'wrap' }}>
                    <span>Code: <strong>{a.agency_code}</strong></span>
                    <span>📍 {a.city||'—'}</span>
                    <span>👤 {a.agent_count||0} agents</span>
                    <span>💰 <strong style={{ color:G }}>{fmtNum(a.float_balance)} XAF</strong></span>
                  </div>
                </div>
                <Btn small outline color={a.status==='active'?R:G} onClick={()=>toggle(a.agency_id, a.status)}>
                  {a.status==='active'?'Suspendre':'Activer'}
                </Btn>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

const Agents = () => {
  const { user } = useAuth();
  const [agents, setAgents]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showFloat, setShowFloat] = useState(null);
  const [form, setForm] = useState({ firstName:'', lastName:'', email:'', phone:'', floatLimit:500000 });
  const [floatForm, setFloatForm] = useState({ amount:0, type:'float_in' });
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => { api.get('/agents').then(r=>setAgents(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false)); }, []);
  useEffect(()=>{ load(); }, [load]);
  const create = async () => {
    if (!form.firstName || !form.email) return toast.error('Prénom et email requis');
    setSaving(true);
    try {
      const r = await api.post('/agents', form);
      toast.success(`Agent créé ✅ — MDP temp: ${r.data.tempPassword}`);
      setShowNew(false); load();
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };
  const toggle = async (id, status) => {
    try { await api.patch(`/agents/${id}/status`, { status: status==='active'?'suspended':'active' }); load(); }
    catch { toast.error('Erreur'); }
  };
  const updateFloat = async () => {
    if (!floatForm.amount || floatForm.amount <= 0) return toast.error('Montant invalide');
    try { await api.patch(`/agents/${showFloat.agent_id}/float`, floatForm); toast.success('Flottant mis à jour ✅'); setShowFloat(null); load(); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
  };
  const canManage = ['bank_admin','agency_admin'].includes(user?.role);
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:800 }}>👤 Agents</h1>
        {canManage && <Btn onClick={()=>setShowNew(true)}>+ Nouvel agent</Btn>}
      </div>
      {showNew && (
        <Modal title="➕ Créer un agent" onClose={()=>setShowNew(false)}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <Inp label="Prénom *" value={form.firstName} onChange={v=>setForm(p=>({...p,firstName:v}))} placeholder="Jean" />
            <Inp label="Nom" value={form.lastName} onChange={v=>setForm(p=>({...p,lastName:v}))} placeholder="Agent" />
          </div>
          <Inp label="Email *" value={form.email} onChange={v=>setForm(p=>({...p,email:v}))} type="email" placeholder="agent@exemple.com" />
          <Inp label="Téléphone" value={form.phone} onChange={v=>setForm(p=>({...p,phone:v}))} placeholder="+242060000001" />
          <Inp label="Limite flottant (XAF)" value={form.floatLimit} onChange={v=>setForm(p=>({...p,floatLimit:parseFloat(v)||0}))} type="number" />
          <div style={{ background:`${O}10`, border:`1px solid ${O}30`, borderRadius:8, padding:10, marginBottom:10, fontSize:12, color:MUTED }}>
            ⚠️ Mot de passe temporaire généré automatiquement — affiché une seule fois.
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Création…':'✅ Créer'}</Btn>
            <Btn outline onClick={()=>setShowNew(false)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Modal>
      )}
      {showFloat && (
        <Modal title={`💰 Flottant — ${showFloat.first_name} ${showFloat.last_name}`} onClose={()=>setShowFloat(null)}>
          <div style={{ marginBottom:14 }}>
            {[['Solde actuel', fmtNum(showFloat.float_balance)+' XAF', G], ['Limite', fmtNum(showFloat.float_limit)+' XAF', MUTED]].map(([k,v,c])=>(
              <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:`1px solid ${BORDER}`, fontSize:13 }}>
                <span style={{ color:MUTED }}>{k}</span><strong style={{ color:c }}>{v}</strong>
              </div>
            ))}
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>Opération</label>
            <select value={floatForm.type} onChange={e=>setFloatForm(p=>({...p,type:e.target.value}))}
              style={{ width:'100%', background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14 }}>
              <option value="float_in">📥 Approvisionner</option>
              <option value="float_out">📤 Retirer</option>
            </select>
          </div>
          <Inp label="Montant (XAF)" value={floatForm.amount} onChange={v=>setFloatForm(p=>({...p,amount:parseFloat(v)||0}))} type="number" placeholder="50000" />
          <div style={{ display:'flex', gap:10 }}>
            <Btn onClick={updateFloat} color={floatForm.type==='float_in'?G:O} style={{ flex:1 }}>✅ Confirmer</Btn>
            <Btn outline onClick={()=>setShowFloat(null)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Modal>
      )}
      {loading ? <Spin /> : agents.length===0 ? (
        <Card style={{ textAlign:'center', padding:40 }}><div style={{ fontSize:48 }}>👤</div><div style={{ color:MUTED }}>Aucun agent</div></Card>
      ) : (
        <div style={{ display:'grid', gap:12 }}>
          {agents.map(a => (
            <Card key={a.agent_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                    <div style={{ fontSize:15, fontWeight:700 }}>👤 {a.first_name} {a.last_name}</div>
                    <Badge label={a.status==='active'?'✅ Actif':'⛔ Suspendu'} color={a.status==='active'?G:R} />
                  </div>
                  <div style={{ display:'flex', gap:16, fontSize:13, color:MUTED, flexWrap:'wrap' }}>
                    <span>{a.email}</span>
                    <span>🏢 {a.agency_name}</span>
                    <span>💰 <strong style={{ color:G }}>{fmtNum(a.float_balance)} XAF</strong> / {fmtNum(a.float_limit)} XAF</span>
                  </div>
                </div>
                {canManage && (
                  <div style={{ display:'flex', gap:8 }}>
                    <Btn small onClick={()=>setShowFloat(a)} color={G}>💰 Float</Btn>
                    <Btn small outline color={a.status==='active'?R:G} onClick={()=>toggle(a.agent_id, a.status)}>
                      {a.status==='active'?'Suspendre':'Activer'}
                    </Btn>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

const Collect = () => {
  const { user } = useAuth();
  const [form, setForm]       = useState({ amount:'', customerPhone:'', method:'airtel_money', description:'' });
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const submit = async () => {
    if (!form.amount || !form.customerPhone) return toast.error('Montant et téléphone requis');
    setLoading(true);
    try {
      const endpoint = ['caissier_maker'].includes(user?.role) ? '/approvals' : '/collect';
      const payload  = { ...form, amount: parseFloat(form.amount), type:'collect' };
      const r = await api.post(endpoint, payload);
      setResult(r.data);
      if (r.data.status==='pending_approval') toast.success('Demande soumise au Checker ⏳');
      else toast.success('Encaissement effectué ✅');
      setForm({ amount:'', customerPhone:'', method:'airtel_money', description:'' });
    }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setLoading(false); }
  };
  const fee = Math.round(parseFloat(form.amount||0)*0.015);
  const net = Math.round(parseFloat(form.amount||0)*0.985);
  return (
    <div style={{ maxWidth:500 }}>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:800 }}>💳 Encaissement</h1>
      {result && (
        <div style={{ background:`${G}10`, border:`1px solid ${G}30`, borderRadius:12, padding:20, marginBottom:20 }}>
          <div style={{ fontSize:16, fontWeight:700, color:result.status==='pending_approval'?O:G, marginBottom:10 }}>
        {result.status==='pending_approval'?'⏳ En attente d&apos;approbation':'✅ Encaissement réussi'}
      </div>
      {result.status==='pending_approval' && <div style={{ fontSize:12, color:MUTED, marginBottom:8 }}>
        Référence: {result.reference} — Un Checker doit valider cette transaction.
      </div>}
          {[['Référence', result.reference],['Montant', fmtNum(result.amount)+' XAF'],['Frais (1.5%)', fmtNum(result.fee)+' XAF'],['Net reçu', fmtNum(result.net)+' XAF']].map(([k,v])=>(
            <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13 }}>
              <span style={{ color:MUTED }}>{k}</span><strong>{v}</strong>
            </div>
          ))}
          <button onClick={()=>setResult(null)} style={{ marginTop:12, background:'none', border:`1px solid ${BORDER}`, borderRadius:6, padding:'6px 14px', cursor:'pointer', fontSize:13 }}>Nouvelle transaction</button>
        </div>
      )}
      <Card>
        <Inp label="Montant (XAF) *" value={form.amount} onChange={v=>setForm(p=>({...p,amount:v}))} type="number" placeholder="5000" />
        <Inp label="Téléphone client *" value={form.customerPhone} onChange={v=>setForm(p=>({...p,customerPhone:v}))} placeholder="+242060000001" />
        <div style={{ marginBottom:14 }}>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>Opérateur *</label>
          <select value={form.method} onChange={e=>setForm(p=>({...p,method:e.target.value}))}
            style={{ width:'100%', background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14 }}>
            <option value="airtel_money">📱 Airtel Money</option>
            <option value="mtn_momo">📱 MTN MoMo</option>
          </select>
        </div>
        <Inp label="Description" value={form.description} onChange={v=>setForm(p=>({...p,description:v}))} placeholder="Paiement facture #001" />
        {form.amount > 0 && (
          <div style={{ background:`${P}08`, borderRadius:8, padding:12, marginBottom:14, fontSize:13 }}>
            {[['Montant', fmtNum(form.amount)+' XAF'],['Frais (1.5%)', fmtNum(fee)+' XAF'],['Net reçu', fmtNum(net)+' XAF']].map(([k,v],i)=>(
              <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderTop:i===2?`1px solid ${BORDER}`:'none', fontWeight:i===2?700:400 }}>
                <span style={{ color:MUTED }}>{k}</span><span style={{ color:i===2?G:TEXT }}>{v}</span>
              </div>
            ))}
          </div>
        )}
        <Btn onClick={submit} disabled={loading} style={{ width:'100%' }}>{loading?'Traitement…':'💳 Encaisser'}</Btn>
      </Card>
    </div>
  );
};

const Disburse = () => {
  const { user } = useAuth();
  const [form, setForm]       = useState({ amount:'', recipientPhone:'', method:'airtel_money', description:'' });
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const submit = async () => {
    if (!form.amount || !form.recipientPhone) return toast.error('Montant et téléphone requis');
    setLoading(true);
    try {
      const endpoint = ['caissier_maker'].includes(user?.role) ? '/approvals' : '/disburse';
      const payload  = { ...form, amount: parseFloat(form.amount), type:'disburse', customerPhone: form.recipientPhone };
      const r = await api.post(endpoint, payload);
      setResult(r.data);
      if (r.data.status==='pending_approval') toast.success('Demande soumise au Checker ⏳');
      else toast.success('Décaissement effectué ✅');
      setForm({ amount:'', recipientPhone:'', method:'airtel_money', description:'' });
    }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setLoading(false); }
  };
  return (
    <div style={{ maxWidth:500 }}>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:800 }}>💸 Décaissement</h1>
      {result && (
        <div style={{ background:`${O}10`, border:`1px solid ${O}30`, borderRadius:12, padding:20, marginBottom:20 }}>
          <div style={{ fontSize:16, fontWeight:700, color:O, marginBottom:10 }}>✅ Décaissement réussi</div>
          {[['Référence', result.reference],['Montant', fmtNum(result.amount)+' XAF'],['Frais (1%)', fmtNum(result.fee)+' XAF']].map(([k,v])=>(
            <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13 }}>
              <span style={{ color:MUTED }}>{k}</span><strong>{v}</strong>
            </div>
          ))}
          <button onClick={()=>setResult(null)} style={{ marginTop:12, background:'none', border:`1px solid ${BORDER}`, borderRadius:6, padding:'6px 14px', cursor:'pointer', fontSize:13 }}>Nouvelle transaction</button>
        </div>
      )}
      <Card>
        <Inp label="Montant (XAF) *" value={form.amount} onChange={v=>setForm(p=>({...p,amount:v}))} type="number" placeholder="10000" />
        <Inp label="Téléphone bénéficiaire *" value={form.recipientPhone} onChange={v=>setForm(p=>({...p,recipientPhone:v}))} placeholder="+242060000001" />
        <div style={{ marginBottom:14 }}>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>Opérateur *</label>
          <select value={form.method} onChange={e=>setForm(p=>({...p,method:e.target.value}))}
            style={{ width:'100%', background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14 }}>
            <option value="airtel_money">📱 Airtel Money</option>
            <option value="mtn_momo">📱 MTN MoMo</option>
          </select>
        </div>
        <Inp label="Description" value={form.description} onChange={v=>setForm(p=>({...p,description:v}))} placeholder="Remboursement commande #42" />
        <Btn onClick={submit} disabled={loading} color={O} style={{ width:'100%' }}>{loading?'Traitement…':'💸 Décaisser'}</Btn>
      </Card>
    </div>
  );
};

const Transactions = () => {
  const [txns, setTxns]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [volume, setVolume]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage]       = useState(1);
  const [filters, setFilters] = useState({ status:'', type:'' });
  const [agencies, setAgencies] = useState([]);
  const [agents, setAgents]     = useState([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');
  const [filterAgency, setFilterAgency] = useState('');
  const [filterAgent, setFilterAgent]   = useState('');

  useEffect(()=>{
    api.get('/agencies').then(r=>setAgencies(r.data.data||[])).catch(()=>{});
    api.get('/agents').then(r=>setAgents(r.data.data||[])).catch(()=>{});
  }, []);

  const exportCSV = () => {
    if (!txns.length) return toast.error('Aucune transaction à exporter');
    const headers = ['Date','Référence','Agent','Type','Montant','Frais','Statut'];
    const rows = txns.map(t=>[
      fmtDate(t.initiated_at), t.reference||'', t.agent_name,
      t.type, t.amount, t.fee_amount, t.status
    ]);
    const csv = [headers, ...rows].map(r=>r.join(';')).join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `transactions_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const exportPDF = () => {
    if (!txns.length) return toast.error('Aucune transaction à exporter');
    const rows = txns.map(t=>[
      fmtDate(t.initiated_at), t.reference||'—', t.agent_name,
      t.type, fmtNum(t.amount)+' XAF', fmtNum(t.fee_amount)+' XAF', t.status
    ]);
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>body{font-family:Arial,sans-serif;padding:20px}h1{color:#1d4f92}
    table{width:100%;border-collapse:collapse;font-size:11px}
    th{background:#1d4f92;color:#fff;padding:7px;text-align:left}
    td{padding:6px 7px;border-bottom:1px solid #dce3ed}
    .total{margin-top:12px;font-weight:700;color:#1d4f92}</style></head>
    <body><h1>Rapport Transactions</h1>
    <p style="color:#5a6677">Généré le ${new Date().toLocaleDateString('fr-FR')} · Total: ${total} transactions · Volume: ${fmtNum(volume)} XAF</p>
    <table><thead><tr><th>Date</th><th>Référence</th><th>Agent</th><th>Type</th><th>Montant</th><th>Frais</th><th>Statut</th></tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <div class="total">Volume total: ${fmtNum(volume)} XAF</div>
    <footer style="margin-top:20px;font-size:10px;color:#8a9ab0">C-Pay Partners 2.6.0</footer>
    </body></html>`;
    const win = window.open('','_blank');
    win.document.write(html); win.document.close();
    win.onload = () => win.print();
  };

  const load = useCallback(() => {
    setLoading(true);
    const params = { page, limit:20 };
    if (filters.status)  params.status   = filters.status;
    if (filters.type)    params.type     = filters.type;
    if (filterAgency)    params.agencyId = filterAgency;
    if (filterAgent)     params.agentId  = filterAgent;
    if (dateFrom)        params.dateFrom = dateFrom;
    if (dateTo)          params.dateTo   = dateTo;
    api.get('/transactions', { params }).then(r=>{ setTxns(r.data.data||[]); setTotal(r.data.total||0); setVolume(r.data.volume||0); }).catch(()=>{}).finally(()=>setLoading(false));
  }, [page, filters, filterAgency, filterAgent, dateFrom, dateTo]);
  useEffect(()=>{ load(); }, [load]);
  const SC = { completed:G, pending:O, failed:R };
  const TC = { collect:P, disburse:O, float_in:G, float_out:R };
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:800 }}>📋 Transactions</h1>
        <div style={{ fontSize:13, color:MUTED }}>{total} · Volume: {fmtNum(volume)} XAF</div>
      </div>
      <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap' }}>
        {[['','Tous'],['completed','Complétés'],['pending','En attente'],['failed','Échoués']].map(([v,l])=>(
          <button key={v} onClick={()=>{setFilters(p=>({...p,status:v}));setPage(1);}}
            style={{ padding:'7px 14px', borderRadius:20, border:`2px solid ${filters.status===v?G:BORDER}`, background:filters.status===v?`${G}12`:CARD, color:filters.status===v?G:MUTED, cursor:'pointer', fontSize:12, fontWeight:filters.status===v?700:400, fontFamily:FONT }}>
            {l}
          </button>
        ))}
        <select value={filters.type} onChange={e=>{setFilters(p=>({...p,type:e.target.value}));setPage(1);}}
          style={{ padding:'7px 12px', borderRadius:20, border:`2px solid ${BORDER}`, background:CARD, fontSize:12, fontFamily:FONT }}>
          <option value="">Tous types</option>
          <option value="collect">Encaissement</option>
          <option value="disburse">Décaissement</option>
        </select>
      </div>
      <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap' }}>
        {agencies.length>0 && (
          <select value={filterAgency} onChange={e=>{setFilterAgency(e.target.value);setFilterAgent('');setPage(1);}}
            style={{ padding:'7px 12px', borderRadius:8, border:`1px solid ${BORDER}`, background:CARD, fontSize:12, fontFamily:FONT }}>
            <option value="">🏢 Toutes les agences</option>
            {agencies.map(a=><option key={a.agency_id} value={a.agency_id}>{a.agency_name}</option>)}
          </select>
        )}
        {agents.length>0 && (
          <select value={filterAgent} onChange={e=>{setFilterAgent(e.target.value);setPage(1);}}
            style={{ padding:'7px 12px', borderRadius:8, border:`1px solid ${BORDER}`, background:CARD, fontSize:12, fontFamily:FONT }}>
            <option value="">👤 Tous les agents</option>
            {agents.filter(a=>!filterAgency||a.agency_id===filterAgency).map(a=>(
              <option key={a.agent_id} value={a.agent_id}>{a.first_name} {a.last_name}</option>
            ))}
          </select>
        )}
        <input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setPage(1);}}
          style={{ padding:'7px 10px', borderRadius:8, border:`1px solid ${BORDER}`, background:CARD, fontSize:12, fontFamily:FONT }} />
        <input type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setPage(1);}}
          style={{ padding:'7px 10px', borderRadius:8, border:`1px solid ${BORDER}`, background:CARD, fontSize:12, fontFamily:FONT }} />
        {(filterAgency||filterAgent||dateFrom||dateTo) && (
          <button onClick={()=>{setFilterAgency('');setFilterAgent('');setDateFrom('');setDateTo('');setPage(1);}}
            style={{ padding:'7px 12px', borderRadius:8, border:`1px solid ${R}`, background:`${R}10`, color:R, cursor:'pointer', fontSize:12 }}>
            ✕ Réinitialiser
          </button>
        )}
      </div>
      {loading ? <Spin /> : (
        <Card style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13, minWidth:650 }}>
            <thead>
              <tr style={{ borderBottom:`2px solid ${BORDER}`, color:MUTED }}>
                {['Date','Référence','Agent','Type','Montant','Frais','Statut'].map(h=>(
                  <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontWeight:600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {txns.length===0 ? <tr><td colSpan={7} style={{ textAlign:'center', padding:32, color:MUTED }}>Aucune transaction</td></tr>
              : txns.map(t=>(
                <tr key={t.txn_id} style={{ borderBottom:`1px solid ${BORDER}` }}>
                  <td style={{ padding:'10px 12px', color:MUTED, whiteSpace:'nowrap' }}>{fmtDate(t.initiated_at)}</td>
                  <td style={{ padding:'10px 12px', fontFamily:'monospace', fontSize:11 }}>{t.reference||'—'}</td>
                  <td style={{ padding:'10px 12px', fontWeight:600 }}>{t.agent_name}</td>
                  <td style={{ padding:'10px 12px' }}><Badge label={t.type} color={TC[t.type]||MUTED} /></td>
                  <td style={{ padding:'10px 12px', fontWeight:700 }}>{fmtNum(t.amount)} XAF</td>
                  <td style={{ padding:'10px 12px', color:MUTED }}>{fmtNum(t.fee_amount)} XAF</td>
                  <td style={{ padding:'10px 12px' }}><Badge label={t.status} color={SC[t.status]||MUTED} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > 20 && (
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12 }}>
              <Btn small outline onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1}>◀</Btn>
              <span style={{ padding:'6px 12px', fontSize:13, color:MUTED }}>Page {page} / {Math.ceil(total/20)}</span>
              <Btn small outline onClick={()=>setPage(p=>p+1)} disabled={page>=Math.ceil(total/20)}>▶</Btn>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

const Profile = () => {
  const { user } = useAuth();
  const [profile, setProfile] = useState(null);
  const _urlTab = new URLSearchParams(window.location.search).get('tab');
  const [tab, setTab]         = useState(_urlTab || 'info');
  const [pwdForm, setPwdForm] = useState({ current:'', newPwd:'', confirm:'' });
  const [showPwd, setShowPwd] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [mfaStatus, setMfaStatus] = useState(null);
  const [mfaSetup, setMfaSetup]   = useState(null);
  const [mfaCode, setMfaCode]     = useState('');

  useEffect(()=>{ api.get('/profile').then(r=>setProfile(r.data)).catch(()=>{}); }, []);
  useEffect(()=>{
    if (tab==='security') api.get('/auth/2fa/status').then(r=>setMfaStatus(r.data)).catch(()=>{});
  }, [tab]);

  const changePassword = async () => {
    if (!pwdForm.current || !pwdForm.newPwd) return toast.error('Champs requis');
    if (pwdForm.newPwd !== pwdForm.confirm) return toast.error('Mots de passe différents');
    if (pwdForm.newPwd.length < 8) return toast.error('8 caractères minimum');
    setSaving(true);
    try {
      await api.post('/auth/change-password', { currentPassword: pwdForm.current, newPassword: pwdForm.newPwd });
      toast.success('Mot de passe modifié ✅');
      setPwdForm({ current:'', newPwd:'', confirm:'' });
    } catch(err){ toast.error(err.response?.data?.error||'Mot de passe actuel incorrect'); }
    finally { setSaving(false); }
  };

  const setup2FA = async () => {
    try {
      const r = await api.post('/auth/2fa/setup');
      setMfaSetup(r.data);
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
  };

  const verify2FA = async () => {
    if (mfaCode.length !== 6) return toast.error('Code 6 chiffres requis');
    try {
      await api.post('/auth/2fa/verify', { token: mfaCode, secret: mfaSetup.secret });
      toast.success('2FA activée ✅'); setMfaSetup(null); setMfaCode('');
      const r = await api.get('/auth/2fa/status'); setMfaStatus(r.data);
    } catch(err){ toast.error(err.response?.data?.error||'Code invalide'); }
  };

  const disable2FA = async () => {
    if (!mfaCode || mfaCode.length !== 6) return toast.error('Code 6 chiffres requis');
    try {
      await api.post('/auth/2fa/disable', { token: mfaCode });
      toast.success('2FA désactivée'); setMfaCode('');
      const r = await api.get('/auth/2fa/status'); setMfaStatus(r.data);
    } catch(err){ toast.error(err.response?.data?.error||'Code invalide'); }
  };

  if (!profile) return <Spin />;
  const rc = ROLE_CONFIG[user?.role] || {};
  const eyeBtn = (show, toggle) => (
    <button onClick={toggle} style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:MUTED, padding:0 }}>
      {show
        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      }
    </button>
  );

  return (
    <div style={{ maxWidth:600 }}>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:800 }}>👤 Mon Profil</h1>

      {/* Header */}
      <Card style={{ marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <div style={{ width:56, height:56, background:`${rc.color||P}20`, borderRadius:14, display:'flex', alignItems:'center', justifyContent:'center', fontSize:28 }}>{rc.icon}</div>
          <div>
            <div style={{ fontSize:18, fontWeight:800 }}>{profile.first_name} {profile.last_name}</div>
            <div style={{ color:rc.color||P, fontWeight:700, fontSize:12 }}>{rc.label}</div>
            <div style={{ color:MUTED, fontSize:11 }}>{profile.bank_name}{profile.agency_name?` · ${profile.agency_name}`:''}</div>
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, marginBottom:16, borderBottom:`2px solid ${BORDER}` }}>
        {[['info','📋 Infos'],['password','🔑 Mot de passe'],['security','🔐 Sécurité 2FA']].map(([v,l])=>(
          <button key={v} onClick={()=>setTab(v)}
            style={{ padding:'10px 18px', border:'none', background:'none', fontSize:13, fontWeight:700, cursor:'pointer',
              color:tab===v?P:MUTED, borderBottom:`3px solid ${tab===v?P:'transparent'}`, marginBottom:-2 }}>
            {l}
          </button>
        ))}
      </div>

      {/* Infos */}
      {tab==='info' && (
        <Card>
          {[['Email', profile.email],['Téléphone', profile.phone||'—'],['Banque', profile.bank_name||'—'],
            ['Agence', profile.agency_name||'—'],['Statut', profile.status],
            profile.float_balance!==undefined?['Solde flottant', fmtNum(profile.float_balance)+' XAF']:null,
            profile.float_limit!==undefined?['Limite flottant', fmtNum(profile.float_limit)+' XAF']:null,
            ['Membre depuis', fmtDate(profile.created_at)]
          ].filter(Boolean).map(([k,v])=>(
            <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:`1px solid ${BORDER}`, fontSize:13 }}>
              <span style={{ color:MUTED }}>{k}</span><strong>{v}</strong>
            </div>
          ))}
        </Card>
      )}

      {/* Changement mot de passe */}
      {tab==='password' && (
        <Card>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>🔑 Changer le mot de passe</div>
          {[['Mot de passe actuel *','current'],['Nouveau mot de passe *','newPwd'],['Confirmer *','confirm']].map(([label,key])=>(
            <div key={key} style={{ marginBottom:12 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>{label}</label>
              <div style={{ position:'relative' }}>
                <input type={showPwd?'text':'password'} value={pwdForm[key]}
                  onChange={e=>setPwdForm(p=>({...p,[key]:e.target.value}))}
                  style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 40px 10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box' }} />
                {key==='current' && eyeBtn(showPwd, ()=>setShowPwd(!showPwd))}
              </div>
            </div>
          ))}
          <div style={{ background:`${P}08`, borderRadius:8, padding:10, marginBottom:14, fontSize:12, color:MUTED }}>
            ℹ️ Minimum 8 caractères — incluez lettres, chiffres et symboles.
          </div>
          <Btn onClick={changePassword} disabled={saving} style={{ width:'100%' }}>
            {saving?'Modification…':'💾 Changer le mot de passe'}
          </Btn>
        </Card>
      )}

      {/* Sécurité 2FA */}
      {tab==='security' && (
        <Card>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>🔐 Double Authentification (2FA)</div>
          {mfaStatus && (
            <div style={{ background:mfaStatus.mfaEnabled?`${G}10`:`${O}10`, border:`1px solid ${mfaStatus.mfaEnabled?G:O}30`, borderRadius:10, padding:14, marginBottom:16 }}>
              <div style={{ fontSize:14, fontWeight:700, color:mfaStatus.mfaEnabled?G:O }}>
                {mfaStatus.mfaEnabled ? '✅ 2FA activée' : '⚠️ 2FA non activée'}
              </div>
              <div style={{ fontSize:12, color:MUTED, marginTop:4 }}>
                {mfaStatus.mfaEnabled ? 'Votre compte est protégé par Google Authenticator.' : 'Activez la 2FA pour sécuriser votre compte.'}
              </div>
            </div>
          )}

          {/* Activer 2FA */}
          {mfaStatus && !mfaStatus.mfaEnabled && !mfaSetup && (
            <Btn onClick={setup2FA} style={{ width:'100%' }}>🔐 Activer la 2FA</Btn>
          )}

          {/* QR Code setup */}
          {mfaSetup && (
            <div>
              <div style={{ fontSize:13, color:MUTED, marginBottom:12 }}>
                1. Scannez ce QR code avec Google Authenticator ou Authy<br/>
                2. Entrez le code à 6 chiffres pour confirmer
              </div>
              <div style={{ textAlign:'center', marginBottom:12 }}>
                <img src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(mfaSetup.qrCode)}`}
                  alt="QR 2FA" style={{ width:180, height:180, border:`1px solid ${BORDER}`, borderRadius:8 }} />
              </div>
              <div style={{ background:BG, borderRadius:6, padding:'6px 10px', fontSize:11, fontFamily:'monospace', marginBottom:12, wordBreak:'break-all' }}>
                {mfaSetup.secret}
              </div>
              <input value={mfaCode} onChange={e=>setMfaCode(e.target.value.replace(/[^0-9]/g,'').slice(0,6))}
                placeholder="000000" maxLength={6}
                style={{ width:'100%', textAlign:'center', fontSize:24, letterSpacing:10, padding:'10px', border:`2px solid ${BORDER}`, borderRadius:8, marginBottom:10, boxSizing:'border-box' }} />
              <div style={{ display:'flex', gap:8 }}>
                <Btn onClick={verify2FA} disabled={mfaCode.length!==6} style={{ flex:1 }}>✅ Confirmer</Btn>
                <Btn outline onClick={()=>{setMfaSetup(null);setMfaCode('');}} style={{ flex:1 }}>Annuler</Btn>
              </div>
            </div>
          )}

          {/* Désactiver 2FA */}
          {mfaStatus && mfaStatus.mfaEnabled && (
            <div>
              <div style={{ fontSize:13, color:MUTED, marginBottom:10 }}>Entrez votre code 2FA pour désactiver :</div>
              <input value={mfaCode} onChange={e=>setMfaCode(e.target.value.replace(/[^0-9]/g,'').slice(0,6))}
                placeholder="000000" maxLength={6}
                style={{ width:'100%', textAlign:'center', fontSize:24, letterSpacing:10, padding:'10px', border:`2px solid ${BORDER}`, borderRadius:8, marginBottom:10, boxSizing:'border-box' }} />
              <Btn onClick={disable2FA} color={R} disabled={mfaCode.length!==6} style={{ width:'100%' }}>🔓 Désactiver la 2FA</Btn>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

// ─── USERS ────────────────────────────────────────────────────────
const ROLES_CONFIG = {
  bank_admin:       { label:'Admin Banque',      color:BLUE,  icon:'🔑', desc:'Accès complet à la banque' },
  bank_user:        { label:'Utilisateur Banque', color:BLUE, icon:'👤', desc:'Accès lecture banque' },
  agency_admin:     { label:'Admin Agence',       color:P,    icon:'🏢', desc:'Gestion complète agence' },
  agency_user:      { label:'Utilisateur Agence', color:P,    icon:'👤', desc:'Accès lecture agence' },
  customer_care:    { label:'Customer Care',       color:G,    icon:'🎧', desc:'Gestion clients et incidents' },
  caissier_maker:   { label:'Caissier Maker',      color:O,    icon:'💳', desc:'Initier les transactions' },
  caissier_checker: { label:'Caissier Checker',    color:O,    icon:'✅', desc:'Valider/approuver les transactions' },
  controleur:       { label:'Contrôleur',          color:BLUE, icon:'🔍', desc:'Supervision et rapports' },
  financier:        { label:'Financier',           color:G,    icon:'💰', desc:'Règlements et soldes' },
};

const Users = () => {
  const { user } = useAuth();
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [newUserResult, setNewUserResult] = useState(null);
  const [form, setForm] = useState({ firstName:'', lastName:'', email:'', phone:'', role:'customer_care', agencyId:'' });
  const [agencies, setAgencies] = useState([]);

  const load = useCallback(() => {
    api.get('/users').then(r=>setUsers(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false));
  }, []);

  useEffect(()=>{
    load();
    if (['bank_admin'].includes(user?.role)) {
      api.get('/agencies').then(r=>setAgencies(r.data.data||[])).catch(()=>{});
    }
  }, [load, user]);

  const create = async () => {
    if (!form.firstName || !form.email || !form.role) return toast.error('Prénom, email et rôle requis');
    setSaving(true);
    try {
      const r = await api.post('/users', form);
      setNewUserResult(r.data);
      setShowNew(false); load();
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (id, status) => {
    try { await api.patch(`/users/${id}/status`, { status: status==='active'?'suspended':'active' }); load(); toast.success('Statut mis à jour ✅'); }
    catch { toast.error('Erreur'); }
  };

  const updateRole = async (id, role) => {
    try { await api.patch(`/users/${id}/role`, { role }); load(); toast.success('Rôle mis à jour ✅'); }
    catch { toast.error('Erreur'); }
  };

  const roleGroups = {
    'Administration': ['bank_admin','bank_user','agency_admin','agency_user'],
    'Opérations': ['customer_care','caissier_maker','caissier_checker'],
    'Supervision': ['controleur','financier'],
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:800 }}>👥 Utilisateurs</h1>
        <Btn onClick={()=>setShowNew(true)}>+ Nouvel utilisateur</Btn>
      </div>

      {/* Résumé par rôle */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:10, marginBottom:20 }}>
        {Object.entries(ROLES_CONFIG).filter(([r])=>r!=='bank_admin').map(([role, rc])=>{
          const count = users.filter(u=>u.role===role).length;
          if (count === 0) return null;
          return (
            <div key={role} style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:'10px 12px', borderLeft:`3px solid ${rc.color}` }}>
              <div style={{ fontSize:18 }}>{rc.icon}</div>
              <div style={{ fontSize:11, color:MUTED, marginTop:2 }}>{rc.label}</div>
              <div style={{ fontSize:20, fontWeight:800, color:rc.color }}>{count}</div>
            </div>
          );
        }).filter(Boolean)}
      </div>

      {showNew && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:28, width:520, maxWidth:'100%', maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:20 }}>
              <div style={{ fontSize:16, fontWeight:700 }}>➕ Créer un utilisateur</div>
              <button onClick={()=>setShowNew(false)} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:MUTED }}>×</button>
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <Inp label="Prénom *" value={form.firstName} onChange={v=>setForm(p=>({...p,firstName:v}))} placeholder="Jean" />
              <Inp label="Nom" value={form.lastName} onChange={v=>setForm(p=>({...p,lastName:v}))} placeholder="Dupont" />
            </div>
            <Inp label="Email *" value={form.email} onChange={v=>setForm(p=>({...p,email:v}))} type="email" placeholder="jean@banque.cg" />
            <Inp label="Téléphone" value={form.phone} onChange={v=>setForm(p=>({...p,phone:v}))} placeholder="+242060000001" />

            {/* Sélection du rôle */}
            <div style={{ marginBottom:16 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:8, fontWeight:600 }}>Rôle *</label>
              {Object.entries(roleGroups).map(([group, roles]) => (
                <div key={group} style={{ marginBottom:12 }}>
                  <div style={{ fontSize:11, color:MUTED, fontWeight:700, marginBottom:6, textTransform:'uppercase' }}>{group}</div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                    {roles.map(role => {
                      const rc = ROLES_CONFIG[role];
                      return (
                        <label key={role} onClick={()=>setForm(p=>({...p,role}))}
                          style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', background:form.role===role?`${rc.color}12`:BG,
                            border:`2px solid ${form.role===role?rc.color:BORDER}`, borderRadius:8, cursor:'pointer', transition:'all .2s' }}>
                          <span style={{ fontSize:16 }}>{rc.icon}</span>
                          <div>
                            <div style={{ fontSize:12, fontWeight:700, color:form.role===role?rc.color:TEXT }}>{rc.label}</div>
                            <div style={{ fontSize:10, color:MUTED }}>{rc.desc}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* Agence */}
            {agencies.length > 0 && (
              <div style={{ marginBottom:14 }}>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>Agence (optionnel)</label>
                <select value={form.agencyId} onChange={e=>setForm(p=>({...p,agencyId:e.target.value}))}
                  style={{ width:'100%', background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14 }}>
                  <option value="">— Siège (toutes agences) —</option>
                  {agencies.map(a=><option key={a.agency_id} value={a.agency_id}>{a.agency_name}</option>)}
                </select>
              </div>
            )}

            <div style={{ display:'flex', gap:10 }}>
              <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Création…':'✅ Créer'}</Btn>
              <Btn outline onClick={()=>setShowNew(false)} style={{ flex:1 }}>Annuler</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Modal credentials nouvel utilisateur */}
      {newUserResult && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:28, width:460, maxWidth:'100%' }}>
            <div style={{ textAlign:'center', marginBottom:20 }}>
              <div style={{ fontSize:48, marginBottom:8 }}>✅</div>
              <div style={{ fontSize:18, fontWeight:700, color:G }}>Utilisateur créé !</div>
            </div>
            <div style={{ background:`${O}10`, border:`1px solid ${O}30`, borderRadius:10, padding:16, marginBottom:16 }}>
              <div style={{ fontSize:13, fontWeight:700, color:O, marginBottom:10 }}>⚠️ Credentials temporaires — À transmettre à l'utilisateur</div>
              {[['Nom', `${newUserResult.first_name} ${newUserResult.last_name}`],
                ['Email / Login', newUserResult.email],
                ['Mot de passe temp.', newUserResult.tempPassword],
                ['Rôle', ROLES_CONFIG[newUserResult.role]?.label || newUserResult.role]
              ].map(([k,v])=>(
                <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${O}20`, fontSize:13 }}>
                  <span style={{ color:MUTED }}>{k}</span>
                  <strong style={{ fontFamily:k.includes('passe')?'monospace':'inherit', color:k.includes('passe')?O:TEXT }}>{v}</strong>
                </div>
              ))}
            </div>
            <div style={{ fontSize:12, color:MUTED, marginBottom:16 }}>
              🔑 URL: <strong>https://partners.c-pay.global</strong>
            </div>
            <Btn onClick={()=>setNewUserResult(null)} style={{ width:'100%' }}>✅ J'ai noté les credentials</Btn>
          </div>
        </div>
      )}

      {/* Liste utilisateurs */}
      {loading ? <Spin /> : users.length===0 ? (
        <Card style={{ textAlign:'center', padding:40 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>👥</div>
          <div style={{ color:MUTED }}>Aucun utilisateur créé</div>
        </Card>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {users.map(u => {
            const rc = ROLES_CONFIG[u.role] || { label:u.role, color:MUTED, icon:'👤' };
            return (
              <Card key={u.user_id}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                    <div style={{ width:40, height:40, background:`${rc.color}15`, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>{rc.icon}</div>
                    <div>
                      <div style={{ fontSize:14, fontWeight:700 }}>{u.first_name} {u.last_name}</div>
                      <div style={{ fontSize:12, color:MUTED }}>{u.email} {u.phone?`· ${u.phone}`:''}</div>
                      <div style={{ display:'flex', gap:8, marginTop:4 }}>
                        <span style={{ background:`${rc.color}15`, color:rc.color, borderRadius:20, padding:'2px 10px', fontSize:11, fontWeight:700 }}>{rc.icon} {rc.label}</span>
                        {u.agency_name && <span style={{ background:`${BORDER}`, color:MUTED, borderRadius:20, padding:'2px 10px', fontSize:11 }}>🏢 {u.agency_name}</span>}
                        {u.temp_password && <span style={{ background:`${O}15`, color:O, borderRadius:20, padding:'2px 10px', fontSize:11 }}>⚠️ MDP temp</span>}
                        <span style={{ background:u.status==='active'?`${G}15`:`${R}15`, color:u.status==='active'?G:R, borderRadius:20, padding:'2px 10px', fontSize:11, fontWeight:700 }}>
                          {u.status==='active'?'Actif':'Suspendu'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:6 }}>
                    <select value={u.role} onChange={e=>updateRole(u.user_id, e.target.value)}
                      style={{ background:BG, border:`1px solid ${BORDER}`, borderRadius:6, padding:'6px 10px', fontSize:12, cursor:'pointer' }}>
                      {Object.entries(ROLES_CONFIG).map(([r,rc])=>(
                        <option key={r} value={r}>{rc.icon} {rc.label}</option>
                      ))}
                    </select>
                    <Btn small color={O} onClick={async ()=>{
                      try {
                        const r = await api.post(`/users/${u.user_id}/reset-link`);
                        toast.success('Lien généré ✅');
                        await navigator.clipboard.writeText(r.data.resetUrl).catch(()=>{});
                        alert(`Lien de réinitialisation:\n${r.data.resetUrl}\n\n(Copié dans le presse-papier)`);
                      } catch(e){ toast.error('Erreur'); }
                    }}>🔑 Reset</Btn>
                    <Btn small outline color={u.status==='active'?R:G} onClick={()=>toggleStatus(u.user_id, u.status)}>
                      {u.status==='active'?'Suspendre':'Activer'}
                    </Btn>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── RAPPORT ──────────────────────────────────────────────────────
const Rapport = () => {
  const { user } = useAuth();
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [agencies, setAgencies] = useState([]);
  const [agents, setAgents]     = useState([]);
  const [filters, setFilters]   = useState({
    dateFrom: new Date(new Date().setDate(1)).toISOString().slice(0,10),
    dateTo:   new Date().toISOString().slice(0,10),
    agencyId: '', agentId: '', groupBy: 'day'
  });

  useEffect(()=>{
    api.get('/agencies').then(r=>setAgencies(r.data.data||[])).catch(()=>{});
    api.get('/agents').then(r=>setAgents(r.data.data||[])).catch(()=>{});
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/transactions/report', { params: filters });
      setData(r.data);
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setLoading(false); }
  };

  useEffect(()=>{ load(); }, []);

  const exportRapportExcel = () => {
    if (!data) return;
    const sheetPeriode = data.byPeriod?.map(p=>[
      new Date(p.period).toLocaleDateString('fr-FR'),
      parseInt(p.count||0), parseFloat(p.volume||0), parseFloat(p.fees||0)
    ]) || [];
    const sheetAgents = data.topAgents?.map(a=>[
      a.agent_name, a.agency_name, parseInt(a.count||0), parseFloat(a.volume||0)
    ]) || [];
    const t = data.totals || {};
    const summaryRows = [
      ['Transactions totales', parseInt(t.total_txns||0)],
      ['Volume total (XAF)', parseFloat(t.total_volume||0)],
      ['Frais collectes (XAF)', parseFloat(t.total_fees||0)],
      ['Volume encaissements (XAF)', parseFloat(t.collect_volume||0)],
      ['Volume decaissements (XAF)', parseFloat(t.disburse_volume||0)],
    ];
    const makeSheet = (name, headers, rows) => {
      const xmlRows = [headers,...rows].map(row=>
        `<Row>${row.map(c=>typeof c==='number'
          ?`<Cell><Data ss:Type="Number">${c}</Data></Cell>`
          :`<Cell><Data ss:Type="String">${String(c||'').replace(/&/g,'&amp;')}</Data></Cell>`
        ).join('')}</Row>`
      ).join('');
      return `<Worksheet ss:Name="${name}"><Table>${xmlRows}</Table></Worksheet>`;
    };
    const xml = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  ${makeSheet('Resume', ['Indicateur','Valeur'], summaryRows)}
  ${makeSheet('Par periode', ['Periode','Transactions','Volume (XAF)','Frais (XAF)'], sheetPeriode)}
  ${makeSheet('Top Agents', ['Agent','Agence','Transactions','Volume (XAF)'], sheetAgents)}
</Workbook>`;
    const blob = new Blob([xml],{type:'application/vnd.ms-excel;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rapport_${filters.dateFrom}_${filters.dateTo}.xls`;
    a.click();
    toast.success('Rapport Excel OK');
  };

  const exportRapportPDF = () => {
    if (!data) return;
    const t = data.totals;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      body{font-family:Arial,sans-serif;padding:24px;color:#1e2d3d}
      h1{color:#1d4f92;margin-bottom:4px}
      .subtitle{color:#5a6677;font-size:13px;margin-bottom:20px}
      .kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
      .kpi{background:#f0f4f8;border-radius:8px;padding:12px;text-align:center}
      .kpi-val{font-size:20px;font-weight:800;color:#1d4f92}
      .kpi-label{font-size:11px;color:#5a6677;margin-top:2px}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:16px}
      th{background:#1d4f92;color:#fff;padding:7px;text-align:left}
      td{padding:6px 7px;border-bottom:1px solid #dce3ed}
      h3{color:#1d4f92;margin:16px 0 8px}
      footer{margin-top:20px;font-size:10px;color:#8a9ab0;text-align:center}
    </style></head>
    <body>
    <h1>📊 Rapport Consolidé</h1>
    <div class="subtitle">Période: ${filters.dateFrom} → ${filters.dateTo} · Généré le ${new Date().toLocaleDateString('fr-FR')}</div>
    <div class="kpis">
      <div class="kpi"><div class="kpi-val">${parseInt(t.total_txns||0).toLocaleString('fr-FR')}</div><div class="kpi-label">Transactions</div></div>
      <div class="kpi"><div class="kpi-val">${parseFloat(t.total_volume||0).toLocaleString('fr-FR')} XAF</div><div class="kpi-label">Volume total</div></div>
      <div class="kpi"><div class="kpi-val">${parseFloat(t.total_fees||0).toLocaleString('fr-FR')} XAF</div><div class="kpi-label">Frais collectés</div></div>
      <div class="kpi"><div class="kpi-val">${parseFloat(t.collect_volume||0).toLocaleString('fr-FR')} XAF</div><div class="kpi-label">Encaissements</div></div>
      <div class="kpi"><div class="kpi-val">${parseFloat(t.disburse_volume||0).toLocaleString('fr-FR')} XAF</div><div class="kpi-label">Décaissements</div></div>
      <div class="kpi"><div class="kpi-val">${parseFloat(t.completed_volume||0).toLocaleString('fr-FR')} XAF</div><div class="kpi-label">Volume complété</div></div>
    </div>
    <h3>Top Agents</h3>
    <table><thead><tr><th>Agent</th><th>Agence</th><th>Transactions</th><th>Volume</th></tr></thead>
    <tbody>${(data.topAgents||[]).map(a=>`<tr><td>${a.agent_name}</td><td>${a.agency_name}</td><td>${a.count}</td><td>${parseFloat(a.volume||0).toLocaleString('fr-FR')} XAF</td></tr>`).join('')}</tbody></table>
    <h3>Volume par période</h3>
    <table><thead><tr><th>Période</th><th>Transactions</th><th>Volume</th><th>Frais</th></tr></thead>
    <tbody>${(data.byPeriod||[]).map(p=>`<tr><td>${new Date(p.period).toLocaleDateString('fr-FR')}</td><td>${p.count}</td><td>${parseFloat(p.volume||0).toLocaleString('fr-FR')} XAF</td><td>${parseFloat(p.fees||0).toLocaleString('fr-FR')} XAF</td></tr>`).join('')}</tbody></table>
    <footer>C-Pay Partners 2.6.0 — Confidentiel</footer>
    </body></html>`;
    const win = window.open('','_blank');
    win.document.write(html); win.document.close();
    win.onload = () => win.print();
  };

  const inputStyle = { background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:TEXT, fontFamily:FONT };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:800 }}>📊 Rapport Consolidé</h1>
        <div style={{ display:'flex', gap:8 }}>
          <Btn small outline onClick={exportRapportExcel} color='#217346'>📊 Excel</Btn>
        <Btn small outline onClick={exportRapportPDF}>🖨️ Exporter PDF</Btn>
        </div>
      </div>

      {/* Filtres */}
      <Card style={{ marginBottom:20 }}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:12, marginBottom:12 }}>
          <div>
            <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>Du</label>
            <input type="date" value={filters.dateFrom} onChange={e=>setFilters(p=>({...p,dateFrom:e.target.value}))} style={inputStyle} />
          </div>
          <div>
            <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>Au</label>
            <input type="date" value={filters.dateTo} onChange={e=>setFilters(p=>({...p,dateTo:e.target.value}))} style={inputStyle} />
          </div>
          {agencies.length>0 && (
            <div>
              <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>Agence</label>
              <select value={filters.agencyId} onChange={e=>setFilters(p=>({...p,agencyId:e.target.value,agentId:''}))} style={inputStyle}>
                <option value="">Toutes</option>
                {agencies.map(a=><option key={a.agency_id} value={a.agency_id}>{a.agency_name}</option>)}
              </select>
            </div>
          )}
          {agents.length>0 && (
            <div>
              <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>Agent</label>
              <select value={filters.agentId} onChange={e=>setFilters(p=>({...p,agentId:e.target.value}))} style={inputStyle}>
                <option value="">Tous</option>
                {agents.filter(a=>!filters.agencyId||a.agency_id===filters.agencyId).map(a=>(
                  <option key={a.agent_id} value={a.agent_id}>{a.first_name} {a.last_name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>Grouper par</label>
            <select value={filters.groupBy} onChange={e=>setFilters(p=>({...p,groupBy:e.target.value}))} style={inputStyle}>
              <option value="day">Jour</option>
              <option value="week">Semaine</option>
              <option value="month">Mois</option>
            </select>
          </div>
        </div>
        <Btn onClick={load} disabled={loading} style={{ width:'100%' }}>{loading?'Chargement…':'🔍 Générer le rapport'}</Btn>
      </Card>

      {loading && <Spin />}

      {data && !loading && (<>
        {/* KPIs */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:12, marginBottom:20 }}>
          <KpiCard icon="🔢" label="Transactions" value={parseInt(data.totals?.total_txns||0).toLocaleString('fr-FR')} color={BLUE} />
          <KpiCard icon="💰" label="Volume total" value={fmtNum(data.totals?.total_volume)+' XAF'} color={P} />
          <KpiCard icon="💸" label="Frais collectés" value={fmtNum(data.totals?.total_fees)+' XAF'} color={G} />
          <KpiCard icon="📥" label="Encaissements" value={fmtNum(data.totals?.collect_volume)+' XAF'} color={P} />
          <KpiCard icon="📤" label="Décaissements" value={fmtNum(data.totals?.disburse_volume)+' XAF'} color={O} />
          <KpiCard icon="✅" label="Volume complété" value={fmtNum(data.totals?.completed_volume)+' XAF'} color={G} />
        </div>

        {/* Graphique volume par période */}
        {data.byPeriod?.length > 0 && (
          <Card style={{ marginBottom:20 }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:8 }}>📈 Volume par {filters.groupBy==='day'?'jour':filters.groupBy==='week'?'semaine':'mois'}</div>
            <MiniBar data={data.byPeriod.slice().reverse().map(p=>({
              label: new Date(p.period).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'}),
              value: parseFloat(p.volume||0)
            }))} color={P} height={100} />
          </Card>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:20 }}>
          {/* Répartition par type */}
          <Card>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:12 }}>🥧 Répartition par type</div>
            {data.byType?.map(t=>{
              const total = data.byType.reduce((s,x)=>s+parseFloat(x.volume||0),0);
              const pct   = total>0 ? Math.round((parseFloat(t.volume||0)/total)*100) : 0;
              const color = t.type==='collect'?P:t.type==='disburse'?O:G;
              return (
                <div key={t.type} style={{ marginBottom:10 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, marginBottom:3 }}>
                    <span>{t.type==='collect'?'📥 Encaissement':t.type==='disburse'?'📤 Décaissement':'🔄 Autre'}</span>
                    <span style={{ color, fontWeight:700 }}>{pct}% · {fmtNum(t.volume)} XAF</span>
                  </div>
                  <div style={{ background:BG, borderRadius:20, height:8 }}>
                    <div style={{ width:`${pct}%`, background:color, height:'100%', borderRadius:20 }} />
                  </div>
                </div>
              );
            })}
          </Card>

          {/* Top agents */}
          <Card>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:12 }}>🏆 Top Agents</div>
            {data.topAgents?.length===0 && <div style={{ color:MUTED, fontSize:13 }}>Aucune donnée</div>}
            {data.topAgents?.slice(0,5).map((a,i)=>(
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', borderBottom:`1px solid ${BORDER}`, fontSize:13 }}>
                <div>
                  <div style={{ fontWeight:600 }}>{i+1}. {a.agent_name}</div>
                  <div style={{ fontSize:11, color:MUTED }}>{a.agency_name}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ color:P, fontWeight:700 }}>{fmtNum(a.volume)} XAF</div>
                  <div style={{ fontSize:11, color:MUTED }}>{a.count} txns</div>
                </div>
              </div>
            ))}
          </Card>
        </div>

        {/* Tableau détaillé par période */}
        <Card>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:12 }}>📋 Détail par période</div>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ borderBottom:`2px solid ${BORDER}`, color:MUTED }}>
                  {['Période','Transactions','Volume','Frais'].map(h=>(
                    <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontWeight:600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.byPeriod?.length===0
                  ? <tr><td colSpan={4} style={{ textAlign:'center', padding:24, color:MUTED }}>Aucune donnée</td></tr>
                  : data.byPeriod?.map((p,i)=>(
                    <tr key={i} style={{ borderBottom:`1px solid ${BORDER}` }}>
                      <td style={{ padding:'8px 12px', fontWeight:600 }}>{new Date(p.period).toLocaleDateString('fr-FR')}</td>
                      <td style={{ padding:'8px 12px' }}>{p.count}</td>
                      <td style={{ padding:'8px 12px', color:P, fontWeight:600 }}>{fmtNum(p.volume)} XAF</td>
                      <td style={{ padding:'8px 12px', color:MUTED }}>{fmtNum(p.fees)} XAF</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        </Card>
      </>)}
    </div>
  );
};

// ─── APPROVALS (Checker) ──────────────────────────────────────────
const Approvals = () => {
  const [pending, setPending]   = useState([]);
  const [history, setHistory]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState('pending');
  const [rejReason, setRejReason] = useState('');
  const [processing, setProcessing] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/approvals/pending'),
      api.get('/approvals/history', { params:{ limit:30 } })
    ]).then(([p,h])=>{ setPending(p.data.data||[]); setHistory(h.data.data||[]); })
    .catch(()=>{}).finally(()=>setLoading(false));
  }, []);
  useEffect(()=>{ load(); }, [load]);

  const approve = async (id) => {
    setProcessing(id);
    try { await api.post(`/approvals/${id}/approve`); toast.success('Transaction approuvée ✅'); load(); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setProcessing(null); }
  };

  const reject = async (id) => {
    if (!rejReason) return toast.error('Motif de rejet requis');
    setProcessing(id);
    try { await api.post(`/approvals/${id}/reject`, { reason: rejReason }); toast.success('Transaction rejetée'); setRejReason(''); load(); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setProcessing(null); }
  };

  const STATUS_COLOR = { pending:O, approved:G, rejected:R, cancelled:MUTED };
  const STATUS_LABEL = { pending:'⏳ En attente', approved:'✅ Approuvé', rejected:'❌ Rejeté', cancelled:'🚫 Annulé' };

  const ApprovalCard = ({ ap, showActions=false }) => (
    <Card key={ap.approval_id} style={{ marginBottom:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
        <div style={{ flex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
            <span style={{ fontSize:20 }}>{ap.type==='collect'?'📥':'📤'}</span>
            <div style={{ fontSize:15, fontWeight:700 }}>
              {ap.type==='collect'?'Encaissement':'Décaissement'} — {fmtNum(ap.amount)} XAF
            </div>
            <Badge label={STATUS_LABEL[ap.status]||ap.status} color={STATUS_COLOR[ap.status]||MUTED} />
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))', gap:6, fontSize:12, color:MUTED }}>
            <span>👤 Maker: <strong>{ap.maker_name}</strong></span>
            <span>🏢 {ap.agency_name}</span>
            <span>📱 {ap.method==='airtel_money'?'Airtel Money':'MTN MoMo'}</span>
            <span>📞 {ap.customer_phone||'—'}</span>
            <span>💰 Frais: {fmtNum(ap.fee_amount)} XAF</span>
            <span>🔖 Réf: {ap.reference}</span>
            <span>🕐 {fmtDate(ap.created_at)}</span>
          </div>
          {ap.description && <div style={{ fontSize:12, color:MUTED, marginTop:4 }}>📝 {ap.description}</div>}
          {ap.rejection_reason && <div style={{ fontSize:12, color:R, marginTop:4 }}>❌ Motif: {ap.rejection_reason}</div>}
        </div>
        {showActions && ap.status==='pending' && (
          <div style={{ display:'flex', flexDirection:'column', gap:8, marginLeft:16, flexShrink:0 }}>
            <Btn small color={G} onClick={()=>approve(ap.approval_id)} disabled={processing===ap.approval_id}>
              {processing===ap.approval_id?'…':'✅ Approuver'}
            </Btn>
            <div>
              <input value={rejReason} onChange={e=>setRejReason(e.target.value)} placeholder="Motif rejet…"
                style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:6, padding:'5px 8px', fontSize:11, marginBottom:4, boxSizing:'border-box' }} />
              <Btn small color={R} outline onClick={()=>reject(ap.approval_id)} disabled={processing===ap.approval_id||!rejReason}>
                ❌ Rejeter
              </Btn>
            </div>
          </div>
        )}
      </div>
    </Card>
  );

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:800 }}>✅ File d'Approbation</h1>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {pending.length > 0 && (
            <span style={{ background:`${R}15`, color:R, borderRadius:20, padding:'4px 12px', fontSize:12, fontWeight:700 }}>
              {pending.length} en attente
            </span>
          )}
          <Btn small outline onClick={load}>🔄 Actualiser</Btn>
        </div>
      </div>

      <div style={{ display:'flex', gap:0, marginBottom:20, borderBottom:`2px solid ${BORDER}` }}>
        {[['pending',`⏳ En attente (${pending.length})`],['history','📋 Historique']].map(([v,l])=>(
          <button key={v} onClick={()=>setTab(v)}
            style={{ padding:'10px 20px', border:'none', background:'none', fontSize:13, fontWeight:700, cursor:'pointer',
              color:tab===v?P:MUTED, borderBottom:`3px solid ${tab===v?P:'transparent'}`, marginBottom:-2 }}>
            {l}
          </button>
        ))}
      </div>

      {loading ? <Spin /> : (<>
        {tab==='pending' && (<>
          {pending.length===0 ? (
            <Card style={{ textAlign:'center', padding:40 }}>
              <div style={{ fontSize:48, marginBottom:12 }}>✅</div>
              <div style={{ color:MUTED }}>Aucune transaction en attente d&apos;approbation</div>
            </Card>
          ) : pending.map(ap=><ApprovalCard key={ap.approval_id} ap={ap} showActions />)}
        </>)}

        {tab==='history' && (<>
          {history.length===0 ? (
            <Card style={{ textAlign:'center', padding:40 }}><div style={{ color:MUTED }}>Aucun historique</div></Card>
          ) : history.map(ap=><ApprovalCard key={ap.approval_id} ap={ap} />)}
        </>)}
      </>)}
    </div>
  );
};

// ─── MY APPROVALS (Maker) ────────────────────────────────────────
const MyApprovals = () => {
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading]     = useState(true);

  const load = useCallback(() => {
    api.get('/approvals/mine').then(r=>setApprovals(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false));
  }, []);
  useEffect(()=>{ load(); }, [load]);

  const cancel = async (id) => {
    try { await api.post(`/approvals/${id}/cancel`); toast.success('Demande annulée'); load(); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
  };

  const STATUS_COLOR = { pending:O, approved:G, rejected:R, cancelled:MUTED };
  const STATUS_LABEL = { pending:'⏳ En attente', approved:'✅ Approuvé', rejected:'❌ Rejeté', cancelled:'🚫 Annulé' };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:800 }}>⏳ Mes Demandes</h1>
        <Btn small outline onClick={load}>🔄 Actualiser</Btn>
      </div>

      {loading ? <Spin /> : approvals.length===0 ? (
        <Card style={{ textAlign:'center', padding:40 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>📋</div>
          <div style={{ color:MUTED }}>Aucune demande soumise</div>
        </Card>
      ) : (
        <div>
          {approvals.map(ap=>(
            <Card key={ap.approval_id} style={{ marginBottom:10 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                    <span style={{ fontSize:20 }}>{ap.type==='collect'?'📥':'📤'}</span>
                    <div style={{ fontSize:15, fontWeight:700 }}>
                      {ap.type==='collect'?'Encaissement':'Décaissement'} — {fmtNum(ap.amount)} XAF
                    </div>
                    <Badge label={STATUS_LABEL[ap.status]||ap.status} color={STATUS_COLOR[ap.status]||MUTED} />
                  </div>
                  <div style={{ display:'flex', gap:16, fontSize:12, color:MUTED, flexWrap:'wrap' }}>
                    <span>📱 {ap.method==='airtel_money'?'Airtel Money':'MTN MoMo'}</span>
                    <span>📞 {ap.customer_phone||'—'}</span>
                    <span>💰 Frais: {fmtNum(ap.fee_amount)} XAF</span>
                    <span>🔖 {ap.reference}</span>
                    <span>🕐 {fmtDate(ap.created_at)}</span>
                  </div>
                  {ap.rejection_reason && (
                    <div style={{ marginTop:8, background:`${R}10`, border:`1px solid ${R}30`, borderRadius:6, padding:'6px 10px', fontSize:12, color:R }}>
                      ❌ Motif de rejet: {ap.rejection_reason}
                    </div>
                  )}
                  {ap.status==='approved' && ap.approved_at && (
                    <div style={{ marginTop:6, fontSize:12, color:G }}>✅ Approuvé le {fmtDate(ap.approved_at)}</div>
                  )}
                </div>
                {ap.status==='pending' && (
                  <Btn small outline color={R} onClick={()=>cancel(ap.approval_id)}>🚫 Annuler</Btn>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── MES AGENCES (onglets Agences + Agents) ──────────────────────
class ErrBound extends React.Component {
  constructor(p){ super(p); this.state={err:null}; }
  static getDerivedStateFromError(e){ return {err:e.message}; }
  render(){
    if(this.state.err) return <div style={{padding:20,background:'#fff0f0',borderRadius:8,color:'#c00'}}><strong>Erreur:</strong> {this.state.err}</div>;
    return this.props.children;
  }
}

const MesAgences = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState('agencies');

  const tabs = [
    { id:'agencies', label:'🏢 Agences', roles:['bank_admin','bank_user'] },
    { id:'agents',   label:'👤 Agents',  roles:['bank_admin','bank_user','agency_admin','agency_user'] },
  ].filter(t => t.roles.includes(user?.role));

  return (
    <div>
      <h1 style={{ margin:'0 0 4px', fontSize:22, fontWeight:800 }}>🏢 Mes Agences</h1>
      <p style={{ color:MUTED, fontSize:13, marginBottom:20 }}>Gérez vos agences et agents.</p>
      {tabs.length > 1 && (
        <div style={{ display:'flex', gap:0, marginBottom:24, borderBottom:`2px solid ${BORDER}` }}>
          {tabs.map(tb=>(
            <button key={tb.id} onClick={()=>setTab(tb.id)}
              style={{ padding:'10px 20px', border:'none', background:'none', fontSize:13, fontWeight:700,
                cursor:'pointer', color:tab===tb.id?P:MUTED,
                borderBottom:`3px solid ${tab===tb.id?P:'transparent'}`, marginBottom:-2, fontFamily:FONT }}>
              {tb.label}
            </button>
          ))}
        </div>
      )}
      {(tab==='agencies' && tabs.find(t=>t.id==='agencies')) && <AgenciesContent />}
      {tab==='agents' && <AgentsContent />}
    </div>
  );
};

// Extraire le contenu de Agencies sans le header
const AgenciesContent = () => {
  const { user } = useAuth();
  const [agencies, setAgencies] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [form, setForm]         = useState({ agencyName:'', agencyCode:'', city:'', address:'', contactPhone:'', floatBalance:'' });

  const load = useCallback(()=>{
    api.get('/agencies').then(r=>setAgencies(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false));
  },[]);
  useEffect(()=>{ load(); },[load]);

  const create = async () => {
    if (!form.agencyName||!form.agencyCode) return toast.error('Nom et code requis');
    setSaving(true);
    try { await api.post('/agencies', form); toast.success('Agence créée ✅'); setShowNew(false); load(); setForm({ agencyName:'', agencyCode:'', city:'', address:'', contactPhone:'', floatBalance:'' }); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  const toggle = async (id, status) => {
    try { await api.patch(`/agencies/${id}/status`, { status: status==='active'?'suspended':'active' }); load(); toast.success('Statut mis à jour ✅'); }
    catch { toast.error('Erreur'); }
  };

  return (
    <div>
      {['bank_admin'].includes(user?.role) && (
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:16 }}>
          <Btn onClick={()=>setShowNew(true)}>+ Nouvelle agence</Btn>
        </div>
      )}
      {showNew && (
        <Card style={{ marginBottom:16 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>➕ Créer une agence</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {[['agencyName','Nom *','Agence Centre'],['agencyCode','Code *','AGC-001'],['city','Ville','Brazzaville'],['contactPhone','Téléphone','+242060000001'],['floatBalance','Float initial (XAF)','500000']].map(([k,l,ph])=>(
              <Inp key={k} label={l} value={form[k]||''} onChange={v=>setForm(p=>({...p,[k]:v}))} placeholder={ph} />
            ))}
          </div>
          <div style={{ display:'flex', gap:10, marginTop:10 }}>
            <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Création…':'✅ Créer'}</Btn>
            <Btn outline onClick={()=>setShowNew(false)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Card>
      )}
      {loading ? <Spin /> : agencies.length===0 ? (
        <Card style={{ textAlign:'center', padding:40 }}><div style={{ color:MUTED }}>Aucune agence</div></Card>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {agencies.map(a=>(
            <Card key={a.agency_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:700, marginBottom:4 }}>🏢 {a.agency_name}</div>
                  <div style={{ fontSize:12, color:MUTED }}>Code: {a.agency_code} · {a.city||'—'} · Float: <strong style={{ color:G }}>{parseFloat(a.float_balance||0).toLocaleString('fr-FR')} XAF</strong></div>
                  <Badge label={a.status==='active'?'✅ Active':'⛔ Suspendue'} color={a.status==='active'?G:R} />
                </div>
                {['bank_admin'].includes(user?.role) && (
                  <Btn small outline color={a.status==='active'?R:G} onClick={()=>toggle(a.agency_id, a.status)}>
                    {a.status==='active'?'Suspendre':'Activer'}
                  </Btn>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// Extraire le contenu de Agents sans le header
const AgentsContent = () => {
  const { user } = useAuth();
  const [agents, setAgents]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showNew, setShowNew]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [newAgentResult, setNewAgentResult] = useState(null);
  const [form, setForm]         = useState({ firstName:'', lastName:'', email:'', phone:'', floatLimit:'500000' });

  const load = useCallback(()=>{
    api.get('/agents').then(r=>setAgents(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false));
  },[]);
  useEffect(()=>{ load(); },[load]);

  const create = async () => {
    if (!form.firstName||!form.email) return toast.error('Prénom et email requis');
    setSaving(true);
    try { const r = await api.post('/agents', form); setNewAgentResult(r.data); setShowNew(false); load(); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  const floatOp = async (id, type, amount) => {
    try { await api.patch(`/agents/${id}/float`, { amount: parseFloat(amount), type }); load(); toast.success('Float mis à jour ✅'); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
  };

  return (
    <div>
      {['bank_admin','agency_admin'].includes(user?.role) && (
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:16 }}>
          <Btn onClick={()=>setShowNew(true)}>+ Nouvel agent</Btn>
        </div>
      )}
      {newAgentResult && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:28, width:440, maxWidth:'100%' }}>
            <div style={{ textAlign:'center', marginBottom:16 }}><div style={{ fontSize:40 }}>✅</div><div style={{ fontSize:16, fontWeight:700, color:G }}>Agent créé !</div></div>
            <div style={{ background:`${O}10`, border:`1px solid ${O}30`, borderRadius:10, padding:14, marginBottom:14 }}>
              <div style={{ fontSize:12, fontWeight:700, color:O, marginBottom:8 }}>⚠️ Credentials temporaires</div>
              {[['Email', newAgentResult.email],['Mot de passe', newAgentResult.tempPassword]].map(([k,v])=>(
                <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13 }}>
                  <span style={{ color:MUTED }}>{k}</span><strong style={{ fontFamily:k==='Mot de passe'?'monospace':'inherit', color:k==='Mot de passe'?O:TEXT }}>{v}</strong>
                </div>
              ))}
            </div>
            <Btn onClick={()=>setNewAgentResult(null)} style={{ width:'100%' }}>✅ Fermer</Btn>
          </div>
        </div>
      )}
      {showNew && (
        <Card style={{ marginBottom:16 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>➕ Créer un agent</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            {[['firstName','Prénom *','Jean'],['lastName','Nom','Agent'],['email','Email *','agent@banque.cg'],['phone','Téléphone','+242060000001'],['floatLimit','Limite float (XAF)','500000']].map(([k,l,ph])=>(
              <Inp key={k} label={l} value={form[k]||''} onChange={v=>setForm(p=>({...p,[k]:v}))} placeholder={ph} />
            ))}
          </div>
          <div style={{ display:'flex', gap:10, marginTop:10 }}>
            <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Création…':'✅ Créer'}</Btn>
            <Btn outline onClick={()=>setShowNew(false)} style={{ flex:1 }}>Annuler</Btn>
          </div>
        </Card>
      )}
      {loading ? <Spin /> : agents.length===0 ? (
        <Card style={{ textAlign:'center', padding:40 }}><div style={{ color:MUTED }}>Aucun agent</div></Card>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {agents.map(a=>(
            <Card key={a.agent_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:700, marginBottom:4 }}>👤 {a.first_name} {a.last_name}</div>
                  <div style={{ fontSize:12, color:MUTED, marginBottom:4 }}>{a.email} · {a.agency_name||'—'}</div>
                  <div style={{ fontSize:12, color:G, fontWeight:700, marginBottom:4 }}>Float: {parseFloat(a.float_balance||0).toLocaleString('fr-FR')} XAF / Limite: {parseFloat(a.float_limit||0).toLocaleString('fr-FR')} XAF</div>
                  <Badge label={a.status==='active'?'✅ Actif':'⛔ Suspendu'} color={a.status==='active'?G:R} />
                </div>
                {['bank_admin','agency_admin'].includes(user?.role) && (
                  <div style={{ display:'flex', gap:6 }}>
                    <button onClick={async()=>{ const amt=prompt('Montant à approvisionner (XAF):'); if(amt) floatOp(a.agent_id,'float_in',amt); }}
                      style={{ background:`${G}10`, border:`1px solid ${G}30`, color:G, borderRadius:6, padding:'5px 10px', cursor:'pointer', fontSize:12 }}>📥 Float +</button>
                    <button onClick={async()=>{ const amt=prompt('Montant à retirer (XAF):'); if(amt) floatOp(a.agent_id,'float_out',amt); }}
                      style={{ background:`${R}10`, border:`1px solid ${R}30`, color:R, borderRadius:6, padding:'5px 10px', cursor:'pointer', fontSize:12 }}>📤 Float -</button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── MES TRANSACTIONS (onglets Transactions + Rapport + Approbations) ──
const MesTransactions = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState('transactions');

  // Checker ne peut pas approuver si bank_admin/bank_user/agency_admin
  const isChecker = ['caissier_checker'].includes(user?.role);
  const canApprove = isChecker; // Seul caissier_checker peut approuver

  const tabs = [
    { id:'transactions', label:'📋 Transactions', show: true },
    { id:'rapport',      label:'📊 Rapport',      show: ['bank_admin','bank_user','agency_admin','agency_user','controleur','financier'].includes(user?.role) },
    { id:'approvals',    label:'✅ Approbations',  show: canApprove },
    { id:'my-approvals', label:'⏳ Mes demandes',  show: ['caissier_maker'].includes(user?.role) },
  ].filter(t => t.show);

  return (
    <div>
      <h1 style={{ margin:'0 0 4px', fontSize:22, fontWeight:800 }}>📋 Mes Transactions</h1>
      <p style={{ color:MUTED, fontSize:13, marginBottom:20 }}>Transactions, rapports et approbations.</p>
      <div style={{ display:'flex', gap:0, marginBottom:24, borderBottom:`2px solid ${BORDER}` }}>
        {tabs.map(tb=>(
          <button key={tb.id} onClick={()=>setTab(tb.id)}
            style={{ padding:'10px 20px', border:'none', background:'none', fontSize:13, fontWeight:700,
              cursor:'pointer', color:tab===tb.id?P:MUTED,
              borderBottom:`3px solid ${tab===tb.id?P:'transparent'}`, marginBottom:-2, fontFamily:FONT }}>
            {tb.label}
          </button>
        ))}
      </div>
      {tab==='transactions'  && <Transactions />}
      {tab==='rapport'       && <Rapport />}
      {tab==='approvals'     && canApprove && <Approvals />}
      {tab==='my-approvals'  && <MyApprovals />}
    </div>
  );
};

// ─── MATRICE DES ROLES ────────────────────────────────────────────
const ROLE_MATRIX = [
  { role:'bank_admin',       label:'Admin Banque',      icon:'🔑', color:'#1d4f92',
    perms:{ dashboard:true, agences:true, agents:true, transactions:true, rapport:true, approvals:false, utilisateurs:true, profil:true } },
  { role:'bank_user',        label:'Utilisateur Banque', icon:'👤', color:'#1d4f92',
    perms:{ dashboard:true, agences:true, agents:true, transactions:true, rapport:true, approvals:false, utilisateurs:false, profil:true } },
  { role:'agency_admin',     label:'Admin Agence',       icon:'🏢', color:'#12b6c7',
    perms:{ dashboard:true, agences:false, agents:true, transactions:true, rapport:true, approvals:false, utilisateurs:true, profil:true } },
  { role:'agency_user',      label:'Utilisateur Agence', icon:'👤', color:'#12b6c7',
    perms:{ dashboard:true, agences:false, agents:true, transactions:true, rapport:true, approvals:false, utilisateurs:false, profil:true } },
  { role:'customer_care',    label:'Customer Care',       icon:'🎧', color:'#00c896',
    perms:{ dashboard:true, agences:false, agents:false, transactions:false, rapport:false, approvals:false, utilisateurs:false, profil:true } },
  { role:'caissier_maker',   label:'Caissier Maker',      icon:'💳', color:'#ff9500',
    perms:{ dashboard:true, agences:false, agents:false, transactions:true, rapport:false, approvals:false, utilisateurs:false, profil:true } },
  { role:'caissier_checker', label:'Caissier Checker',    icon:'✅', color:'#ff9500',
    perms:{ dashboard:true, agences:false, agents:false, transactions:true, rapport:false, approvals:true,  utilisateurs:false, profil:true } },
  { role:'controleur',       label:'Controleur',          icon:'🔍', color:'#1d4f92',
    perms:{ dashboard:true, agences:false, agents:false, transactions:true, rapport:true,  approvals:false, utilisateurs:false, profil:true } },
  { role:'financier',        label:'Financier',           icon:'💰', color:'#00c896',
    perms:{ dashboard:true, agences:false, agents:false, transactions:true, rapport:true,  approvals:false, utilisateurs:false, profil:true } },
];

const PERM_LABELS = {
  dashboard:'Dashboard', agences:'Agences', agents:'Agents',
  transactions:'Transactions', rapport:'Rapport', approvals:'Approbations',
  utilisateurs:'Utilisateurs', profil:'Mon Profil'
};

// ─── MES UTILISATEURS ─────────────────────────────────────────────
const MesUtilisateurs = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState('users');
  const [users, setUsers]         = useState([]);
  const [agencies, setAgencies]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showNew, setShowNew]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [newUserResult, setNewUserResult] = useState(null);
  const [form, setForm] = useState({ firstName:'', lastName:'', email:'', phone:'', role:'customer_care', agencyId:'' });

  // Affectation
  const [affUsers, setAffUsers]   = useState([]);
  const [selUser, setSelUser]     = useState('');
  const [selAgency, setSelAgency] = useState('');
  const [selRole, setSelRole]     = useState('');
  const [affSaving, setAffSaving] = useState(false);

  const load = useCallback(()=>{
    Promise.all([
      api.get('/users'),
      api.get('/agencies'),
    ]).then(([u,a])=>{ setUsers(u.data.data||[]); setAffUsers(u.data.data||[]); setAgencies(a.data.data||[]); })
    .catch(()=>{}).finally(()=>setLoading(false));
  },[]);
  useEffect(()=>{ load(); },[load]);

  const create = async () => {
    if (!form.firstName||!form.email||!form.role) return toast.error('Prenom, email et role requis');
    setSaving(true);
    try { const r = await api.post('/users', form); setNewUserResult(r.data); setShowNew(false); load(); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (id, status) => {
    try { await api.patch(`/users/${id}/status`,{status:status==='active'?'suspended':'active'}); load(); toast.success('Statut mis a jour'); }
    catch { toast.error('Erreur'); }
  };

  const updateRole = async (id, role) => {
    try { await api.patch(`/users/${id}/role`,{role}); load(); toast.success('Role mis a jour'); }
    catch { toast.error('Erreur'); }
  };

  const resetLink = async (id) => {
    try {
      const r = await api.post(`/users/${id}/reset-link`);
      toast.success('Lien genere');
      await navigator.clipboard.writeText(r.data.resetUrl).catch(()=>{});
      alert(`Lien de reinitialisation:\n${r.data.resetUrl}\n\n(Copie dans le presse-papier)`);
    } catch { toast.error('Erreur'); }
  };

  const applyAffectation = async () => {
    if (!selUser) return toast.error('Selectionnez un utilisateur');
    setAffSaving(true);
    try {
      if (selRole)   await api.patch(`/users/${selUser}/role`,   { role:selRole });
      if (selAgency) await api.patch(`/users/${selUser}/agency`, { agencyId:selAgency });
      toast.success('Affectation appliquee ✅');
      load(); setSelUser(''); setSelAgency(''); setSelRole('');
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setAffSaving(false); }
  };

  const ROLES_CFG = {
    bank_admin:{ label:'Admin Banque', color:'#1d4f92', icon:'🔑' },
    bank_user:{ label:'Utilisateur Banque', color:'#1d4f92', icon:'👤' },
    agency_admin:{ label:'Admin Agence', color:P, icon:'🏢' },
    agency_user:{ label:'Utilisateur Agence', color:P, icon:'👤' },
    customer_care:{ label:'Customer Care', color:G, icon:'🎧' },
    caissier_maker:{ label:'Caissier Maker', color:O, icon:'💳' },
    caissier_checker:{ label:'Caissier Checker', color:O, icon:'✅' },
    controleur:{ label:'Controleur', color:'#1d4f92', icon:'🔍' },
    financier:{ label:'Financier', color:G, icon:'💰' },
  };

  return (
    <div>
      <h1 style={{ margin:'0 0 4px', fontSize:22, fontWeight:800 }}>👥 Mes Utilisateurs</h1>
      <p style={{ color:MUTED, fontSize:13, marginBottom:20 }}>Gestion des utilisateurs, roles et affectations.</p>

      {/* Tabs */}
      <div style={{ display:'flex', gap:0, marginBottom:24, borderBottom:`2px solid ${BORDER}` }}>
        {[['users','👥 Utilisateurs'],['matrix','📊 Matrice des roles'],['affectation','🔗 Affectation']].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)}
            style={{ padding:'10px 20px', border:'none', background:'none', fontSize:13, fontWeight:700,
              cursor:'pointer', color:tab===id?P:MUTED,
              borderBottom:`3px solid ${tab===id?P:'transparent'}`, marginBottom:-2, fontFamily:FONT }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Onglet Utilisateurs ── */}
      {tab==='users' && (<>
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:16 }}>
          <Btn onClick={()=>setShowNew(true)}>+ Nouvel utilisateur</Btn>
        </div>

        {newUserResult && (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
            <div style={{ background:CARD, borderRadius:16, padding:28, width:440, maxWidth:'100%' }}>
              <div style={{ textAlign:'center', marginBottom:16 }}><div style={{ fontSize:40 }}>✅</div><div style={{ fontSize:16, fontWeight:700, color:G }}>Utilisateur cree !</div></div>
              <div style={{ background:`${O}10`, border:`1px solid ${O}30`, borderRadius:10, padding:14, marginBottom:14 }}>
                <div style={{ fontSize:12, fontWeight:700, color:O, marginBottom:8 }}>Credentials temporaires</div>
                {[['Email', newUserResult.email],['Mot de passe', newUserResult.tempPassword],['Role', ROLES_CFG[newUserResult.role]?.label||newUserResult.role]].map(([k,v])=>(
                  <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', fontSize:13, borderBottom:`1px solid ${O}20` }}>
                    <span style={{ color:MUTED }}>{k}</span>
                    <strong style={{ fontFamily:k==='Mot de passe'?'monospace':'inherit', color:k==='Mot de passe'?O:TEXT }}>{v}</strong>
                  </div>
                ))}
              </div>
              <div style={{ fontSize:12, color:MUTED, marginBottom:12 }}>URL: <strong>https://partners.c-pay.global</strong></div>
              <Btn onClick={()=>setNewUserResult(null)} style={{ width:'100%' }}>Fermer</Btn>
            </div>
          </div>
        )}

        {showNew && (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
            <div style={{ background:CARD, borderRadius:16, padding:28, width:520, maxWidth:'100%', maxHeight:'90vh', overflowY:'auto' }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:20 }}>
                <div style={{ fontSize:16, fontWeight:700 }}>Creer un utilisateur</div>
                <button onClick={()=>setShowNew(false)} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:MUTED }}>x</button>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:12 }}>
                <Inp label="Prenom *" value={form.firstName} onChange={v=>setForm(p=>({...p,firstName:v}))} placeholder="Jean" />
                <Inp label="Nom" value={form.lastName} onChange={v=>setForm(p=>({...p,lastName:v}))} placeholder="Dupont" />
              </div>
              <Inp label="Email *" value={form.email} onChange={v=>setForm(p=>({...p,email:v}))} type="email" placeholder="jean@banque.cg" />
              <Inp label="Telephone" value={form.phone} onChange={v=>setForm(p=>({...p,phone:v}))} placeholder="+242060000001" />
              <div style={{ marginBottom:14 }}>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>Role *</label>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                  {Object.entries(ROLES_CFG).map(([role,rc])=>(
                    <label key={role} onClick={()=>setForm(p=>({...p,role}))}
                      style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px',
                        background:form.role===role?`${rc.color}12`:BG,
                        border:`2px solid ${form.role===role?rc.color:BORDER}`,
                        borderRadius:8, cursor:'pointer' }}>
                      <span>{rc.icon}</span>
                      <div style={{ fontSize:12, fontWeight:700, color:form.role===role?rc.color:TEXT }}>{rc.label}</div>
                    </label>
                  ))}
                </div>
              </div>
              {agencies.length>0 && (
                <div style={{ marginBottom:14 }}>
                  <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>Agence (optionnel)</label>
                  <select value={form.agencyId} onChange={e=>setForm(p=>({...p,agencyId:e.target.value}))}
                    style={{ width:'100%', background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:13 }}>
                    <option value="">— Siege (toutes agences) —</option>
                    {agencies.map(a=><option key={a.agency_id} value={a.agency_id}>{a.agency_name}</option>)}
                  </select>
                </div>
              )}
              <div style={{ display:'flex', gap:10 }}>
                <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Creation...':'Creer'}</Btn>
                <Btn outline onClick={()=>setShowNew(false)} style={{ flex:1 }}>Annuler</Btn>
              </div>
            </div>
          </div>
        )}

        {loading ? <Spin /> : (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {users.map(u=>{
              const rc = ROLES_CFG[u.role]||{ label:u.role, color:MUTED, icon:'👤' };
              return (
                <Card key={u.user_id}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                      <div style={{ width:40, height:40, background:`${rc.color}15`, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>{rc.icon}</div>
                      <div>
                        <div style={{ fontSize:14, fontWeight:700 }}>{u.first_name} {u.last_name}</div>
                        <div style={{ fontSize:12, color:MUTED }}>{u.email}</div>
                        <div style={{ display:'flex', gap:6, marginTop:4, flexWrap:'wrap' }}>
                          <span style={{ background:`${rc.color}15`, color:rc.color, borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700 }}>{rc.icon} {rc.label}</span>
                          {u.agency_name && <span style={{ background:BG, color:MUTED, borderRadius:20, padding:'2px 8px', fontSize:11 }}>🏢 {u.agency_name}</span>}
                          {u.temp_password && <span style={{ background:`${O}15`, color:O, borderRadius:20, padding:'2px 8px', fontSize:11 }}>Temp MDP</span>}
                          <span style={{ background:u.status==='active'?`${G}15`:`${R}15`, color:u.status==='active'?G:R, borderRadius:20, padding:'2px 8px', fontSize:11 }}>
                            {u.status==='active'?'Actif':'Suspendu'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap', justifyContent:'flex-end' }}>
                      <select value={u.role} onChange={e=>updateRole(u.user_id,e.target.value)}
                        style={{ background:BG, border:`1px solid ${BORDER}`, borderRadius:6, padding:'6px 8px', fontSize:11, cursor:'pointer' }}>
                        {Object.entries(ROLES_CFG).map(([r,rc])=>(
                          <option key={r} value={r}>{rc.icon} {rc.label}</option>
                        ))}
                      </select>
                      <Btn small color={O} onClick={()=>resetLink(u.user_id)}>🔑 Reset</Btn>
                      <Btn small outline color={u.status==='active'?R:G} onClick={()=>toggleStatus(u.user_id,u.status)}>
                        {u.status==='active'?'Suspendre':'Activer'}
                      </Btn>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </>)}

      {/* ── Onglet Matrice des roles ── */}
      {tab==='matrix' && (
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12, minWidth:700 }}>
            <thead>
              <tr style={{ borderBottom:`2px solid ${BORDER}` }}>
                <th style={{ padding:'10px 12px', textAlign:'left', color:MUTED, fontWeight:600, minWidth:160 }}>Role</th>
                {Object.keys(PERM_LABELS).map(p=>(
                  <th key={p} style={{ padding:'10px 8px', textAlign:'center', color:MUTED, fontWeight:600, fontSize:11 }}>{PERM_LABELS[p]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROLE_MATRIX.map(rm=>(
                <tr key={rm.role} style={{ borderBottom:`1px solid ${BORDER}` }}>
                  <td style={{ padding:'10px 12px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ fontSize:18 }}>{rm.icon}</span>
                      <span style={{ fontWeight:700, color:rm.color, fontSize:13 }}>{rm.label}</span>
                    </div>
                  </td>
                  {Object.keys(PERM_LABELS).map(p=>(
                    <td key={p} style={{ padding:'10px 8px', textAlign:'center' }}>
                      {rm.perms[p]
                        ? <span style={{ color:G, fontSize:16 }}>✅</span>
                        : <span style={{ color:BORDER, fontSize:16 }}>—</span>
                      }
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Onglet Affectation ── */}
      {tab==='affectation' && (
        <div>
          <Card style={{ marginBottom:20 }}>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>🔗 Affecter un utilisateur</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:16 }}>
              <div>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>Utilisateur *</label>
                <select value={selUser} onChange={e=>setSelUser(e.target.value)}
                  style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:13 }}>
                  <option value="">— Choisir —</option>
                  {affUsers.map(u=><option key={u.user_id} value={u.user_id}>{u.first_name} {u.last_name} ({u.email})</option>)}
                </select>
              </div>
              <div>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>Agence</label>
                <select value={selAgency} onChange={e=>setSelAgency(e.target.value)}
                  style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:13 }}>
                  <option value="">— Siege —</option>
                  {agencies.map(a=><option key={a.agency_id} value={a.agency_id}>{a.agency_name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>Role</label>
                <select value={selRole} onChange={e=>setSelRole(e.target.value)}
                  style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:13 }}>
                  <option value="">— Inchange —</option>
                  {Object.entries(ROLES_CFG).map(([r,rc])=><option key={r} value={r}>{rc.icon} {rc.label}</option>)}
                </select>
              </div>
            </div>
            <Btn onClick={applyAffectation} disabled={affSaving||!selUser} style={{ width:'100%' }}>
              {affSaving?'Affectation...':'✅ Appliquer'}
            </Btn>
          </Card>

          {/* Tableau affectations actuelles */}
          <Card>
            <div style={{ fontSize:14, fontWeight:700, marginBottom:12 }}>Affectations actuelles</div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ borderBottom:`2px solid ${BORDER}`, color:MUTED }}>
                    {['Utilisateur','Email','Role','Agence','Statut','Lien reset'].map(h=>(
                      <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontWeight:600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} style={{ textAlign:'center', padding:24 }}><Spin /></td></tr>
                  ) : affUsers.map(u=>{
                    const rc = ROLES_CFG[u.role]||{ label:u.role, color:MUTED, icon:'👤' };
                    return (
                      <tr key={u.user_id} style={{ borderBottom:`1px solid ${BORDER}` }}>
                        <td style={{ padding:'8px 12px', fontWeight:600 }}>{u.first_name} {u.last_name}</td>
                        <td style={{ padding:'8px 12px', color:MUTED, fontSize:12 }}>{u.email}</td>
                        <td style={{ padding:'8px 12px' }}>
                          <span style={{ background:`${rc.color}15`, color:rc.color, borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700 }}>{rc.icon} {rc.label}</span>
                        </td>
                        <td style={{ padding:'8px 12px', color:MUTED }}>{u.agency_name||'Siege'}</td>
                        <td style={{ padding:'8px 12px' }}>
                          <span style={{ background:u.status==='active'?`${G}15`:`${R}15`, color:u.status==='active'?G:R, borderRadius:20, padding:'2px 8px', fontSize:11 }}>
                            {u.status==='active'?'Actif':'Suspendu'}
                          </span>
                        </td>
                        <td style={{ padding:'8px 12px' }}>
                          <button onClick={()=>resetLink(u.user_id)}
                            style={{ background:`${O}10`, border:`1px solid ${O}30`, color:O, borderRadius:6, padding:'4px 10px', cursor:'pointer', fontSize:11 }}>
                            🔑 Lien
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};

export default function App() {
  return (
    <BrowserRouter>
      <TenantProvider>
      <AuthProvider>
        <Toaster position="top-right" />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={
            <Guard>
              <Layout>
                <Routes>
                  <Route path="/"             element={<Dashboard />} />
                  <Route path="/agencies"     element={<Agencies />} />
                  <Route path="/agents"       element={<Agents />} />
                  <Route path="/collect"      element={<Collect />} />
                  <Route path="/disburse"     element={<Disburse />} />
                  <Route path="/mes-agences"      element={<ErrBound><MesAgences /></ErrBound>} />
                  <Route path="/mes-transactions"  element={<ErrBound><MesTransactions /></ErrBound>} />
                  <Route path="/approvals"         element={<Approvals />} />
                  <Route path="/my-approvals"      element={<MyApprovals />} />
                  <Route path="/transactions"      element={<Transactions />} />
                  <Route path="/rapport"      element={<Rapport />} />
                  <Route path="/users"             element={<Users />} />
                  <Route path="/mes-utilisateurs"  element={<ErrBound><MesUtilisateurs /></ErrBound>} />
                  <Route path="/profile"           element={<Profile />} />
                </Routes>
              </Layout>
            </Guard>
          } />
        </Routes>
      </AuthProvider>
      </TenantProvider>
    </BrowserRouter>
  );
}
