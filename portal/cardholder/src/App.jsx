// C-Pay 2.6.0 — Cardholder Portal
// Virtual Card: Payment, Top-up, Unload, History, PIN, Profile
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import toast, { Toaster } from 'react-hot-toast';

// ─── Config ───────────────────────────────────────────────────────
const BASE = process.env.REACT_APP_API_BASE_URL || '';
const api  = axios.create({ baseURL: `${BASE}/api/v1/cardholder` });
api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('ch_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});
api.interceptors.response.use(r => r, err => {
  const st = err.response?.status;
  if (st === 401) { localStorage.removeItem('ch_token'); if (window.location.pathname !== '/login') window.location.href = '/login'; }
  else if (st === 403) { toast.error('Accès refusé'); }
  else if (st === 410 || err.response?.data?.code === 'FEATURE_DISABLED') { toast.error('Fonctionnalité en cours d\u2019intégration'); } // topup / unload / paiement tokenisé (hotfix v1)
  return Promise.reject(err);
});

// ─── Auth ─────────────────────────────────────────────────────────
const useAuth = () => {
  const token = localStorage.getItem('ch_token');
  const user  = token ? (() => { try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; } })() : null;
  return { isAuth: !!user && user.exp * 1000 > Date.now(), user };
};
const Guard = ({ children }) => { const { isAuth } = useAuth(); return isAuth ? children : <Navigate to="/login" replace />; };

// ─── i18n ─────────────────────────────────────────────────────────
const T = {
  fr: {
    login:'Se connecter', logout:'Déconnexion', emailOrPhone:'Email ou téléphone',
    password:'Mot de passe', loggingIn:'Connexion…', loginError:'Identifiants incorrects',
    dashboard:'Mon Espace', transactions:'Mes Transactions', payment:'Paiement', topup:'Top-up',
    unload:'Décharger', profile:'Profil', settings:'Paramètres',
    cardBalance:'Solde disponible', cardFrozen:'CARTE GELÉE', cardActive:'ACTIVE',
    freeze:'Geler la carte', unfreeze:'Activer la carte',
    monthSpent:'Dépenses (30j)', monthTopup:'Rechargements', monthCount:'Transactions',
    recentTxn:'Transactions récentes',
    payMerchant:'Payer un marchand', merchantId:'ID ou code marchand',
    amount:'Montant', description:'Description (optionnel)', pin:'Code PIN (4 chiffres)',
    confirmPay:'Confirmer le paiement', paying:'Traitement…',
    paySuccess:'Paiement effectué ✓', payFailed:'Paiement refusé',
    topupTitle:'Recharger via Mobile Money', operator:'Opérateur',
    mmPhone:'Numéro Mobile Money', topupBtn:'Recharger', toppingUp:'Rechargement…',
    topupSuccess:'Carte rechargée ✓', fee:'Frais', net:'Net crédité',
    unloadTitle:'Transférer vers Mobile Money', unloadBtn:'Transférer', unloading:'Transfert…',
    unloadSuccess:'Transfert effectué ✓', unloadFeeNote:'Frais 1.5% déduits de votre carte',
    txnPayment:'Paiement', txnTopup:'Rechargement', txnUnload:'Déchargement',
    txnFee:'Frais', txnRefund:'Remboursement', noTxn:'Aucune transaction',
    pinTitle:'Changer le code PIN', currentPin:'PIN actuel', newPin:'Nouveau PIN (4 chiffres)',
    confirmPin:'Confirmer le PIN', pinChanged:'PIN modifié ✓', pinError:'PIN actuel incorrect',
    pinMismatch:'Les PIN ne correspondent pas', pinInvalid:'PIN doit être 4 chiffres',
    profileTitle:'Mes informations', emailLabel:'Email', phoneLabel:'Téléphone',
    addressLabel:'Adresse', cityLabel:'Ville', save:'Enregistrer', saving:'Enregistrement…',
    profileSaved:'Profil mis à jour ✓', changePwd:'Changer le mot de passe',
    currentPwd:'Mot de passe actuel', newPwd:'Nouveau mot de passe', pwdChanged:'Mot de passe changé ✓',
    pwdError:'Mot de passe actuel incorrect', language:'English',
    balance:'Solde', status:'Statut', date:'Date', type:'Type', network:'Réseau',
    newBalance:'Nouveau solde', loading:'Chargement…', error:'Erreur', retry:'Réessayer',
    freezeConfirm:'Geler la carte ? Les paiements seront bloqués.',
    unfreezeConfirm:'Activer la carte ?',
    insufficientBalance:'Solde insuffisant', pinRequired:'PIN requis',
  },
  en: {
    login:'Sign in', logout:'Sign out', emailOrPhone:'Email or phone',
    password:'Password', loggingIn:'Signing in…', loginError:'Invalid credentials',
    dashboard:'My Space', transactions:'My Transactions', payment:'Payment', topup:'Top-up',
    unload:'Unload', profile:'Profile', settings:'Settings',
    cardBalance:'Available balance', cardFrozen:'CARD FROZEN', cardActive:'ACTIVE',
    freeze:'Freeze card', unfreeze:'Unfreeze card',
    monthSpent:'Spending (30d)', monthTopup:'Top-ups', monthCount:'Transactions',
    recentTxn:'Recent transactions',
    payMerchant:'Pay a merchant', merchantId:'Merchant ID or code',
    amount:'Amount', description:'Description (optional)', pin:'PIN code (4 digits)',
    confirmPay:'Confirm payment', paying:'Processing…',
    paySuccess:'Payment successful ✓', payFailed:'Payment declined',
    topupTitle:'Top-up via Mobile Money', operator:'Operator',
    mmPhone:'Mobile Money number', topupBtn:'Top-up', toppingUp:'Topping up…',
    topupSuccess:'Card topped up ✓', fee:'Fee', net:'Net credited',
    unloadTitle:'Transfer to Mobile Money', unloadBtn:'Transfer', unloading:'Transferring…',
    unloadSuccess:'Transfer successful ✓', unloadFeeNote:'1.5% fee deducted from your card',
    txnPayment:'Payment', txnTopup:'Top-up', txnUnload:'Unload',
    txnFee:'Fee', txnRefund:'Refund', noTxn:'No transactions',
    pinTitle:'Change PIN', currentPin:'Current PIN', newPin:'New PIN (4 digits)',
    confirmPin:'Confirm PIN', pinChanged:'PIN changed ✓', pinError:'Current PIN incorrect',
    pinMismatch:'PINs do not match', pinInvalid:'PIN must be 4 digits',
    profileTitle:'My information', emailLabel:'Email', phoneLabel:'Phone',
    addressLabel:'Address', cityLabel:'City', save:'Save', saving:'Saving…',
    profileSaved:'Profile updated ✓', changePwd:'Change password',
    currentPwd:'Current password', newPwd:'New password', pwdChanged:'Password changed ✓',
    pwdError:'Current password is incorrect', language:'Français',
    balance:'Balance', status:'Status', date:'Date', type:'Type', network:'Network',
    newBalance:'New balance', loading:'Loading…', error:'Error', retry:'Retry',
    freezeConfirm:'Freeze the card? Payments will be blocked.',
    unfreezeConfirm:'Activate the card?',
    insufficientBalance:'Insufficient balance', pinRequired:'PIN required',
  }
};
const useLang = () => {
  const [lang, setLang] = useState(localStorage.getItem('ch_lang') || 'fr');
  const toggle = () => { const n = lang === 'fr' ? 'en' : 'fr'; localStorage.setItem('ch_lang', n); setLang(n); };
  return { lang, toggle };
};

// ─── Styles ───────────────────────────────────────────────────────
const P = '#12b6c7', BG = '#f0f4f8', CARD = '#fff', BORDER = '#dce3ed', TEXT = '#1e2d3d', MUTED = '#5a6677';
const FONT = "Inter, 'Century Gothic', 'URW Gothic', Jost, system-ui, sans-serif";
const FONT_TITRE = "Jost, 'Century Gothic', 'URW Gothic', Questrial, system-ui, sans-serif";
const DANGER = '#ff3b30', SUCCESS = '#00c896', WARNING = '#ff9500', BLUE = '#1d4f92';
const sc = s => ({ active:SUCCESS, frozen:WARNING, cancelled:DANGER, completed:SUCCESS, failed:DANGER, pending:WARNING, payment:DANGER, topup:SUCCESS, unload:WARNING, fee:MUTED }[s] || MUTED);

// ─── Composants ───────────────────────────────────────────────────
const Box = ({ children, style }) => <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:14, padding:20, marginBottom:14, fontFamily:FONT, ...style }}>{children}</div>;
const Badge = ({ label, color=MUTED }) => <span style={{ display:'inline-block', padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:`${color}22`, color }}>{label}</span>;
const Spin  = () => <div style={{ textAlign:'center', padding:40, color:MUTED }}>⏳</div>;
const Btn   = ({ children, onClick, color=P, outline, small, disabled, style:s }) => (
  <button onClick={onClick} disabled={disabled} style={{ background:outline?'transparent':color, color:outline?color:'#fff', border:`2px solid ${color}`, borderRadius:10, padding:small?'6px 14px':'11px 20px', fontSize:small?12:14, fontWeight:700, cursor:disabled?'not-allowed':'pointer', opacity:disabled?0.55:1, fontFamily:FONT, ...s }}>{children}</button>
);
const _slugId = s => 'f-' + String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const Inp   = ({ label, value, onChange, type='text', placeholder, maxLength, pattern, id, name, autoComplete, required, inputMode }) => {
  const _id = id || _slugId(label);
  return (
  <div style={{ marginBottom:14 }}>
    {label && <label htmlFor={_id} style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{label}</label>}
    <input id={_id} name={name || _id} type={type} value={value||''} onChange={e=>onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength} pattern={pattern} autoComplete={autoComplete} required={required} inputMode={inputMode}
      style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', color:TEXT, fontSize:14, boxSizing:'border-box', fontFamily:FONT, outline:'none' }} />
  </div>
  );
};
const Sel   = ({ label, value, onChange, options }) => (
  <div style={{ marginBottom:14 }}>
    {label && <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{label}</label>}
    <select value={value} onChange={e=>onChange(e.target.value)} style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', color:TEXT, fontSize:14, boxSizing:'border-box', fontFamily:FONT }}>
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  </div>
);
const Modal = ({ title, onClose, children }) => (
  <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
    <Box style={{ width:440, maxHeight:'90vh', overflowY:'auto', margin:0 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
        <span style={{ fontSize:17, fontWeight:700, fontFamily:FONT }}>{title}</span>
        <button onClick={onClose} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:MUTED }}>✕</button>
      </div>
      {children}
    </Box>
  </div>
);
const PinInput = ({ value, onChange, placeholder }) => (
  <input type="password" inputMode="numeric" maxLength={4} value={value} onChange={e=>onChange(e.target.value.replace(/\D/g,'').slice(0,4))} placeholder={placeholder||'••••'}
    style={{ width:'100%', background:BG, border:`2px solid ${BORDER}`, borderRadius:8, padding:'12px', fontSize:22, letterSpacing:8, textAlign:'center', color:TEXT, fontFamily:'monospace', boxSizing:'border-box' }} />
);
const fmtDate = (d, lang) => d ? new Date(d).toLocaleString(lang==='fr'?'fr-FR':'en-US') : '—';
const fmtNum  = n => parseFloat(n||0).toLocaleString('fr-FR');

const OPERATORS = [
  { v:'mtn', l:'MTN Mobile Money' }, { v:'orange', l:'Orange Money' },
  { v:'airtel', l:'Airtel Money' }, { v:'vodacom', l:'Vodacom M-Pesa' },
];

// ─── LAYOUT ───────────────────────────────────────────────────────
// Libelle volontairement factuel : "PCI-DSS v4.0" seul se lit comme une
// revendication de certification, or aucune AoC n'a ete delivree par un QSA.
// AES-256-GCM decrit ce que le systeme fait reellement et rassure autant.
// Le nom du composant est conserve pour ne pas casser ses appels.
const PciSecurityBadge = () => (
  <div style={{ display:'flex', alignItems:'center', gap:6, background:'#f0f4f8', borderRadius:8, padding:'6px 12px', fontSize:11, color:'#5a6677', fontFamily:"'Century Gothic',sans-serif" }}>
    <span style={{ fontSize:14 }}>🔒</span>
    <span>Chiffrement AES-256</span>
  </div>
);

// ─── 2FA BANNER ───────────────────────────────────────────────────
const TwoFABanner = ({ lang, onSetup }) => {
  const [status, setStatus]       = useState(null);
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem('2fa_dismissed_ch') === '1'
  );
  useEffect(() => {
    api.get('/auth/2fa/status').then(r=>setStatus(r.data)).catch(()=>{});
  }, []);
  if (!status || status.mfaEnabled || dismissed) return null;
  return (
    <div style={{ background:'transparent', padding:'6px 16px', display:'flex', justifyContent:'flex-end' }}>
      <div style={{ background:'#ff9500', color:'#fff', padding:'6px 14px',
        display:'inline-flex', alignItems:'center', gap:8,
        fontSize:12, fontFamily:FONT, borderRadius:20,
        boxShadow:'0 2px 8px rgba(255,149,0,0.3)' }}>
        <span>🔐 {lang==='fr'?'Activez la 2FA':'Enable 2FA'}</span>
        <button onClick={onSetup}
          style={{ background:'#fff', color:'#ff9500', border:'none', borderRadius:10,
            padding:'3px 8px', cursor:'pointer', fontSize:11, fontWeight:700, fontFamily:FONT }}>
          {lang==='fr'?'Activer':'Enable'}
        </button>
        <button onClick={()=>{ setDismissed(true); sessionStorage.setItem('2fa_dismissed_ch','1'); }}
          style={{ background:'none', border:'none', color:'#fff', cursor:'pointer', fontSize:14, lineHeight:1, padding:0 }}>
          ×
        </button>
      </div>
    </div>
  );
};

// ─── 2FA SETUP MODAL ──────────────────────────────────────────────
const TwoFASetup = ({ lang, onClose, onSuccess }) => {
  const [step, setStep] = useState('generate');
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.post('/auth/2fa/setup').then(r => { setQrCode(r.data.qrCode); setSecret(r.data.secret); }).catch(()=>toast.error('Erreur'));
  }, []);

  const verify = async () => {
    if (code.length !== 6) return toast.error('Code 6 chiffres requis');
    setLoading(true);
    try {
      await api.post('/auth/2fa/verify', { token: code });
      setStep('done');
      onSuccess && onSuccess();
    } catch(err) { toast.error(err.response?.data?.error || 'Code invalide'); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:3000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:16, padding:32, width:440, maxWidth:'100%' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <div style={{ fontSize:18, fontWeight:700, fontFamily:FONT }}>🔐 {lang==='fr'?'Configurer la 2FA':'Setup 2FA'}</div>
          {step !== 'done' && <button onClick={onClose} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:MUTED }}>×</button>}
        </div>
        {step === 'generate' && (<>
          <div style={{ background:BG, borderRadius:10, padding:14, marginBottom:16, fontSize:13, color:MUTED }}>
            1️⃣ {lang==='fr'?'Scannez ce QR code avec Google Authenticator ou Authy':'Scan with Google Authenticator or Authy'}
          </div>
          {qrCode && <img src={qrCode} alt="QR" style={{ width:'100%', maxWidth:220, display:'block', margin:'0 auto 16px', borderRadius:8 }} />}
          <div style={{ background:BG, borderRadius:8, padding:10, marginBottom:16, fontSize:11, fontFamily:'monospace', wordBreak:'break-all', textAlign:'center' }}>{secret}</div>
          <button onClick={()=>setStep('verify')}
            style={{ width:'100%', background:P, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:FONT }}>
            {lang==='fr'?'Suivant →':'Next →'}
          </button>
        </>)}
        {step === 'verify' && (<>
          <div style={{ background:BG, borderRadius:10, padding:14, marginBottom:16, fontSize:13, color:MUTED }}>
            2️⃣ {lang==='fr'?'Entrez le code à 6 chiffres de votre application':'Enter the 6-digit code from your app'}
          </div>
          <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))}
            placeholder="000000" maxLength={6} autoFocus
            style={{ width:'100%', textAlign:'center', fontSize:28, letterSpacing:8, padding:'14px', border:`2px solid ${BORDER}`, borderRadius:10, fontFamily:'monospace', marginBottom:16, boxSizing:'border-box' }} />
          <button onClick={verify} disabled={loading||code.length!==6}
            style={{ width:'100%', background:SUCCESS, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:14, fontWeight:700, cursor:loading||code.length!==6?'not-allowed':'pointer', fontFamily:FONT, opacity:loading||code.length!==6?0.7:1 }}>
            {loading?(lang==='fr'?'Vérification…':'Verifying…'):(lang==='fr'?'✅ Activer':'✅ Enable')}
          </button>
          <button onClick={()=>setStep('generate')} style={{ width:'100%', background:'none', border:'none', color:MUTED, cursor:'pointer', marginTop:10, fontSize:13 }}>← {lang==='fr'?'Retour':'Back'}</button>
        </>)}
        {step === 'done' && (
          <div style={{ textAlign:'center', padding:'20px 0' }}>
            <div style={{ fontSize:64, marginBottom:16 }}>✅</div>
            <div style={{ fontSize:18, fontWeight:700, color:SUCCESS, marginBottom:8 }}>{lang==='fr'?'2FA activée !':'2FA enabled!'}</div>
            <button onClick={onClose} style={{ width:'100%', background:SUCCESS, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:FONT }}>
              {lang==='fr'?'Terminer':'Done'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};


// ─── CONSENT MODAL ────────────────────────────────────────────────
const ConsentModal = ({ userId, onAccepted }) => {
  const [cgu, setCgu]         = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [saving, setSaving]   = useState(false);
  const accept = async () => {
    if (!cgu || !privacy) return toast.error('Acceptez les CGU et la politique de confidentialite');
    setSaving(true);
    try {
      await fetch((process.env.REACT_APP_API_BASE_URL||'') + '/api/v1/consent/accept', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ userId, userType:'cardholder', portal:'cardholder', cguAccepted:true, privacyAccepted:true })
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
          <div style={{ fontSize:12, color:'#5a6677', marginTop:4 }}>Veuillez lire et accepter avant de continuer.</div>
        </div>
        <div style={{ background:'#f0f4f8', borderRadius:10, padding:14, marginBottom:12, fontSize:13, maxHeight:150, overflowY:'auto' }}>
          <strong style={{ color:'#1d4f92' }}>CGU — Calculus Plus SAS</strong>
          <ul style={{ marginTop:8, paddingLeft:16 }}>
            <li>Service reserve aux personnes de 18 ans ou plus</li>
            <li>Usage strictement personnel et non frauduleux</li>
            <li>Droit applicable : Zone CEMAC</li>
          </ul>
          <a href="https://c-pay.global/legal/cgu.html" target="_blank" rel="noreferrer" style={{ color:'#12b6c7', fontSize:12 }}>Lire les CGU completes</a>
        </div>
        <div style={{ background:'#f0f4f8', borderRadius:10, padding:14, marginBottom:16, fontSize:13, maxHeight:120, overflowY:'auto' }}>
          <strong style={{ color:'#1d4f92' }}>Politique de Confidentialite</strong>
          <ul style={{ marginTop:8, paddingLeft:16 }}>
            <li>Donnees collectees pour executer les transactions</li>
            <li>Aucune vente de donnees a des tiers</li>
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

const Layout = ({ children, lang, toggleLang }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = window.location;
  const nav = [
    { path:'/',             icon:'🏠', label:lang==='fr'?'Mon Espace':'My Space' },
    { path:'/transactions', icon:'📋', label:lang==='fr'?'Mes Transactions':'My Transactions' },
    { path:'/cards',        icon:'💳', label:lang==='fr'?'Mes Cartes':'My Cards' },
    { path:'/incidents',    icon:'🚨', label:lang==='fr'?'Mes Incidents':'My Incidents' },
    { path:'/profile',      icon:'👤', label:lang==='fr'?'Mon Profil':'My Profile' },
  ];
  const t = k => T[lang][k] || k;
  const [show2FA, setShow2FA] = useState(false);
  // Hauteur bandeau 2FA
  const [bannerHeight, setBannerHeight] = useState(0);
  const [showConsent, setShowConsent]       = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);

  useEffect(()=>{
    if (user?.userId && !consentChecked) {
      fetch((process.env.REACT_APP_API_BASE_URL||'') + '/api/v1/consent/check?userId=' + user.userId + '&userType=cardholder&portal=cardholder')
        .then(r=>r.json())
        .then(d=>{ if (!d.hasConsented) setShowConsent(true); setConsentChecked(true); })
        .catch(()=>setConsentChecked(true));
    }
  }, [user, consentChecked]);

  return (
    <div style={{ display:'flex', flexDirection:'column', minHeight:'100vh', background:BG, fontFamily:FONT }}>
      {show2FA && <TwoFASetup lang={lang} onClose={()=>setShow2FA(false)} onSuccess={()=>setShow2FA(false)} />}
      {showConsent && <ConsentModal userId={user?.userId} onAccepted={()=>setShowConsent(false)} />}
      {/* Bandeau 2FA fixed en haut */}
      <div ref={el=>{ if(el) setBannerHeight(el.offsetHeight); }}
        style={{ position:'fixed', top:0, left:0, right:0, zIndex:200 }}>
        <TwoFABanner lang={lang} onSetup={()=>setShow2FA(true)} />
      </div>
      <div style={{ display:'flex', flex:1, paddingTop:bannerHeight }}>
      {/* Sidebar */}
      <aside style={{ width:220, background:CARD, borderRight:`1px solid ${BORDER}`, display:'flex', flexDirection:'column', position:'fixed', top:bannerHeight, bottom:0, left:0, zIndex:100 }}>
        <div style={{ padding:'16px 16px 12px', borderBottom:`1px solid ${BORDER}` }}>
          <img src="/logo-calculus.svg" alt="Calculus Plus" style={{ width:'100%', maxWidth:175, height:'auto', objectFit:'contain' }} />
          <div style={{ fontSize:10, color:MUTED, marginTop:4, fontFamily:FONT }}>C-Pay — Espace Porteur</div>
        </div>
        <nav style={{ flex:1, padding:'10px 0', overflowY:'auto' }}>
          {nav.map(n => (
            <Link key={n.path} to={n.path} style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 18px', color:pathname===n.path?P:MUTED, textDecoration:'none', fontSize:13, fontWeight:pathname===n.path?700:400, background:pathname===n.path?`${P}12`:'transparent', borderLeft:`3px solid ${pathname===n.path?P:'transparent'}` }}>
              <span>{n.icon}</span><span>{n.label || t(n.key||'')}</span>
            </Link>
          ))}
        </nav>
        <div style={{ padding:'12px 16px', borderTop:`1px solid ${BORDER}` }}>
          <button onClick={toggleLang} style={{ background:'none', border:`1px solid ${BORDER}`, color:TEXT, padding:'6px 10px', borderRadius:6, cursor:'pointer', fontSize:12, marginBottom:8, width:'100%', fontFamily:FONT }}>🌐 {t('language')}</button>
          <button onClick={() => { localStorage.removeItem('ch_token'); navigate('/login'); }} style={{ background:'none', border:`1px solid ${BORDER}`, color:MUTED, padding:'6px 10px', borderRadius:6, cursor:'pointer', fontSize:12, width:'100%', fontFamily:FONT }}>{t('logout')}</button>
          <div style={{ marginTop:12, paddingTop:10, borderTop:`1px solid ${BORDER}`, fontSize:10, color:MUTED, textAlign:'center' }}>
            <a href="https://c-pay.global/legal/cgu.html" target="_blank" rel="noreferrer" style={{ color:MUTED, display:'block', marginBottom:2 }}>CGU</a>
            <a href="https://c-pay.global/legal/confidentialite.html" target="_blank" rel="noreferrer" style={{ color:MUTED }}>Confidentialité</a>
          </div>
        </div>
      </aside>
      <main style={{ marginLeft:220, flex:1, padding:28 }}>{children}</main>
      </div>
    </div>
  );
};

// ─── LOGIN ────────────────────────────────────────────────────────
// ─── REGISTER ────────────────────────────────────────────────────
const Register = ({ lang, toggleLang }) => {
  const navigate = useNavigate();
  const [step, setStep] = useState(1); // 1=infos 2=identity 3=done
  const [form, setForm] = useState({ firstName:'', lastName:'', email:'', phone:'', password:'', confirmPassword:'', dateOfBirth:'', idType:'national_id', idNumber:'', country:'CG', city:'' });
  const [loading, setLoading] = useState(false);
  const inp = (label, key, opts={}) => (
    <div style={{ marginBottom:12 }}>
      <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{label}</label>
      <input {...opts} value={form[key]} onChange={e=>setForm(p=>({...p,[key]:e.target.value}))}
        style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box' }} />
    </div>
  );

  const submit = async () => {
    if (step === 1) {
      if (!form.firstName || !form.email || !form.phone || !form.password) return toast.error(lang==='fr'?'Champs requis':'Required fields');
      if (form.password !== form.confirmPassword) return toast.error(lang==='fr'?'Mots de passe différents':'Passwords do not match');
      if (form.password.length < 8) return toast.error(lang==='fr'?'8 caractères minimum':'8 characters minimum');
      return setStep(2);
    }
    if (!form.idNumber || !form.dateOfBirth) return toast.error(lang==='fr'?'Champs requis':'Required fields');
    setLoading(true);
    try {
      await api.post('/auth/register', form);
      setStep(3);
    } catch(err){ toast.error(err.response?.data?.error || (lang==='fr'?'Erreur inscription':'Registration error')); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight:'100vh', background:`linear-gradient(135deg, #1d4f92, ${P})`, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, padding:32, width:440, maxWidth:'100%', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ textAlign:'center', marginBottom:24 }}>
          <img src="/logo-calculus.svg" alt="Calculus Plus" style={{ width:180, height:'auto', marginBottom:12 }} />
          <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>{lang==='fr'?'Créer un compte':'Create an account'}</div>
          <div style={{ display:'flex', justifyContent:'center', gap:8, marginTop:12 }}>
            {[1,2].map(s=>(
              <div key={s} style={{ width:32, height:4, borderRadius:2, background:step>=s?P:BORDER }} />
            ))}
          </div>
        </div>

        {step===1 && (<>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <div>{inp(lang==='fr'?'Prénom *':'First name *', 'firstName', {placeholder:'Jean'})}</div>
            <div>{inp(lang==='fr'?'Nom *':'Last name *', 'lastName', {placeholder:'Dupont'})}</div>
          </div>
          {inp('Email *', 'email', {type:'email', placeholder:'jean@exemple.com'})}
          {inp(lang==='fr'?'Téléphone *':'Phone *', 'phone', {type:'tel', placeholder:'+242XXXXXXXXX'})}
          {inp(lang==='fr'?'Mot de passe *':'Password *', 'password', {type:'password', placeholder:'••••••••'})}
          {inp(lang==='fr'?'Confirmer le mot de passe *':'Confirm password *', 'confirmPassword', {type:'password', placeholder:'••••••••'})}
        </>)}

        {step===2 && (<>
          <div style={{ background:`${P}10`, borderRadius:8, padding:12, marginBottom:16, fontSize:12, color:MUTED, fontFamily:FONT }}>
            {lang==='fr'?'Pour votre sécurité, nous avons besoin de vérifier votre identité.':'For your security, we need to verify your identity.'}
          </div>
          {inp(lang==='fr'?'Date de naissance *':'Date of birth *', 'dateOfBirth', {type:'date'})}
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{lang==='fr'?'Type de pièce *':'ID type *'}</label>
            <select value={form.idType} onChange={e=>setForm(p=>({...p,idType:e.target.value}))}
              style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT }}>
              <option value="national_id">{lang==='fr'?'Carte nationale':'National ID'}</option>
              <option value="passport">{lang==='fr'?'Passeport':'Passport'}</option>
              <option value="driver_license">{lang==='fr'?'Permis de conduire':'Driver license'}</option>
            </select>
          </div>
          {inp(lang==='fr'?'Numéro de pièce *':'ID number *', 'idNumber', {placeholder:'123456789'})}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <div>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{lang==='fr'?'Pays':'Country'}</label>
              <select value={form.country} onChange={e=>setForm(p=>({...p,country:e.target.value}))}
                style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT }}>
                <option value="CG">🇨🇬 Congo Brazzaville</option>
                <option value="CD">🇨🇩 RDC</option>
                <option value="CM">🇨🇲 Cameroun</option>
              </select>
            </div>
            <div>{inp(lang==='fr'?'Ville':'City', 'city', {placeholder:'Brazzaville'})}</div>
          </div>
        </>)}

        {step===3 && (
          <div style={{ textAlign:'center', padding:'20px 0' }}>
            <div style={{ fontSize:64, marginBottom:16 }}>✅</div>
            <div style={{ fontSize:18, fontWeight:700, color:SUCCESS, marginBottom:8, fontFamily:FONT }}>
              {lang==='fr'?'Compte créé !':'Account created!'}
            </div>
            <div style={{ fontSize:13, color:MUTED, marginBottom:20 }}>
              {lang==='fr'?'Vous pouvez maintenant vous connecter.':'You can now sign in.'}
            </div>
            <button onClick={()=>navigate('/login')}
              style={{ width:'100%', background:P, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:FONT }}>
              {lang==='fr'?'Se connecter':'Sign in'}
            </button>
          </div>
        )}

        {step < 3 && (
          <button onClick={submit} disabled={loading}
            style={{ width:'100%', background:P, color:'#fff', border:'none', borderRadius:10, padding:'13px', fontSize:15, fontWeight:700, cursor:loading?'not-allowed':'pointer', fontFamily:FONT, marginTop:16, opacity:loading?0.7:1 }}>
            {loading?'...':(step===1?(lang==='fr'?'Suivant →':'Next →'):(lang==='fr'?'Créer mon compte':'Create account'))}
          </button>
        )}

        {step > 1 && step < 3 && (
          <button onClick={()=>setStep(s=>s-1)} style={{ width:'100%', background:'none', border:'none', color:MUTED, cursor:'pointer', marginTop:10, fontSize:13, fontFamily:FONT }}>
            ← {lang==='fr'?'Retour':'Back'}
          </button>
        )}

        {step < 3 && (
          <div style={{ textAlign:'center', marginTop:16, fontSize:13, color:MUTED }}>
            {lang==='fr'?'Déjà un compte ?':'Already have an account?'}{' '}
            <button onClick={()=>navigate('/login')} style={{ background:'none', border:'none', color:P, cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT }}>
              {lang==='fr'?'Se connecter':'Sign in'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── RESET PASSWORD ───────────────────────────────────────────────
const ResetPassword = ({ lang }) => {
  const navigate = useNavigate();
  const urlToken = new URLSearchParams(window.location.search).get('token') || '';
  const [step, setStep] = useState(urlToken ? 'password' : 'email'); // email | sent | password | done
  const [email, setEmail] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [loading, setLoading] = useState(false);

  const sendLink = async () => {
    if (!email) return toast.error(lang==='fr'?'Email requis':'Email required');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setStep('sent');
    } catch(err){ toast.error(err.response?.data?.error||(lang==='fr'?'Erreur':'Error')); }
    finally { setLoading(false); }
  };

  const resetPwd = async () => {
    if (!newPwd || newPwd.length < 8) return toast.error(lang==='fr'?'8 caractères minimum':'8 characters minimum');
    if (!/[A-Z]/.test(newPwd) || !/[a-z]/.test(newPwd) || !/[0-9]/.test(newPwd))
      return toast.error(lang==='fr'?'Majuscule, minuscule et chiffre requis':'Need uppercase, lowercase and digit');
    if (newPwd !== confirmPwd) return toast.error(lang==='fr'?'Mots de passe différents':'Passwords do not match');
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token: urlToken, newPassword: newPwd });
      setStep('done');
    } catch(err){ toast.error(err.response?.data?.error||(lang==='fr'?'Lien invalide ou expiré':'Invalid or expired link')); }
    finally { setLoading(false); }
  };

  const inp_style = { width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box', marginBottom:12 };
  const btn_style = { width:'100%', background:P, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:FONT };

  return (
    <div style={{ minHeight:'100vh', background:`linear-gradient(135deg, #1d4f92, ${P})`, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, padding:32, width:400, maxWidth:'100%', boxShadow:'0 20px 60px rgba(0,0,0,0.2)' }}>
        <div style={{ textAlign:'center', marginBottom:24 }}>
          <img src="/logo-calculus.svg" alt="Calculus Plus" style={{ width:160, height:'auto', marginBottom:12 }} />
          <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>🔐 {lang==='fr'?'Réinitialiser le mot de passe':'Reset password'}</div>
        </div>

        {step==='email' && (<>
          <div style={{ fontSize:13, color:MUTED, marginBottom:16, textAlign:'center' }}>
            {lang==='fr'?'Entrez votre email. Vous recevrez un lien de réinitialisation.':'Enter your email. You will receive a reset link.'}
          </div>
          <input value={email} onChange={e=>setEmail(e.target.value)} type="email" placeholder="email@exemple.com" style={inp_style} />
          <button onClick={sendLink} disabled={loading} style={btn_style}>
            {loading?'...':(lang==='fr'?'Envoyer le lien':'Send link')}
          </button>
        </>)}

        {step==='sent' && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:56, marginBottom:12 }}>📧</div>
            <div style={{ fontSize:15, fontWeight:700, marginBottom:8 }}>
              {lang==='fr'?'Vérifiez votre email':'Check your email'}
            </div>
            <div style={{ fontSize:13, color:MUTED, lineHeight:1.5 }}>
              {lang==='fr'?`Si un compte existe pour ${email}, un lien de réinitialisation vient d'être envoyé. Cliquez sur ce lien pour choisir un nouveau mot de passe.`:`If an account exists for ${email}, a reset link was just sent. Click it to set a new password.`}
            </div>
          </div>
        )}

        {step==='password' && (<>
          <div style={{ fontSize:13, color:MUTED, marginBottom:16, textAlign:'center' }}>
            {lang==='fr'?'Choisissez votre nouveau mot de passe.':'Choose your new password.'}
          </div>
          <input value={newPwd} onChange={e=>setNewPwd(e.target.value)} type="password" placeholder={lang==='fr'?'Nouveau mot de passe':'New password'} style={inp_style} />
          <input value={confirmPwd} onChange={e=>setConfirmPwd(e.target.value)} type="password" placeholder={lang==='fr'?'Confirmer':'Confirm'} style={inp_style} />
          <div style={{ fontSize:11, color:MUTED, marginBottom:12 }}>
            {lang==='fr'?'Min. 8 caractères, avec majuscule, minuscule et chiffre.':'Min. 8 chars, with uppercase, lowercase and digit.'}
          </div>
          <button onClick={resetPwd} disabled={loading} style={btn_style}>
            {loading?'...':(lang==='fr'?'Réinitialiser':'Reset')}
          </button>
        </>)}

        {step==='done' && (
          <div style={{ textAlign:'center' }}>
            <div style={{ fontSize:56, marginBottom:12 }}>✅</div>
            <div style={{ fontSize:16, fontWeight:700, color:SUCCESS, marginBottom:16 }}>
              {lang==='fr'?'Mot de passe réinitialisé !':'Password reset!'}
            </div>
            <button onClick={()=>navigate('/login')} style={btn_style}>
              {lang==='fr'?'Se connecter':'Sign in'}
            </button>
          </div>
        )}

        {step !== 'done' && step !== 'sent' && (
          <button onClick={()=>navigate('/login')} style={{ width:'100%', background:'none', border:'none', color:MUTED, cursor:'pointer', marginTop:12, fontSize:13, fontFamily:FONT }}>
            ← {lang==='fr'?'Retour':'Back'}
          </button>
        )}
      </div>
    </div>
  );
};

const VerifyEmail = ({ lang }) => {
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [state, setState] = useState('loading'); // loading | ok | error

  useEffect(() => {
    if (!token) { setState('error'); return; }
    api.get(`/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(() => setState('ok'))
      .catch(() => setState('error'));
  }, [token]);

  return (
    <div style={{ minHeight:'100vh', background:`linear-gradient(135deg, #1d4f92, ${P})`, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, padding:32, width:400, maxWidth:'100%', boxShadow:'0 20px 60px rgba(0,0,0,0.2)', textAlign:'center' }}>
        <img src="/logo-calculus.svg" alt="Calculus Plus" style={{ width:160, height:'auto', marginBottom:20 }} />
        {state==='loading' && (
          <div style={{ fontSize:15, color:MUTED }}>{lang==='fr'?'Vérification en cours…':'Verifying…'}</div>
        )}
        {state==='ok' && (<>
          <div style={{ fontSize:56, marginBottom:12 }}>✅</div>
          <div style={{ fontSize:18, fontWeight:700, color:SUCCESS, marginBottom:8 }}>
            {lang==='fr'?'Email vérifié !':'Email verified!'}
          </div>
          <div style={{ fontSize:14, color:MUTED, marginBottom:20 }}>
            {lang==='fr'?'Votre compte est maintenant activé.':'Your account is now activated.'}
          </div>
          <button onClick={()=>navigate('/login')} style={{ width:'100%', background:P, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:FONT }}>
            {lang==='fr'?'Se connecter':'Sign in'}
          </button>
        </>)}
        {state==='error' && (<>
          <div style={{ fontSize:56, marginBottom:12 }}>⚠️</div>
          <div style={{ fontSize:18, fontWeight:700, color:DANGER, marginBottom:8 }}>
            {lang==='fr'?'Lien invalide ou expiré':'Invalid or expired link'}
          </div>
          <div style={{ fontSize:14, color:MUTED, marginBottom:20 }}>
            {lang==='fr'?'Ce lien a peut-être déjà été utilisé. Connectez-vous pour renvoyer un email.':'This link may already have been used. Sign in to resend an email.'}
          </div>
          <button onClick={()=>navigate('/login')} style={{ width:'100%', background:P, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:FONT }}>
            {lang==='fr'?'Retour connexion':'Back to sign in'}
          </button>
        </>)}
      </div>
    </div>
  );
};

const Login = ({ lang, toggleLang }) => {
  const t = k => T[lang][k] || k;
  const [creds, setCreds] = useState({ emailOrPhone:'', password:'' });
  const [loading, setLoading] = useState(false);
  // Etapes supplementaires renvoyees par /auth/login (hotfix v1) :
  //   { mfaRequired:true, mfaToken }  -> saisie du code TOTP a 6 chiffres
  //   { mustChangePassword:true }     -> changement de mot de passe force
  const [mfa, setMfa] = useState(null);
  const [code, setCode] = useState('');
  const [forcePwd, setForcePwd] = useState(false);
  const [pwd, setPwd] = useState({ newPassword:'', confirm:'' });
  const navigate = useNavigate();
  const { isAuth } = useAuth();
  useEffect(() => { if (isAuth && !forcePwd) navigate('/'); }, [isAuth, forcePwd, navigate]);

  const finishLogin = (data) => {
    if (data.mfaRequired && data.mfaToken) { setMfa({ mfaToken: data.mfaToken }); return; }
    if (data.access_token) localStorage.setItem('ch_token', data.access_token);
    if (data.mustChangePassword) { setForcePwd(true); return; }
    navigate('/');
  };

  const submit = async () => {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', creds);
      finishLogin(data);
    } catch (err) { toast.error(err.response?.data?.error || t('loginError')); }
    finally { setLoading(false); }
  };

  const submitMfa = async () => {
    if (code.length !== 6) return toast.error(lang==='fr'?'Code à 6 chiffres requis':'6-digit code required');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/2fa/validate', { mfaToken: mfa.mfaToken, code, tempToken: mfa.mfaToken, totpCode: code });
      finishLogin({ ...data, mfaRequired: false });
    } catch (err) { toast.error(err.response?.data?.error || (lang==='fr'?'Code invalide':'Invalid code')); }
    finally { setLoading(false); }
  };

  const submitPwd = async () => {
    if (pwd.newPassword.length < 8) return toast.error(lang==='fr'?'8 caractères minimum':'8 characters minimum');
    if (pwd.newPassword !== pwd.confirm) return toast.error(lang==='fr'?'Les mots de passe ne correspondent pas':'Passwords do not match');
    setLoading(true);
    try {
      await api.post('/auth/change-password', { currentPassword: creds.password, newPassword: pwd.newPassword });
      toast.success(t('pwdChanged'));
      setForcePwd(false); navigate('/');
    } catch (err) { toast.error(err.response?.data?.error || t('error')); }
    finally { setLoading(false); }
  };

  const onSubmit = e => { e.preventDefault(); if (loading) return; if (forcePwd) submitPwd(); else if (mfa) submitMfa(); else submit(); };

  return (
    <div style={{ minHeight:'100vh', background:BG, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:FONT }}>
      <div style={{ width:400 }}>
        <div style={{ textAlign:'right', marginBottom:12 }}>
          <button onClick={toggleLang} style={{ background:'none', border:`1px solid ${BORDER}`, color:TEXT, padding:'5px 12px', borderRadius:20, cursor:'pointer', fontSize:12, fontFamily:FONT }}>🌐 {t('language')}</button>
        </div>
        <div style={{ textAlign:'center', marginBottom:24 }}>
          <img src="/logo-calculus.svg" alt="Calculus Plus" style={{ width:210, height:'auto', display:'block', margin:'0 auto 10px', objectFit:'contain' }} />
          <div style={{ color:MUTED, fontSize:13 }}>C-Pay — Espace Porteur de Carte</div>
        </div>
        <PciSecurityBadge />
        <Box>
          <form onSubmit={onSubmit}>
          {forcePwd ? (<>
            <div style={{ fontSize:15, fontWeight:700, marginBottom:6, fontFamily:FONT }}>🔐 {lang==='fr'?'Nouveau mot de passe requis':'New password required'}</div>
            <div style={{ fontSize:12, color:MUTED, marginBottom:14, fontFamily:FONT }}>
              {lang==='fr'?'Pour continuer, vous devez définir un nouveau mot de passe (8 caractères minimum).':'To continue you must set a new password (min. 8 characters).'}
            </div>
            <Inp label={t('newPwd')} value={pwd.newPassword} onChange={v=>setPwd(p=>({...p,newPassword:v}))} type="password" placeholder="••••••••" autoComplete="new-password" required />
            <Inp label={lang==='fr'?'Confirmer le mot de passe':'Confirm password'} value={pwd.confirm} onChange={v=>setPwd(p=>({...p,confirm:v}))} type="password" placeholder="••••••••" autoComplete="new-password" required />
            <Btn disabled={loading} style={{ width:'100%', marginTop:4 }}>{loading?t('saving'):t('changePwd')}</Btn>
          </>) : mfa ? (<>
            <div style={{ fontSize:15, fontWeight:700, marginBottom:6, fontFamily:FONT }}>🔐 {lang==='fr'?'Vérification en deux étapes':'Two-step verification'}</div>
            <div style={{ fontSize:12, color:MUTED, marginBottom:14, fontFamily:FONT }}>
              {lang==='fr'?'Saisissez le code à 6 chiffres de votre application d’authentification.':'Enter the 6-digit code from your authenticator app.'}
            </div>
            <Inp label={lang==='fr'?'Code à 6 chiffres':'6-digit code'} value={code} onChange={v=>setCode(String(v).replace(/[^0-9]/g,'').slice(0,6))} placeholder="123456" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
            <Btn disabled={loading || code.length!==6} style={{ width:'100%', marginTop:4 }}>{loading?t('loggingIn'):(lang==='fr'?'Valider':'Verify')}</Btn>
            <button type="button" onClick={()=>{ setMfa(null); setCode(''); }} style={{ width:'100%', background:'none', border:'none', color:MUTED, cursor:'pointer', marginTop:10, fontSize:12, fontFamily:FONT }}>← {lang==='fr'?'Retour':'Back'}</button>
          </>) : (<>
            <Inp label={t('emailOrPhone')} value={creds.emailOrPhone} onChange={v=>setCreds(c=>({...c,emailOrPhone:v}))} placeholder="email@example.com" autoComplete="username" required />
            <Inp label={t('password')} value={creds.password} onChange={v=>setCreds(c=>({...c,password:v}))} type="password" placeholder="••••••••" autoComplete="current-password" required />
            <div style={{ fontSize:11, color:MUTED, marginBottom:12, fontFamily:FONT }}>
              🔒 {lang==='fr'?'Votre session sera verrouillée après 5 tentatives échouées':'Your account will be locked after 5 failed attempts'}
            </div>
            <Btn disabled={loading} style={{ width:'100%', marginTop:4 }}>{loading?t('loggingIn'):t('login')}</Btn>
          </>)}
          </form>

        {!mfa && !forcePwd && (
        <div style={{ textAlign:'center', marginTop:16 }} className="login-links-block">
          <div onClick={()=>navigate('/reset-password')} style={{ color:P, cursor:'pointer', fontSize:13, fontWeight:600, fontFamily:FONT, marginBottom:12 }}>
            {lang==='fr'?'Mot de passe oublié ?':'Forgot password?'}
          </div>
          <div style={{ fontSize:13, color:MUTED, fontFamily:FONT }}>
            {lang==='fr'?'Pas encore de compte ?':'No account yet?'}{' '}
            <span onClick={()=>navigate('/register')} style={{ color:P, cursor:'pointer', fontWeight:700 }}>
              {lang==='fr'?'Créer un compte':'Create account'}
            </span>
          </div>
        </div>
        )}
        </Box>
        <div style={{ textAlign:'center', marginTop:12, fontSize:11, color:MUTED, fontFamily:FONT }}>C-Pay est un produit de Calculus Plus SAS</div>
      </div>
    </div>
  );
};

// ─── DASHBOARD / MA CARTE ─────────────────────────────────────────
const Dashboard = ({ lang }) => {
  const t = k => T[lang][k] || k;
  const navigate = useNavigate();

  // Cartes simulées (en prod: charger depuis API)
  const [cards] = useState([
    { id:'card-001', type:'created', number:'4532 •••• •••• 7821', holder:'Boutique Test C-Pay', balance:45750, currency:'XAF', status:'active',  network:'Visa',       color:'#1d4f92', expiry:'12/28' },
    { id:'card-002', type:'created', number:'5412 •••• •••• 3309', holder:'Boutique Test C-Pay', balance:12300, currency:'XAF', status:'frozen',  network:'Mastercard', color:'#9b59b6', expiry:'09/27' },
    { id:'card-003', type:'enrolled', number:'6011 •••• •••• 5544', holder:'Boutique Test C-Pay', balance:8900,  currency:'XAF', status:'active',  network:'Visa',       color:'#00c896', expiry:'06/26' },
  ]);
  const [selectedCard, setSelectedCard] = useState(0);
  const [txns, setTxns] = useState([]);

  useEffect(() => {
    const cardId = cards[selectedCard]?.id;
    api.get('/transactions', { params:{ limit:5, cardId } })
      .then(r => setTxns(r.data.data||[]))
      .catch(()=>setTxns([]));
  }, [selectedCard]);

  const card = cards[selectedCard];
  const fmt = n => parseFloat(n||0).toLocaleString('fr-FR');

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700, fontFamily:FONT }}>
        🏠 {lang==='fr'?'Mon Espace':'My Space'}
      </h1>

      {/* Cartes en grille responsive */}
      <div style={{ marginBottom:20 }}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:14 }}>
          {cards.map((c, i) => (
            <div key={c.id} onClick={() => setSelectedCard(i)}
              style={{ borderRadius:18, padding:'20px 24px', background:`linear-gradient(135deg, ${c.color}, ${c.color}cc)`, color:'#fff', cursor:'pointer', border:`3px solid ${selectedCard===i?'#fff':'transparent'}`, transition:'all .2s', position:'relative', overflow:'hidden' }}>
              {/* Network */}
              <div style={{ position:'absolute', top:16, right:18, fontSize:13, fontWeight:700, opacity:0.9 }}>{c.network}</div>
              {/* Type badge */}
              <div style={{ position:'absolute', top:16, left:18 }}>
                <span style={{ background:'rgba(255,255,255,0.25)', borderRadius:20, padding:'2px 8px', fontSize:10, fontWeight:700 }}>
                  {c.type==='created'?(lang==='fr'?'Créée':'Created'):(lang==='fr'?'Enrollée':'Enrolled')}
                </span>
              </div>
              {/* Statut */}
              {c.status==='frozen' && (
                <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.4)', borderRadius:15, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700 }}>
                  ❄️ {lang==='fr'?'CARTE GELÉE':'CARD FROZEN'}
                </div>
              )}
              <div style={{ marginTop:32, marginBottom:16, fontSize:16, letterSpacing:2, fontFamily:'monospace' }}>{c.number}</div>
              <div style={{ fontSize:11, opacity:0.8, marginBottom:4 }}>{lang==='fr'?'Solde disponible':'Available balance'}</div>
              <div style={{ fontSize:26, fontWeight:800 }}>{fmt(c.balance)} {c.currency}</div>
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:16, fontSize:11, opacity:0.8 }}>
                <span>{c.holder}</span>
                <span>EXP {c.expiry}</span>
              </div>
            </div>
          ))}
        </div>


      </div>

      {/* Actions selon type de carte */}
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, padding:16, marginBottom:20 }}>
        <div style={{ fontSize:12, color:MUTED, marginBottom:12, fontFamily:FONT }}>
          {card.type==='created'
            ? (lang==='fr'?'Carte créée — toutes les opérations disponibles':'Created card — all operations available')
            : (lang==='fr'?'Carte enrollée — chargement et paiement uniquement':'Enrolled card — top-up and payment only')}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:`repeat(${card.type==='created'?4:2},1fr)`, gap:10 }}>
          {[
            { icon:'⬆️', label:lang==='fr'?'Charger':'Top-up', path:'/transactions?tab=topup', tab:'topup', color:SUCCESS, show:true },
            { icon:'💸', label:lang==='fr'?'Payer':'Pay', path:'/transactions?tab=payment', tab:'payment', color:P, show:true },
            { icon:'⬇️', label:lang==='fr'?'Décharger':'Unload', path:'/transactions?tab=unload', tab:'unload', color:WARNING, show:card.type==='created' },
            { icon:card.status==='active'?'❄️':'🔓', label:card.status==='active'?(lang==='fr'?'Geler':'Freeze'):(lang==='fr'?'Activer':'Activate'), path:null, color:card.status==='active'?DANGER:SUCCESS, show:card.type==='created' },
          ].filter(a=>a.show).map(action => (
            <button key={action.label} onClick={() => action.path ? navigate(action.path) : toast(lang==='fr'?'Bientôt disponible':'Coming soon')}
              style={{ background:`${action.color}15`, border:`1px solid ${action.color}30`, borderRadius:10, padding:'12px 8px', cursor:'pointer', textAlign:'center' }}>
              <div style={{ fontSize:22, marginBottom:4 }}>{action.icon}</div>
              <div style={{ fontSize:12, fontWeight:600, color:action.color, fontFamily:FONT }}>{action.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Transactions récentes de la carte */}
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, padding:16 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
          <div>
            <div style={{ fontSize:14, fontWeight:700, fontFamily:FONT }}>{lang==='fr'?'Transactions récentes':'Recent transactions'}</div>
            <div style={{ fontSize:11, color:MUTED, marginTop:2 }}>
              {lang==='fr'?'Carte':'Card'}: <span style={{ color:cards[selectedCard]?.color, fontWeight:600 }}>{cards[selectedCard]?.number}</span>
            </div>
          </div>
          <button onClick={() => navigate('/transactions')}
            style={{ background:'none', border:'none', color:P, fontSize:12, cursor:'pointer', fontWeight:600, fontFamily:FONT }}>
            {lang==='fr'?'Voir tout →':'See all →'}
          </button>
        </div>
        {txns.length===0 ? (
          <div style={{ textAlign:'center', padding:24, color:MUTED, fontSize:13, fontFamily:FONT }}>
            {lang==='fr'?'Aucune transaction':'No transactions'}
          </div>
        ) : txns.slice(0,5).map((tx,i) => (
          <div key={tx.txn_id||i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom:i<4?`1px solid ${BORDER}`:'none' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <div style={{ width:32, height:32, borderRadius:'50%', background:`${sc(tx.type||tx.status)}20`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14 }}>
                {tx.type==='topup'?'⬆️':tx.type==='unload'?'⬇️':tx.type==='payment'?'💸':'💳'}
              </div>
              <div>
                <div style={{ fontSize:12, fontWeight:600, fontFamily:FONT }}>{tx.description||tx.type}</div>
                <div style={{ fontSize:10, color:MUTED }}>{tx.created_at?new Date(tx.created_at).toLocaleDateString(lang==='fr'?'fr-FR':'en-US'):'—'}</div>
              </div>
            </div>
            <div style={{ fontSize:13, fontWeight:700, color:tx.type==='topup'?SUCCESS:tx.type==='unload'?WARNING:DANGER }}>
              {tx.type==='topup'?'+':'-'}{parseFloat(tx.amount||0).toLocaleString('fr-FR')} XAF
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const TopUp = ({ lang }) => {
  const t = k => T[lang][k] || k;
  const [form, setForm]   = useState({ amount:'', operator:'mtn', phone:'' });
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const f = k => v => setForm(p=>({...p,[k]:v}));

  const submit = async () => {
    if (!form.amount || parseFloat(form.amount) < 500) return toast.error('Montant minimum 500');
    if (!form.phone) return toast.error(t('mmPhone'));
    setLoading(true);
    try {
      const { data } = await api.post('/topup', { amount: parseFloat(form.amount), operator: form.operator, phone: form.phone });
      setResult(data);
      toast.success(t('topupSuccess'));
    } catch (err) { toast.error(err.response?.data?.error || t('error')); }
    finally { setLoading(false); }
  };

  const reset = () => { setResult(null); setForm({ amount:'', operator:'mtn', phone:'' }); };

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>⬆️ {t('topup')}</h1>
      {!result ? (
        <Box style={{ maxWidth:480 }}>
          <h3 style={{ margin:'0 0 16px', fontFamily:FONT }}>{t('topupTitle')}</h3>
          <Inp label={`${t('amount')} * (min. 500 XAF)`} value={form.amount} onChange={f('amount')} type="number" placeholder="10000" />
          <Sel label={t('operator')} value={form.operator} onChange={f('operator')} options={OPERATORS} />
          <Inp label={`${t('mmPhone')} *`} value={form.phone} onChange={f('phone')} placeholder="+237XXXXXXXXX" />
          {form.amount && parseFloat(form.amount) >= 500 && (
            <div style={{ background:`${SUCCESS}10`, border:`1px solid ${SUCCESS}40`, borderRadius:8, padding:12, marginBottom:16, fontSize:12, color:TEXT }}>
              💰 {lang==='fr' ? 'Vous recevrez' : 'You will receive'} : <strong>{fmtNum(Math.round(parseFloat(form.amount) * 0.99))} XAF</strong>
              {' '}({t('fee')} : {fmtNum(Math.round(parseFloat(form.amount) * 0.01))} XAF, 1%)
            </div>
          )}
          <Btn onClick={submit} disabled={loading} color={SUCCESS} style={{ width:'100%' }}>{loading ? t('toppingUp') : t('topupBtn')}</Btn>
        </Box>
      ) : (
        <Box style={{ maxWidth:480, textAlign:'center' }}>
          <div style={{ fontSize:56, marginBottom:12 }}>💳</div>
          <div style={{ fontSize:20, fontWeight:700, color:SUCCESS, marginBottom:8 }}>{t('topupSuccess')}</div>
          <div style={{ fontSize:32, fontWeight:800, color:TEXT, marginBottom:4 }}>+{fmtNum(result.credited)} XAF</div>
          <div style={{ fontSize:12, color:MUTED, marginBottom:4 }}>Réf: {result.mmReference}</div>
          <div style={{ fontSize:14, color:P, fontWeight:700, marginBottom:20 }}>{t('newBalance')} : {fmtNum(result.newBalance)} XAF</div>
          <Btn onClick={reset} color={SUCCESS}>{t('topup')} +</Btn>
        </Box>
      )}
    </div>
  );
};

// ─── UNLOAD ───────────────────────────────────────────────────────
const Unload = ({ lang }) => {
  const t = k => T[lang][k] || k;
  const [form, setForm]   = useState({ amount:'', operator:'mtn', phone:'', pin:'' });
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const f = k => v => setForm(p=>({...p,[k]:v}));

  const submit = async () => {
    if (!form.amount || parseFloat(form.amount) < 500) return toast.error('Montant minimum 500');
    if (!form.phone) return toast.error(t('mmPhone'));
    if (!form.pin || form.pin.length !== 4) return toast.error(t('pinInvalid'));
    setLoading(true);
    try {
      const { data } = await api.post('/unload', { amount: parseFloat(form.amount), operator: form.operator, phone: form.phone, pin: form.pin });
      setResult(data);
      toast.success(t('unloadSuccess'));
    } catch (err) { toast.error(err.response?.data?.error || t('error')); }
    finally { setLoading(false); }
  };

  const reset = () => { setResult(null); setForm({ amount:'', operator:'mtn', phone:'', pin:'' }); };

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>⬇️ {t('unload')}</h1>
      {!result ? (
        <Box style={{ maxWidth:480 }}>
          <h3 style={{ margin:'0 0 16px', fontFamily:FONT }}>{t('unloadTitle')}</h3>
          <Inp label={`${t('amount')} * (min. 500 XAF)`} value={form.amount} onChange={f('amount')} type="number" placeholder="10000" />
          <Sel label={t('operator')} value={form.operator} onChange={f('operator')} options={OPERATORS} />
          <Inp label={`${t('mmPhone')} *`} value={form.phone} onChange={f('phone')} placeholder="+237XXXXXXXXX" />
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{t('pin')} *</label>
            <PinInput value={form.pin} onChange={v=>setForm(p=>({...p,pin:v}))} />
          </div>
          {form.amount && parseFloat(form.amount) >= 500 && (
            <div style={{ background:`${WARNING}10`, border:`1px solid ${WARNING}40`, borderRadius:8, padding:12, marginBottom:16, fontSize:12, color:TEXT }}>
              ⚠️ {t('unloadFeeNote')} · {lang==='fr'?'Vous recevrez':'You will receive'} : <strong>{fmtNum(Math.round(parseFloat(form.amount) * 0.985))} XAF</strong>
            </div>
          )}
          <Btn onClick={submit} disabled={loading} color={WARNING} style={{ width:'100%' }}>{loading ? t('unloading') : t('unloadBtn')}</Btn>
        </Box>
      ) : (
        <Box style={{ maxWidth:480, textAlign:'center' }}>
          <div style={{ fontSize:56, marginBottom:12 }}>📲</div>
          <div style={{ fontSize:20, fontWeight:700, color:SUCCESS, marginBottom:8 }}>{t('unloadSuccess')}</div>
          <div style={{ fontSize:32, fontWeight:800, color:TEXT, marginBottom:4 }}>{fmtNum(result.sent)} XAF</div>
          <div style={{ fontSize:13, color:MUTED, marginBottom:4 }}>{t('fee')} : {fmtNum(result.fee)} XAF · Réf: {result.mmReference}</div>
          <div style={{ fontSize:14, color:P, fontWeight:700, marginBottom:20 }}>{t('newBalance')} : {fmtNum(result.newBalance)} XAF</div>
          <Btn onClick={reset} color={WARNING}>{t('unload')} +</Btn>
        </Box>
      )}
    </div>
  );
};

// ─── TRANSACTIONS ─────────────────────────────────────────────────
const TxnRow = ({ txn, t, lang }) => {
  const icons = { payment:'💸', topup:'⬆️', unload:'⬇️', fee:'⚙️', refund:'↩️' };
  const sign  = { payment:'-', unload:'-', fee:'-', topup:'+', refund:'+' };
  return (
    <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 0', borderBottom:`1px solid ${BORDER}` }}>
      <div style={{ width:40, height:40, borderRadius:12, background:`${sc(txn.type)}18`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>{icons[txn.type]||'💳'}</div>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:13, fontWeight:600, color:TEXT }}>{txn.merchant_name || t(`txn${txn.type.charAt(0).toUpperCase()+txn.type.slice(1)}`)||txn.type}</div>
        <div style={{ fontSize:11, color:MUTED }}>{fmtDate(txn.initiated_at, lang)}</div>
      </div>
      <div style={{ textAlign:'right' }}>
        <div style={{ fontSize:15, fontWeight:700, color:sc(txn.type) }}>{sign[txn.type]||''}{fmtNum(txn.amount)} {txn.currency}</div>
        <Badge label={txn.status} color={sc(txn.status)} />
      </div>
    </div>
  );
};

const Transactions = ({ lang }) => {
  const t = k => T[lang][k] || k;
  const [txns, setTxns]   = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage]   = useState(1);
  const [typeF, setTypeF] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/transactions', { params:{ page, limit:20, type:typeF||undefined } })
      .then(r=>{ setTxns(r.data.data||[]); setTotal(r.data.total||0); })
      .finally(()=>setLoading(false));
  }, [page, typeF]);
  useEffect(()=>{ load(); }, [load]);

  const sel = { background:CARD, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:TEXT, fontFamily:FONT };

  return (
    <div>
      <h1 style={{ margin:'0 0 16px', fontSize:22, fontWeight:700 }}>📋 {t('transactions')} <span style={{ fontSize:14, color:MUTED }}>({total})</span></h1>
      <div style={{ display:'flex', gap:10, marginBottom:14 }}>
        <select value={typeF} onChange={e=>{ setTypeF(e.target.value); setPage(1); }} style={sel}>
          <option value="">Tous les types</option>
          <option value="payment">{t('txnPayment')}</option>
          <option value="topup">{t('txnTopup')}</option>
          <option value="unload">{t('txnUnload')}</option>
          <option value="refund">{t('txnRefund')}</option>
        </select>
      </div>
      {loading ? <Spin /> : (
        <Box>
          {txns.length === 0
            ? <div style={{ textAlign:'center', padding:32, color:MUTED }}>{t('noTxn')}</div>
            : txns.map(txn => <TxnRow key={txn.txn_id} txn={txn} t={t} lang={lang} />)}
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12 }}>
            <Btn small outline color={P} onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1}>←</Btn>
            <span style={{ padding:'6px 12px', fontSize:13, color:MUTED }}>Page {page}</span>
            <Btn small outline color={P} onClick={()=>setPage(p=>p+1)} disabled={txns.length<20}>→</Btn>
          </div>
        </Box>
      )}
    </div>
  );
};

// ─── PROFIL + PARAMÈTRES ─────────────────────────────────────────
// ─── SECURITY 2FA ─────────────────────────────────────────────────
const Security2FA = ({ lang }) => {
  const [status, setStatus] = useState(null);
  const [show2FA, setShow2FA] = useState(false);
  const [showDisable, setShowDisable] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [loading, setLoading] = useState(false);

  const loadStatus = () => {
    api.get('/auth/2fa/status').then(r => setStatus(r.data)).catch(()=>{});
  };
  useEffect(() => { loadStatus(); }, []);

  const disable2FA = async () => {
    if (!disableCode || disableCode.length !== 6) return toast.error(lang==='fr'?'Code 6 chiffres requis':'6-digit code required');
    setLoading(true);
    try {
      await api.post('/auth/2fa/disable', { token: disableCode });
      toast.success(lang==='fr'?'2FA désactivée':'2FA disabled');
      setShowDisable(false); setDisableCode(''); loadStatus();
    } catch(err){ toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setLoading(false); }
  };

  if (!status) return <div style={{ textAlign:'center', padding:20, color:MUTED }}>Chargement…</div>;

  return (
    <div>
      <div style={{ fontSize:15, fontWeight:700, marginBottom:16, fontFamily:FONT }}>🔐 {lang==='fr'?'Double Authentification (2FA)':'Two-Factor Authentication (2FA)'}</div>

      {/* Statut actuel */}
      <div style={{ background:status.mfaEnabled?`${SUCCESS}10`:`${WARNING}10`, border:`1px solid ${status.mfaEnabled?SUCCESS:WARNING}30`, borderRadius:10, padding:16, marginBottom:20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <div style={{ fontSize:14, fontWeight:700, color:status.mfaEnabled?SUCCESS:WARNING, marginBottom:4 }}>
              {status.mfaEnabled ? '✅ '+(lang==='fr'?'2FA activée':'2FA enabled') : '⚠️ '+(lang==='fr'?'2FA non activée':'2FA not enabled')}
            </div>
            <div style={{ fontSize:12, color:MUTED }}>
              {status.mfaEnabled
                ? (lang==='fr'?'Votre compte est protégé par Google Authenticator / Authy':'Your account is protected by Google Authenticator / Authy')
                : (lang==='fr'?`${status.daysLeft} jour(s) avant que la 2FA soit obligatoire`:`${status.daysLeft} day(s) before 2FA becomes mandatory`)}
            </div>
          </div>
          {status.mfaEnabled
            ? <button onClick={()=>setShowDisable(!showDisable)}
                style={{ background:`${DANGER}10`, border:`1px solid ${DANGER}30`, color:DANGER, borderRadius:8, padding:'8px 14px', cursor:'pointer', fontSize:12, fontWeight:700, fontFamily:FONT }}>
                🔓 {lang==='fr'?'Désactiver':'Disable'}
              </button>
            : <button onClick={()=>setShow2FA(true)}
                style={{ background:P, color:'#fff', border:'none', borderRadius:8, padding:'8px 14px', cursor:'pointer', fontSize:12, fontWeight:700, fontFamily:FONT }}>
                🔐 {lang==='fr'?'Activer':'Enable'}
              </button>
          }
        </div>
      </div>

      {/* Méthodes disponibles */}
      <div style={{ fontSize:13, fontWeight:700, color:MUTED, marginBottom:10, fontFamily:FONT }}>
        {lang==='fr'?'Méthodes disponibles':'Available methods'}
      </div>
      <div style={{ display:'grid', gap:10, marginBottom:20 }}>
        {[
          { icon:'📱', name:'Google Authenticator / Authy', desc:lang==='fr'?'Application mobile TOTP (recommandé)':'Mobile TOTP app (recommended)', active:status.mfaEnabled && status.mfaMethod==='totp' },
          { icon:'💬', name:'SMS OTP', desc:lang==='fr'?'Code par SMS (bientôt disponible)':'Code by SMS (coming soon)', active:false, disabled:true },
        ].map(m => (
          <div key={m.name} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 14px', background:m.active?`${P}08`:BG, border:`1px solid ${m.active?P:BORDER}`, borderRadius:10 }}>
            <span style={{ fontSize:24 }}>{m.icon}</span>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:600, fontFamily:FONT }}>{m.name}</div>
              <div style={{ fontSize:11, color:MUTED }}>{m.desc}</div>
            </div>
            {m.active && <span style={{ background:`${SUCCESS}20`, color:SUCCESS, borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>✅ Actif</span>}
            {m.disabled && <span style={{ background:`${MUTED}20`, color:MUTED, borderRadius:20, padding:'3px 10px', fontSize:11 }}>{lang==='fr'?'Bientôt':'Soon'}</span>}
          </div>
        ))}
      </div>

      {/* Modal désactiver */}
      {showDisable && (
        <div style={{ background:`${DANGER}08`, border:`1px solid ${DANGER}30`, borderRadius:10, padding:16 }}>
          <div style={{ fontSize:13, fontWeight:700, color:DANGER, marginBottom:10 }}>
            ⚠️ {lang==='fr'?'Désactiver la 2FA':'Disable 2FA'}
          </div>
          <div style={{ fontSize:12, color:MUTED, marginBottom:12 }}>
            {lang==='fr'?'Entrez le code de votre application pour confirmer.':'Enter the code from your app to confirm.'}
          </div>
          <input value={disableCode} onChange={e=>setDisableCode(e.target.value.replace(/\D/g,'').slice(0,6))}
            placeholder="000000" maxLength={6}
            style={{ width:'100%', textAlign:'center', fontSize:24, letterSpacing:8, padding:'12px', border:`2px solid ${BORDER}`, borderRadius:8, fontFamily:'monospace', marginBottom:10, boxSizing:'border-box' }} />
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={disable2FA} disabled={loading||disableCode.length!==6}
              style={{ flex:1, background:DANGER, color:'#fff', border:'none', borderRadius:8, padding:'10px', cursor:'pointer', fontWeight:700, fontFamily:FONT }}>
              {loading?'...':(lang==='fr'?'Confirmer désactivation':'Confirm disable')}
            </button>
            <button onClick={()=>{setShowDisable(false);setDisableCode('');}}
              style={{ flex:1, background:'none', border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px', cursor:'pointer', fontFamily:FONT }}>
              {lang==='fr'?'Annuler':'Cancel'}
            </button>
          </div>
        </div>
      )}

      {/* Modal setup 2FA */}
      {show2FA && <TwoFASetup lang={lang} onClose={()=>setShow2FA(false)} onSuccess={()=>{ setShow2FA(false); loadStatus(); }} />}
    </div>
  );
};

const Profile = ({ lang }) => {
  const t = k => T[lang][k] || k;
  const [card, setCard]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm]   = useState({});
  const [pwdForm, setPwdForm] = useState({ currentPassword:'', newPassword:'' });
  const [pinForm, setPinForm] = useState({ currentPin:'', newPin:'', confirmPin:'' });
  const [saving, setSaving] = useState(false);
  const [savingPwd, setSavingPwd] = useState(false);
  const [savingPin, setSavingPin] = useState(false);
  const [activeTab, setActiveTab] = useState('info');
  const f = k => v => setForm(p=>({...p,[k]:v}));

  useEffect(() => {
    api.get('/card').then(r => {
      setCard(r.data);
      setForm({ email: r.data.cardholder?.email||'', phone: r.data.cardholder?.phone||'', address: r.data.cardholder?.address||'', city: r.data.cardholder?.city||'' });
    }).finally(() => setLoading(false));
  }, []);

  const saveProfile = async () => {
    setSaving(true);
    try { await api.patch('/profile', form); toast.success(t('profileSaved')); }
    catch (err) { toast.error(err.response?.data?.error || t('error')); }
    finally { setSaving(false); }
  };

  const changePwd = async () => {
    setSavingPwd(true);
    try { await api.post('/profile/change-password', { currentPassword: pwdForm.currentPassword, newPassword: pwdForm.newPassword }); toast.success(t('pwdChanged')); setPwdForm({ currentPassword:'', newPassword:'' }); }
    catch (err) { toast.error(err.response?.data?.error === 'Mot de passe actuel incorrect' ? t('pwdError') : t('error')); }
    finally { setSavingPwd(false); }
  };

  const changePin = async () => {
    if (!/^\d{4}$/.test(pinForm.newPin)) return toast.error(t('pinInvalid'));
    if (pinForm.newPin !== pinForm.confirmPin) return toast.error(t('pinMismatch'));
    setSavingPin(true);
    try { await api.post('/card/pin', { currentPin: pinForm.currentPin||undefined, newPin: pinForm.newPin }); toast.success(t('pinChanged')); setPinForm({ currentPin:'', newPin:'', confirmPin:'' }); }
    catch (err) { toast.error(err.response?.data?.error || t('pinError')); }
    finally { setSavingPin(false); }
  };

  if (loading) return <Spin />;

  const tabs = [['info',t('profileTitle')],['pin',t('pinTitle')],['pwd',t('changePwd')],['security','🔐 Sécurité']];

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700 }}>👤 {t('profile')}</h1>
      <div style={{ display:'flex', gap:2, marginBottom:20, background:BG, borderRadius:10, padding:4, width:'fit-content', border:`1px solid ${BORDER}` }}>
        {tabs.map(([v,l]) => (
          <button key={v} onClick={()=>setActiveTab(v)} style={{ padding:'7px 20px', borderRadius:8, border:'none', background:activeTab===v?CARD:'transparent', fontWeight:activeTab===v?700:400, color:activeTab===v?P:MUTED, cursor:'pointer', fontSize:13, fontFamily:FONT }}>{l}</button>
        ))}
      </div>

      {activeTab === 'info' && (
        <Box style={{ maxWidth:500 }}>
          <Inp label={t('emailLabel')} value={form.email} onChange={f('email')} type="email" placeholder="email@example.com" />
          <Inp label={t('phoneLabel')} value={form.phone} onChange={f('phone')} placeholder="+237XXXXXXXXX" />
          <Inp label={t('addressLabel')} value={form.address} onChange={f('address')} placeholder="Rue, Quartier" />
          <Inp label={t('cityLabel')} value={form.city} onChange={f('city')} placeholder="Douala" />
          <div style={{ background:`${WARNING}10`, border:`1px solid ${WARNING}30`, borderRadius:8, padding:10, marginBottom:14, fontSize:12, color:TEXT }}>
            🔒 {lang==='fr'?'La modification de votre email ou téléphone nécessite une validation.':'Changing your email or phone requires verification.'}
          </div>
          <Btn onClick={saveProfile} disabled={saving} style={{ width:'100%' }}>{saving ? t('saving') : t('save')}</Btn>
        </Box>
      )}

      {activeTab === 'pin' && (
        <Box style={{ maxWidth:400 }}>
          <div style={{ marginBottom:16, background:`${P}10`, border:`1px solid ${P}30`, borderRadius:8, padding:12, fontSize:12, color:TEXT }}>
            🔐 {lang==='fr'?'Le PIN est requis pour les paiements et les déchargements.':'PIN is required for payments and unloads.'}
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>{t('currentPin')}</label>
            <PinInput value={pinForm.currentPin} onChange={v=>setPinForm(p=>({...p,currentPin:v}))} />
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>{t('newPin')}</label>
            <PinInput value={pinForm.newPin} onChange={v=>setPinForm(p=>({...p,newPin:v}))} />
          </div>
          <div style={{ marginBottom:18 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>{t('confirmPin')}</label>
            <PinInput value={pinForm.confirmPin} onChange={v=>setPinForm(p=>({...p,confirmPin:v}))} />
          </div>
          <Btn onClick={changePin} disabled={savingPin} style={{ width:'100%' }}>{savingPin ? t('saving') : t('pinTitle')}</Btn>
        </Box>
      )}

      {activeTab === 'pwd' && (
        <Box style={{ maxWidth:400 }}>
          <Inp label={t('currentPwd')} value={pwdForm.currentPassword} onChange={v=>setPwdForm(p=>({...p,currentPassword:v}))} type="password" placeholder="••••••••" />
          <Inp label={t('newPwd')} value={pwdForm.newPassword} onChange={v=>setPwdForm(p=>({...p,newPassword:v}))} type="password" placeholder="••••••••" />
          <Btn onClick={changePwd} disabled={savingPwd} style={{ width:'100%' }}>{savingPwd ? t('saving') : t('changePwd')}</Btn>
        </Box>
      )}
    </div>
  );
};


// ─── Luhn Check côté client ───────────────────────────────────────
const luhnCheck = (pan) => {
  const digits = pan.replace(/\D/g, '').split('').map(Number).reverse();
  const sum = digits.reduce((acc, d, i) => {
    if (i % 2 === 1) { const x = d*2; return acc + (x>9?x-9:x); }
    return acc + d;
  }, 0);
  return sum % 10 === 0;
};

const detectNetwork = (pan) => {
  const p = pan.replace(/\D/g, '');
  if (/^4/.test(p)) return 'visa';
  if (/^5[1-5]|^2[2-7]/.test(p)) return 'mastercard';
  if (/^3[47]/.test(p)) return 'amex';
  return 'unknown';
};

const NETWORK_ICONS = { visa:'💙', mastercard:'🔴', amex:'🟦', unknown:'💳' };
const NETWORK_COLORS = { visa:'#1a1f71', mastercard:'#eb001b', amex:'#2e77bc', unknown:MUTED };

// Formater le numéro en groupes de 4
const formatPan = (v) => v.replace(/\D/g,'').slice(0,19).replace(/(\d{4})(?=\d)/g,'$1 ');
const formatExpiry = (v) => {
  const d = v.replace(/\D/g,'').slice(0,4);
  return d.length > 2 ? d.slice(0,2)+'/'+d.slice(2) : d;
};

// ─── Chiffrement AES-256-GCM côté browser (SubtleCrypto) ─────────
const encryptPan = async (pan, sessionKey) => {
  const keyBytes = new Uint8Array(sessionKey.match(/../g).map(h => parseInt(h,16)));
  const key = await window.crypto.subtle.importKey(
    'raw', keyBytes, { name:'AES-GCM' }, false, ['encrypt']
  );
  const iv   = window.crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(pan.replace(/\D/g,''));
  const encrypted = await window.crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, data);
  // Les 16 derniers bytes sont le tag GCM
  const encBytes = new Uint8Array(encrypted);
  const ciphertext = encBytes.slice(0, encBytes.length - 16);
  const tag        = encBytes.slice(encBytes.length - 16);
  return {
    iv:   Array.from(iv).map(b=>b.toString(16).padStart(2,'0')).join(''),
    data: Array.from(ciphertext).map(b=>b.toString(16).padStart(2,'0')).join(''),
    tag:  Array.from(tag).map(b=>b.toString(16).padStart(2,'0')).join(''),
  };
};


// ─── GTP Card Page ────────────────────────────────────────────────
const GtpCardPage = ({ lang }) => {
  const t = k => T[lang][k] || k;
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('cards');
  const [issueForm, setIssueForm] = useState({ firstName:'', lastName:'', dateOfBirth:'', idType:'national_id', idNumber:'', country:'CM' });
  const [issuing, setIssuing] = useState(false);
  const [newCard, setNewCard] = useState(null);
  const [selectedCard, setSelectedCard] = useState(null);
  const [balance, setBalance] = useState(null);
  const [payForm, setPayForm] = useState({ amount:'', merchantName:'', description:'', pin:'', schema:'1' });
  const [paying, setPaying] = useState(false);
  const [payResult, setPayResult] = useState(null);
  const [topupForm, setTopupForm] = useState({ amount:'', operator:'mtn', mmPhone:'' });
  const [toppingUp, setToppingUp] = useState(false);
  const [unloadForm, setUnloadForm] = useState({ amount:'', operator:'mtn', mmPhone:'', pin:'' });
  const [unloading, setUnloading] = useState(false);
  const [txns, setTxns] = useState([]);

  const load = () => {
    setLoading(true);
    api.get('/gtp/cards').then(r => {
      setCards(r.data.data || []);
      if (r.data.data?.length > 0 && !selectedCard) setSelectedCard(r.data.data[0]);
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const loadBalance = async (card) => {
    try {
      const { data } = await api.get(`/gtp/cards/${card.gtp_card_id}`);
      setBalance(data);
    } catch { toast.error('Impossible de récupérer le solde'); }
  };

  const loadTxns = async (card) => {
    try {
      const { data } = await api.get(`/gtp/cards/${card.gtp_card_id}/transactions`);
      setTxns(data.data || []);
    } catch {}
  };

  useEffect(() => {
    if (selectedCard) { loadBalance(selectedCard); loadTxns(selectedCard); }
  }, [selectedCard]);

  const CEMAC = [
    { v:'CM', l:'🇨🇲 Cameroun' }, { v:'CG', l:'🇨🇬 Congo' }, { v:'GA', l:'🇬🇦 Gabon' },
    { v:'CF', l:'🇨🇫 RCA' }, { v:'TD', l:'🇹🇩 Tchad' }, { v:'GQ', l:'🇬🇶 Guinée Éq.' },
  ];

  // ─── Emission carte ───────────────────────────────────────────
  const issueCard = async () => {
    if (!issueForm.firstName || !issueForm.lastName) return toast.error('Nom et prénom requis');
    setIssuing(true);
    try {
      const { data } = await api.post('/gtp/issue', issueForm);
      setNewCard(data.card);
      toast.success(t('gtpIssued'));
      load();
      setTab('cards');
    } catch (err) { toast.error(err.response?.data?.error || t('error')); }
    finally { setIssuing(false); }
  };

  // ─── Paiement ─────────────────────────────────────────────────
  const pay = async () => {
    if (!selectedCard) return;
    if (!payForm.amount || parseFloat(payForm.amount) <= 0) return toast.error(t('amount'));
    if (!payForm.pin || payForm.pin.length !== 4) return toast.error('PIN requis');
    setPaying(true);
    try {
      const endpoint = payForm.schema === '1'
        ? `/gtp/cards/${selectedCard.gtp_card_id}/payment`
        : '/gtp/payment/token';
      const payload = payForm.schema === '1'
        ? { amount: parseFloat(payForm.amount), merchantName: payForm.merchantName, description: payForm.description, pin: payForm.pin }
        : { tokenId: selectedCard.token_id, amount: parseFloat(payForm.amount), merchantName: payForm.merchantName, description: payForm.description, pin: payForm.pin };
      const { data } = await api.post(endpoint, payload);
      setPayResult(data);
      toast.success('Paiement approuvé ✓');
      loadBalance(selectedCard);
    } catch (err) { toast.error(err.response?.data?.error || t('payFailed')); }
    finally { setPaying(false); }
  };

  // ─── Top-up ───────────────────────────────────────────────────
  const doTopup = async () => {
    if (!selectedCard || !topupForm.amount || parseFloat(topupForm.amount) < 500) return toast.error('Min 500 XAF');
    if (!topupForm.mmPhone) return toast.error('Numéro Mobile Money requis');
    setToppingUp(true);
    try {
      const { data } = await api.post(`/gtp/cards/${selectedCard.gtp_card_id}/topup`, { amount: parseFloat(topupForm.amount), operator: topupForm.operator, mmPhone: topupForm.mmPhone });
      toast.success(`Carte rechargée : +${fmtNum(data.credited)} XAF ✓`);
      setTopupForm({ amount:'', operator:'mtn', mmPhone:'' });
      loadBalance(selectedCard);
    } catch (err) { toast.error(err.response?.data?.error || t('error')); }
    finally { setToppingUp(false); }
  };

  // ─── Unload ───────────────────────────────────────────────────
  const doUnload = async () => {
    if (!selectedCard || !unloadForm.amount || parseFloat(unloadForm.amount) < 500) return toast.error('Min 500 XAF');
    if (!unloadForm.pin || unloadForm.pin.length !== 4) return toast.error('PIN requis');
    setUnloading(true);
    try {
      const { data } = await api.post(`/gtp/cards/${selectedCard.gtp_card_id}/unload`, { ...unloadForm, amount: parseFloat(unloadForm.amount) });
      toast.success(`Transféré : ${fmtNum(data.sent)} XAF ✓`);
      setUnloadForm({ amount:'', operator:'mtn', mmPhone:'', pin:'' });
      loadBalance(selectedCard);
    } catch (err) { toast.error(err.response?.data?.error || t('error')); }
    finally { setUnloading(false); }
  };

  // ─── Toggle carte ─────────────────────────────────────────────
  const toggleFreeze = async () => {
    if (!selectedCard) return;
    const action = selectedCard.status === 'active' ? 'freeze' : 'unfreeze';
    try {
      await api.patch(`/gtp/cards/${selectedCard.gtp_card_id}/${action}`);
      toast.success(action === 'freeze' ? '❄️ Carte gelée' : '✅ Carte activée');
      load();
    } catch (err) { toast.error(err.response?.data?.error || t('error')); }
  };

  const inp = { width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box' };
  const sel = { ...inp };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700, fontFamily:FONT }}>🌍 {t('gtpCard')}</h1>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ background:`${BLUE}15`, border:`1px solid ${BLUE}30`, color:BLUE, borderRadius:20, padding:'4px 12px', fontSize:11, fontWeight:700, fontFamily:FONT }}>GIMAC • CEMAC • XAF</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', gap:2, marginBottom:20, background:BG, borderRadius:10, padding:4, width:'fit-content', border:`1px solid ${BORDER}`, flexWrap:'wrap' }}>
        {[['cards','💳 Mes cartes'],['issue','➕ Nouvelle carte'],['pay','💸 Payer'],['topup','⬆️ Recharger'],['unload','⬇️ Transférer'],['txns','📋 Historique']].map(([v,l]) => (
          <button key={v} onClick={()=>setTab(v)} style={{ padding:'7px 16px', borderRadius:8, border:'none', background:tab===v?CARD:'transparent', fontWeight:tab===v?700:400, color:tab===v?P:MUTED, cursor:'pointer', fontSize:12, fontFamily:FONT }}>{l}</button>
        ))}
      </div>

      {/* ── Mes cartes GTP ── */}
      {tab==='cards' && (
        loading ? <Spin /> : cards.length === 0 ? (
          <Box style={{ textAlign:'center', padding:48 }}>
            <div style={{ fontSize:56, marginBottom:16 }}>🌍</div>
            <div style={{ fontSize:16, fontWeight:700, marginBottom:8, fontFamily:FONT }}>Aucune carte C-Pay</div>
            <div style={{ fontSize:13, color:MUTED, marginBottom:20, fontFamily:FONT }}>Émettez votre carte virtuelle GIMAC gratuite</div>
            <Btn onClick={()=>setTab('issue')} color={P}>➕ {t('gtpIssue')}</Btn>
          </Box>
        ) : (
          <div>
            {/* Sélecteur cartes */}
            {cards.length > 1 && (
              <div style={{ display:'flex', gap:10, marginBottom:16, overflowX:'auto' }}>
                {cards.map(c => (
                  <button key={c.gtp_card_id} onClick={()=>setSelectedCard(c)}
                    style={{ background:selectedCard?.gtp_card_id===c.gtp_card_id?`${BLUE}18`:CARD, border:`2px solid ${selectedCard?.gtp_card_id===c.gtp_card_id?BLUE:BORDER}`, borderRadius:10, padding:'10px 16px', cursor:'pointer', fontFamily:FONT, fontSize:12, whiteSpace:'nowrap' }}>
                    💳 {c.pan_masked}
                  </button>
                ))}
              </div>
            )}
            {selectedCard && (
              <>
                {/* Carte GTP visuelle */}
                <div style={{ background:`linear-gradient(135deg, ${BLUE}, #0a3060)`, borderRadius:20, padding:'28px', marginBottom:16, color:'#fff', position:'relative', overflow:'hidden', boxShadow:'0 8px 32px rgba(10,48,96,0.35)' }}>
                  <div style={{ position:'absolute', top:-30, right:-20, width:180, height:180, borderRadius:'50%', background:'rgba(255,255,255,0.06)' }} />
                  <div style={{ position:'absolute', bottom:-50, left:-10, width:220, height:220, borderRadius:'50%', background:'rgba(18,182,199,0.12)' }} />
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
                    <div>
                      <div style={{ fontSize:11, opacity:0.7, letterSpacing:2, fontFamily:FONT }}>C-PAY CARD</div>
                      <div style={{ fontSize:10, opacity:0.6, marginTop:2, fontFamily:FONT }}>GIMAC · CEMAC · {selectedCard.country}</div>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:11, opacity:0.7, fontFamily:FONT }}>{selectedCard.network}</div>
                      <div style={{ fontSize:11, background:selectedCard.status==='active'?'rgba(0,200,150,0.3)':'rgba(255,100,100,0.3)', borderRadius:12, padding:'2px 10px', marginTop:4, fontWeight:700, fontFamily:FONT }}>
                        {selectedCard.status==='active'?'✓ ACTIVE':'❄️ GELÉE'}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize:20, letterSpacing:4, fontFamily:'monospace', marginBottom:20 }}>{selectedCard.pan_masked}</div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end' }}>
                    <div>
                      <div style={{ fontSize:10, opacity:0.6, fontFamily:FONT }}>SOLDE DISPONIBLE</div>
                      {balance
                        ? <div style={{ fontSize:26, fontWeight:800, fontFamily:FONT }}>{fmtNum(balance.balance)} <span style={{ fontSize:14, opacity:0.8 }}>XAF</span></div>
                        : <div style={{ fontSize:14, opacity:0.6, fontFamily:FONT }}>Chargement…</div>}
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:10, opacity:0.6, fontFamily:FONT }}>{selectedCard.cardholder_name}</div>
                      <div style={{ fontSize:12, fontFamily:'monospace' }}>{String(selectedCard.expiry_month).padStart(2,'0')}/{selectedCard.expiry_year}</div>
                    </div>
                  </div>
                </div>

                {/* Actions rapides */}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:16 }}>
                  {[['💸 Payer','pay',P],['⬆️ Recharger','topup',SUCCESS],['⬇️ Transférer','unload',WARNING]].map(([l,v,c]) => (
                    <Btn key={v} onClick={()=>setTab(v)} color={c} style={{ padding:'10px 8px', fontSize:12 }}>{l}</Btn>
                  ))}
                </div>

                {/* Geler/Activer */}
                <Btn onClick={toggleFreeze} color={selectedCard.status==='active'?WARNING:SUCCESS} outline style={{ width:'100%', marginBottom:16 }}>
                  {selectedCard.status==='active' ? '❄️ Geler la carte' : '✅ Activer la carte'}
                </Btn>

                {/* Stats */}
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
                  {[[lang==='fr'?'Dépenses (30j)':'Spending (30d)', fmtNum(selectedCard.month_spent||0), DANGER],[lang==='fr'?'Rechargements':'Top-ups', fmtNum(selectedCard.month_topup||0), SUCCESS],[lang==='fr'?'Transactions':'Transactions', selectedCard.month_count||0, P]].map(([l,v,c]) => (
                    <Box key={l} style={{ padding:14, marginBottom:0 }}>
                      <div style={{ fontSize:10, color:MUTED, marginBottom:4, fontFamily:FONT }}>{l}</div>
                      <div style={{ fontSize:18, fontWeight:700, color:c, fontFamily:FONT }}>{v}</div>
                    </Box>
                  ))}
                </div>
              </>
            )}
          </div>
        )
      )}

      {/* ── Émettre une carte ── */}
      {tab==='issue' && (
        !newCard ? (
          <Box style={{ maxWidth:480 }}>
            <h3 style={{ margin:'0 0 6px', fontFamily:FONT }}>➕ {t('gtpIssue')}</h3>
            <div style={{ fontSize:12, color:MUTED, marginBottom:16, fontFamily:FONT }}>Carte virtuelle Visa/GIMAC · Réseau CEMAC · Valide 3 ans</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <div>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Prénom *</label>
                <input value={issueForm.firstName} onChange={e=>setIssueForm(f=>({...f,firstName:e.target.value}))} placeholder="JEAN" style={inp} />
              </div>
              <div>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Nom *</label>
                <input value={issueForm.lastName} onChange={e=>setIssueForm(f=>({...f,lastName:e.target.value}))} placeholder="DUPONT" style={inp} />
              </div>
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Date de naissance</label>
              <input type="date" value={issueForm.dateOfBirth} onChange={e=>setIssueForm(f=>({...f,dateOfBirth:e.target.value}))} style={inp} />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:14 }}>
              <div>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Type pièce d'identité</label>
                <select value={issueForm.idType} onChange={e=>setIssueForm(f=>({...f,idType:e.target.value}))} style={sel}>
                  <option value="national_id">CNI</option>
                  <option value="passport">Passeport</option>
                  <option value="drivers_license">Permis</option>
                </select>
              </div>
              <div>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Numéro pièce</label>
                <input value={issueForm.idNumber} onChange={e=>setIssueForm(f=>({...f,idNumber:e.target.value}))} placeholder="123456789" style={inp} />
              </div>
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Pays CEMAC *</label>
              <select value={issueForm.country} onChange={e=>setIssueForm(f=>({...f,country:e.target.value}))} style={sel}>
                {CEMAC.map(c => <option key={c.v} value={c.v}>{c.l}</option>)}
              </select>
            </div>
            <div style={{ background:`${BLUE}08`, border:`1px solid ${BLUE}25`, borderRadius:10, padding:12, marginBottom:16, fontSize:12, color:TEXT, fontFamily:FONT }}>
              🌍 <strong>Réseau GIMAC</strong> — Acceptée dans toute la CEMAC chez tous les commerçants affiliés Visa/GIMAC. Émission instantanée.
            </div>
            <Btn onClick={issueCard} disabled={issuing} color={BLUE} style={{ width:'100%', fontSize:15 }}>
              {issuing ? t('gtpIssuing') : `🌍 ${t('gtpIssue')}`}
            </Btn>
          </Box>
        ) : (
          <Box style={{ maxWidth:480, textAlign:'center' }}>
            <div style={{ fontSize:56, marginBottom:12 }}>🎉</div>
            <div style={{ fontSize:18, fontWeight:700, color:SUCCESS, marginBottom:16, fontFamily:FONT }}>{t('gtpIssued')}</div>
            <div style={{ background:`linear-gradient(135deg,${BLUE},#0a3060)`, borderRadius:16, padding:'24px', color:'#fff', marginBottom:20 }}>
              <div style={{ fontSize:10, opacity:0.7, letterSpacing:2, marginBottom:14, fontFamily:FONT }}>C-PAY CARD · GIMAC · CEMAC</div>
              <div style={{ fontSize:18, letterSpacing:4, fontFamily:'monospace', marginBottom:14 }}>{newCard.cardMasked}</div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:12 }}>
                <span style={{ fontFamily:FONT }}>{issueForm.firstName} {issueForm.lastName}</span>
                <span style={{ fontFamily:'monospace' }}>{String(newCard.expiryMonth).padStart(2,'0')}/{newCard.expiryYear}</span>
              </div>
            </div>
            {newCard.cvv2 && (
              <div style={{ background:`${WARNING}15`, border:`2px solid ${WARNING}`, borderRadius:10, padding:16, marginBottom:20 }}>
                <div style={{ fontSize:12, fontWeight:700, color:WARNING, marginBottom:8, fontFamily:FONT }}>⚠️ {t('gtpCvvNotice')}</div>
                <div style={{ fontSize:32, fontFamily:'monospace', color:TEXT, fontWeight:700, letterSpacing:8 }}>{newCard.cvv2}</div>
                <div style={{ fontSize:11, color:MUTED, marginTop:6, fontFamily:FONT }}>Code CVV2 — confidentiel</div>
              </div>
            )}
            <Btn onClick={()=>{ setNewCard(null); setTab('cards'); }} color={P} style={{ width:'100%' }}>Voir ma carte</Btn>
          </Box>
        )
      )}

      {/* ── Paiement ── */}
      {tab==='pay' && (
        <Box style={{ maxWidth:480 }}>
          {!selectedCard ? <div style={{ color:MUTED, fontFamily:FONT }}>Aucune carte sélectionnée</div> : !payResult ? (
            <>
              <h3 style={{ margin:'0 0 16px', fontFamily:FONT }}>💸 Payer avec C-Pay Card</h3>
              {/* Schéma */}
              <div style={{ marginBottom:16 }}>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6, fontFamily:FONT }}>{t('gtpSchemaLabel')}</label>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  {[['1',t('gtpSchema1')],['2',t('gtpSchema2')]].map(([v,l]) => (
                    <button key={v} onClick={()=>setPayForm(f=>({...f,schema:v}))}
                      style={{ padding:'10px 8px', borderRadius:8, border:`2px solid ${payForm.schema===v?BLUE:BORDER}`, background:payForm.schema===v?`${BLUE}12`:CARD, color:payForm.schema===v?BLUE:MUTED, cursor:'pointer', fontSize:11, fontFamily:FONT, fontWeight:payForm.schema===v?700:400, textAlign:'center' }}>
                      {l}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize:11, color:MUTED, marginTop:6, fontFamily:FONT }}>
                  {payForm.schema==='1' ? '→ Débite directement la carte GTP via GIMAC' : '→ Utilise votre token C-Pay pour payer via GIMAC'}
                </div>
              </div>
              <div style={{ marginBottom:12 }}>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{t('amount')} (XAF) *</label>
                <input type="number" value={payForm.amount} onChange={e=>setPayForm(f=>({...f,amount:e.target.value}))} placeholder="5000" style={inp} />
              </div>
              <div style={{ marginBottom:12 }}>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Nom du marchand</label>
                <input value={payForm.merchantName} onChange={e=>setPayForm(f=>({...f,merchantName:e.target.value}))} placeholder="BOUTIQUE CENTRALE" style={inp} />
              </div>
              <div style={{ marginBottom:14 }}>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{t('description')}</label>
                <input value={payForm.description} onChange={e=>setPayForm(f=>({...f,description:e.target.value}))} placeholder="Achat divers" style={inp} />
              </div>
              <div style={{ marginBottom:20 }}>
                <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6, fontFamily:FONT }}>PIN (4 chiffres) *</label>
                <PinInput value={payForm.pin} onChange={v=>setPayForm(f=>({...f,pin:v}))} />
              </div>
              <Btn onClick={pay} disabled={paying} color={P} style={{ width:'100%' }}>{paying ? t('paying') : '💸 Confirmer le paiement GIMAC'}</Btn>
            </>
          ) : (
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:56 }}>✅</div>
              <div style={{ fontSize:18, fontWeight:700, color:SUCCESS, marginBottom:8, fontFamily:FONT }}>Paiement approuvé</div>
              <div style={{ fontSize:28, fontWeight:800, color:TEXT, marginBottom:4, fontFamily:FONT }}>{fmtNum(payResult.amount)} XAF</div>
              <div style={{ fontSize:13, color:MUTED, marginBottom:4, fontFamily:FONT }}>Auth: {payResult.authCode} · RRN: {payResult.rrn}</div>
              <div style={{ fontSize:12, color:BLUE, marginBottom:4, fontFamily:FONT }}>{payResult.schema==='TOKENIZED'?'🔐 Token C-Pay → GIMAC':'🌍 Débit direct GIMAC'}</div>
              <div style={{ fontSize:11, color:MUTED, marginBottom:20, fontFamily:FONT }}>Réseau: {payResult.network}</div>
              <Btn onClick={()=>setPayResult(null)} color={P}>Nouveau paiement</Btn>
            </div>
          )}
        </Box>
      )}

      {/* ── Top-up ── */}
      {tab==='topup' && (
        <Box style={{ maxWidth:480 }}>
          <h3 style={{ margin:'0 0 16px', fontFamily:FONT }}>⬆️ Recharger via Mobile Money</h3>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{t('amount')} * (min 500 XAF)</label>
            <input type="number" value={topupForm.amount} onChange={e=>setTopupForm(f=>({...f,amount:e.target.value}))} placeholder="10000" style={inp} />
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Opérateur</label>
            <select value={topupForm.operator} onChange={e=>setTopupForm(f=>({...f,operator:e.target.value}))} style={sel}>
              {[['mtn','MTN Mobile Money'],['orange','Orange Money'],['airtel','Airtel Money'],['vodacom','Vodacom M-Pesa']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div style={{ marginBottom:16 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Numéro Mobile Money *</label>
            <input value={topupForm.mmPhone} onChange={e=>setTopupForm(f=>({...f,mmPhone:e.target.value}))} placeholder="+237XXXXXXXXX" style={inp} />
          </div>
          {topupForm.amount && parseFloat(topupForm.amount) >= 500 && (
            <div style={{ background:`${SUCCESS}10`, border:`1px solid ${SUCCESS}30`, borderRadius:8, padding:10, marginBottom:16, fontSize:12, fontFamily:FONT }}>
              💰 Crédité sur votre carte : <strong>{fmtNum(Math.round(parseFloat(topupForm.amount)*0.99))} XAF</strong> (frais 1%)
            </div>
          )}
          <Btn onClick={doTopup} disabled={toppingUp} color={SUCCESS} style={{ width:'100%' }}>{toppingUp ? t('toppingUp') : '⬆️ Recharger la C-Pay Card'}</Btn>
        </Box>
      )}

      {/* ── Unload ── */}
      {tab==='unload' && (
        <Box style={{ maxWidth:480 }}>
          <h3 style={{ margin:'0 0 16px', fontFamily:FONT }}>⬇️ Transférer vers Mobile Money</h3>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{t('amount')} * (min 500 XAF)</label>
            <input type="number" value={unloadForm.amount} onChange={e=>setUnloadForm(f=>({...f,amount:e.target.value}))} placeholder="10000" style={inp} />
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Opérateur</label>
            <select value={unloadForm.operator} onChange={e=>setUnloadForm(f=>({...f,operator:e.target.value}))} style={sel}>
              {[['mtn','MTN Mobile Money'],['orange','Orange Money'],['airtel','Airtel Money'],['vodacom','Vodacom M-Pesa']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div style={{ marginBottom:12 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>Numéro Mobile Money *</label>
            <input value={unloadForm.mmPhone} onChange={e=>setUnloadForm(f=>({...f,mmPhone:e.target.value}))} placeholder="+237XXXXXXXXX" style={inp} />
          </div>
          <div style={{ marginBottom:20 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6, fontFamily:FONT }}>PIN *</label>
            <PinInput value={unloadForm.pin} onChange={v=>setUnloadForm(f=>({...f,pin:v}))} />
          </div>
          <Btn onClick={doUnload} disabled={unloading} color={WARNING} style={{ width:'100%' }}>{unloading ? t('unloading') : '⬇️ Transférer'}</Btn>
        </Box>
      )}

      {/* ── Historique GTP ── */}
      {tab==='txns' && (
        <Box>
          <h3 style={{ margin:'0 0 16px', fontFamily:FONT }}>📋 Transactions GIMAC</h3>
          {txns.length === 0 ? <div style={{ color:MUTED, fontSize:13, textAlign:'center', padding:32, fontFamily:FONT }}>Aucune transaction GTP</div>
          : txns.map((txn, i) => (
            <div key={txn.txn_id||i} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 0', borderBottom:`1px solid ${BORDER}` }}>
              <div style={{ width:40, height:40, borderRadius:12, background:`${sc(txn.type)}18`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>
                {txn.type==='payment'?'💸':txn.type==='topup'?'⬆️':'⬇️'}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:600, color:TEXT, fontFamily:FONT }}>{txn.merchant_name || txn.type}</div>
                <div style={{ fontSize:11, color:MUTED, fontFamily:FONT }}>{txn.auth_code} · {fmtDate(txn.created_at, lang)}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:15, fontWeight:700, color:txn.type==='topup'?SUCCESS:DANGER, fontFamily:FONT }}>
                  {txn.type==='topup'?'+':'-'}{fmtNum(txn.amount)} XAF
                </div>
                <Badge label={txn.response_code==='00'?'OK':txn.response_code||txn.status} color={txn.response_code==='00'?SUCCESS:DANGER} />
              </div>
            </div>
          ))}
        </Box>
      )}
    </div>
  );
};

// ─── EnrollForm ───────────────────────────────────────────────────
const EnrollForm = ({ lang, onSuccess, onCancel }) => {
  const t = k => T[lang][k] || k;
  const [pan, setPan]         = useState('');
  const [expiry, setExpiry]   = useState('');
  const [cvv, setCvv]         = useState('');
  const [name, setName]       = useState('');
  const [loading, setLoading] = useState(false);
  const [panError, setPanError] = useState('');

  const network = detectNetwork(pan);
  const panClean = pan.replace(/\D/g,'');
  const panValid = panClean.length >= 13 && luhnCheck(panClean);

  const handlePan = (v) => {
    const formatted = formatPan(v);
    setPan(formatted);
    const clean = formatted.replace(/\D/g,'');
    if (clean.length >= 13) setPanError(luhnCheck(clean) ? '' : t('luhnError'));
    else setPanError('');
  };

  const submit = async () => {
    // Validations côté client
    if (!panValid) return toast.error(t('luhnError'));
    const [expM, expY] = expiry.split('/');
    if (!expM || !expY || expY.length < 2) return toast.error(t('expiry'));
    if (!cvv || cvv.length < 3) return toast.error(t('cvvRequired'));
    setLoading(true);
    try {
      // 1. Obtenir la session key du serveur
      const { data: keyData } = await api.get('/cards/session-key');

      // 2. Chiffrer le PAN avec SubtleCrypto (jamais en clair sur le réseau)
      const encrypted = await encryptPan(panClean, keyData.sessionKey);

      // 3. Envoyer le PAN chiffré + métadonnées non-sensibles
      const { data } = await api.post('/cards/enroll', {
        encryptedPan: { keyId: keyData.keyId, ...encrypted },
        expiryMonth:  parseInt(expM),
        expiryYear:   parseInt('20'+expY.slice(-2)),
        cardholderName: name.trim() || undefined,
        cvvProvided:  true, // boolean uniquement — CVV jamais transmis
      });

      // 4. Zéroïser les variables sensibles
      setPan(''); setCvv(''); setExpiry(''); setName('');

      toast.success(t('enrollSuccess'));
      onSuccess(data.card);
    } catch (err) {
      const code = err.response?.data?.code;
      const msg  = err.response?.data?.error;
      if (code === 'CARD_ALREADY_ENROLLED') toast.error(t('enrollErrorDup'));
      else if (code === 'LUHN_FAILED') toast.error(t('luhnError'));
      else if (code === 'CARD_EXPIRED') toast.error(t('enrollErrorExp'));
      else toast.error(msg || t('error'));
    } finally { setLoading(false); }
  };

  return (
    <div>
      {/* Banner sécurité */}
      <div style={{ display:'flex', alignItems:'center', gap:8, background:`${SUCCESS}10`, border:`1px solid ${SUCCESS}30`, borderRadius:8, padding:'8px 12px', marginBottom:16, fontSize:11, color:SUCCESS }}>
        🔒 {t('secureInput')}
      </div>

      {/* Prévisualisation carte */}
      <div style={{ background:network==='visa'?'linear-gradient(135deg,#1a1f71,#12b6c7)':network==='mastercard'?'linear-gradient(135deg,#eb001b,#f79e1b)':'linear-gradient(135deg,#1d4f92,#12b6c7)', borderRadius:14, padding:'20px 22px', marginBottom:20, color:'#fff', fontFamily:'monospace', boxShadow:'0 6px 24px rgba(0,0,0,0.2)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:16 }}>
          <span style={{ fontSize:12, opacity:0.8, fontFamily:FONT }}>C-Pay</span>
          <span style={{ fontSize:18 }}>{NETWORK_ICONS[network]}</span>
        </div>
        <div style={{ fontSize:20, letterSpacing:3, marginBottom:16 }}>
          {pan || '•••• •••• •••• ••••'}
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', fontSize:13 }}>
          <span style={{ fontFamily:FONT }}>{name || 'VOTRE NOM'}</span>
          <span>{expiry || 'MM/AA'}</span>
        </div>
      </div>

      {/* Numéro de carte */}
      <div style={{ marginBottom:14 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{t('cardNumber')} *</label>
        <div style={{ position:'relative' }}>
          <input
            value={pan} onChange={e=>handlePan(e.target.value)}
            maxLength={23} placeholder="1234 5678 9012 3456"
            inputMode="numeric" autoComplete="cc-number"
            style={{ width:'100%', background:BG, border:`2px solid ${panError?DANGER:panValid&&pan?SUCCESS:BORDER}`, borderRadius:8, padding:'11px 44px 11px 12px', fontSize:16, letterSpacing:2, fontFamily:'monospace', boxSizing:'border-box', color:TEXT }}
          />
          <span style={{ position:'absolute', right:12, top:'50%', transform:'translateY(-50%)', fontSize:18 }}>{NETWORK_ICONS[network]}</span>
        </div>
        {panError && <div style={{ fontSize:11, color:DANGER, marginTop:4, fontFamily:FONT }}>{panError}</div>}
        {panValid && <div style={{ fontSize:11, color:SUCCESS, marginTop:4, fontFamily:FONT }}>✓ Numéro valide</div>}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:14 }}>
        <div>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{t('expiry')} *</label>
          <input
            value={expiry} onChange={e=>setExpiry(formatExpiry(e.target.value))}
            maxLength={5} placeholder="MM/AA" inputMode="numeric" autoComplete="cc-exp"
            style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'11px 12px', fontSize:14, fontFamily:'monospace', boxSizing:'border-box', color:TEXT }}
          />
        </div>
        <div>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{t('cvvLabel')} *</label>
          <input
            value={cvv} onChange={e=>setCvv(e.target.value.replace(/\D/g,'').slice(0,4))}
            maxLength={4} placeholder="•••" type="password" inputMode="numeric" autoComplete="cc-csc"
            style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'11px 12px', fontSize:14, fontFamily:'monospace', boxSizing:'border-box', color:TEXT }}
          />
          <div style={{ fontSize:10, color:MUTED, marginTop:3, fontFamily:FONT }}>{t('cvvHint')}</div>
        </div>
      </div>

      <div style={{ marginBottom:20 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{t('cardName')}</label>
        <input
          value={name} onChange={e=>setName(e.target.value.toUpperCase())}
          placeholder="JEAN DUPONT" autoComplete="cc-name"
          style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'11px 12px', fontSize:14, fontFamily:'monospace', boxSizing:'border-box', color:TEXT }}
        />
      </div>

      <div style={{ background:`${BLUE}08`, border:`1px solid ${BLUE}20`, borderRadius:8, padding:'10px 14px', marginBottom:16, fontSize:11, color:MUTED, fontFamily:FONT }}>
        🛡️ {lang==='fr'?'Le CVV n\'est jamais transmis ni stocké. Le numéro de carte est chiffré AES-256-GCM avant envoi.':'CVV is never transmitted or stored. Card number is AES-256-GCM encrypted before sending.'}
      </div>

      <div style={{ display:'flex', gap:10 }}>
        <Btn onClick={onCancel} outline color={MUTED} style={{ flex:1 }}>{lang==='fr'?'Annuler':'Cancel'}</Btn>
        <Btn onClick={submit} disabled={loading||!panValid} color={P} style={{ flex:2 }}>
          {loading ? t('enrolling') : `🔐 ${t('enrollCard')}`}
        </Btn>
      </div>
    </div>
  );
};

// ─── MyCards ──────────────────────────────────────────────────────
const MyCards = ({ lang }) => {
  const t = k => T[lang][k] || k;
  const [cards, setCards]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showEnroll, setShowEnroll] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ cardType:'virtual', currency:'XAF' });
  const [creating, setCreating] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/cards').then(r => setCards(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false));
  };
  useEffect(()=>{ load(); },[]);

  const setDefault = async (id) => {
    try { await api.patch(`/cards/${id}/default`); toast.success(lang==='fr'?'Carte par défaut définie ✅':'Default card set ✅'); load(); }
    catch { toast.error(t('error')); }
  };

  const remove = async (id) => {
    if (!window.confirm(lang==='fr'?'Supprimer cette carte ?':'Remove this card?')) return;
    try { await api.delete(`/cards/${id}`); toast.success(lang==='fr'?'Carte supprimée':'Card removed'); load(); }
    catch(err) { toast.error(err.response?.data?.error||t('error')); }
  };

  const createCard = async () => {
    setCreating(true);
    try {
      await api.post('/cards/create', createForm);
      toast.success(lang==='fr'?'Carte créée ✅':'Card created ✅');
      setShowCreate(false);
      load();
    } catch(err) { toast.error(err.response?.data?.error||(lang==='fr'?'Erreur création':'Creation error')); }
    finally { setCreating(false); }
  };

  const CARD_COLORS = { visa:'linear-gradient(135deg,#1a1f71,#1d4f92)', mastercard:'linear-gradient(135deg,#eb001b,#f79e1b)', default:'linear-gradient(135deg,#1d4f92,#12b6c7)' };
  const inp = { width:'100%', background:'#f0f4f8', border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box', marginBottom:14 };

  // Cartes simulées si API vide
  const displayCards = cards.length > 0 ? cards : [
    { enrollmentId:'card-001', cardType:'created',  cardMasked:'4532 •••• •••• 7821', network:'visa',       isDefault:true,  status:'active',  currency:'XAF', expiryMonth:12, expiryYear:28, cardholderName:'Boutique Test C-Pay', balance:45750 },
    { enrollmentId:'card-002', cardType:'created',  cardMasked:'5412 •••• •••• 3309', network:'mastercard', isDefault:false, status:'frozen',  currency:'XAF', expiryMonth:9,  expiryYear:27, cardholderName:'Boutique Test C-Pay', balance:12300 },
    { enrollmentId:'card-003', cardType:'enrolled', cardMasked:'6011 •••• •••• 5544', network:'visa',       isDefault:false, status:'active',  currency:'XAF', expiryMonth:6,  expiryYear:26, cardholderName:'Boutique Test C-Pay', balance:8900 },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700, fontFamily:FONT }}>💳 {lang==='fr'?'Mes Cartes':'My Cards'}</h1>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={()=>{setShowCreate(false);setShowEnroll(!showEnroll);}}
            style={{ background:'none', border:`2px solid ${P}`, color:P, borderRadius:8, padding:'9px 16px', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT }}>
            🔗 {lang==='fr'?'Enroller une carte':'Enroll a card'}
          </button>
          <button onClick={()=>{setShowEnroll(false);setShowCreate(!showCreate);}}
            style={{ background:P, border:'none', color:'#fff', borderRadius:8, padding:'9px 16px', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT }}>
            + {lang==='fr'?'Créer une carte':'Create a card'}
          </button>
        </div>
      </div>

      {/* Modal Enroller */}
      {showEnroll && (
        <div style={{ background:'#fff', border:`1px solid ${P}30`, borderRadius:12, padding:24, marginBottom:20 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
            <div style={{ fontSize:15, fontWeight:700, fontFamily:FONT }}>🔗 {lang==='fr'?'Enroller une carte existante':'Enroll an existing card'}</div>
            <button onClick={()=>setShowEnroll(false)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:MUTED }}>×</button>
          </div>
          <div style={{ background:'#f0f4f8', borderRadius:8, padding:12, marginBottom:16, fontSize:12, color:MUTED }}>
            {lang==='fr'?'Enrollez une carte bancaire physique existante pour l&apos;utiliser dans l&apos;application.':'Enroll an existing physical bank card to use in the app.'}
          </div>
          <EnrollForm lang={lang} onSuccess={()=>{ setShowEnroll(false); load(); }} onCancel={()=>setShowEnroll(false)} />
        </div>
      )}

      {/* Modal Créer */}
      {showCreate && (
        <div style={{ background:'#fff', border:`1px solid ${P}30`, borderRadius:12, padding:24, marginBottom:20 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
            <div style={{ fontSize:15, fontWeight:700, fontFamily:FONT }}>✨ {lang==='fr'?'Créer une nouvelle carte':'Create a new card'}</div>
            <button onClick={()=>setShowCreate(false)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:MUTED }}>×</button>
          </div>
          <div style={{ background:'#f0f4f8', borderRadius:8, padding:12, marginBottom:16, fontSize:12, color:MUTED }}>
            {lang==='fr'?'Une carte virtuelle sera créée et disponible immédiatement.':'A virtual card will be created and available immediately.'}
          </div>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Type de carte':'Card type'}</label>
          <select value={createForm.cardType} onChange={e=>setCreateForm(p=>({...p,cardType:e.target.value}))} style={inp}>
            <option value="virtual">{lang==='fr'?'Carte virtuelle':'Virtual card'}</option>
            <option value="physical">{lang==='fr'?'Carte physique (envoi postal)':'Physical card (postal delivery)'}</option>
          </select>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Devise':'Currency'}</label>
          <select value={createForm.currency} onChange={e=>setCreateForm(p=>({...p,currency:e.target.value}))} style={inp}>
            <option value="XAF">XAF — Franc CFA</option>
            <option value="USD">USD — Dollar</option>
            <option value="EUR">EUR — Euro</option>
          </select>
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={createCard} disabled={creating}
              style={{ flex:1, background:P, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:14, fontWeight:700, cursor:creating?'not-allowed':'pointer', fontFamily:FONT, opacity:creating?0.7:1 }}>
              {creating?(lang==='fr'?'Création…':'Creating…'):(lang==='fr'?'✨ Créer la carte':'✨ Create card')}
            </button>
            <button onClick={()=>setShowCreate(false)}
              style={{ flex:1, background:'none', border:`1px solid ${BORDER}`, borderRadius:8, padding:'12px', fontSize:14, cursor:'pointer', fontFamily:FONT }}>
              {lang==='fr'?'Annuler':'Cancel'}
            </button>
          </div>
        </div>
      )}

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, marginBottom:20 }}>
        {[
          [lang==='fr'?'Total cartes':'Total cards', displayCards.length, P],
          [lang==='fr'?'Cartes créées':'Created cards', displayCards.filter(c=>c.cardType==='created').length, SUCCESS],
          [lang==='fr'?'Cartes enrollées':'Enrolled cards', displayCards.filter(c=>c.cardType==='enrolled').length, '#9b59b6'],
        ].map(([label,val,color])=>(
          <div key={label} style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:10, padding:'14px 16px', borderTop:`3px solid ${color}`, textAlign:'center' }}>
            <div style={{ fontSize:22, fontWeight:800, color }}>{val}</div>
            <div style={{ fontSize:11, color:MUTED, fontFamily:FONT }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Liste cartes */}
      {loading ? <div style={{ textAlign:'center', padding:32, color:MUTED }}>Chargement…</div> : (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(300px, 1fr))', gap:16 }}>
          {displayCards.map(card => {
            const isCreated = card.cardType === 'created';
            const isFrozen  = card.status === 'frozen';
            const bgColor   = CARD_COLORS[card.network] || CARD_COLORS.default;
            return (
              <div key={card.enrollmentId} style={{ borderRadius:18, overflow:'hidden', boxShadow:card.isDefault?`0 0 0 3px ${P}, 0 8px 24px rgba(0,0,0,0.2)`:'0 4px 16px rgba(0,0,0,0.1)' }}>
                {/* Carte */}
                <div style={{ background:isFrozen?'linear-gradient(135deg,#8a9ab0,#5a6677)':bgColor, padding:'22px 24px', color:'#fff', position:'relative' }}>
                  {/* Badges */}
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:12 }}>
                    <div style={{ display:'flex', gap:6 }}>
                      <span style={{ background:'rgba(255,255,255,0.2)', borderRadius:20, padding:'2px 8px', fontSize:10, fontWeight:700 }}>
                        {isCreated?(lang==='fr'?'Créée':'Created'):(lang==='fr'?'Enrollée':'Enrolled')}
                      </span>
                      {card.isDefault && (
                        <span style={{ background:'rgba(255,255,255,0.3)', borderRadius:20, padding:'2px 8px', fontSize:10, fontWeight:700 }}>
                          ⭐ {lang==='fr'?'Défaut':'Default'}
                        </span>
                      )}
                    </div>
                    <span style={{ background:isFrozen?'rgba(255,100,100,0.3)':'rgba(0,200,150,0.3)', borderRadius:20, padding:'2px 8px', fontSize:10, fontWeight:700 }}>
                      {isFrozen?'❄️ '+(lang==='fr'?'Gelée':'Frozen'):'✅ '+(lang==='fr'?'Active':'Active')}
                    </span>
                  </div>
                  <div style={{ fontSize:18, letterSpacing:3, fontFamily:'monospace', marginBottom:16 }}>{card.cardMasked}</div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end' }}>
                    <div>
                      <div style={{ fontSize:10, opacity:0.7 }}>{lang==='fr'?'Solde':'Balance'}</div>
                      <div style={{ fontSize:20, fontWeight:800 }}>{(card.balance||0).toLocaleString('fr-FR')} {card.currency||'XAF'}</div>
                    </div>
                    <div style={{ textAlign:'right' }}>
                      <div style={{ fontSize:10, opacity:0.7 }}>{lang==='fr'?'EXP':'EXP'}</div>
                      <div style={{ fontFamily:'monospace', fontSize:13 }}>{String(card.expiryMonth||'').padStart(2,'0')}/{card.expiryYear}</div>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderBottomLeftRadius:18, borderBottomRightRadius:18, padding:'12px 16px' }}>
                  <div style={{ fontSize:11, color:MUTED, marginBottom:10, fontFamily:FONT }}>
                    {isCreated
                      ? (lang==='fr'?'✅ Charger · Décharger · Payer · Geler/Activer':'✅ Top-up · Unload · Pay · Freeze/Activate')
                      : (lang==='fr'?'⚠️ Charger et Payer uniquement':'⚠️ Top-up and Pay only')}
                  </div>
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                    {!card.isDefault && (
                      <button onClick={()=>setDefault(card.enrollmentId)}
                        style={{ background:`${P}10`, border:`1px solid ${P}30`, color:P, borderRadius:6, padding:'6px 12px', cursor:'pointer', fontSize:11, fontWeight:600, fontFamily:FONT }}>
                        ⭐ {lang==='fr'?'Définir défaut':'Set default'}
                      </button>
                    )}
                    {isCreated && (
                      <button onClick={()=>toast(lang==='fr'?'Geler/Activer — bientôt disponible':'Freeze/Activate — coming soon')}
                        style={{ background:`${WARNING}10`, border:`1px solid ${WARNING}30`, color:WARNING, borderRadius:6, padding:'6px 12px', cursor:'pointer', fontSize:11, fontWeight:600, fontFamily:FONT }}>
                        {isFrozen?'🔓 '+(lang==='fr'?'Activer':'Activate'):'❄️ '+(lang==='fr'?'Geler':'Freeze')}
                      </button>
                    )}
                    <button onClick={()=>remove(card.enrollmentId)}
                      style={{ background:`${DANGER}10`, border:`1px solid ${DANGER}30`, color:DANGER, borderRadius:6, padding:'6px 12px', cursor:'pointer', fontSize:11, fontWeight:600, fontFamily:FONT, marginLeft:'auto' }}>
                      🗑️ {lang==='fr'?'Supprimer':'Remove'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const HistoriqueTab = ({ lang, txns, loading, cards }) => {
  const navigate = useNavigate();
  const [filterCard, setFilterCard]     = useState('all');
  const [filterPeriod, setFilterPeriod] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filterType, setFilterType]     = useState('all');
  const [search, setSearch]             = useState('');
  const [flagged, setFlagged]           = useState({});
  const [showFlag, setShowFlag]         = useState(null);

  const fmt = n => parseFloat(n||0).toLocaleString('fr-FR');

  // Filtres
  const filtered = txns.filter(tx => {
    if (filterCard !== 'all' && tx.card_id !== filterCard) return false;
    if (filterType !== 'all' && tx.type !== filterType) return false;
    if (search && !((tx.description||'')+(tx.auth_code||'')).toLowerCase().includes(search.toLowerCase())) return false;
    if (filterPeriod !== 'all') {
      const d = new Date(tx.created_at);
      const now = new Date();
      if (filterPeriod === '7d'  && (now - d) > 7*86400000)  return false;
      if (filterPeriod === '30d' && (now - d) > 30*86400000) return false;
      if (filterPeriod === '90d' && (now - d) > 90*86400000) return false;
      if (filterPeriod === 'custom') {
        if (dateFrom && d < new Date(dateFrom)) return false;
        if (dateTo   && d > new Date(dateTo + 'T23:59:59')) return false;
      }
    }
    return true;
  });

  const openIncident = (tx) => {
    navigate('/incidents', { state: { subject: `Transaction ${tx.auth_code||tx.txn_id?.slice(-8)||''}`, description: `Transaction de ${fmt(tx.amount)} XAF le ${new Date(tx.created_at).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}` } });
  };

  const selStyle = { background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:12, color:TEXT, fontFamily:FONT, cursor:'pointer' };

  return (
    <div>
      {/* Filtres */}
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, padding:14, marginBottom:14 }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:10 }}>
          {/* Filtre carte */}
          <div>
            <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Carte':'Card'}</label>
            <select value={filterCard} onChange={e=>setFilterCard(e.target.value)} style={selStyle}>
              <option value="all">{lang==='fr'?'Toutes les cartes':'All cards'}</option>
              {cards.map(c=><option key={c.id} value={c.id}>{c.number}</option>)}
            </select>
          </div>
          {/* Filtre période */}
          <div>
            <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Période':'Period'}</label>
            <select value={filterPeriod} onChange={e=>setFilterPeriod(e.target.value)} style={selStyle}>
              <option value="all">{lang==='fr'?'Toutes les dates':'All dates'}</option>
              <option value="7d">{lang==='fr'?'7 derniers jours':'Last 7 days'}</option>
              <option value="30d">{lang==='fr'?'30 derniers jours':'Last 30 days'}</option>
              <option value="90d">{lang==='fr'?'90 derniers jours':'Last 90 days'}</option>
              <option value="custom">{lang==='fr'?'Période personnalisée':'Custom period'}</option>
            </select>
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          {/* Filtre type */}
          <div>
            <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>Type</label>
            <select value={filterType} onChange={e=>setFilterType(e.target.value)} style={selStyle}>
              <option value="all">{lang==='fr'?'Tous les types':'All types'}</option>
              <option value="payment">{lang==='fr'?'Paiements':'Payments'}</option>
              <option value="topup">{lang==='fr'?'Chargements':'Top-ups'}</option>
              <option value="unload">{lang==='fr'?'Déchargements':'Unloads'}</option>
            </select>
          </div>
          {/* Recherche */}
          <div>
            <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Recherche':'Search'}</label>
            <input value={search} onChange={e=>setSearch(e.target.value)}
              placeholder={lang==='fr'?'Référence, description…':'Reference, description…'}
              style={{...selStyle, width:'100%', boxSizing:'border-box'}} />
          </div>
        </div>
      </div>

      {/* Dates personnalisées */}
      {filterPeriod === 'custom' && (
        <div style={{ background:CARD, border:`1px solid ${P}30`, borderRadius:10, padding:12, marginBottom:12 }}>
          <div style={{ fontSize:12, fontWeight:700, color:P, marginBottom:10, fontFamily:FONT }}>
            📅 {lang==='fr'?'Période personnalisée':'Custom period'}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <div>
              <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>
                {lang==='fr'?'Du':'From'}
              </label>
              <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}
                style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:TEXT, fontFamily:FONT, boxSizing:'border-box' }} />
            </div>
            <div>
              <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>
                {lang==='fr'?'Au':'To'}
              </label>
              <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}
                style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:13, color:TEXT, fontFamily:FONT, boxSizing:'border-box' }} />
            </div>
          </div>
          {dateFrom && dateTo && (
            <div style={{ fontSize:11, color:MUTED, marginTop:8 }}>
              {lang==='fr'?'Du':'From'} <strong>{new Date(dateFrom).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}</strong> {lang==='fr'?'au':'to'} <strong>{new Date(dateTo).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}</strong>
            </div>
          )}
        </div>
      )}

      {/* Résultats */}
      <div style={{ fontSize:12, color:MUTED, marginBottom:8 }}>
        {filtered.length} {lang==='fr'?'transaction(s)':'transaction(s)'}
        {(filterCard!=='all'||filterPeriod!=='all'||filterType!=='all'||search||dateFrom||dateTo) && (
          <button onClick={()=>{setFilterCard('all');setFilterPeriod('all');setFilterType('all');setSearch('');}}
            style={{ marginLeft:8, background:'none', border:'none', color:P, cursor:'pointer', fontSize:12 }}>
            × {lang==='fr'?'Effacer filtres':'Clear filters'}
          </button>
        )}
      </div>

      {loading ? <div style={{ textAlign:'center', padding:32, color:MUTED }}>Chargement…</div>
      : filtered.length===0 ? (
        <div style={{ textAlign:'center', padding:40, color:MUTED }}>
          <div style={{ fontSize:40, marginBottom:12 }}>📋</div>
          <div style={{ fontFamily:FONT }}>{lang==='fr'?'Aucune transaction':'No transactions'}</div>
        </div>
      ) : (
        <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, overflow:'hidden' }}>
          {filtered.map((tx,i) => (
            <div key={tx.txn_id||i}
              style={{ padding:'12px 16px', borderBottom:`1px solid ${BORDER}`, background:flagged[tx.txn_id]?'#fff3cd':CARD, borderLeft:`4px solid ${flagged[tx.txn_id]?WARNING:(sc(tx.type||tx.status))}` }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:36, height:36, borderRadius:'50%', background:`${sc(tx.type||tx.status)}20`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0 }}>
                    {tx.type==='topup'?'⬆️':tx.type==='unload'?'⬇️':tx.type==='payment'?'💸':'💳'}
                    {flagged[tx.txn_id] && <span style={{ position:'absolute', fontSize:10 }}>🚩</span>}
                  </div>
                  <div>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <div style={{ fontSize:13, fontWeight:600, fontFamily:FONT }}>{tx.description||tx.type}</div>
                      {flagged[tx.txn_id] && <span style={{ background:`${WARNING}20`, color:WARNING, borderRadius:20, padding:'1px 6px', fontSize:10, fontWeight:700 }}>🚩 {lang==='fr'?'Signalée':'Flagged'}</span>}
                    </div>
                    <div style={{ fontSize:11, color:MUTED }}>{tx.created_at?new Date(tx.created_at).toLocaleString(lang==='fr'?'fr-FR':'en-US'):'—'}</div>
                    {tx.auth_code && <div style={{ fontSize:10, color:MUTED, fontFamily:'monospace' }}>Auth: {tx.auth_code}</div>}
                  </div>
                </div>
                <div style={{ textAlign:'right', flexShrink:0 }}>
                  <div style={{ fontSize:15, fontWeight:700, color:tx.type==='topup'?SUCCESS:tx.type==='unload'?WARNING:DANGER }}>
                    {tx.type==='topup'?'+':'-'}{fmt(tx.amount)} XAF
                  </div>
                  <div style={{ fontSize:11, color:sc(tx.status), marginBottom:6 }}>{tx.status}</div>
                  <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
                    <button onClick={()=>setFlagged(p=>({...p,[tx.txn_id]:!p[tx.txn_id]}))}
                      style={{ background:flagged[tx.txn_id]?`${WARNING}20`:BG, border:`1px solid ${flagged[tx.txn_id]?WARNING:BORDER}`, borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:11, color:flagged[tx.txn_id]?WARNING:MUTED }}>
                      🚩 {flagged[tx.txn_id]?(lang==='fr'?'Signalée':'Flagged'):(lang==='fr'?'Signaler':'Flag')}
                    </button>
                    <button onClick={()=>openIncident(tx)}
                      style={{ background:`${'#ff3b30'}10`, border:`1px solid ${'#ff3b30'}30`, borderRadius:6, padding:'3px 8px', cursor:'pointer', fontSize:11, color:'#ff3b30' }}>
                      🚨 {lang==='fr'?'Incident':'Report'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const TransactionsHub = ({ lang }) => {
  const t = s => ({ fr:{ history:'Historique', topup:'Top-up', unload:'Décharge', all:'Toutes', noTxn:'Aucune transaction' }, en:{ history:'History', topup:'Top-up', unload:'Unload', all:'All', noTxn:'No transactions' } }[lang]||{})[s]||s;
  const _loc = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') : null;
  const [tab, setTab] = useState(_loc || 'history');
  const [txns, setTxns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedCardIdx, setSelectedCardIdx] = useState(0);
  const cards = [
    { id:'card-001', number:'4532 •••• •••• 7821', color:'#1d4f92', type:'created', balance:45750 },
    { id:'card-002', number:'5412 •••• •••• 3309', color:'#9b59b6', type:'created', balance:12300 },
    { id:'card-003', number:'6011 •••• •••• 5544', color:'#00c896', type:'enrolled', balance:8900 },
  ];
  const [topupForm, setTopupForm] = useState({ amount:'', operator:'airtel', phone:'', targetCard:'', source:'momo', sourceCard:'' });
  const [unloadForm, setUnloadForm] = useState({ amount:'', operator:'airtel', phone:'', sourceCard:'' });
  const [processing, setProcessing] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/transactions', { params:{ limit:50 } })
      .then(r => setTxns(r.data.data||[]))
      .catch(()=>{})
      .finally(()=>setLoading(false));
  }, []);
  useEffect(() => { if(tab==='history') load(); }, [tab, load]);

  const doTopup = async () => {
    if (!topupForm.amount || parseFloat(topupForm.amount) < 500) return toast.error(lang==='fr'?'Minimum 500 XAF':'Minimum 500 XAF');
    if (!topupForm.phone) return toast.error(lang==='fr'?'Numéro requis':'Phone required');
    setProcessing(true);
    try {
      await api.post('/topup', topupForm);
      toast.success(lang==='fr'?'Rechargement initié ✅':'Top-up initiated ✅');
      setTopupForm({ amount:'', operator:'airtel', phone:'' });
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setProcessing(false); }
  };

  const doUnload = async () => {
    if (!unloadForm.amount || parseFloat(unloadForm.amount) < 500) return toast.error(lang==='fr'?'Minimum 500 XAF':'Minimum 500 XAF');
    if (!unloadForm.phone) return toast.error(lang==='fr'?'Numéro requis':'Phone required');
    setProcessing(true);
    try {
      await api.post('/unload', unloadForm);
      toast.success(lang==='fr'?'Transfert initié ✅':'Transfer initiated ✅');
      setUnloadForm({ amount:'', operator:'airtel', phone:'' });
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setProcessing(false); }
  };

  const tabs = [
    { v:'history', label:'📋 ' + (lang==='fr'?'Historique':'History') },
    { v:'topup',   label:'⬆️ ' + (lang==='fr'?'Chargement':'Top-up') },
    { v:'unload',  label:'⬇️ ' + (lang==='fr'?'Déchargement':'Unload') },
    { v:'payment', label:'💸 ' + (lang==='fr'?'Paiement':'Payment') },
  ];

  const inp = { width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box', marginBottom:14 };

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700, fontFamily:FONT }}>
        {lang==='fr'?'Mes Transactions':'My Transactions'}
      </h1>
      {/* Onglets */}
      <div style={{ display:'flex', gap:0, marginBottom:24, borderBottom:`2px solid ${BORDER}`, justifyContent:'center' }}>
        {tabs.map(tb => (
          <button key={tb.v} onClick={()=>setTab(tb.v)}
            style={{ padding:'12px 32px', border:'none', background:'none', fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:FONT, color:tab===tb.v?P:MUTED, borderBottom:`3px solid ${tab===tb.v?P:'transparent'}`, marginBottom:-2 }}>
            {tb.label}
          </button>
        ))}
      </div>

      {/* Historique */}
      {tab==='history' && (
        <HistoriqueTab lang={lang} txns={txns} loading={loading} cards={cards} />
      )}
      {/* Chargement */}
      {tab==='topup' && (
        <div style={{ maxWidth:520, margin:'0 auto' }}>
          <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, padding:24 }}>
            <div style={{ fontSize:15, fontWeight:700, marginBottom:16, fontFamily:FONT }}>⬆️ {lang==='fr'?'Charger une carte':'Top-up a card'}</div>

            {/* Carte à charger — créées uniquement */}
            <div style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>{lang==='fr'?'Carte à charger (créées uniquement)':'Card to top-up (created only)'}</label>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {cards.filter(c=>c.type==='created').map((c,i) => (
                  <div key={c.id} onClick={()=>setTopupForm(p=>({...p,targetCard:c.id}))}
                    style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:10, border:`2px solid ${topupForm.targetCard===c.id?c.color:BORDER}`, background:topupForm.targetCard===c.id?`${c.color}10`:BG, cursor:'pointer' }}>
                    <div style={{ width:12, height:12, borderRadius:'50%', background:c.color }} />
                    <span style={{ fontFamily:'monospace', fontSize:13 }}>{c.number}</span>
                    <span style={{ fontSize:11, color:MUTED, marginLeft:'auto' }}>Solde: {c.balance?.toLocaleString('fr-FR')} XAF</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Source de chargement */}
            <div style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>{lang==='fr'?'Source du chargement':'Funding source'}</label>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                {[['momo', '📱', lang==='fr'?'Mobile Money':'Mobile Money'], ['card', '💳', lang==='fr'?'Depuis une autre carte':'From another card']].map(([v,icon,label]) => (
                  <div key={v} onClick={()=>setTopupForm(p=>({...p,source:v}))}
                    style={{ padding:'12px', borderRadius:10, border:`2px solid ${topupForm.source===v?P:BORDER}`, background:topupForm.source===v?`${P}10`:BG, cursor:'pointer', textAlign:'center' }}>
                    <div style={{ fontSize:22, marginBottom:4 }}>{icon}</div>
                    <div style={{ fontSize:12, fontWeight:600, color:topupForm.source===v?P:MUTED, fontFamily:FONT }}>{label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Champs selon source */}
            {topupForm.source==='momo' && (<>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Opérateur':'Operator'}</label>
              <select value={topupForm.operator} onChange={e=>setTopupForm(p=>({...p,operator:e.target.value}))} style={{...inp, marginBottom:14}}>
                <option value="airtel">Airtel Money</option>
                <option value="mtn">MTN MoMo</option>
              </select>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Numéro Mobile Money':'Mobile Money number'}</label>
              <input value={topupForm.phone} onChange={e=>setTopupForm(p=>({...p,phone:e.target.value}))} placeholder="+242XXXXXXXXX" style={inp} />
            </>)}
            {topupForm.source==='card' && (<>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>{lang==='fr'?'Carte source (créée uniquement)':'Source card (created only)'}</label>
              <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:14 }}>
                {cards.filter(c=>c.type==='created' && c.id!==topupForm.targetCard).map(c => (
                  <div key={c.id} onClick={()=>setTopupForm(p=>({...p,sourceCard:c.id}))}
                    style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:10, border:`2px solid ${topupForm.sourceCard===c.id?c.color:BORDER}`, background:topupForm.sourceCard===c.id?`${c.color}10`:BG, cursor:'pointer' }}>
                    <div style={{ width:12, height:12, borderRadius:'50%', background:c.color }} />
                    <span style={{ fontFamily:'monospace', fontSize:13 }}>{c.number}</span>
                    <span style={{ fontSize:11, color:MUTED, marginLeft:'auto' }}>Solde: {c.balance?.toLocaleString('fr-FR')} XAF</span>
                  </div>
                ))}
              </div>
            </>)}

            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Montant (XAF)':'Amount (XAF)'}</label>
            <input type="number" value={topupForm.amount} onChange={e=>setTopupForm(p=>({...p,amount:e.target.value}))} placeholder="5000" min="500" style={inp} />
            {topupForm.amount && parseFloat(topupForm.amount)>=500 && (
              <div style={{ background:`${SUCCESS}10`, border:`1px solid ${SUCCESS}30`, borderRadius:8, padding:12, marginBottom:14, fontSize:12 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                  <span style={{ color:MUTED }}>{lang==='fr'?'Frais (1.5%)':'Fee (1.5%)'}</span>
                  <span style={{ color:DANGER }}>-{Math.round(parseFloat(topupForm.amount)*0.015).toLocaleString('fr-FR')} XAF</span>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between' }}>
                  <span style={{ color:MUTED }}>{lang==='fr'?'Net crédité':'Net credited'}</span>
                  <span style={{ color:SUCCESS, fontWeight:700 }}>{Math.round(parseFloat(topupForm.amount)*0.985).toLocaleString('fr-FR')} XAF</span>
                </div>
              </div>
            )}
            <button onClick={doTopup} disabled={processing||!topupForm.targetCard}
              style={{ width:'100%', background:SUCCESS, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:15, fontWeight:700, cursor:processing||!topupForm.targetCard?'not-allowed':'pointer', fontFamily:FONT, opacity:processing||!topupForm.targetCard?0.7:1 }}>
              {processing?(lang==='fr'?'Traitement…':'Processing…'):(lang==='fr'?'⬆️ Charger la carte':'⬆️ Top-up card')}
            </button>
          </div>
        </div>
      )}

      {/* Déchargement */}
      {tab==='unload' && (
        <div style={{ maxWidth:520, margin:'0 auto' }}>
          <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, padding:24 }}>
            <div style={{ fontSize:15, fontWeight:700, marginBottom:16, fontFamily:FONT }}>⬇️ {lang==='fr'?'Décharger une carte':'Unload a card'}</div>

            {/* Carte à décharger — créées uniquement */}
            <div style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6 }}>{lang==='fr'?'Carte à décharger (créées uniquement)':'Card to unload (created only)'}</label>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {cards.filter(c=>c.type==='created').map(c => (
                  <div key={c.id} onClick={()=>setUnloadForm(p=>({...p,sourceCard:c.id}))}
                    style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', borderRadius:10, border:`2px solid ${unloadForm.sourceCard===c.id?c.color:BORDER}`, background:unloadForm.sourceCard===c.id?`${c.color}10`:BG, cursor:'pointer' }}>
                    <div style={{ width:12, height:12, borderRadius:'50%', background:c.color }} />
                    <span style={{ fontFamily:'monospace', fontSize:13 }}>{c.number}</span>
                    <span style={{ fontSize:11, color:MUTED, marginLeft:'auto' }}>Solde: {c.balance?.toLocaleString('fr-FR')} XAF</span>
                  </div>
                ))}
              </div>
            </div>

            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Opérateur':'Operator'}</label>
            <select value={unloadForm.operator} onChange={e=>setUnloadForm(p=>({...p,operator:e.target.value}))} style={{...inp, marginBottom:14}}>
              <option value="airtel">Airtel Money</option>
              <option value="mtn">MTN MoMo</option>
            </select>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Numéro Mobile Money':'Mobile Money number'}</label>
            <input value={unloadForm.phone} onChange={e=>setUnloadForm(p=>({...p,phone:e.target.value}))} placeholder="+242XXXXXXXXX" style={inp} />
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Montant à décharger':'Amount to unload'}</label>
            <input type="number" value={unloadForm.amount} onChange={e=>setUnloadForm(p=>({...p,amount:e.target.value}))} placeholder="5000" min="500" style={inp} />
            {unloadForm.amount && parseFloat(unloadForm.amount)>=500 && (
              <div style={{ background:`${WARNING}10`, border:`1px solid ${WARNING}30`, borderRadius:8, padding:12, marginBottom:14, fontSize:12 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                  <span style={{ color:MUTED }}>{lang==='fr'?'Frais (1.5%)':'Fee (1.5%)'}</span>
                  <span style={{ color:DANGER }}>-{Math.round(parseFloat(unloadForm.amount)*0.015).toLocaleString('fr-FR')} XAF</span>
                </div>
                <div style={{ display:'flex', justifyContent:'space-between' }}>
                  <span style={{ color:MUTED }}>{lang==='fr'?'Vous recevez':'You receive'}</span>
                  <span style={{ color:WARNING, fontWeight:700 }}>{Math.round(parseFloat(unloadForm.amount)*0.985).toLocaleString('fr-FR')} XAF</span>
                </div>
              </div>
            )}
            <button onClick={doUnload} disabled={processing||!unloadForm.sourceCard}
              style={{ width:'100%', background:WARNING, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:15, fontWeight:700, cursor:processing||!unloadForm.sourceCard?'not-allowed':'pointer', fontFamily:FONT, opacity:processing||!unloadForm.sourceCard?0.7:1 }}>
              {processing?(lang==='fr'?'Traitement…':'Processing…'):(lang==='fr'?'⬇️ Décharger':'⬇️ Unload')}
            </button>
          </div>
        </div>
      )}

      {/* Paiement */}
      {tab==='payment' && (
        <div style={{ maxWidth:480, margin:'0 auto' }}>
          <PaymentForm lang={lang} />
        </div>
      )}
    </div>
  );
};

// ─── INCIDENTS ────────────────────────────────────────────────────
// ─── PAYMENT FORM (réutilisable) ──────────────────────────────────
const PaymentForm = ({ lang }) => {
  const [step, setStep]           = useState('scan'); // scan | confirm | processing | success
  const [scanning, setScanning]   = useState(false);
  const [scanError, setScanError] = useState('');
  const [merchantInfo, setMerchantInfo] = useState(null);
  const [form, setForm]           = useState({ amount:'', pin:'', description:'' });
  const [processing, setProcessing] = useState(false);
  const [result, setResult]       = useState(null);
  const videoRef                  = useRef(null);
  const streamRef                 = useRef(null);

  const startScan = async () => {
    setScanError('');
    setScanning(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        detectQR();
      }
    } catch(err){
      setScanError(lang==='fr'?'Accès caméra refusé — vérifiez les permissions':'Camera access denied');
      setScanning(false);
    }
  };

  const stopScan = () => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t=>t.stop()); streamRef.current = null; }
    setScanning(false);
  };

  const detectQR = () => {
    if (!videoRef.current) return;
    const canvas   = document.createElement('canvas');
    const ctx      = canvas.getContext('2d');
    const interval = setInterval(() => {
      if (!videoRef.current || !streamRef.current) { clearInterval(interval); return; }
      canvas.width  = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      if (canvas.width === 0) return;
      ctx.drawImage(videoRef.current, 0, 0);
      try {
        // Utiliser BarcodeDetector si disponible
        if ('BarcodeDetector' in window) {
          const detector = new window.BarcodeDetector({ formats:['qr_code'] });
          detector.detect(canvas).then(codes => {
            if (codes.length > 0) {
              clearInterval(interval);
              stopScan();
              processQRResult(codes[0].rawValue);
            }
          }).catch(()=>{});
        }
      } catch(e){}
    }, 300);
    setTimeout(()=>{ clearInterval(interval); if (scanning) stopScan(); }, 30000);
  };

  const processQRResult = async (qrData) => {
    try {
      // Format QR C-Pay: https://pay.c-pay.global/SHORTID ou JSON
      let merchantId = qrData;
      let amount     = '';
      let description = '';

      if (qrData.includes('pay.c-pay.global/')) {
        const shortId = qrData.split('/').pop();
        // Charger les infos du pay link
        const r = await api.get(`/pay-links/${shortId}`).catch(()=>null);
        if (r?.data) {
          merchantId  = r.data.merchant_id;
          amount      = String(r.data.amount || '');
          description = r.data.description || '';
          setMerchantInfo({ name: r.data.merchant_name||'Marchand', shortId, amount, description, type:'pay_link' });
          setForm(p=>({...p, amount, description }));
          setStep('confirm');
          return;
        }
      }

      // QR simple = merchantId
      const r = await api.get(`/merchant-info/${merchantId}`).catch(()=>null);
      setMerchantInfo({
        name: r?.data?.business_name || merchantId,
        merchantId,
        type: 'merchant',
        description
      });
      setStep('confirm');
    } catch(err){
      toast.error(lang==='fr'?'QR Code invalide':'Invalid QR code');
      setStep('scan');
    }
  };

  // Saisie manuelle du code marchand
  const enterManually = () => {
    const code = prompt(lang==='fr'?'Entrez le code marchand ou l&apos;URL du lien de paiement :':'Enter merchant code or pay link URL:');
    if (code) processQRResult(code.trim());
  };

  const pay = async (mode) => {
    if (!form.pin || form.pin.length !== 4) return toast.error(lang==='fr'?'PIN 4 chiffres requis':'4-digit PIN required');
    if (!form.amount || parseFloat(form.amount) < 100) return toast.error(lang==='fr'?'Montant min 100 XAF':'Min 100 XAF');
    setProcessing(true); setStep('processing');
    try {
      const payload = {
        merchantId:  merchantInfo?.merchantId || merchantInfo?.shortId,
        shortId:     merchantInfo?.shortId,
        amount:      parseFloat(form.amount),
        pin:         form.pin,
        description: form.description,
        paymentMode: mode,
        type:        merchantInfo?.type,
      };
      const { data } = await api.post('/payment', payload);
      setResult({ ...data, mode, amount: form.amount });
      setStep('success');
    } catch(err){
      toast.error(err.response?.data?.error||(lang==='fr'?'Paiement refusé':'Payment declined'));
      setStep('confirm');
    } finally { setProcessing(false); }
  };

  const reset = () => { setStep('scan'); setMerchantInfo(null); setForm({ amount:'', pin:'', description:'' }); setResult(null); setScanError(''); };

  const boxStyle = { width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box', marginBottom:12 };

  // ── Étape: Succès ──────────────────────────────────────────────
  if (step==='success') return (
    <div style={{ background:CARD, border:`2px solid ${SUCCESS}`, borderRadius:16, padding:32, textAlign:'center' }}>
      <div style={{ fontSize:56, marginBottom:12 }}>✅</div>
      <div style={{ fontSize:20, fontWeight:800, color:SUCCESS, marginBottom:8, fontFamily:FONT }}>
        {lang==='fr'?'Paiement effectué !':'Payment successful!'}
      </div>
      <div style={{ fontSize:28, fontWeight:800, marginBottom:4 }}>{parseFloat(result?.amount||form.amount).toLocaleString('fr-FR')} XAF</div>
      <div style={{ fontSize:13, color:MUTED, marginBottom:8 }}>{merchantInfo?.name}</div>
      {result?.authCode && <div style={{ fontSize:11, color:MUTED, fontFamily:'monospace', marginBottom:20 }}>Auth: {result.authCode}</div>}
      <button onClick={reset} style={{ background:P, color:'#fff', border:'none', borderRadius:8, padding:'12px 28px', cursor:'pointer', fontWeight:700, fontSize:14, fontFamily:FONT }}>
        {lang==='fr'?'Nouveau paiement':'New payment'}
      </button>
    </div>
  );

  // ── Étape: Processing ─────────────────────────────────────────
  if (step==='processing') return (
    <div style={{ background:CARD, borderRadius:16, padding:40, textAlign:'center' }}>
      <div style={{ width:48, height:48, border:`4px solid ${BORDER}`, borderTopColor:P, borderRadius:'50%', animation:'spin 1s linear infinite', margin:'0 auto 20px' }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ fontSize:16, fontWeight:700, color:P }}>{lang==='fr'?'Traitement en cours…':'Processing…'}</div>
      <div style={{ fontSize:13, color:MUTED, marginTop:8 }}>{lang==='fr'?'Veuillez patienter':'Please wait'}</div>
    </div>
  );

  // ── Étape: Confirmation ───────────────────────────────────────
  if (step==='confirm') return (
    <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:16, padding:24 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
        <button onClick={reset} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:MUTED }}>←</button>
        <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>💸 {lang==='fr'?'Confirmer le paiement':'Confirm payment'}</div>
      </div>

      {/* Info marchand */}
      <div style={{ background:`${P}08`, border:`1px solid ${P}20`, borderRadius:10, padding:16, marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ width:44, height:44, background:`${P}20`, borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22 }}>🏪</div>
          <div>
            <div style={{ fontSize:16, fontWeight:700 }}>{merchantInfo?.name}</div>
            <div style={{ fontSize:12, color:MUTED }}>{merchantInfo?.type==='pay_link'?'Pay Link':'Code marchand'}</div>
            {merchantInfo?.description && <div style={{ fontSize:12, color:MUTED }}>{merchantInfo.description}</div>}
          </div>
        </div>
      </div>

      {/* Montant */}
      <div style={{ marginBottom:12 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontWeight:600 }}>
          {lang==='fr'?'Montant (XAF) *':'Amount (XAF) *'}
        </label>
        <input type="number" value={form.amount} onChange={e=>setForm(p=>({...p,amount:e.target.value}))}
          placeholder="5000" min="100" readOnly={!!merchantInfo?.amount}
          style={{ ...boxStyle, fontSize:20, fontWeight:700, color:P, textAlign:'center',
            background: merchantInfo?.amount ? `${P}08` : BG }} />
      </div>

      {/* Description */}
      <div style={{ marginBottom:12 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Description':'Description'}</label>
        <input value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))}
          placeholder={lang==='fr'?'Achat #001':'Purchase #001'} style={boxStyle} />
      </div>

      {/* PIN */}
      <div style={{ marginBottom:16 }}>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:6, fontWeight:600 }}>PIN *</label>
        <div style={{ display:'flex', justifyContent:'center' }}>
          <PinInput value={form.pin} onChange={v=>setForm(p=>({...p,pin:v}))} />
        </div>
      </div>

      {/* Modes paiement */}
      <div style={{ fontSize:13, fontWeight:700, marginBottom:10, color:MUTED }}>
        {lang==='fr'?'Choisir le mode de paiement :':'Choose payment method:'}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
        {[['momo_airtel','🔴','Airtel Money'],['momo_mtn','🟡','MTN MoMo']].map(([m,icon,label])=>(
          <button key={m} onClick={()=>pay(m)}
            style={{ background:BG, border:`1px solid ${BORDER}`, borderRadius:10, padding:'14px 10px', cursor:'pointer', textAlign:'center', transition:'all .2s' }}>
            <div style={{ fontSize:28, marginBottom:4 }}>{icon}</div>
            <div style={{ fontSize:12, fontWeight:700, fontFamily:FONT }}>{label}</div>
          </button>
        ))}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
        {[['card_link','🔗',lang==='fr'?'Lien PSP':'PSP Link'],['card_qr','💳',lang==='fr'?'Carte directe':'Direct Card']].map(([m,icon,label])=>(
          <button key={m} onClick={()=>pay(m)}
            style={{ background:BG, border:`1px solid ${BORDER}`, borderRadius:10, padding:'14px 10px', cursor:'pointer', textAlign:'center' }}>
            <div style={{ fontSize:28, marginBottom:4 }}>{icon}</div>
            <div style={{ fontSize:12, fontWeight:700, fontFamily:FONT }}>{label}</div>
          </button>
        ))}
      </div>
    </div>
  );

  // ── Étape: Scan QR ────────────────────────────────────────────
  return (
    <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:16, padding:24 }}>
      <div style={{ fontSize:16, fontWeight:700, marginBottom:4, fontFamily:FONT }}>📷 {lang==='fr'?'Scanner le QR Code marchand':'Scan merchant QR Code'}</div>
      <div style={{ fontSize:13, color:MUTED, marginBottom:20 }}>
        {lang==='fr'?'Scannez le QR code affiché chez le marchand pour initier le paiement.':'Scan the QR code displayed at the merchant to initiate payment.'}
      </div>

      {/* Zone vidéo */}
      {scanning ? (
        <div style={{ position:'relative', marginBottom:16 }}>
          <video ref={videoRef} style={{ width:'100%', borderRadius:12, background:'#000', maxHeight:300, objectFit:'cover' }} muted playsInline />
          {/* Overlay viseur */}
          <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', pointerEvents:'none' }}>
            <div style={{ width:200, height:200, border:'3px solid #fff', borderRadius:12, boxShadow:'0 0 0 2000px rgba(0,0,0,0.4)',
              backgroundImage:'linear-gradient(#fff,#fff),linear-gradient(#fff,#fff),linear-gradient(#fff,#fff),linear-gradient(#fff,#fff)',
              backgroundSize:'20px 3px,3px 20px,20px 3px,3px 20px',
              backgroundPosition:'top left,top left,bottom right,bottom right',
              backgroundRepeat:'no-repeat' }} />
          </div>
          <button onClick={stopScan}
            style={{ width:'100%', marginTop:10, background:`${DANGER}`, color:'#fff', border:'none', borderRadius:8, padding:'10px', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT }}>
            ✕ {lang==='fr'?'Arrêter le scan':'Stop scanning'}
          </button>
          <div style={{ textAlign:'center', marginTop:8, fontSize:12, color:MUTED }}>
            {lang==='fr'?'Pointez vers le QR code du marchand…':'Point at the merchant QR code…'}
          </div>
        </div>
      ) : (
        <div style={{ textAlign:'center', padding:'32px 20px', background:BG, borderRadius:12, marginBottom:16 }}>
          <div style={{ fontSize:72, marginBottom:12 }}>📷</div>
          <div style={{ fontSize:14, color:MUTED, marginBottom:20 }}>
            {lang==='fr'?'Appuyez sur le bouton pour activer la caméra':'Press the button to activate the camera'}
          </div>
          <button onClick={startScan}
            style={{ width:'100%', background:P, color:'#fff', border:'none', borderRadius:10, padding:'14px', fontSize:15, fontWeight:700, cursor:'pointer', fontFamily:FONT, marginBottom:10 }}>
            📷 {lang==='fr'?'Scanner le QR Code':'Scan QR Code'}
          </button>
          <button onClick={enterManually}
            style={{ width:'100%', background:'none', border:`1px solid ${BORDER}`, borderRadius:10, padding:'12px', fontSize:13, cursor:'pointer', fontFamily:FONT, color:MUTED }}>
            ✏️ {lang==='fr'?'Saisir le code manuellement':'Enter code manually'}
          </button>
        </div>
      )}

      {scanError && (
        <div style={{ background:`${DANGER}10`, border:`1px solid ${DANGER}30`, borderRadius:8, padding:12, fontSize:13, color:DANGER, textAlign:'center' }}>
          ⚠️ {scanError}
          <div style={{ marginTop:8 }}>
            <button onClick={enterManually} style={{ background:P, color:'#fff', border:'none', borderRadius:6, padding:'6px 14px', cursor:'pointer', fontSize:12, fontFamily:FONT }}>
              ✏️ {lang==='fr'?'Saisir manuellement':'Enter manually'}
            </button>
          </div>
        </div>
      )}

      {/* Info BarcodeDetector */}
      {!('BarcodeDetector' in window) && (
        <div style={{ background:`${WARNING}10`, border:`1px solid ${WARNING}30`, borderRadius:8, padding:10, fontSize:11, color:MUTED, marginTop:10, textAlign:'center' }}>
          ⚠️ {lang==='fr'?'Scan QR non supporté sur ce navigateur — utilisez la saisie manuelle ou Chrome/Edge':'QR scan not supported — use manual entry or Chrome/Edge'}
        </div>
      )}
    </div>
  );
};

const Incidents = ({ lang }) => {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [replying, setReplying] = useState(false);
  const [form, setForm] = useState({ subject:'', description:'', priority:'normal', category:'general', cardReference:'' });
  const cards = [
    { id:'card-001', number:'4532 •••• •••• 7821', color:'#1d4f92' },
    { id:'card-002', number:'5412 •••• •••• 3309', color:'#9b59b6' },
    { id:'card-003', number:'6011 •••• •••• 5544', color:'#00c896' },
  ];
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get('/support/tickets').then(r => setTickets(r.data.data||r.data.tickets||[])).catch(()=>{}).finally(()=>setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const openTicket = async (ticket) => {
    setSelected(ticket); setMessages([]);
    try {
      const r = await api.get('/support/tickets/'+ticket.ticket_id);
      setMessages(r.data.messages||[]);
    } catch { setMessages([]); }
  };

  const submit = async () => {
    if (!form.subject || !form.description) return toast.error(lang==='fr'?'Champs requis':'Required fields');
    setSaving(true);
    try {
      await api.post('/support/tickets', { subject:form.subject, message:form.description, priority:form.priority, category:form.category, cardReference:form.cardReference||undefined });
      toast.success(lang==='fr'?'Incident signalé ✅':'Incident reported ✅');
      setShowNew(false); setForm({ subject:'', description:'', priority:'normal', category:'general' }); load();
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
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
      setMessages(r.data.messages||[]);
      toast.success(lang==='fr'?'Envoyé ✅':'Sent ✅');
    } catch { toast.error('Erreur'); }
    finally { setReplying(false); }
  };

  const SC = { open:'#ff3b30', pending_admin:'#ff9500', pending_merchant:'#12b6c7', resolved:'#00c896', closed:'#5a6677' };
  const SL = { open:lang==='fr'?'Ouvert':'Open', pending_admin:lang==='fr'?'En cours':'In progress', pending_merchant:lang==='fr'?'Votre réponse':'Your reply', resolved:lang==='fr'?'Résolu':'Resolved', closed:lang==='fr'?'Fermé':'Closed' };

  const inp = { width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box', marginBottom:14 };

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700, fontFamily:FONT }}>🚨 {lang==='fr'?'Mes Incidents':'My Incidents'}</h1>
        <button onClick={()=>setShowNew(true)}
          style={{ background:P, color:'#fff', border:'none', borderRadius:8, padding:'10px 18px', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT }}>
          + {lang==='fr'?'Signaler':'Report'}
        </button>
      </div>

      {/* Modal nouveau ticket */}
      {showNew && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:28, width:500, maxWidth:'100%' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>{lang==='fr'?'Signaler un incident':'Report an incident'}</div>
              <button onClick={()=>setShowNew(false)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:MUTED }}>×</button>
            </div>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Catégorie':'Category'}</label>
            <select value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))} style={inp}>
              <option value="general">{lang==='fr'?'Général':'General'}</option>
              <option value="transaction">{lang==='fr'?'Transaction':'Transaction'}</option>
              <option value="card">{lang==='fr'?'Carte':'Card'}</option>
              <option value="topup">{lang==='fr'?'Rechargement':'Top-up'}</option>
              <option value="other">{lang==='fr'?'Autre':'Other'}</option>
            </select>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Carte concernée (optionnel)':'Affected card (optional)'}</label>
            <select value={form.cardReference} onChange={e=>setForm(p=>({...p,cardReference:e.target.value}))} style={inp}>
              <option value="">{lang==='fr'?'-- Aucune carte spécifique --':'-- No specific card --'}</option>
              {cards.map(c=><option key={c.id} value={c.number}>{c.number}</option>)}
            </select>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Sujet *':'Subject *'}</label>
            <input value={form.subject} onChange={e=>setForm(p=>({...p,subject:e.target.value}))} placeholder={lang==='fr'?'Ex: Transaction échouée':'Ex: Failed transaction'} style={inp} />
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Priorité':'Priority'}</label>
            <select value={form.priority} onChange={e=>setForm(p=>({...p,priority:e.target.value}))} style={inp}>
              <option value="low">{lang==='fr'?'Faible':'Low'}</option>
              <option value="normal">{lang==='fr'?'Normale':'Normal'}</option>
              <option value="high">{lang==='fr'?'Urgente':'Urgent'}</option>
            </select>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Description *':'Description *'}</label>
            <textarea value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} rows={4}
              style={{...inp, resize:'vertical'}} placeholder={lang==='fr'?'Décrivez le problème…':'Describe the issue…'} />
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={submit} disabled={saving}
                style={{ flex:1, background:'#ff3b30', color:'#fff', border:'none', borderRadius:8, padding:'11px', cursor:'pointer', fontWeight:700, fontSize:13, fontFamily:FONT }}>
                {saving?(lang==='fr'?'Envoi…':'Sending…'):(lang==='fr'?'Signaler':'Report')}
              </button>
              <button onClick={()=>setShowNew(false)}
                style={{ flex:1, background:'none', border:`1px solid ${BORDER}`, borderRadius:8, padding:'11px', cursor:'pointer', fontSize:13, fontFamily:FONT }}>
                {lang==='fr'?'Annuler':'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal détail ticket */}
      {selected && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:0, width:620, maxWidth:'100%', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
            <div style={{ padding:'16px 20px', borderBottom:`1px solid ${BORDER}` }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div>
                  <div style={{ fontFamily:'monospace', fontSize:11, color:MUTED }}>{selected.ticket_number}</div>
                  <div style={{ fontSize:15, fontWeight:700, fontFamily:FONT }}>{selected.subject}</div>
                  <span style={{ background:`${SC[selected.status]||MUTED}20`, color:SC[selected.status]||MUTED, borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:700 }}>
                    {SL[selected.status]||selected.status}
                  </span>
                  {selected.status==='pending_merchant' && (
                    <span style={{ marginLeft:8, background:`${P}20`, color:P, borderRadius:6, padding:'3px 8px', fontSize:11, fontWeight:700 }}>
                      ⚠️ {lang==='fr'?'Votre réponse attendue':'Your response needed'}
                    </span>
                  )}
                </div>
                <button onClick={()=>setSelected(null)} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:MUTED }}>×</button>
              </div>
            </div>

            {/* Messages */}
            <div style={{ flex:1, overflowY:'auto', padding:'16px 20px' }}>
              {messages.length===0 ? (
                <div style={{ textAlign:'center', padding:24, color:MUTED, fontSize:13 }}>{lang==='fr'?'En attente de traitement':'Pending review'}</div>
              ) : messages.map((msg,idx) => (
                <div key={msg.message_id||idx} style={{ display:'flex', flexDirection:'column', alignItems:msg.sender_type==='merchant'?'flex-end':'flex-start', marginBottom:12 }}>
                  <div style={{ fontSize:10, color:MUTED, marginBottom:3 }}>
                    {msg.sender_type==='merchant'?(lang==='fr'?'Vous':'You'):'Support'} · {msg.sender_name} · {new Date(msg.created_at).toLocaleString(lang==='fr'?'fr-FR':'en-US')}
                  </div>
                  <div style={{ background:msg.sender_type==='merchant'?`${P}15`:'#fff', border:`1px solid ${msg.sender_type==='merchant'?P:BORDER}`, borderRadius:10, padding:'8px 12px', maxWidth:'78%', fontSize:13, fontFamily:FONT }}>
                    {msg.message}
                  </div>
                </div>
              ))}
            </div>

            {/* Répondre + Pièces jointes */}
            {!['resolved','closed'].includes(selected.status) && (
              <div style={{ padding:'14px 20px', borderTop:`1px solid ${BORDER}` }}>
                {attachments.length>0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:8 }}>
                    {attachments.map((a,i)=>(
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:4, background:BG, border:`1px solid ${BORDER}`, borderRadius:6, padding:'2px 8px', fontSize:11 }}>
                        {a.type?.startsWith('image')?'🖼️':'📎'} {a.name}
                        <button onClick={()=>setAttachments(p=>p.filter((_,j)=>j!==i))} style={{ background:'none', border:'none', cursor:'pointer', color:'#ff3b30', fontSize:14 }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display:'flex', gap:8 }}>
                  <textarea value={reply} onChange={e=>setReply(e.target.value)} rows={2}
                    placeholder={lang==='fr'?'Votre réponse…':'Your reply…'}
                    style={{ flex:1, background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 12px', fontSize:13, resize:'none', fontFamily:FONT, color:TEXT }} />
                  <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                    <label style={{ cursor:'pointer', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'8px 10px', fontSize:14, textAlign:'center' }}>
                      📎<input type="file" multiple accept="image/*,.pdf" onChange={handleAttach} style={{ display:'none' }} />
                    </label>
                    <button onClick={sendReply} disabled={replying||(!reply.trim()&&attachments.length===0)}
                      style={{ background:P, color:'#fff', border:'none', borderRadius:8, padding:'8px 12px', cursor:'pointer', fontWeight:700, fontSize:12, fontFamily:FONT }}>
                      {replying?'…':'📤'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Liste tickets */}
      {loading ? <div style={{ textAlign:'center', padding:32, color:MUTED }}>Chargement…</div>
      : tickets.length===0 ? (
        <div style={{ textAlign:'center', padding:40 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>✅</div>
          <div style={{ color:MUTED, fontFamily:FONT }}>{lang==='fr'?'Aucun incident signalé':'No incidents reported'}</div>
        </div>
      ) : (
        <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12 }}>
          {tickets.map(tk => (
            <div key={tk.ticket_id} onClick={()=>openTicket(tk)}
              style={{ padding:'14px 18px', borderBottom:`1px solid ${BORDER}`, cursor:'pointer', borderLeft:`4px solid ${SC[tk.status]||MUTED}` }}
              onMouseEnter={e=>e.currentTarget.style.background=BG}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                    <span style={{ fontFamily:'monospace', fontSize:11, color:MUTED }}>{tk.ticket_number}</span>
                    <span style={{ background:`${SC[tk.status]||MUTED}20`, color:SC[tk.status]||MUTED, borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700 }}>
                      {SL[tk.status]||tk.status}
                    </span>
                    {tk.status==='pending_merchant' && <span style={{ background:`${P}20`, color:P, borderRadius:6, padding:'2px 8px', fontSize:11, fontWeight:700 }}>⚠️ Action requise</span>}
                  </div>
                  <div style={{ fontSize:14, fontWeight:600, fontFamily:FONT }}>{tk.subject}</div>
                  <div style={{ fontSize:11, color:MUTED }}>{new Date(tk.created_at).toLocaleString(lang==='fr'?'fr-FR':'en-US')}</div>
                </div>
                <div style={{ color:P, fontSize:12, fontWeight:600 }}>Voir →</div>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
};
// ─── KYC ──────────────────────────────────────────────────────────
const KYC = ({ lang }) => {
  const [profile, setProfile] = useState(null);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ docType:'id_card', fileUrl:'', fileName:'' });

  const DOC_TYPES = [
    { v:'id_card',       label:lang==='fr'?'Pièce d&apos;identité (CNI/Passeport)':'ID Card / Passport' },
    { v:'selfie',        label:lang==='fr'?'Selfie avec la pièce d&apos;identité':'Selfie with ID' },
    { v:'address_proof', label:lang==='fr'?'Justificatif de domicile':'Proof of address' },
    { v:'income_proof',  label:lang==='fr'?'Justificatif de revenus':'Proof of income' },
  ];
  const STATUS_COLORS = { pending:'#ff9500', approved:'#00c896', rejected:'#ff3b30' };
  const STATUS_LABELS = { pending:lang==='fr'?'En attente':'Pending', approved:lang==='fr'?'Approuvé':'Approved', rejected:lang==='fr'?'Rejeté':'Rejected' };

  const load = useCallback(() => {
    api.get('/kyc').then(r => { setDocs(r.data.documents||[]); setProfile(r.data); }).catch(()=>{}).finally(()=>setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5*1024*1024) return toast.error('Max 5MB');
    const reader = new FileReader();
    reader.onload = ev => setForm(p=>({...p, fileUrl:ev.target.result, fileName:file.name}));
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    if (!form.fileUrl) return toast.error(lang==='fr'?'Sélectionner un fichier':'Select a file');
    setUploading(true);
    try {
      await api.post('/kyc/documents', { docType:form.docType, docLabel:DOC_TYPES.find(d=>d.v===form.docType)?.label||form.docType, fileUrl:form.fileUrl, fileName:form.fileName, mimeType:form.fileUrl.split(';')[0].split(':')[1] });
      toast.success(lang==='fr'?'Document soumis ✅':'Document submitted ✅');
      setForm({ docType:'id_card', fileUrl:'', fileName:'' });
      load();
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setUploading(false); }
  };

  const kycLevel = profile?.kyc_level || 0;
  const approved = docs.filter(d=>d.status==='approved').length;

  return (
    <div>
      <h1 style={{ margin:'0 0 20px', fontSize:22, fontWeight:700, fontFamily:FONT }}>🔐 {lang==='fr'?'Mon KYC':'My KYC'}</h1>

      {/* Progression */}
      <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12, padding:20, marginBottom:20 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
          <div style={{ fontSize:14, fontWeight:700, fontFamily:FONT }}>{lang==='fr'?'Statut de vérification':'Verification status'}</div>
          <span style={{ background:kycLevel>=1?`${SUCCESS}20`:`${'#ff9500'}20`, color:kycLevel>=1?SUCCESS:'#ff9500', borderRadius:20, padding:'4px 12px', fontSize:12, fontWeight:700 }}>
            {kycLevel>=1?(lang==='fr'?'✅ Vérifié':'✅ Verified'):(lang==='fr'?'⏳ En attente':'⏳ Pending')}
          </span>
        </div>
        <div style={{ background:BORDER, borderRadius:6, height:8, overflow:'hidden', marginBottom:12 }}>
          <div style={{ background:SUCCESS, height:'100%', borderRadius:6, width:`${(approved/DOC_TYPES.length)*100}%`, transition:'width .5s' }} />
        </div>
        <div style={{ fontSize:12, color:MUTED }}>{approved}/{DOC_TYPES.length} {lang==='fr'?'documents approuvés':'documents approved'}</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8, marginTop:14 }}>
          {[
            [0, lang==='fr'?'Niveau 0 — 100k/j':'Level 0 — 100k/day'],
            [1, lang==='fr'?'Niveau 1 — 1M/j (KYC validé)':'Level 1 — 1M/day (KYC verified)'],
          ].map(([l, label]) => (
            <div key={l} style={{ display:'flex', alignItems:'center', gap:8, padding:10, background:kycLevel>=l?`${SUCCESS}08`:BG, border:`1px solid ${kycLevel>=l?SUCCESS:BORDER}`, borderRadius:8 }}>
              <span style={{ width:24, height:24, borderRadius:'50%', background:kycLevel>=l?SUCCESS:BORDER, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, color:'#fff', fontWeight:700, flexShrink:0 }}>{l}</span>
              <span style={{ fontSize:12, fontFamily:FONT }}>{label}</span>
              {kycLevel>=l && <span style={{ color:SUCCESS, marginLeft:'auto' }}>✓</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Soumettre document */}
      <div style={{ background:CARD, border:`1px solid ${P}20`, borderRadius:12, padding:20, marginBottom:20 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:14, fontFamily:FONT }}>📤 {lang==='fr'?'Soumettre un document':'Submit a document'}</div>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Type de document':'Document type'}</label>
        <select value={form.docType} onChange={e=>setForm(p=>({...p,docType:e.target.value}))}
          style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, marginBottom:14 }}>
          {DOC_TYPES.map(d=><option key={d.v} value={d.v}>{d.label}</option>)}
        </select>
        <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Fichier (PDF, JPG, PNG — max 5MB)':'File (PDF, JPG, PNG — max 5MB)'}</label>
        <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={handleFile}
          style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:13, fontFamily:FONT, boxSizing:'border-box', marginBottom:form.fileName?8:14 }} />
        {form.fileName && <div style={{ fontSize:11, color:SUCCESS, marginBottom:14 }}>✓ {form.fileName}</div>}
        <button onClick={submit} disabled={uploading||!form.fileUrl}
          style={{ width:'100%', background:P, color:'#fff', border:'none', borderRadius:8, padding:'12px', fontSize:14, fontWeight:700, cursor:uploading||!form.fileUrl?'not-allowed':'pointer', fontFamily:FONT, opacity:uploading||!form.fileUrl?0.6:1 }}>
          {uploading?(lang==='fr'?'Envoi…':'Uploading…'):(lang==='fr'?'📤 Soumettre':'📤 Submit')}
        </button>
      </div>

      {/* Documents soumis */}
      {loading ? <div style={{ textAlign:'center', padding:20, color:MUTED }}>Chargement…</div>
      : docs.length===0 ? (
        <div style={{ textAlign:'center', padding:32, background:CARD, border:`1px solid ${BORDER}`, borderRadius:12 }}>
          <div style={{ fontSize:40, marginBottom:8 }}>📄</div>
          <div style={{ color:MUTED, fontFamily:FONT }}>{lang==='fr'?'Aucun document soumis':'No documents submitted'}</div>
        </div>
      ) : (
        <div style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:12 }}>
          <div style={{ padding:'12px 18px', borderBottom:`1px solid ${BORDER}`, fontSize:13, fontWeight:700, fontFamily:FONT }}>
            {lang==='fr'?'Documents soumis':'Submitted documents'}
          </div>
          {docs.map(doc => (
            <div key={doc.doc_id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 18px', borderBottom:`1px solid ${BORDER}` }}>
              <div>
                <div style={{ fontSize:13, fontWeight:600, fontFamily:FONT }}>{DOC_TYPES.find(d=>d.v===doc.doc_type)?.label||doc.doc_type}</div>
                <div style={{ fontSize:11, color:MUTED }}>{doc.file_name} · {new Date(doc.uploaded_at).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}</div>
                {doc.rejection_reason && <div style={{ fontSize:11, color:'#ff3b30', marginTop:2 }}>⚠️ {doc.rejection_reason}</div>}
              </div>
              <span style={{ background:`${STATUS_COLORS[doc.status]||MUTED}20`, color:STATUS_COLORS[doc.status]||MUTED, borderRadius:20, padding:'4px 12px', fontSize:11, fontWeight:700 }}>
                {STATUS_LABELS[doc.status]||doc.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default function App() {
  const { lang, toggle } = useLang();
  return (
    <BrowserRouter>
      <Toaster position="top-right" toastOptions={{ style:{ fontFamily:FONT, fontSize:13 } }} />
      <Routes>
        <Route path="/login"          element={<Login         lang={lang} toggleLang={toggle} />} />
        <Route path="/verify-email"   element={<VerifyEmail   lang={lang} />} />
                <Route path="/register"       element={<Register      lang={lang} toggleLang={toggle} />} />
        <Route path="/reset-password" element={<ResetPassword lang={lang} />} />
        <Route path="/*" element={
          <Guard>
            <Layout lang={lang} toggleLang={toggle}>
              <Routes>
                <Route path="/"             element={<Dashboard   lang={lang} />} />
                <Route path="/payment"      element={<PaymentForm lang={lang} />} />
                <Route path="/topup"        element={<TopUp       lang={lang} />} />
                <Route path="/unload"       element={<Unload      lang={lang} />} />
                <Route path="/transactions" element={<TransactionsHub lang={lang} />} />
                <Route path="/incidents"    element={<Incidents    lang={lang} />} />
                <Route path="/gtp-card"    element={<GtpCardPage lang={lang} />} />
                <Route path="/cards"        element={<MyCards     lang={lang} />} />
                <Route path="/profile"      element={<Profile     lang={lang} />} />
              </Routes>
            </Layout>
          </Guard>
        } />
      </Routes>
    </BrowserRouter>
  );
}
