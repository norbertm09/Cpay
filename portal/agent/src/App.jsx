// ================================================================
// C-Pay 2.6 — Portail Agent (agent.c-pay.global)
// ================================================================
import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import axios from 'axios';
import { BrowserRouter, Routes, Route, Link, useNavigate, Navigate } from 'react-router-dom';
import { Toaster, toast } from 'react-hot-toast';

const BASE = process.env.REACT_APP_API_BASE_URL || '';
const api  = axios.create({ baseURL: `${BASE}/api/v1/agent` });
api.interceptors.request.use(cfg => { const t = localStorage.getItem('agt_token'); if (t) cfg.headers.Authorization = `Bearer ${t}`; return cfg; });
api.interceptors.response.use(r => r, e => {
  const st = e.response?.status;
  if (st === 401) {
    // Purge complete (token ET utilisateur) : sinon AuthProvider relit agt_user,
    // considere la session valide et renvoie sur '/' -> 401 -> boucle de redirection.
    localStorage.removeItem('agt_token'); localStorage.removeItem('agt_user');
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
const P='#12b6c7',G='#00c896',DANGER='#ff3b30',WARNING='#ff9500',TEAL='#0d7a8a';
const BG='#f0f4f8',CARD='#fff',BORDER='#dce3ed',TEXT='#1e2d3d',MUTED='#5a6677';
const fmtNum = n => parseFloat(n||0).toLocaleString('fr-FR');

const AuthCtx = createContext(null);
const useAuth = () => useContext(AuthCtx);
const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    try {
      const t = localStorage.getItem('agt_token');
      if (!t || !tokenValid(t)) { localStorage.removeItem('agt_token'); localStorage.removeItem('agt_user'); return null; }
      return JSON.parse(localStorage.getItem('agt_user') || 'null');
    } catch { return null; }
  });
  const login  = (token,u) => { localStorage.setItem('agt_token',token); localStorage.setItem('agt_user',JSON.stringify(u)); setUser(u); };
  const logout = () => { localStorage.removeItem('agt_token'); localStorage.removeItem('agt_user'); setUser(null); };
  return <AuthCtx.Provider value={{user,login,logout,isAuth:!!user}}>{children}</AuthCtx.Provider>;
};

const Box  = ({children,style}) => <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:20,marginBottom:16,...style}}>{children}</div>;
const Btn  = ({children,onClick,color,outline,disabled,style}) => (
  <button onClick={onClick} disabled={disabled} style={{background:outline?'transparent':color||P,color:outline?color||P:'#fff',border:`2px solid ${color||P}`,borderRadius:8,padding:'10px 20px',fontFamily:FONT,fontWeight:700,fontSize:13,cursor:disabled?'not-allowed':'pointer',opacity:disabled?.6:1,...style}}>{children}</button>
);
const _slugId = s => 'f-' + String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const Inp  = ({label,value,onChange,type='text',placeholder,required,id,name,autoComplete,inputMode}) => {
  const _id = id || _slugId(label);
  return (
  <div style={{marginBottom:14}}>
    {label&&<label htmlFor={_id} style={{display:'block',fontSize:12,color:MUTED,marginBottom:4,fontFamily:FONT}}>{label}{required&&<span style={{color:DANGER}}> *</span>}</label>}
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
  const agent=user?.agent||{};
  const pct = agent.cardsLimit ? Math.round((agent.cardsIssued/agent.cardsLimit)*100) : 0;
  return (
    <div style={{display:'flex',minHeight:'100vh',background:BG,fontFamily:FONT}}>
      <aside style={{width:220,background:TEAL,color:'#fff',display:'flex',flexDirection:'column',position:'fixed',top:0,bottom:0,zIndex:10}}>
        <div style={{padding:'20px 16px',borderBottom:'1px solid rgba(255,255,255,0.1)'}}>
          <img src="/logo-calculus.svg" alt="Calculus Plus" style={{height:36,marginBottom:8}} onError={e=>e.target.style.display='none'} />
          <div style={{fontSize:11,opacity:.7}}>Portail Agent</div>
          <div style={{fontSize:13,fontWeight:700}}>{user?.firstName} {user?.lastName}</div>
          <div style={{fontSize:11,opacity:.6,marginTop:2}}>{user?.agency?.agencyName}</div>
        </div>
        {/* Quota barre */}
        <div style={{padding:'12px 16px',borderBottom:'1px solid rgba(255,255,255,0.1)'}}>
          <div style={{fontSize:11,opacity:.7,marginBottom:6}}>Cartes émises : {agent.cardsIssued||0}/{agent.cardsLimit||0}</div>
          <div style={{background:'rgba(255,255,255,0.2)',borderRadius:4,height:6,overflow:'hidden'}}>
            <div style={{background:pct>=90?DANGER:G,height:'100%',width:`${Math.min(pct,100)}%`,transition:'width .3s'}} />
          </div>
        </div>
        <nav style={{flex:1,padding:'12px 8px'}}>
          {[['/', '📊 Dashboard'], ['/enroll', '➕ Enrôler'], ['/cardholders', '💳 Mes porteurs']].map(([to,label])=>(
            <Link key={to} to={to} style={{display:'block',padding:'10px 12px',borderRadius:8,color:'rgba(255,255,255,0.85)',textDecoration:'none',fontSize:13,marginBottom:4}}>{label}</Link>
          ))}
        </nav>
        <div style={{padding:16,borderTop:'1px solid rgba(255,255,255,0.1)'}}>
          <button onClick={()=>{logout();navigate('/login');}} style={{background:'none',border:'1px solid rgba(255,255,255,0.3)',color:'#fff',padding:'6px 12px',borderRadius:6,cursor:'pointer',fontSize:12,width:'100%',fontFamily:FONT}}>Déconnexion</button>
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
    <div style={{minHeight:'100vh',background:`linear-gradient(135deg,#052530,${TEAL},${P})`,display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div style={{width:400}}>
        <Box style={{marginBottom:0}}>
          <div style={{textAlign:'center',marginBottom:24}}>
            <img src="/logo-calculus.svg" alt="Calculus Plus" style={{height:48,marginBottom:12}} onError={e=>e.target.style.display='none'} />
            <div style={{fontSize:20,fontWeight:700,color:TEXT,fontFamily:FONT}}>Portail Agent</div>
            <div style={{fontSize:13,color:MUTED}}>C-Pay Distribution Network</div>
          </div>
          <form onSubmit={e => { e.preventDefault(); if (!loading) submit(); }}>
          <Inp label="Email ou téléphone" value={creds.email} onChange={v=>setCreds(c=>({...c,email:v}))} placeholder="agent@agence.cd" />
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
  const {user}=useAuth();
  const [data,setData]=useState(null);
  useEffect(()=>{ api.get('/dashboard').then(r=>setData(r.data)).catch(()=>{}); },[]);
  if(!data)return<Spin/>;
  const agent=data||{}; const perf=agent.performance||agent;
  return (
    <div>
      <h1 style={{margin:'0 0 20px',fontSize:22,fontWeight:700}}>Bonjour, {user?.firstName} 👋</h1>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:14,marginBottom:20}}>
        {[['💳','Cartes émises',`${agent.cards_issued||0}/${agent.cards_limit||0}`,P],['👥','Porteurs actifs',agent.active_cardholders||0,G],['📅','Enrôlés aujourd\'hui',agent.todayEnrolled||0,WARNING]].map(([icon,label,val,color])=>(
          <Box key={label} style={{marginBottom:0,borderTop:`3px solid ${color}`,textAlign:'center'}}>
            <div style={{fontSize:24,marginBottom:8}}>{icon}</div>
            <div style={{fontSize:11,color:MUTED,marginBottom:4}}>{label}</div>
            <div style={{fontSize:20,fontWeight:800,color}}>{val}</div>
          </Box>
        ))}
      </div>
      {/* Quota */}
      <Box style={{marginBottom:20}}>
        <div style={{display:'flex',justifyContent:'space-between',marginBottom:8,fontSize:13}}>
          <span style={{fontWeight:600}}>Quota cartes</span>
          <span style={{color:MUTED}}>{agent.cards_issued||0} / {agent.cards_limit||0}</span>
        </div>
        <div style={{background:BG,borderRadius:6,height:10,overflow:'hidden'}}>
          <div style={{background:P,height:'100%',width:`${Math.min(((agent.cards_issued||0)/(agent.cards_limit||1))*100,100)}%`,borderRadius:6,transition:'width .5s'}} />
        </div>
      </Box>
      <Box>
        <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Derniers porteurs enrôlés</div>
        {(data.recentCardholders||[]).length===0?<div style={{color:MUTED,fontSize:13,textAlign:'center',padding:16}}>Aucun porteur enrôlé.</div>
          :(data.recentCardholders||[]).map(ch=>(
            <div key={ch.cardholder_id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:`1px solid ${BORDER}`,fontSize:13}}>
              <div>
                <div style={{fontWeight:600}}>{ch.first_name} {ch.last_name}</div>
                <div style={{color:MUTED,fontSize:11}}>{ch.phone} · {ch.card_masked}</div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontWeight:700,color:G}}>{fmtNum(ch.balance)} XAF</div>
                <Badge label={ch.card_status==='active'?'Active':'Gelée'} color={ch.card_status==='active'?G:DANGER} />
              </div>
            </div>
          ))}
      </Box>
    </div>
  );
};

const Enroll = () => {
  const [form,setForm]=useState({firstName:'',lastName:'',phone:'',email:'',dateOfBirth:'',idType:'national_id',idNumber:'',country:'CM',password:'',confirmPassword:''});
  const [loading,setLoading]=useState(false); const [success,setSuccess]=useState(null);
  const [step,setStep]=useState(1);
  const f = k => v => setForm(p=>({...p,[k]:v}));

  const CEMAC=[['CM','🇨🇲 Cameroun'],['CG','🇨🇬 Congo'],['GA','🇬🇦 Gabon'],['CF','🇨🇫 RCA'],['TD','🇹🇩 Tchad'],['GQ','🇬🇶 Guinée Éq.'],['CD','🇨🇩 RDC']];
  const pwdStrength = p => { let s=0; if(p.length>=6)s++; if(/[A-Z]/.test(p))s++; if(/[0-9]/.test(p))s++; if(/[^A-Za-z0-9]/.test(p))s++; return s; };

  const validate1 = () => {
    if(!form.firstName||!form.lastName||!form.phone) { toast.error('Prénom, nom et téléphone requis'); return false; }
    return true;
  };
  const validate2 = () => {
    if(!form.password||form.password.length<6) { toast.error('Mot de passe trop court (min 6 caractères)'); return false; }
    if(form.password!==form.confirmPassword) { toast.error('Les mots de passe ne correspondent pas'); return false; }
    return true;
  };

  const submit = async () => {
    if(!validate2()) return;
    setLoading(true);
    try {
      const {data}=await api.post('/cardholders',form);
      setSuccess(data); setStep(1);
      setForm({firstName:'',lastName:'',phone:'',email:'',dateOfBirth:'',idType:'national_id',idNumber:'',country:'CM',password:'',confirmPassword:''});
      toast.success('Porteur enrôlé avec succès !');
    } catch(e){ toast.error(e.response?.data?.error||'Erreur lors de l\'enrôlement'); }
    finally{setLoading(false);}
  };

  const sel = {width:'100%',background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:'10px 12px',fontSize:14,color:TEXT,fontFamily:FONT};

  return (
    <div>
      <h1 style={{margin:'0 0 20px',fontSize:22,fontWeight:700}}>Enrôler un porteur de carte</h1>

      {success && (
        <Box style={{border:`2px solid ${G}`,background:`${G}08`,marginBottom:20}}>
          <div style={{fontSize:16,fontWeight:700,color:G,marginBottom:12}}>✅ Porteur enrôlé avec succès !</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,fontSize:13}}>
            <div><span style={{color:MUTED}}>Nom :</span> <strong>{form.firstName||success.card?.cardholderName}</strong></div>
            <div><span style={{color:MUTED}}>Carte :</span> <strong style={{fontFamily:'monospace'}}>{success.card?.cardMasked}</strong></div>
            <div><span style={{color:MUTED}}>Expiration :</span> <strong>12/{success.card?.expiryYear}</strong></div>
            <div><span style={{color:MUTED}}>Solde initial :</span> <strong>0 XAF</strong></div>
          </div>
          <div style={{marginTop:12,padding:'10px 14px',background:`${P}10`,borderRadius:8,fontSize:12,color:TEXT}}>
            📱 Le porteur peut se connecter sur <strong>app.c-pay.global</strong> avec son téléphone et le mot de passe défini.
          </div>
          <Btn onClick={()=>setSuccess(null)} style={{marginTop:12}} color={G}>Enrôler un autre porteur</Btn>
        </Box>
      )}

      {/* Indicateur étapes */}
      <div style={{display:'flex',gap:8,marginBottom:20}}>
        {[1,2].map(s=>(
          <div key={s} style={{flex:1,height:4,borderRadius:2,background:s<=step?P:BORDER,transition:'background .3s'}} />
        ))}
      </div>
      <div style={{fontSize:12,color:MUTED,marginBottom:16,textAlign:'center'}}>
        Étape {step} sur 2 — {step===1?'Informations personnelles':'Sécurité'}
      </div>

      <Box>
        {step===1 ? (
          <>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
              <Inp label="Prénom" required value={form.firstName} onChange={f('firstName')} placeholder="Jean" />
              <Inp label="Nom" required value={form.lastName} onChange={f('lastName')} placeholder="Dupont" />
              <Inp label="Téléphone" required value={form.phone} onChange={f('phone')} placeholder="+243810000000" type="tel" />
              <Inp label="Email" value={form.email} onChange={f('email')} placeholder="jean@email.cd" type="email" />
              <Inp label="Date de naissance" value={form.dateOfBirth} onChange={f('dateOfBirth')} type="date" />
              <div style={{marginBottom:14}}>
                <label style={{display:'block',fontSize:12,color:MUTED,marginBottom:4}}>Type de pièce</label>
                <select value={form.idType} onChange={e=>f('idType')(e.target.value)} style={sel}>
                  <option value="national_id">CNI</option>
                  <option value="passport">Passeport</option>
                  <option value="drivers_license">Permis de conduire</option>
                </select>
              </div>
              <Inp label="Numéro de pièce" value={form.idNumber} onChange={f('idNumber')} placeholder="123456789" />
              <div style={{marginBottom:14}}>
                <label style={{display:'block',fontSize:12,color:MUTED,marginBottom:4}}>Pays</label>
                <select value={form.country} onChange={e=>f('country')(e.target.value)} style={sel}>
                  {CEMAC.map(([v,l])=><option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
            <Btn onClick={()=>{ if(validate1()) setStep(2); }} style={{width:'100%',marginTop:8}}>Continuer →</Btn>
          </>
        ) : (
          <>
            <div style={{marginBottom:14}}>
              <Inp label="Mot de passe" required value={form.password} onChange={f('password')} type="password" placeholder="••••••••" />
              {form.password && (
                <div style={{marginTop:-8,marginBottom:12}}>
                  <div style={{display:'flex',gap:4,marginBottom:6}}>
                    {[1,2,3,4].map(i=>(
                      <div key={i} style={{flex:1,height:3,borderRadius:2,background:i<=pwdStrength(form.password)?[DANGER,WARNING,P,G][pwdStrength(form.password)-1]||G:BORDER}} />
                    ))}
                  </div>
                  <div style={{display:'flex',gap:12,fontSize:10,color:MUTED}}>
                    {[[form.password.length>=6,'6 car.'],[/[A-Z]/.test(form.password),'Majuscule'],[/[0-9]/.test(form.password),'Chiffre']].map(([ok,l])=>(
                      <span key={l} style={{color:ok?G:MUTED}}>{ok?'✓':'○'} {l}</span>
                    ))}
                  </div>
                </div>
              )}
              <Inp label="Confirmer le mot de passe" required value={form.confirmPassword} onChange={f('confirmPassword')} type="password" placeholder="••••••••" />
            </div>
            <div style={{background:`${P}08`,border:`1px solid ${P}20`,borderRadius:8,padding:12,marginBottom:16,fontSize:12,color:MUTED}}>
              🌍 Une carte virtuelle GIMAC sera automatiquement créée pour ce porteur.
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <Btn outline onClick={()=>setStep(1)}>← Retour</Btn>
              <Btn onClick={submit} disabled={loading} color={G}>{loading?'Enrôlement…':'✓ Enrôler'}</Btn>
            </div>
          </>
        )}
      </Box>
    </div>
  );
};

const Cardholders = () => {
  const [list,setList]=useState([]); const [total,setTotal]=useState(0);
  const [search,setSearch]=useState(''); const [page,setPage]=useState(1);
  const LIMIT=15;

  const load = useCallback(()=>{
    api.get('/cardholders',{params:{page,limit:LIMIT,search}}).then(r=>{ setList(r.data.data||[]); setTotal(r.data.total||0); }).catch(()=>{});
  },[page,search]);
  useEffect(()=>{ load(); },[load]);

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
        <h1 style={{margin:0,fontSize:22,fontWeight:700}}>Mes porteurs ({total})</h1>
        <Link to="/enroll"><Btn>+ Enrôler</Btn></Link>
      </div>
      <div style={{marginBottom:16}}>
        <input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="Rechercher nom, téléphone ou carte…"
          style={{width:'100%',background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,padding:'10px 14px',fontSize:14,color:TEXT,fontFamily:FONT,boxSizing:'border-box'}} />
      </div>
      {list.length===0?<Box><div style={{color:MUTED,textAlign:'center',padding:20}}>Aucun porteur trouvé.</div></Box>
        :list.map(ch=>(
          <Box key={ch.cardholder_id} style={{marginBottom:10}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <div style={{fontSize:15,fontWeight:700}}>{ch.first_name} {ch.last_name}</div>
                <div style={{color:MUTED,fontSize:12,marginTop:2}}>{ch.phone}{ch.email?` · ${ch.email}`:''}</div>
                <div style={{fontFamily:'monospace',fontSize:13,marginTop:4,color:P}}>{ch.card_masked}</div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontSize:18,fontWeight:800,color:G}}>{fmtNum(ch.balance)} <span style={{fontSize:11}}>XAF</span></div>
                <Badge label={ch.card_status==='active'?'Active':'Gelée'} color={ch.card_status==='active'?G:DANGER} />
              </div>
            </div>
          </Box>
        ))
      }
      {total>LIMIT && (
        <div style={{display:'flex',justifyContent:'center',gap:10,marginTop:16}}>
          <Btn outline onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1}>← Préc.</Btn>
          <span style={{padding:'10px 16px',fontSize:13,color:MUTED}}>Page {page} / {Math.ceil(total/LIMIT)}</span>
          <Btn outline onClick={()=>setPage(p=>p+1)} disabled={page>=Math.ceil(total/LIMIT)}>Suiv. →</Btn>
        </div>
      )}
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
            <Route path="enroll" element={<Enroll />} />
            <Route path="cardholders" element={<Cardholders />} />
          </Routes></Layout></Guard>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
