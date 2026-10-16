// ================================================================
// C-Pay 2.7 — Portail Banque (bank.c-pay.global)
// ================================================================
import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import axios from 'axios';
import { BrowserRouter, Routes, Route, Link, useNavigate, Navigate } from 'react-router-dom';
import { Toaster, toast } from 'react-hot-toast';

const BASE = process.env.REACT_APP_API_BASE_URL || '';
// Jeton d'acces (15 min) dans localStorage sous bk_token ; le refresh opaque
// est dans le cookie HttpOnly cp_rt_bank (path /api/v1/bank/auth) pose par
// le backend, d'ou withCredentials sur l'instance. Pas de /auth/me sur les
// portails distribution : le profil reste celui renvoye par /auth/login
// (bk_user) et la validite de session est lue dans le jeton (base64url, exp).
const TOKEN_KEY = 'bk_token', USER_KEY = 'bk_user';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* navigation privee */ } };
const readStoredUser = () => { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; } };
const purgeSession = () => { try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); } catch (e) {} };

const decodeJwt = (t) => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b.padEnd(b.length + (4 - b.length % 4) % 4, '=')));
    if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch { return null; }
};
// Session valide uniquement si le JWT n'est pas expire.
const tokenValid = (t) => !!decodeJwt(t || '');

const api  = axios.create({ baseURL: `${BASE}/api/v1/bank`, withCredentials: true });
api.interceptors.request.use(cfg => { const t = getToken(); if (t) cfg.headers.Authorization = `Bearer ${t}`; return cfg; });

// Refresh nu (hors instance api) et single-flight : les 401 concurrents
// attendent la meme promesse, sinon la rotation revoquerait les suivants.
const callRefresh = () => axios.post(`${BASE}/api/v1/bank/auth/refresh`, {}, { withCredentials: true });
let refreshPromise = null;
const refreshAccessToken = () => {
  if (!refreshPromise) {
    refreshPromise = callRefresh()
      .then(({ data }) => {
        if (!data.access_token) throw new Error('no access_token');
        setToken(data.access_token);
        return data.access_token;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};

// Routes d'authentification non protegees : un 401 est une reponse metier.
const NO_REFRESH_RE = /\/auth\/(login|refresh|forgot-password|reset-password)(\?|$)/;
// Purge complete (token ET utilisateur) : sinon AuthProvider relit bk_user,
// considere la session valide et renvoie sur '/' -> 401 -> boucle de redirection.
const logoutLocal = () => { purgeSession(); if (window.location.pathname !== '/login') window.location = '/login'; };

api.interceptors.response.use(r => r, async e => {
  const st = e.response?.status;
  const original = e.config;
  const isAuthRoute = NO_REFRESH_RE.test(original?.url || '');
  if (st === 401 && original && !original._retry && !isAuthRoute) {
    original._retry = true;
    try {
      const t = await refreshAccessToken();
      original.headers.Authorization = `Bearer ${t}`;
      return api(original);
    } catch (err) { logoutLocal(); }
  } else if (st === 403) {
    toast.error('Accès refusé');
  }
  return Promise.reject(e);
});

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif';
const FONT_TITRE = FONT;
const P='#12b6c7',BLUE='#1d4f92',G='#00c896',DANGER='#ff3b30',WARNING='#ff9500';
const BG='#f0f4f8',CARD='#fff',BORDER='#dce3ed',TEXT='#1e2d3d',MUTED='#5a6677';
const fmtNum = n => parseFloat(n||0).toLocaleString('fr-FR');

const AuthCtx = createContext(null);
const useAuth = () => useContext(AuthCtx);
const AuthProvider = ({ children }) => {
  // Profil stocke si le jeton est encore valide ; sinon refresh silencieux
  // par cookie avant de renvoyer sur /login (le cookie survit au jeton 15 min).
  const [user, setUser] = useState(() => (tokenValid(getToken()) ? readStoredUser() : null));
  const [loading, setLoading] = useState(() => !tokenValid(getToken()) && !!readStoredUser());
  useEffect(() => {
    if (!loading) return undefined;
    let cancelled = false;
    refreshAccessToken()
      .then(() => { if (!cancelled) setUser(readStoredUser()); })
      .catch(() => purgeSession())
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const login  = (token, u) => { setToken(token); try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch (e) {} setUser(u); };
  // Deconnexion reelle : l'etat local est vide immediatement (la page /login ne
  // renvoie pas sur '/'), puis le refresh est revoque cote serveur.
  const logout = () => { setUser(null); api.post('/auth/logout').catch(() => {}).finally(() => purgeSession()); };
  return <AuthCtx.Provider value={{ user, login, logout, loading, isAuth: !!user }}>{children}</AuthCtx.Provider>;
};

const Box  = ({ children, style }) => <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, padding:20, marginBottom:16, ...style }}>{children}</div>;
const Btn  = ({ children, onClick, color, outline, disabled, style }) => (
  <button onClick={onClick} disabled={disabled} style={{ background:outline?'transparent':color||P, color:outline?color||P:'#fff', border:`2px solid ${color||P}`, borderRadius:8, padding:'10px 20px', fontFamily:FONT, fontWeight:700, fontSize:13, cursor:disabled?'not-allowed':'pointer', opacity:disabled?.6:1, transition:'all .2s', ...style }}>{children}</button>
);
const _slugId = s => 'f-' + String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const Inp  = ({ label, value, onChange, type='text', placeholder, id, name, autoComplete, required, inputMode }) => {
  const _id = id || _slugId(label);
  return (
  <div style={{ marginBottom:14 }}>
    {label && <label htmlFor={_id} style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{label}</label>}
    <input id={_id} name={name || _id} value={value} onChange={e=>onChange(e.target.value)} type={type} placeholder={placeholder} autoComplete={autoComplete} required={required} inputMode={inputMode}
      style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box' }} />
  </div>
  );
};
const Badge = ({ label, color }) => <span style={{ background:`${color}20`, color, borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>{label}</span>;
const Spin  = () => <div style={{ textAlign:'center', padding:40, color:MUTED, fontFamily:FONT }}>Chargement…</div>;
const Guard = ({ children }) => { const { isAuth, loading } = useAuth(); if (loading) return <Spin />; return isAuth ? children : <Navigate to="/login" replace />; };

const Layout = ({ children }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div style={{ display:'flex', minHeight:'100vh', background:BG, fontFamily:FONT }}>
      <aside style={{ width:220, background:BLUE, color:'#fff', display:'flex', flexDirection:'column', position:'fixed', top:0, bottom:0, zIndex:10 }}>
        <div style={{ padding:'20px 16px', borderBottom:'1px solid rgba(255,255,255,0.1)' }}>
          <img src="/logo-calculus.png" alt="Calculus Plus" style={{ height:36, marginBottom:8 }} onError={e=>e.target.style.display='none'} />
          <div style={{ fontSize:11, opacity:.7, fontFamily:FONT }}>Portail Banque</div>
          <div style={{ fontSize:13, fontWeight:700 }}>{user?.bank?.bankName}</div>
        </div>
        <nav style={{ flex:1, padding:'12px 8px' }}>
          {[['/', '📊 Dashboard'], ['/agencies', '🏢 Agences'], ['/network', '🌐 Réseau']].map(([to, label]) => (
            <Link key={to} to={to} style={{ display:'block', padding:'10px 12px', borderRadius:8, color:'rgba(255,255,255,0.85)', textDecoration:'none', fontSize:13, marginBottom:4 }}>{label}</Link>
          ))}
        </nav>
        <div style={{ padding:16, borderTop:'1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ fontSize:12, opacity:.7 }}>{user?.firstName} {user?.lastName}</div>
          <button onClick={()=>{logout();navigate('/login');}} style={{ marginTop:8, background:'none', border:'1px solid rgba(255,255,255,0.3)', color:'#fff', padding:'6px 12px', borderRadius:6, cursor:'pointer', fontSize:12, width:'100%', fontFamily:FONT }}>Déconnexion</button>
        </div>
      </aside>
      <main style={{ marginLeft:220, flex:1, padding:28 }}>{children}</main>
    </div>
  );
};

const Login = () => {
  const { login, isAuth } = useAuth(); const navigate = useNavigate();
  const [creds, setCreds] = useState({ email:'', password:'' }); const [loading, setLoading] = useState(false);
  useEffect(() => { if (isAuth) navigate('/'); }, [isAuth, navigate]);
  const submit = async () => {
    setLoading(true);
    try { const { data } = await api.post('/auth/login', creds); login(data.access_token, data.user); navigate('/'); }
    catch (e) { toast.error(e.response?.data?.error || 'Identifiants incorrects'); }
    finally { setLoading(false); }
  };
  return (
    <div style={{ minHeight:'100vh', background:`linear-gradient(135deg,#0a1628,${BLUE},${P})`, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ width:400 }}>
        <Box style={{ marginBottom:0 }}>
          <div style={{ textAlign:'center', marginBottom:24 }}>
            <img src="/logo-calculus.png" alt="Calculus Plus" style={{ height:48, marginBottom:12 }} onError={e=>e.target.style.display='none'} />
            <div style={{ fontSize:20, fontWeight:700, color:TEXT, fontFamily:FONT }}>Portail Banque</div>
            <div style={{ fontSize:13, color:MUTED }}>C-Pay Distribution Network</div>
          </div>
          <form onSubmit={e => { e.preventDefault(); if (!loading) submit(); }}>
          <Inp label="Email" value={creds.email} onChange={v=>setCreds(c=>({...c,email:v}))} placeholder="admin@mabanque.com" />
          <Inp label="Mot de passe" value={creds.password} onChange={v=>setCreds(c=>({...c,password:v}))} type="password" placeholder="••••••••" autoComplete="current-password" required />
          <Btn disabled={loading} style={{ width:'100%', marginTop:8 }}>{loading?'Connexion…':'Se connecter'}</Btn>
          </form>
          <div style={{ textAlign:'center', marginTop:16, fontSize:11, color:MUTED, fontFamily:FONT }}>C-Pay est un produit de Calculus Plus SAS</div>
        </Box>
      </div>
    </div>
  );
};

const Dashboard = () => {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/dashboard').then(r=>setData(r.data)).catch(()=>{}); }, []);
  if (!data) return <Spin />;
  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>Tableau de bord — {data.bank_name}</h1>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:20 }}>
        {[['🏢','Agences',data.total_agencies||0,BLUE],['👤','Agents',data.total_agents||0,P],['💳','Porteurs',data.total_cardholders||0,G],['💰','Commissions',fmtNum(data.total_commissions)+' XAF',WARNING]].map(([icon,label,val,color])=>(
          <Box key={label} style={{ marginBottom:0, borderTop:`3px solid ${color}`, textAlign:'center' }}>
            <div style={{ fontSize:24, marginBottom:8 }}>{icon}</div>
            <div style={{ fontSize:11, color:MUTED, marginBottom:4, fontFamily:FONT }}>{label}</div>
            <div style={{ fontSize:20, fontWeight:800, color }}>{val}</div>
          </Box>
        ))}
      </div>
      <Box>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>Agences récentes</div>
        {(data.recentAgencies||[]).length===0 ? <div style={{ color:MUTED, fontSize:13 }}>Aucune agence créée.</div>
          : (data.recentAgencies||[]).map(a=>(
            <div key={a.agency_id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom:`1px solid ${BORDER}`, fontSize:13 }}>
              <div><div style={{ fontWeight:600 }}>{a.agency_name}</div><div style={{ color:MUTED, fontSize:11 }}>{a.city} · {a.agent_count||0} agents</div></div>
              <Badge label={a.is_active?'Active':'Inactive'} color={a.is_active?G:DANGER} />
            </div>
          ))}
      </Box>
    </div>
  );
};

const Agencies = () => {
  const [agencies, setAgencies] = useState([]); const [showCreate, setShowCreate] = useState(false); const [showUser, setShowUser] = useState(null);
  const [form, setForm] = useState({ agencyName:'', agencyCode:'', city:'', region:'', contactName:'', contactEmail:'', contactPhone:'', commissionRate:'0.15', maxAgents:'50' });
  const [uForm, setUForm] = useState({ firstName:'', lastName:'', email:'', phone:'', password:'' });
  const [loading, setLoading] = useState(false);
  const f = k => v => setForm(p=>({...p,[k]:v})); const uf = k => v => setUForm(p=>({...p,[k]:v}));
  const load = useCallback(()=>{ api.get('/agencies').then(r=>setAgencies(r.data.data||[])).catch(()=>{}); },[]);
  useEffect(()=>{ load(); },[load]);

  const create = async () => {
    if (!form.agencyName||!form.agencyCode||!form.city) return toast.error('Nom, code et ville requis');
    setLoading(true);
    try { await api.post('/agencies',{...form,commissionRate:parseFloat(form.commissionRate)/100,maxAgents:parseInt(form.maxAgents)}); toast.success('Agence créée'); setShowCreate(false); load(); setForm({agencyName:'',agencyCode:'',city:'',region:'',contactName:'',contactEmail:'',contactPhone:'',commissionRate:'0.15',maxAgents:'50'}); }
    catch(e){ toast.error(e.response?.data?.error||'Erreur'); } finally { setLoading(false); }
  };

  const createUser = async agencyId => {
    if (!uForm.firstName||!uForm.email||!uForm.password) return toast.error('Champs requis');
    setLoading(true);
    try { await api.post(`/agencies/${agencyId}/users`, uForm); toast.success('Utilisateur créé'); setShowUser(null); setUForm({firstName:'',lastName:'',email:'',phone:'',password:''}); }
    catch(e){ toast.error(e.response?.data?.error||'Erreur'); } finally { setLoading(false); }
  };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700 }}>Agences & Distributeurs</h1>
        <Btn onClick={()=>setShowCreate(true)}>+ Nouvelle agence</Btn>
      </div>
      {showCreate && (
        <Box style={{ border:`2px solid ${P}` }}>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:16 }}>Créer une agence</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Inp label="Nom de l'agence *" value={form.agencyName} onChange={f('agencyName')} placeholder="Agence Gombe" />
            <Inp label="Code *" value={form.agencyCode} onChange={f('agencyCode')} placeholder="AGC-001" />
            <Inp label="Ville *" value={form.city} onChange={f('city')} placeholder="Kinshasa" />
            <Inp label="Région" value={form.region} onChange={f('region')} placeholder="Kinshasa-Ouest" />
            <Inp label="Responsable" value={form.contactName} onChange={f('contactName')} />
            <Inp label="Email contact" value={form.contactEmail} onChange={f('contactEmail')} />
            <Inp label="Téléphone" value={form.contactPhone} onChange={f('contactPhone')} />
            <Inp label="Commission (%)" value={form.commissionRate} onChange={f('commissionRate')} />
            <Inp label="Max agents" value={form.maxAgents} onChange={f('maxAgents')} />
          </div>
          <div style={{ display:'flex', gap:10, marginTop:8 }}>
            <Btn onClick={create} disabled={loading}>{loading?'Création…':'Créer'}</Btn>
            <Btn outline onClick={()=>setShowCreate(false)}>Annuler</Btn>
          </div>
        </Box>
      )}
      {showUser && (
        <Box style={{ border:`2px solid ${BLUE}` }}>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:16 }}>Créer un accès pour {showUser.name}</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <Inp label="Prénom *" value={uForm.firstName} onChange={uf('firstName')} />
            <Inp label="Nom *" value={uForm.lastName} onChange={uf('lastName')} />
            <Inp label="Email *" value={uForm.email} onChange={uf('email')} />
            <Inp label="Téléphone" value={uForm.phone} onChange={uf('phone')} />
            <Inp label="Mot de passe *" value={uForm.password} onChange={uf('password')} type="password" />
          </div>
          <div style={{ display:'flex', gap:10, marginTop:8 }}>
            <Btn onClick={()=>createUser(showUser.id)} disabled={loading} color={BLUE}>{loading?'Création…':'Créer'}</Btn>
            <Btn outline onClick={()=>setShowUser(null)}>Annuler</Btn>
          </div>
        </Box>
      )}
      {agencies.length===0 ? <Box><div style={{ color:MUTED, textAlign:'center', padding:20 }}>Aucune agence. Créez votre première agence.</div></Box>
        : agencies.map(a=>(
          <Box key={a.agency_id} style={{ marginBottom:12 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <div>
                <div style={{ fontSize:16, fontWeight:700 }}>{a.agency_name}</div>
                <div style={{ color:MUTED, fontSize:12, marginTop:2 }}>{a.agency_code} · {a.city}{a.region?` · ${a.region}`:''}</div>
                <div style={{ display:'flex', gap:16, marginTop:8, fontSize:13, color:MUTED }}>
                  <span>👤 {a.agent_count||0} agents</span>
                  <span>💳 {a.cardholder_count||0} porteurs</span>
                  <span>📊 {(parseFloat(a.commission_rate||0)*100).toFixed(2)}%</span>
                </div>
              </div>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <Badge label={a.is_active?'Active':'Inactive'} color={a.is_active?G:DANGER} />
                <Btn onClick={()=>setShowUser({id:a.agency_id,name:a.agency_name})} color={BLUE} style={{ padding:'6px 12px', fontSize:12 }}>+ Accès</Btn>
              </div>
            </div>
          </Box>
        ))
      }
    </div>
  );
};

const Network = () => {
  const [data, setData] = useState([]);
  useEffect(()=>{ api.get('/network').then(r=>setData(r.data.data||[])).catch(()=>{}); },[]);
  const grouped = data.reduce((acc,row)=>{ if(!acc[row.agency_id])acc[row.agency_id]={name:row.agency_name,city:row.city,agents:[]}; if(row.agent_id)acc[row.agency_id].agents.push(row); return acc; },{});
  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>Vue réseau</h1>
      {Object.values(grouped).map((ag,i)=>(
        <Box key={i}>
          <div style={{ fontSize:15, fontWeight:700, color:BLUE, marginBottom:12 }}>🏢 {ag.name} — {ag.city}</div>
          {ag.agents.length===0 ? <div style={{ color:MUTED, fontSize:13 }}>Aucun agent.</div>
            : ag.agents.map(a=>(
              <div key={a.agent_id} style={{ display:'flex', justifyContent:'space-between', padding:'8px 12px', background:BG, borderRadius:8, marginBottom:6, fontSize:13 }}>
                <span>👤 {a.agent_name} · {a.agent_phone}</span>
                <span style={{ color:MUTED }}>💳 {a.cards_issued}/{a.cards_limit} · {a.active_cardholders} porteurs</span>
              </div>
            ))}
        </Box>
      ))}
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster position="top-right" />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={<Guard><Layout><Routes>
            <Route path="" element={<Dashboard />} />
            <Route path="agencies" element={<Agencies />} />
            <Route path="network" element={<Network />} />
          </Routes></Layout></Guard>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
