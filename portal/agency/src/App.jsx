// ================================================================
// C-Pay 2.6 — Portail Agence (agency.c-pay.global)
// ================================================================
import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import axios from 'axios';
import { BrowserRouter, Routes, Route, Link, useNavigate, Navigate } from 'react-router-dom';
import { Toaster, toast } from 'react-hot-toast';

const BASE = process.env.REACT_APP_API_BASE_URL || '';
const api  = axios.create({ baseURL: `${BASE}/api/v1/agency` });
api.interceptors.request.use(cfg => { const t = localStorage.getItem('ag_token'); if (t) cfg.headers.Authorization = `Bearer ${t}`; return cfg; });
api.interceptors.response.use(r => r, e => {
  const st = e.response?.status;
  if (st === 401) {
    // Purge complete (token ET utilisateur) : sinon AuthProvider relit ag_user,
    // considere la session valide et renvoie sur '/' -> 401 -> boucle de redirection.
    localStorage.removeItem('ag_token'); localStorage.removeItem('ag_user');
    if (window.location.pathname !== '/login') window.location = '/login';
  } else if (st === 403) {
    toast.error('Accès refusé');
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
const P='#12b6c7',BLUE='#1d4f92',G='#00c896',DANGER='#ff3b30',WARNING='#ff9500';
const BG='#f0f4f8',CARD='#fff',BORDER='#dce3ed',TEXT='#1e2d3d',MUTED='#5a6677';
const fmtNum = n => parseFloat(n||0).toLocaleString('fr-FR');

const AuthCtx = createContext(null);
const useAuth = () => useContext(AuthCtx);
const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    try {
      const t = localStorage.getItem('ag_token');
      if (!t || !tokenValid(t)) { localStorage.removeItem('ag_token'); localStorage.removeItem('ag_user'); return null; }
      return JSON.parse(localStorage.getItem('ag_user') || 'null');
    } catch { return null; }
  });
  const login  = (token,u) => { localStorage.setItem('ag_token',token); localStorage.setItem('ag_user',JSON.stringify(u)); setUser(u); };
  const logout = () => { localStorage.removeItem('ag_token'); localStorage.removeItem('ag_user'); setUser(null); };
  return <AuthCtx.Provider value={{ user, login, logout, isAuth:!!user }}>{children}</AuthCtx.Provider>;
};

const Box  = ({children,style}) => <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:20,marginBottom:16,...style}}>{children}</div>;
const Btn  = ({children,onClick,color,outline,disabled,style}) => (
  <button onClick={onClick} disabled={disabled} style={{background:outline?'transparent':color||P,color:outline?color||P:'#fff',border:`2px solid ${color||P}`,borderRadius:8,padding:'10px 20px',fontFamily:FONT,fontWeight:700,fontSize:13,cursor:disabled?'not-allowed':'pointer',opacity:disabled?.6:1,...style}}>{children}</button>
);
const _slugId = s => 'f-' + String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const Inp  = ({label,value,onChange,type='text',placeholder,id,name,autoComplete,required,inputMode}) => {
  const _id = id || _slugId(label);
  return (
  <div style={{marginBottom:14}}>
    {label&&<label htmlFor={_id} style={{display:'block',fontSize:12,color:MUTED,marginBottom:4,fontFamily:FONT}}>{label}</label>}
    <input id={_id} name={name || _id} value={value} onChange={e=>onChange(e.target.value)} type={type} placeholder={placeholder} autoComplete={autoComplete} required={required} inputMode={inputMode}
      style={{width:'100%',background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:'10px 12px',fontSize:14,color:TEXT,fontFamily:FONT,boxSizing:'border-box'}} />
  </div>
  );
};
const Badge = ({label,color}) => <span style={{background:`${color}20`,color,borderRadius:20,padding:'3px 10px',fontSize:11,fontWeight:700}}>{label}</span>;
const Spin  = () => <div style={{textAlign:'center',padding:40,color:MUTED,fontFamily:FONT}}>Chargement…</div>;
const Guard = ({children}) => { const {isAuth}=useAuth(); return isAuth?children:<Navigate to="/login" replace />; };

const Layout = ({children}) => {
  const {user,logout}=useAuth(); const navigate=useNavigate();
  const SIDEBAR = '#0d7a8a';
  return (
    <div style={{display:'flex',minHeight:'100vh',background:BG,fontFamily:FONT}}>
      <aside style={{width:220,background:SIDEBAR,color:'#fff',display:'flex',flexDirection:'column',position:'fixed',top:0,bottom:0,zIndex:10}}>
        <div style={{padding:'20px 16px',borderBottom:'1px solid rgba(255,255,255,0.1)'}}>
          <img src="/logo-calculus.svg" alt="Calculus Plus" style={{height:36,marginBottom:8}} onError={e=>e.target.style.display='none'} />
          <div style={{fontSize:11,opacity:.7}}>Portail Agence</div>
          <div style={{fontSize:13,fontWeight:700}}>{user?.agency?.agencyName}</div>
          <div style={{fontSize:11,opacity:.6}}>{user?.bank?.bankName}</div>
        </div>
        <nav style={{flex:1,padding:'12px 8px'}}>
          {[['/', '📊 Dashboard'], ['/agents', '👤 Agents'], ['/cardholders', '💳 Porteurs']].map(([to,label])=>(
            <Link key={to} to={to} style={{display:'block',padding:'10px 12px',borderRadius:8,color:'rgba(255,255,255,0.85)',textDecoration:'none',fontSize:13,marginBottom:4}}>{label}</Link>
          ))}
        </nav>
        <div style={{padding:16,borderTop:'1px solid rgba(255,255,255,0.1)'}}>
          <div style={{fontSize:12,opacity:.7}}>{user?.firstName} {user?.lastName}</div>
          <button onClick={()=>{logout();navigate('/login');}} style={{marginTop:8,background:'none',border:'1px solid rgba(255,255,255,0.3)',color:'#fff',padding:'6px 12px',borderRadius:6,cursor:'pointer',fontSize:12,width:'100%',fontFamily:FONT}}>Déconnexion</button>
        </div>
      </aside>
      <main style={{marginLeft:220,flex:1,padding:28}}>{children}</main>
    </div>
  );
};

const Login = () => {
  const {login,isAuth}=useAuth(); const navigate=useNavigate();
  const [creds,setCreds]=useState({email:'',password:''}); const [loading,setLoading]=useState(false);
  useEffect(()=>{if(isAuth)navigate('/');},[isAuth,navigate]);
  const submit = async () => {
    setLoading(true);
    try { const {data}=await api.post('/auth/login',creds); login(data.access_token,data.user); navigate('/'); }
    catch(e){ toast.error(e.response?.data?.error||'Identifiants incorrects'); } finally{setLoading(false);}
  };
  return (
    <div style={{minHeight:'100vh',background:`linear-gradient(135deg,#052530,#0d7a8a,${P})`,display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div style={{width:400}}>
        <Box style={{marginBottom:0}}>
          <div style={{textAlign:'center',marginBottom:24}}>
            <img src="/logo-calculus.svg" alt="Calculus Plus" style={{height:48,marginBottom:12}} onError={e=>e.target.style.display='none'} />
            <div style={{fontSize:20,fontWeight:700,color:TEXT,fontFamily:FONT}}>Portail Agence</div>
            <div style={{fontSize:13,color:MUTED}}>C-Pay Distribution Network</div>
          </div>
          <form onSubmit={e => { e.preventDefault(); if (!loading) submit(); }}>
          <Inp label="Email" value={creds.email} onChange={v=>setCreds(c=>({...c,email:v}))} placeholder="admin@agence.cd" />
          <Inp label="Mot de passe" value={creds.password} onChange={v=>setCreds(c=>({...c,password:v}))} type="password" placeholder="••••••••" autoComplete="current-password" required />
          <Btn disabled={loading} style={{width:'100%',marginTop:8}}>{loading?'Connexion…':'Se connecter'}</Btn>
          </form>
          <div style={{ textAlign:'center', marginTop:16, fontSize:11, color:MUTED, fontFamily:FONT }}>C-Pay est un produit de Calculus Plus SAS</div>
        </Box>
      </div>
    </div>
  );
};

const Dashboard = () => {
  const [data,setData]=useState(null);
  useEffect(()=>{ api.get('/dashboard').then(r=>setData(r.data)).catch(()=>{}); },[]);
  if(!data)return<Spin/>;
  return (
    <div>
      <h1 style={{margin:'0 0 20px',fontSize:22,fontWeight:700}}>Dashboard — {data.agency_name}</h1>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,marginBottom:20}}>
        {[['👤','Agents',data.total_agents||0,P],['💳','Porteurs',data.total_cardholders||0,G],['💰','Commissions',fmtNum(data.total_commissions)+' XAF',WARNING]].map(([icon,label,val,color])=>(
          <Box key={label} style={{marginBottom:0,borderTop:`3px solid ${color}`,textAlign:'center'}}>
            <div style={{fontSize:24,marginBottom:8}}>{icon}</div>
            <div style={{fontSize:11,color:MUTED,marginBottom:4}}>{label}</div>
            <div style={{fontSize:22,fontWeight:800,color}}>{val}</div>
          </Box>
        ))}
      </div>
      <Box>
        <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Agents récents</div>
        {(data.recentAgents||[]).length===0?<div style={{color:MUTED,fontSize:13}}>Aucun agent.</div>
          :(data.recentAgents||[]).map(a=>(
            <div key={a.agent_id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:`1px solid ${BORDER}`,fontSize:13}}>
              <div><div style={{fontWeight:600}}>{a.first_name} {a.last_name}</div><div style={{color:MUTED,fontSize:11}}>{a.phone} · {a.cardholder_count||0} porteurs</div></div>
              <div style={{textAlign:'right'}}>
                <div style={{fontSize:12,color:P}}>{a.cards_issued}/{a.cards_limit} cartes</div>
                <Badge label={a.is_active?'Actif':'Inactif'} color={a.is_active?G:DANGER} />
              </div>
            </div>
          ))}
      </Box>
    </div>
  );
};

const Agents = () => {
  const [agents,setAgents]=useState([]); const [showCreate,setShowCreate]=useState(false); const [search,setSearch]=useState('');
  const [form,setForm]=useState({firstName:'',lastName:'',phone:'',email:'',password:'',idType:'national_id',idNumber:'',commissionRate:'0.10',cardsLimit:'200'});
  const [loading,setLoading]=useState(false);
  const f = k => v => setForm(p=>({...p,[k]:v}));
  const load = useCallback(()=>{ api.get('/agents',{params:{search}}).then(r=>setAgents(r.data.data||[])).catch(()=>{}); },[search]);
  useEffect(()=>{ load(); },[load]);

  const create = async () => {
    if(!form.firstName||!form.lastName||!form.phone||!form.password) return toast.error('Champs obligatoires manquants');
    setLoading(true);
    try {
      await api.post('/agents',{...form,commissionRate:parseFloat(form.commissionRate)/100,cardsLimit:parseInt(form.cardsLimit)});
      toast.success('Agent créé'); setShowCreate(false); load();
      setForm({firstName:'',lastName:'',phone:'',email:'',password:'',idType:'national_id',idNumber:'',commissionRate:'0.10',cardsLimit:'200'});
    } catch(e){ toast.error(e.response?.data?.error||'Erreur'); } finally{setLoading(false);}
  };

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
        <h1 style={{margin:0,fontSize:22,fontWeight:700}}>Agents bancaires</h1>
        <Btn onClick={()=>setShowCreate(true)}>+ Nouvel agent</Btn>
      </div>
      <div style={{marginBottom:16}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Rechercher un agent…"
          style={{width:'100%',background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,padding:'10px 14px',fontSize:14,color:TEXT,fontFamily:FONT,boxSizing:'border-box'}} />
      </div>
      {showCreate && (
        <Box style={{border:`2px solid ${P}`,marginBottom:20}}>
          <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Créer un agent</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Inp label="Prénom *" value={form.firstName} onChange={f('firstName')} />
            <Inp label="Nom *" value={form.lastName} onChange={f('lastName')} />
            <Inp label="Téléphone *" value={form.phone} onChange={f('phone')} placeholder="+243810000000" />
            <Inp label="Email" value={form.email} onChange={f('email')} placeholder="agent@agence.cd" />
            <Inp label="Mot de passe *" value={form.password} onChange={f('password')} type="password" />
            <div style={{marginBottom:14}}>
              <label style={{display:'block',fontSize:12,color:MUTED,marginBottom:4}}>Type de pièce</label>
              <select value={form.idType} onChange={e=>f('idType')(e.target.value)} style={{width:'100%',background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:'10px 12px',fontSize:14,color:TEXT,fontFamily:FONT}}>
                <option value="national_id">CNI</option>
                <option value="passport">Passeport</option>
              </select>
            </div>
            <Inp label="Numéro de pièce" value={form.idNumber} onChange={f('idNumber')} />
            <Inp label="Commission (%)" value={form.commissionRate} onChange={f('commissionRate')} placeholder="0.10" />
            <Inp label="Quota cartes" value={form.cardsLimit} onChange={f('cardsLimit')} placeholder="200" />
          </div>
          <div style={{display:'flex',gap:10,marginTop:8}}>
            <Btn onClick={create} disabled={loading}>{loading?'Création…':'Créer l\'agent'}</Btn>
            <Btn outline onClick={()=>setShowCreate(false)}>Annuler</Btn>
          </div>
        </Box>
      )}
      {agents.length===0?<Box><div style={{color:MUTED,textAlign:'center',padding:20}}>Aucun agent trouvé.</div></Box>
        :agents.map(a=>(
          <Box key={a.agent_id} style={{marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
              <div>
                <div style={{fontSize:16,fontWeight:700}}>{a.first_name} {a.last_name}</div>
                <div style={{color:MUTED,fontSize:12,marginTop:2}}>{a.agent_code} · {a.phone}{a.email?` · ${a.email}`:''}</div>
                <div style={{display:'flex',gap:16,marginTop:8,fontSize:13,color:MUTED}}>
                  <span>💳 {a.cards_issued}/{a.cards_limit} cartes</span>
                  <span>👥 {a.cardholder_count||0} porteurs</span>
                  <span>💰 {fmtNum(a.commissions_paid)} XAF</span>
                </div>
              </div>
              <Badge label={a.is_active?'Actif':'Inactif'} color={a.is_active?G:DANGER} />
            </div>
          </Box>
        ))
      }
    </div>
  );
};

const Cardholders = () => {
  const [list,setList]=useState([]); const [total,setTotal]=useState(0); const [search,setSearch]=useState('');
  useEffect(()=>{ api.get('/agents').then(async r=>{
    const agents=r.data.data||[];
    // Récupérer porteurs de tous les agents
    setList(agents);setTotal(agents.length);
  }).catch(()=>{}); },[search]);
  return (
    <div>
      <h1 style={{margin:'0 0 20px',fontSize:22,fontWeight:700}}>Porteurs de carte ({total})</h1>
      <Box><div style={{color:MUTED,fontSize:13,textAlign:'center',padding:20}}>Sélectionnez un agent dans l'onglet Agents pour voir ses porteurs.</div></Box>
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
            <Route path="agents" element={<Agents />} />
            <Route path="cardholders" element={<Cardholders />} />
          </Routes></Layout></Guard>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
