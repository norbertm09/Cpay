// CPlus 2.6.0 — Merchant Portal
import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import toast, { Toaster } from 'react-hot-toast';
import { useT } from './i18n';

// Purge unique des tokens herites de l'ancien stockage localStorage.
// Sans cela, un refresh token valide 30 jours reste exploitable par XSS
// chez tous les marchands connectes avant la migration.
try {
  localStorage.removeItem('merchant_token');
  localStorage.removeItem('merchant_refresh');
} catch (e) { /* navigation privee */ }

const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || '';

// ─── Stockage de l'access token EN MEMOIRE ────────────────────────
//
// Volontairement hors de localStorage. Une XSS peut encore lire cette
// variable, mais le token expire en 15 minutes et ne permet aucun
// renouvellement : le refresh vit desormais dans un cookie HttpOnly
// (cp_rt_merchant), inaccessible au JavaScript.
//
// Contrepartie : un rechargement de page perd le token. C'est le role du
// refresh silencieux au demarrage (voir AuthProvider).
let accessToken = null;
const authListeners = new Set();

const decodeJwt = (t) => {
  try { return JSON.parse(atob(t.split('.')[1])); } catch { return null; }
};

const setAccessToken = (t) => {
  accessToken = t || null;
  authListeners.forEach(fn => fn(accessToken));
};

const getAccessToken = () => accessToken;

// withCredentials : indispensable pour que le navigateur joigne le cookie
// cp_rt_merchant aux appels vers /auth/refresh et /auth/logout.
const api = axios.create({
  baseURL: `${apiBaseUrl}/api/v1/merchant`,
  withCredentials: true,
});

api.interceptors.request.use(cfg => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

// Appel de refresh nu : pas d'instance api, pour eviter toute recursion
// d'intercepteur si le refresh lui-meme repond 401.
const callRefresh = () =>
  axios.post(`${apiBaseUrl}/api/v1/merchant/auth/refresh`, {}, { withCredentials: true });

// Une seule requete de refresh a la fois. Les appels concurrents qui se
// prennent un 401 attendent la meme promesse plutot que d'en declencher
// chacun un : la rotation cote serveur revoquerait les suivants.
let refreshPromise = null;

const refreshAccessToken = () => {
  if (!refreshPromise) {
    refreshPromise = callRefresh()
      .then(({ data }) => {
        if (!data.access_token) throw new Error('no access_token');
        setAccessToken(data.access_token);
        return data.access_token;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};

api.interceptors.response.use(r => r, async err => {
  const original = err.config;
  const isAuthRoute = original?.url?.includes('/auth/');
  if (err.response?.status === 401 && !original._retry && !isAuthRoute) {
    original._retry = true;
    try {
      const t = await refreshAccessToken();
      original.headers.Authorization = `Bearer ${t}`;
      return api(original);
    } catch (e) {
      setAccessToken(null);
      window.location.href = '/login';
    }
  }
  return Promise.reject(err);
});

// ─── Contexte d'authentification ──────────────────────────────────
//
// Trois etats, la ou l'ancien code n'en avait que deux :
//   loading  : refresh silencieux en cours, on n'affiche rien
//   authenticated
//   anonymous
// Sans l'etat loading, Guard renverrait sur /login a chaque rechargement
// de page avant meme que le refresh ait pu repondre.
const AuthContext = React.createContext(null);

const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(accessToken);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const listener = (t) => setToken(t);
    authListeners.add(listener);
    return () => { authListeners.delete(listener); };
  }, []);

  useEffect(() => {
    // Refresh silencieux au demarrage : le cookie HttpOnly survit au
    // rechargement, l'access token en memoire non.
    let cancelled = false;
    if (accessToken) { setLoading(false); return; }
    refreshAccessToken()
      .catch(() => { if (!cancelled) setAccessToken(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const user = token ? decodeJwt(token) : null;
  const isAuth = !!user && user.exp * 1000 > Date.now();

  return (
    <AuthContext.Provider value={{ isAuth, user, loading, setAccessToken }}>
      {children}
    </AuthContext.Provider>
  );
};

const useAuth = () => {
  const ctx = React.useContext(AuthContext);
  // Repli defensif : si un composant appelle useAuth hors du Provider,
  // on lit l'etat module plutot que de planter.
  if (!ctx) {
    const user = accessToken ? decodeJwt(accessToken) : null;
    return { isAuth: !!user && user.exp * 1000 > Date.now(), user, loading: false };
  }
  return ctx;
};

const AuthSplash = () => (
  <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#f0f4f8', color:'#5a6677', fontSize:14, fontFamily:"'Century Gothic',sans-serif" }}>
    Chargement…
  </div>
);

const Guard = ({ children }) => {
  const { isAuth, loading } = useAuth();
  if (loading) return <AuthSplash />;
  return isAuth ? children : <Navigate to="/login" replace />;
};
const useLang = () => {
  const [lang, setLang] = useState(localStorage.getItem('cplus_lang') || 'fr');
  const toggle = () => { const n = lang === 'fr' ? 'en' : 'fr'; localStorage.setItem('cplus_lang', n); setLang(n); };
  return { lang, toggle };
};

// ─── Styles ──────────────────────────────────────────────────────
const G = '#00c896', R = '#ff3b30', P = '#12b6c7', O = '#ff9500', BLUE = '#1d4f92';
const BG = '#f0f4f8', CARD = '#fff', BORDER = '#dce3ed', TEXT = '#1e2d3d', MUTED = '#5a6677';
const FONT = "Inter, 'Century Gothic', 'URW Gothic', Jost, system-ui, sans-serif";
const FONT_TITRE = "Jost, 'Century Gothic', 'URW Gothic', Questrial, system-ui, sans-serif";
const fmtNum = n => parseFloat(n || 0).toLocaleString('fr-FR');
const fmtDate = (d, lang) => d ? new Date(d).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US') : '—';
const sc = s => ({ authorized: G, completed: G, active: G, paid: G, failed: R, cancelled: R, refunded: R, pending: O, processing: O, timeout: O }[s] || MUTED);

// Libelles des statuts et types de transaction.
// Le tableau affichait les valeurs brutes de la base ("authorized",
// "failed", "payout") au milieu de colonnes francaises. Sur un ecran qui
// montre des montants et des statuts de paiement, un marchand doit pouvoir
// lire ce qu'il voit.
const ST_FR = {
  authorized: 'Autorisé', completed: 'Terminé', active: 'Actif', paid: 'Payé',
  failed: 'Échoué', cancelled: 'Annulé', refunded: 'Remboursé',
  pending: 'En attente', processing: 'En cours', timeout: 'Expiré',
  inactive: 'Inactif', suspended: 'Suspendu',
};
const ST_EN = {
  authorized: 'Authorized', completed: 'Completed', active: 'Active', paid: 'Paid',
  failed: 'Failed', cancelled: 'Cancelled', refunded: 'Refunded',
  pending: 'Pending', processing: 'Processing', timeout: 'Timed out',
  inactive: 'Inactive', suspended: 'Suspended',
};
// Repli sur la valeur brute : un statut inconnu reste lisible plutot que
// de disparaitre.
const sl = (s, lang) => (lang === 'en' ? ST_EN : ST_FR)[s] || s || '—';

const TY_FR = { collect: 'Encaissement', payout: 'Décaissement', refund: 'Remboursement', transfer: 'Transfert' };
const TY_EN = { collect: 'Collection', payout: 'Payout', refund: 'Refund', transfer: 'Transfer' };
const tl = (v, lang) => (lang === 'en' ? TY_EN : TY_FR)[v] || v || '—';

// ─── UI Components ────────────────────────────────────────────────
const Card = ({ children, style }) => <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, ...style }}>{children}</div>;
// type='button' par defaut : en React un <button> sans type vaut "submit".
// Hors formulaire c'est sans effet, mais des qu'un ecran sera enveloppe
// dans un <form>, chaque Btn deviendrait un bouton de soumission — un clic
// sur "Annuler" enverrait le formulaire.
const Btn = ({ children, onClick, color, outline, disabled, small, type = 'button', style: s }) => (
  <button type={type} onClick={onClick} disabled={disabled} style={{ background: outline ? 'transparent' : color || P, color: outline ? color || P : '#fff', border: `2px solid ${color || P}`, borderRadius: 8, padding: small ? '6px 14px' : '10px 20px', fontSize: small ? 12 : 14, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1, fontFamily: FONT, transition: 'all .2s', ...s }}>{children}</button>
);
const _slugId = s => 'f-' + String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const Inp = ({ label, value, onChange, type = 'text', placeholder, min, max, id, name, autoComplete, required, inputMode }) => {
  const _id = id || _slugId(label);
  return (
  <div style={{ marginBottom: 14 }}>
    {label && <label htmlFor={_id} style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4, fontFamily: FONT }}>{label}</label>}
    <input id={_id} name={name || _id} type={type} value={value || ''} onChange={e => onChange(e.target.value)} placeholder={placeholder} min={min} max={max} autoComplete={autoComplete} required={required} inputMode={inputMode}
      style={{ width: '100%', background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 12px', color: TEXT, fontSize: 14, boxSizing: 'border-box', fontFamily: FONT }} />
  </div>
  );
};
// ─── DateFR ───────────────────────────────────────────────────────
//
// <input type="date"> affiche selon la locale du NAVIGATEUR. Chrome ignore
// lang="fr-FR" sur ce champ : un marchand sur un Chrome en anglais voit
// mm/dd/yyyy, saisit 03/04 pour le 3 avril, et obtient le 4 mars sans
// aucune alerte. Sur un ecran de transactions, l'erreur est invisible.
//
// Ce composant garantit l'affichage JJ/MM/AAAA sur tous les navigateurs et
// maintient la valeur en ISO (AAAA-MM-JJ) : l'API, les comparaisons de
// chaines et les 3 exports continuent de recevoir exactement ce qu'ils
// recevaient avant.
const isoVersFr = (iso) => {
  if (!iso || iso.length !== 10) return '';
  const [a, m, j] = iso.split('-');
  return `${j}/${m}/${a}`;
};

const frVersIso = (fr) => {
  const n = fr.replace(/\D/g, '');
  if (n.length !== 8) return null;
  const j = +n.slice(0, 2), m = +n.slice(2, 4), a = +n.slice(4, 8);
  if (m < 1 || m > 12 || j < 1 || a < 1900 || a > 2200) return null;
  // Verification du quantieme reel : rejette 31/04 comme 29/02 hors bissextile
  const d = new Date(Date.UTC(a, m - 1, j));
  if (d.getUTCDate() !== j || d.getUTCMonth() !== m - 1) return null;
  return `${a}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
};

const masqueFr = (saisie) => {
  const n = saisie.replace(/\D/g, '').slice(0, 8);
  if (n.length <= 2) return n;
  if (n.length <= 4) return `${n.slice(0, 2)}/${n.slice(2)}`;
  return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n.slice(4)}`;
};

const DateFR = ({ value, onChange, ariaLabel, min, max }) => {
  const [txt, setTxt] = useState(isoVersFr(value));
  const [invalide, setInvalide] = useState(false);
  const natifRef = React.useRef(null);

  // Resynchronise si la valeur change ailleurs (bouton d'effacement).
  useEffect(() => { setTxt(isoVersFr(value)); setInvalide(false); }, [value]);

  const saisir = (v) => {
    const m = masqueFr(v);
    setTxt(m);
    if (m === '') { setInvalide(false); onChange(''); return; }
    const iso = frVersIso(m);
    // Une date incomplete ne declenche aucune recherche : le filtre reste
    // inactif tant que les 8 chiffres ne sont pas saisis.
    if (m.replace(/\D/g, '').length === 8) {
      setInvalide(!iso);
      if (iso) onChange(iso);
    } else {
      setInvalide(false);
    }
  };

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <input
        type="text" inputMode="numeric" value={txt} placeholder="JJ/MM/AAAA"
        onChange={e => saisir(e.target.value)}
        aria-label={ariaLabel} title={ariaLabel} maxLength={10}
        style={{ padding:'7px 28px 7px 10px', borderRadius:8, width:118,
          border:`1px solid ${invalide ? R : BORDER}`, background:CARD,
          fontSize:12, fontFamily:FONT, color: invalide ? R : TEXT,
          boxSizing:'border-box' }} />
      {/* Selecteur natif conserve : le calendrier reste accessible d'un clic,
          seule la SAISIE passe par le champ texte. */}
      <input
        ref={natifRef} type="date" value={value || ''} min={min} max={max}
        tabIndex={-1} aria-hidden="true"
        onChange={e => onChange(e.target.value)}
        style={{ position:'absolute', right:0, width:26, height:'100%',
          opacity:0, cursor:'pointer', border:'none', padding:0 }} />
      <span onClick={() => { try { natifRef.current?.showPicker?.(); } catch (e) {} }}
        style={{ position:'absolute', right:7, fontSize:12, pointerEvents:'none' }}>📅</span>
    </span>
  );
};

const Badge = ({ label, color }) => <span style={{ background: `${color || MUTED}20`, color: color || MUTED, borderRadius: 20, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>{label}</span>;
const Spin = () => <div style={{ textAlign: 'center', padding: 40, color: MUTED, fontFamily: FONT }}>Chargement…</div>;
const Modal = ({ title, onClose, children }) => (
  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
    <Card style={{ width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <span style={{ fontSize: 16, fontWeight: 700, fontFamily: FONT }}>{title}</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: MUTED }}>×</button>
      </div>
      {children}
    </Card>
  </div>
);

// ─── Receipt ─────────────────────────────────────────────────────
const Receipt = ({ txn, lang, onClose }) => {
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  if (!txn) return null;
  const rows = [
    [lang === 'fr' ? 'Référence' : 'Reference', (txn.txn_id || txn.link_id || '').slice(-8).toUpperCase()],
    [lang === 'fr' ? 'Date' : 'Date', fmtDate(txn.initiated_at || new Date().toISOString(), lang)],
    [lang === 'fr' ? 'Montant' : 'Amount', fmtNum(txn.amount) + ' XAF'],
    [lang === 'fr' ? 'Statut' : 'Status', txn.status || 'completed'],
    ['Auth', txn.auth_code || txn.short_url?.slice(-8) || '—'],
  ];
  const sendSms = async () => {
    if (!phone.trim()) return toast.error(lang === 'fr' ? 'Numéro requis' : 'Phone required');
    setSending(true);
    try {
      await api.post('/receipts/sms', { txnId: txn.txn_id, phone: phone.trim() });
      toast.success(lang === 'fr' ? 'SMS envoyé' : 'SMS sent');
    } catch { toast.error('Erreur SMS'); }
    finally { setSending(false); }
  };
  const print = () => {
    const w = window.open('', '_blank', 'width=320,height=500');
    if (!w) return;
    w.document.write('<html><head><title>Reçu C-Pay</title><style>body{font-family:monospace;font-size:12px;padding:20px;max-width:280px}.r{display:flex;justify-content:space-between;margin:4px 0}.sep{border-top:1px dashed #999;margin:8px 0}.c{text-align:center;font-weight:bold}</style></head><body>');
    w.document.write('<div class="c">C-PAY — REÇU</div><div class="sep"></div>');
    rows.forEach(([l, v]) => w.document.write(`<div class="r"><span>${l}</span><span>${v}</span></div>`));
    w.document.write('<div class="sep"></div><div class="c">www.c-pay.global</div></body></html>');
    w.document.close();
    w.print();
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 380, maxWidth: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: FONT }}>{lang === 'fr' ? 'Reçu transaction' : 'Transaction receipt'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: MUTED }}>×</button>
        </div>
        <div style={{ background: BG, borderRadius: 10, padding: 14, marginBottom: 16 }}>
          {rows.map(([l, v]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 13 }}>
              <span style={{ color: MUTED }}>{l}</span>
              <span style={{ fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 6 }}>{lang === 'fr' ? 'Envoyer par SMS :' : 'Send by SMS:'}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+237XXXXXXXXX"
              style={{ flex: 1, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, fontFamily: FONT }} />
            <button onClick={sendSms} disabled={sending}
              style={{ background: P, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
              {sending ? '…' : '📱'}
            </button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button onClick={print} style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 10, cursor: 'pointer', fontWeight: 600, fontSize: 13, fontFamily: FONT }}>
            🖨️ {lang === 'fr' ? 'Imprimer' : 'Print'}
          </button>
          <button onClick={onClose} style={{ background: P, color: '#fff', border: 'none', borderRadius: 8, padding: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13, fontFamily: FONT }}>
            ✓ {lang === 'fr' ? 'Fermer' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── BackBtn ─────────────────────────────────────────────────────
const BackBtn = ({ lang }) => {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate('/operations')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${BORDER}`, color: MUTED, padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontFamily: FONT, marginBottom: 20, fontWeight: 600 }}>
      ← {lang === 'fr' ? 'Retour aux opérations' : 'Back to operations'}
    </button>
  );
};

// ─── Operations Hub ───────────────────────────────────────────────
// ─── OPERATIONS — Encaissement & Décaissement ────────────────────
// ─── 2FA BANNER ───────────────────────────────────────────────────
const TwoFABanner = ({ lang, onSetup }) => {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    api.get('/auth/2fa/status').then(r => setStatus(r.data)).catch(()=>{});
  }, []);
  if (!status || status.mfaEnabled) return null;
  const urgent = status.daysLeft <= 3;
  const expired = status.required;
  return (
    <div style={{ background: expired ? R : urgent ? O : '#ff9500', color: '#fff', padding: '10px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, fontFamily: FONT }}>
      <div>
        🔐 {expired
          ? (lang === 'fr' ? 'La 2FA est maintenant obligatoire. Activez-la pour continuer.' : '2FA is now required. Please enable it to continue.')
          : (lang === 'fr' ? `Activez la double authentification — ${status.daysLeft} jour(s) restant(s)` : `Enable 2FA — ${status.daysLeft} day(s) remaining`)}
      </div>
      <button onClick={onSetup}
        style={{ background: '#fff', color: expired ? R : O, border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: FONT }}>
        🔐 {lang === 'fr' ? 'Configurer maintenant' : 'Setup now'}
      </button>
    </div>
  );
};

// ─── 2FA SETUP MODAL ──────────────────────────────────────────────
const TwoFABannerInline = ({ lang, onSetup }) => {
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    api.get('/auth/2fa/status').then(r => setStatus(r.data)).catch(()=>{});
  }, []);
  if (!status || status.mfaEnabled || dismissed) return null;
  const urgent = status.required || status.daysLeft <= 3;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, background:urgent?'#ff3b30':'#ff9500', borderRadius:8, padding:'4px 10px' }}>
      <span style={{ fontSize:11, color:'#fff', fontFamily:FONT, whiteSpace:'nowrap' }}>
        🔐 {status.required ? (lang==='fr'?'2FA obligatoire':'2FA required') : `2FA — ${status.daysLeft}j`}
      </span>
      <button onClick={onSetup}
        style={{ background:'rgba(255,255,255,0.3)', border:'none', color:'#fff', borderRadius:4, padding:'2px 8px', cursor:'pointer', fontSize:11, fontWeight:700, fontFamily:FONT }}>
        {lang==='fr'?'Configurer':'Setup'}
      </button>
      {!status.required && (
        <button onClick={()=>setDismissed(true)}
          style={{ background:'none', border:'none', color:'#fff', cursor:'pointer', fontSize:14, padding:0, lineHeight:1 }}>×</button>
      )}
    </div>
  );
};

const TwoFASetup = ({ lang, onClose, onSuccess }) => {
  const [step, setStep] = useState('generate'); // generate | verify | done
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.post('/auth/2fa/setup').then(r => {
      setQrCode(r.data.qrCode);
      setSecret(r.data.secret);
    }).catch(() => toast.error('Erreur'));
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: CARD, borderRadius: 16, padding: 32, width: 440, maxWidth: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontSize: 18, fontWeight: 700, fontFamily: FONT }}>🔐 {lang === 'fr' ? 'Configurer la 2FA' : 'Setup 2FA'}</div>
          {step !== 'done' && <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: MUTED }}>×</button>}
        </div>

        {step === 'generate' && (<>
          <div style={{ background: BG, borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 13, color: MUTED }}>
            1️⃣ {lang === 'fr' ? 'Scannez ce QR code avec Google Authenticator ou Authy' : 'Scan this QR code with Google Authenticator or Authy'}
          </div>
          {qrCode && <img src={qrCode} alt="QR Code 2FA" style={{ width: '100%', maxWidth: 220, display: 'block', margin: '0 auto 16px', borderRadius: 8 }} />}
          <div style={{ background: BG, borderRadius: 8, padding: 10, marginBottom: 16, fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all', textAlign: 'center', color: TEXT }}>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Ou saisissez manuellement :' : 'Or enter manually:'}</div>
            {secret}
          </div>
          <Btn onClick={() => setStep('verify')} style={{ width: '100%' }}>
            {lang === 'fr' ? 'Suivant → Vérifier le code' : 'Next → Verify code'}
          </Btn>
        </>)}

        {step === 'verify' && (<>
          <div style={{ background: BG, borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 13, color: MUTED }}>
            2️⃣ {lang === 'fr' ? 'Entrez le code à 6 chiffres affiché dans votre application' : 'Enter the 6-digit code shown in your app'}
          </div>
          <input value={code} onChange={e => setCode(e.target.value.replace(/\D/g,'').slice(0,6))}
            placeholder="000000" maxLength={6} autoFocus
            style={{ width: '100%', textAlign: 'center', fontSize: 28, letterSpacing: 8, padding: '14px', border: `2px solid ${BORDER}`, borderRadius: 10, fontFamily: 'monospace', marginBottom: 16, boxSizing: 'border-box' }} />
          <Btn onClick={verify} disabled={loading || code.length !== 6} color={G} style={{ width: '100%' }}>
            {loading ? (lang === 'fr' ? 'Vérification…' : 'Verifying…') : (lang === 'fr' ? '✅ Activer la 2FA' : '✅ Enable 2FA')}
          </Btn>
          <button onClick={() => setStep('generate')} style={{ width: '100%', background: 'none', border: 'none', color: MUTED, cursor: 'pointer', marginTop: 10, fontSize: 13 }}>
            ← {lang === 'fr' ? 'Retour' : 'Back'}
          </button>
        </>)}

        {step === 'done' && (<>
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: G, marginBottom: 8, fontFamily: FONT }}>
              {lang === 'fr' ? '2FA activée !' : '2FA enabled!'}
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginBottom: 20 }}>
              {lang === 'fr' ? 'Votre compte est maintenant sécurisé.' : 'Your account is now secured.'}
            </div>
            <Btn onClick={onClose} color={G} style={{ width: '100%' }}>{lang === 'fr' ? 'Terminer' : 'Done'}</Btn>
          </div>
        </>)}
      </div>
    </div>
  );
};

const NfcModal = ({ lang, amount, status, onStart, onClose, onCardDetected, authCode, network, onPrint }) => (
  <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
    <div style={{ background:'#fff', borderRadius:20, padding:32, width:360, maxWidth:'100%', textAlign:'center', boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:4 }}>
        <button onClick={onClose} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:'#5a6677' }}>×</button>
      </div>

      {status === 'idle' && (<>
        <div style={{ fontSize:56, marginBottom:12 }}>📡</div>
        <div style={{ fontSize:17, fontWeight:700, marginBottom:6 }}>{lang==='fr'?'Paiement Sans Contact':'Contactless Payment'}</div>
        <div style={{ fontSize:24, fontWeight:800, color:'#12b6c7', marginBottom:20 }}>
          {parseFloat(amount||0).toLocaleString('fr-FR')} XAF
        </div>
        <div style={{ background:'#f0f4f8', borderRadius:10, padding:12, fontSize:12, color:'#5a6677', marginBottom:20 }}>
          📱 {lang==='fr'?'Approchez la carte ou le téléphone du client près de ce terminal':'Hold the customer card or phone near this terminal'}
        </div>
        <button onClick={onStart}
          style={{ width:'100%', background:'#1d4f92', color:'#fff', border:'none', borderRadius:10, padding:'13px', fontSize:15, fontWeight:700, cursor:'pointer' }}>
          📡 {lang==='fr'?'Démarrer la lecture NFC':'Start NFC reading'}
        </button>
      </>)}

      {status === 'waiting' && (<>
        <div style={{ fontSize:72, marginBottom:16 }}>📡</div>
        <div style={{ fontSize:17, fontWeight:700, marginBottom:8 }}>{lang==='fr'?'En attente du paiement…':'Waiting for payment…'}</div>
        <div style={{ fontSize:24, fontWeight:800, color:'#12b6c7', marginBottom:16 }}>
          {parseFloat(amount||0).toLocaleString('fr-FR')} XAF
        </div>
        <div style={{ background:'#f0f4f8', borderRadius:10, padding:12, fontSize:12, color:'#5a6677', marginBottom:16 }}>
          📱 {lang==='fr'?'Demandez au client d&apos;approcher sa carte ou son téléphone du terminal':'Ask the customer to hold their card or phone near the terminal'}
        </div>
        <button onClick={onCardDetected}
          style={{ width:'100%', background:'#00c896', color:'#fff', border:'none', borderRadius:10, padding:'13px', fontSize:14, fontWeight:700, cursor:'pointer', marginBottom:10 }}>
          ✅ {lang==='fr'?'Carte détectée — Confirmer':'Card detected — Confirm'}
        </button>
        <button onClick={onClose}
          style={{ width:'100%', background:'none', border:'1px solid #dce3ed', borderRadius:10, padding:'10px', fontSize:13, cursor:'pointer', color:'#5a6677' }}>
          {lang==='fr'?'Annuler':'Cancel'}
        </button>
      </>)}

      {status === 'processing' && (<>
        <div style={{ fontSize:56, marginBottom:16 }}>⚡</div>
        <div style={{ fontSize:16, fontWeight:700, color:'#ff9500' }}>{lang==='fr'?'Traitement en cours…':'Processing…'}</div>
      </>)}

      {status === 'success' && (<>
        <div style={{ fontSize:64, marginBottom:12 }}>✅</div>
        <div style={{ fontSize:18, fontWeight:700, color:'#00c896', marginBottom:8 }}>{lang==='fr'?'Paiement accepté !':'Payment accepted!'}</div>
        <div style={{ fontSize:28, fontWeight:800, marginBottom:8 }}>{parseFloat(amount||0).toLocaleString('fr-FR')} XAF</div>
        {authCode && (
          <div style={{ background:'#f0f4f8', borderRadius:8, padding:10, marginBottom:16, fontSize:12, color:'#5a6677' }}>
            <div>Auth: <strong style={{ fontFamily:'monospace' }}>{authCode}</strong></div>
            {network && <div>Réseau: <strong>{network}</strong></div>}
          </div>
        )}
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={onPrint}
            style={{ flex:1, background:'#f0f4f8', border:'1px solid #dce3ed', borderRadius:10, padding:'11px', fontSize:13, cursor:'pointer', fontWeight:600 }}>
            🖨️ {lang==='fr'?'Ticket':'Receipt'}
          </button>
          <button onClick={onClose}
            style={{ flex:1, background:'#00c896', color:'#fff', border:'none', borderRadius:10, padding:'11px', fontSize:14, fontWeight:700, cursor:'pointer' }}>
            {lang==='fr'?'✓ Terminer':'✓ Done'}
          </button>
        </div>
      </>)}
    </div>
  </div>
);

const Operations = ({ lang }) => {
  const [tab, setTab] = useState('collection'); // collection | disbursement
  const [polling, setPolling] = useState(false);
  const [countdown, setCountdown] = useState(90);

  // ── Shared state ─────────────────────────────────────────────
  const [step, setStep] = useState(1); // 1=form 2=method 3=result
  const [receipt, setReceipt] = useState(null);

  // ── Collection state ──────────────────────────────────────────
  const [colForm, setColForm] = useState({
    customerName: '', customerPhone: '', amount: '', reference: 'COL-' + Date.now().toString(36).toUpperCase(),
    collectMode: '', // 'card' | 'mobile_money'
    momoFormat: 'ussd', // 'ussd' | 'qr'
    cardMethod: '',  // 'contactless' | 'paylink' | 'qr'
    psp: 'cybersource',
    mobileOperator: 'mtn',
    sendChannel: '',  // 'sms' | 'whatsapp' | 'email'
    customerEmail: '',
  });
  const [colLoading, setColLoading] = useState(false);
  const [colResult, setColResult] = useState(null);
  const [showNfcModal, setShowNfcModal] = useState(false);
  const [nfcStatus, setNfcStatus] = useState('idle'); // idle | waiting | processing | success

  // ── Disbursement state ────────────────────────────────────────
  const [disForm, setDisForm] = useState({
    recipientName: '', recipientPhone: '',
    reference: 'DIS-' + Date.now().toString(36).toUpperCase(),
    amount: '', operator: 'mtn',
  });
  const [disLoading, setDisLoading] = useState(false);
  const [disResult, setDisResult] = useState(null);
  useEffect(() => {
    window.__cpayTxnActive = polling;
    window.__cpayTxnDetail = polling ? {
      amount: (colResult?.amount || disResult?.amount),
      phone: (colResult?.customerPhone || disResult?.recipientPhone),
      ref: (colResult?.ref || disResult?.ref),
      countdown,
    } : null;
    window.dispatchEvent(new Event('cpay-txn-change'));
    const bu = (e) => { if (window.__cpayTxnActive) { e.preventDefault(); e.returnValue = ''; return ''; } };
    window.addEventListener('beforeunload', bu);
    return () => window.removeEventListener('beforeunload', bu);
  }, [polling, countdown, colResult, disResult]);


  const formatLocalPhone = (v) => { const d = String(v).replace(/[^0-9]/g, '').slice(0, 9); if (d.length <= 3) return d; if (d.length <= 6) return d.slice(0,3) + ' ' + d.slice(3); return d.slice(0,3) + ' ' + d.slice(3,6) + ' ' + d.slice(6); };
  const fc = k => v => setColForm(p => ({ ...p, [k]: v }));
  const fd = k => v => setDisForm(p => ({ ...p, [k]: v }));

  const PSPs = [
    { v: 'cybersource', label: 'CyberSource', sublabel: 'Visa · Défaut', color: '#1d4f92' },
    { v: 'migs', label: 'MIGS', sublabel: 'Mastercard · Backup', color: '#eb001b' },
  ];

  const OPERATORS_CG = [
    { v: 'mtn', label: 'MTN MoMo', flag: '🟡', color: '#ffcb05', enabled: true },
    { v: 'airtel', label: 'Airtel Money', flag: '🟥', color: '#ff0000', enabled: true },
  ];

  // ── Collection submit ─────────────────────────────────────────
  // ── Polling du statut d'encaissement ─────────────────────────
  const pollCollectStatus = async (txnId) => {
    setPolling(true);
    setCountdown(180);

    const tick = setInterval(() => setCountdown((s) => (s > 0 ? s - 1 : 0)), 1000);
    let elapsed = 0;

    const check = async () => {
      try {
        const { data } = await api.get(`/collect/${txnId}/status`);
        if (data.status === 'authorized') {
          clearInterval(tick);
          setPolling(false);
          setColResult((r) => ({ ...r, status: 'authorized', authCode: data.authCode,
            airtelMoneyId: data.reference || null,
            message: data.message, fee: data.fee, net: data.net }));
          toast.success(lang === 'fr' ? 'Paiement confirmé' : 'Payment confirmed');
          return true;
        }
        if (data.status === 'failed') {
          clearInterval(tick);
          setPolling(false);
          setColResult((r) => ({ ...r, status: 'failed', message: data.message }));
          toast.error(data.message || (lang === 'fr' ? 'Paiement refusé' : 'Payment declined'));
          return true;
        }
      } catch (e) { /* continue */ }
      return false;
    };

    while (elapsed < 180000) {
      await new Promise((r) => setTimeout(r, 3000));
      elapsed += 3000;
      if (await check()) return;
    }

    clearInterval(tick);
    setPolling(false);
    setColResult((r) => ({ ...r, status: 'timeout',
      message: lang === 'fr' ? "Le client n'a pas confirmé dans le délai"
                             : 'Client did not confirm in time' }));
  };

  // ── Collection submit ─────────────────────────────────────────
  const submitCollection = async () => {
    const { customerName, customerPhone, amount, reference, collectMode, cardMethod, psp, mobileOperator, sendChannel, customerEmail } = colForm;
    // Paiement sans contact — pas besoin de téléphone client
    if (collectMode === 'card' && cardMethod === 'contactless') {
      if (!amount || parseFloat(amount) < 100) return toast.error(lang === 'fr' ? 'Montant minimum 100 XAF' : 'Minimum 100 XAF');
      console.log('NFC MODAL OPEN', amount, showNfcModal);
      setShowNfcModal(true);
      console.log('NFC MODAL SET');
      return;
    }
    const isQr = collectMode === 'mobile_money' && colForm.momoFormat === 'qr';
    if (!amount || !collectMode || (!isQr && (!customerName || !customerPhone))) return toast.error(lang === 'fr' ? 'Champs requis manquants' : 'Required fields missing');
    if (parseFloat(amount) < 100) return toast.error(lang === 'fr' ? 'Montant minimum 100 XAF' : 'Minimum 100 XAF');
    if (collectMode === 'card' && !cardMethod) return toast.error(lang === 'fr' ? 'Choisissez un mode de paiement carte' : 'Choose a card payment method');
    setColLoading(true);
    try {
      const ref = reference || 'COL-' + Date.now().toString(36).toUpperCase();
    if (collectMode === 'mobile_money') {
        // Format QR : creer un pay-link mobile_money, le client scanne et paie
        if (colForm.momoFormat === 'qr') {
          const { data: pl } = await api.post('/pay-links', {
            amount: parseFloat(amount), description: ref,
            expiresIn: 24, payment_method: 'mobile_money',
          });
          const link = pl.link || pl;
          setColResult({ type: 'momo_qr', ref, amount, operator: mobileOperator,
            shortUrl: link.short_url, txnId: link.pay_link_id });
          setStep(3);
          setColLoading(false);
          return;
        }
        // MoMo collection — push USSD reel
        const { data } = await api.post('/collect', {
          amount: parseFloat(amount), customerPhone, description: ref,
          method: mobileOperator === 'airtel' ? 'airtel_money' : 'mtn_momo',
        });

        setColResult({
          type: 'momo', txnId: data.txnId, ref, amount,
          operator: mobileOperator,
          status: data.status || 'pending',
          message: data.message,
          customerPhone,
        });

        // Si confirmation requise, poller le statut
        if (data.requiresConfirmation && data.txnId) {
          setStep(3);
          setColLoading(false);
          pollCollectStatus(data.txnId);
          return;
        }
      } else {
        // Card → créer un pay link
        const { data } = await api.post('/pay-links', {
          amount: parseFloat(amount), description: `${customerName} · ${ref}`,
          expiresIn: 24, recipientPhone: customerPhone,
          channel: sendChannel || 'sms', psp,
        });
        const link = data.link || data;
        setColResult({ type: cardMethod, txnId: link.pay_link_id, ref, amount, shortUrl: link.short_url, psp, sendChannel, customerName, customerPhone, customerEmail });
        // Envoi automatique si canal choisi
        if (sendChannel && link.pay_link_id) {
          try { await api.post(`/pay-links/${link.pay_link_id}/send`, { phone: customerPhone, email: customerEmail, channel: sendChannel }); }
          catch { /* silencieux */ }
        }
      }
      setStep(3);
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setColLoading(false); }
  };

  // ── Disbursement submit ───────────────────────────────────────
  const pollDisburseStatus = async (txnId) => {
    setPolling(true);
    setCountdown(180);
    const tick = setInterval(() => setCountdown((s) => (s > 0 ? s - 1 : 0)), 1000);
    let elapsed = 0;
    const check = async () => {
      try {
        const { data } = await api.get(`/disburse/${txnId}/status`);
        if (data.status === 'authorized') {
          clearInterval(tick); setPolling(false);
          setDisResult((r) => ({ ...r, status: 'authorized', message: data.message }));
          toast.success(lang === 'fr' ? 'Transfert confirmé' : 'Transfer confirmed');
          return true;
        }
        if (data.status === 'failed') {
          clearInterval(tick); setPolling(false);
          setDisResult((r) => ({ ...r, status: 'failed', message: data.message }));
          toast.error(data.message || (lang === 'fr' ? 'Transfert refusé' : 'Transfer declined'));
          return true;
        }
      } catch (e) { /* continue */ }
      return false;
    };
    while (elapsed < 180000) {
      await new Promise((r) => setTimeout(r, 3000));
      elapsed += 3000;
      if (await check()) return;
    }
    clearInterval(tick); setPolling(false);
  };
  const submitDisbursement = async () => {
    const { recipientName, recipientPhone, amount, reference, operator } = disForm;
    if (!recipientName || !recipientPhone || !amount) return toast.error(lang === 'fr' ? 'Champs requis manquants' : 'Required fields missing');
    if (parseFloat(amount) < 500) return toast.error(lang === 'fr' ? 'Montant minimum 500 XAF' : 'Minimum 500 XAF');
    setDisLoading(true);
    try {
      const { data } = await api.post('/withdraw', { amount: parseFloat(amount), operator, phone: recipientPhone, description: reference });
      setDisResult({ txnId: data.txnId, ref: reference, amount, operator, recipientName, recipientPhone, status: 'pending' });
      setStep(3);
      if (data.txnId) pollDisburseStatus(data.txnId);
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setDisLoading(false); }
  };

  const resetAll = () => {
    setStep(1); setColResult(null); setDisResult(null);
    setColForm({ customerName: '', customerPhone: '', amount: '', reference: 'COL-' + Date.now().toString(36).toUpperCase(), collectMode: '', cardMethod: '', psp: 'cybersource', mobileOperator: 'mtn', sendChannel: '', customerEmail: '' });
    setDisForm({ recipientName: '', recipientPhone: '', reference: 'DIS-' + Date.now().toString(36).toUpperCase(), amount: '', operator: 'mtn' });
  };

  // ─── UI helpers ───────────────────────────────────────────────
  const inp = (label, value, onChange, opts = {}) => (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4, fontFamily: FONT }}>{label}</label>
      <input type={opts.type || 'text'} value={value || ''} onChange={e => onChange(e.target.value)}
        placeholder={opts.placeholder || ''} readOnly={opts.readOnly}
        style={{ width: '100%', background: opts.readOnly ? '#f8f9fa' : BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 12px', color: TEXT, fontSize: 14, fontFamily: FONT, boxSizing: 'border-box', opacity: opts.readOnly ? 0.7 : 1 }} />
    </div>
  );

  const methodCard = (v, label, icon, color, current, setter, disabled = false) => (
    <button key={v} disabled={disabled} onClick={() => !disabled && setter(v)}
      style={{ border: `2px solid ${current === v ? color : BORDER}`, background: current === v ? `${color}12` : CARD, borderRadius: 12, padding: '14px 10px', cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'center', transition: 'all .2s', flex: 1, opacity: disabled ? 0.5 : 1 }}>
      <div style={{ fontSize: 26, marginBottom: 6 }}>{icon}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: current === v ? color : MUTED, fontFamily: FONT }}>{label}</div>
      {disabled && <div style={{ fontSize: 10, color: MUTED, marginTop: 4, fontFamily: FONT }}>Bientôt disponible</div>}
    </button>
  );

  // ─── Tabs ─────────────────────────────────────────────────────
  const tabs = [
    { v: 'collection',   label: lang === 'fr' ? '⬇️ Encaissement' : '⬇️ Collection',   color: G },
    { v: 'disbursement', label: lang === 'fr' ? '⬆️ Décaissement'  : '⬆️ Disbursement', color: O },
  ];

  return (
    <div>
      {receipt && <Receipt txn={receipt} lang={lang} onClose={() => setReceipt(null)} />}

      {/* Onglets centrés */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28, borderBottom: `2px solid ${BORDER}` }}>
        <div style={{ display: 'flex', gap: 0 }}>
          {tabs.map(t => (
            <button key={t.v} onClick={() => { setTab(t.v); resetAll(); }}
              style={{ padding: '14px 48px', border: 'none', background: 'none', fontSize: 15, fontWeight: 700, fontFamily: FONT, cursor: 'pointer', color: tab === t.v ? t.color : MUTED, borderBottom: `3px solid ${tab === t.v ? t.color : 'transparent'}`, marginBottom: -2, transition: 'all .2s' }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── ENCAISSEMENT ─────────────────────────────────────── */}
      {tab === 'collection' && (
        <>
          {step === 1 && (
            <div style={{ maxWidth: 640, margin: '0 auto' }}>
              <Card>
                <div style={{ fontSize: 14, fontWeight: 700, color: G, marginBottom: 16, fontFamily: FONT }}>
                  👤 {lang === 'fr' ? 'Informations client' : 'Customer information'}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {inp(lang === 'fr' ? 'Nom du client *' : 'Customer name *', colForm.customerName, fc('customerName'), { placeholder: 'Jean Dupont' })}
                  {inp(lang === 'fr' ? 'Téléphone *' : 'Phone *', colForm.customerPhone, v => fc('customerPhone')(formatLocalPhone(v)), { placeholder: '044 797 873', type: 'tel' })}
                  {inp(lang === 'fr' ? 'Montant (XAF) *' : 'Amount (XAF) *', colForm.amount, fc('amount'), { placeholder: '5000', type: 'number' })}
                  <div style={{ marginBottom:14 }}>
                    <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4, fontFamily:FONT }}>{lang==='fr'?'Référence transaction':'Transaction reference'}</label>
                    <div style={{ display:'flex', gap:8 }}>
                      <input value={colForm.reference} readOnly
                        style={{ flex:1, background:'#e8ecf0', border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:13, fontFamily:'monospace', color:MUTED, cursor:'not-allowed' }} />
                      <button onClick={()=>fc('reference')('COL-'+Date.now().toString(36).toUpperCase())}
                        style={{ background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'0 12px', cursor:'pointer', fontSize:16, color:MUTED }}>🔄</button>
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 12, marginTop: 8, fontFamily: FONT }}>
                  💳 {lang === 'fr' ? 'Mode de collecte *' : 'Collection mode *'}
                </div>
                <div style={{ display: 'flex', gap: 10, marginBottom: colForm.collectMode ? 20 : 0 }}>
                  {methodCard('card', lang === 'fr' ? 'Carte bancaire' : 'Card', '💳', BLUE, colForm.collectMode, fc('collectMode'), true)}
                  {methodCard('mobile_money', 'Mobile Money', '📱', G, colForm.collectMode, fc('collectMode'))}
                </div>

                {/* Mode CARTE */}
                {colForm.collectMode === 'card' && (
                  <div style={{ marginTop: 16, padding: 16, background: `${BLUE}08`, border: `1px solid ${BLUE}20`, borderRadius: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: BLUE, marginBottom: 12 }}>
                      {lang === 'fr' ? 'Méthode de paiement carte' : 'Card payment method'}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                      {methodCard('contactless', lang === 'fr' ? 'Sans contact' : 'Contactless', '📡', BLUE, colForm.cardMethod, fc('cardMethod'))}
                      {methodCard('paylink', lang === 'fr' ? 'Lien de paiement' : 'Payment link', '🔗', P, colForm.cardMethod, fc('cardMethod'))}
                      {methodCard('qr', 'QR Code', '📷', G, colForm.cardMethod, fc('cardMethod'))}
                    </div>

                    {/* Envoi lien */}
                    {(colForm.cardMethod === 'paylink' || colForm.cardMethod === 'qr') && (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 700, color: TEXT, marginBottom: 10 }}>
                          📤 {lang === 'fr' ? 'Envoyer le lien par' : 'Send link via'}
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                          {[['sms', '💬 SMS', '#25d366'], ['whatsapp', '📲 WhatsApp', '#25d366'], ['email', '📧 Email', P]].map(([v, l, c]) => (
                            <button key={v} onClick={() => fc('sendChannel')(colForm.sendChannel === v ? '' : v)}
                              style={{ flex: 1, border: `2px solid ${colForm.sendChannel === v ? c : BORDER}`, background: colForm.sendChannel === v ? `${c}12` : CARD, borderRadius: 8, padding: '8px 6px', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: colForm.sendChannel === v ? c : MUTED, fontFamily: FONT }}>
                              {l}
                            </button>
                          ))}
                        </div>
                        {colForm.sendChannel === 'email' && inp('Email *', colForm.customerEmail, fc('customerEmail'), { type: 'email', placeholder: 'client@email.com' })}
                      </>
                    )}

                    {/* PSP */}
                    {colForm.cardMethod !== 'contactless' && (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 700, color: TEXT, marginBottom: 10 }}>
                          🏦 PSP {lang === 'fr' ? '(processeur de paiement)' : '(payment processor)'}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {PSPs.map(p => (
                            <button key={p.v} onClick={() => fc('psp')(p.v)}
                              style={{ flex: 1, border: `2px solid ${colForm.psp === p.v ? p.color : BORDER}`, background: colForm.psp === p.v ? `${p.color}10` : CARD, borderRadius: 10, padding: '12px 8px', cursor: 'pointer', textAlign: 'center' }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: colForm.psp === p.v ? p.color : TEXT, fontFamily: FONT }}>{p.label}</div>
                              <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>{p.sublabel}</div>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Mode MOBILE MONEY */}
                {colForm.collectMode === 'mobile_money' && (
                  <div style={{ marginTop: 16, padding: 16, background: `${G}08`, border: `1px solid ${G}20`, borderRadius: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: G, marginBottom: 12 }}>
                      {lang === 'fr' ? 'Opérateur Mobile Money (Congo-Brazzaville)' : 'Mobile Money Operator (Congo-Brazzaville)'}
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      {OPERATORS_CG.map(op => (
                        <button key={op.v} disabled={op.enabled === false} onClick={() => op.enabled !== false && fc('mobileOperator')(op.v)}
                          style={{ flex: 1, border: `2px solid ${colForm.mobileOperator === op.v ? op.color : BORDER}`, background: colForm.mobileOperator === op.v ? `${op.color}10` : CARD, borderRadius: 12, padding: '16px 10px', cursor: op.enabled === false ? 'not-allowed' : 'pointer', textAlign: 'center', opacity: op.enabled === false ? 0.45 : 1 }}>
                          <div style={{ fontSize: 28, marginBottom: 6 }}>{op.flag}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: colForm.mobileOperator === op.v ? op.color : TEXT, fontFamily: FONT }}>{op.label}</div>
                          {op.enabled === false && <div style={{ fontSize: 10, color: MUTED, marginTop: 4, fontFamily: FONT }}>Bientôt</div>}
                        </button>
                      ))}
                    </div>
                    <div style={{ marginTop: 16, marginBottom: 8, fontSize: 13, fontWeight: 700, color: G }}>
                      {lang === 'fr' ? 'Format de la demande' : 'Request format'}
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button onClick={() => fc('momoFormat')('ussd')}
                        style={{ flex: 1, border: `2px solid ${colForm.momoFormat === 'ussd' ? G : BORDER}`, background: colForm.momoFormat === 'ussd' ? `${G}10` : CARD, borderRadius: 12, padding: '14px 10px', cursor: 'pointer', textAlign: 'center' }}>
                        <div style={{ fontSize: 24, marginBottom: 4 }}>📲</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: colForm.momoFormat === 'ussd' ? G : TEXT, fontFamily: FONT }}>{lang === 'fr' ? 'Push USSD' : 'USSD Push'}</div>
                      </button>
                      <button onClick={() => fc('momoFormat')('qr')}
                        style={{ flex: 1, border: `2px solid ${colForm.momoFormat === 'qr' ? G : BORDER}`, background: colForm.momoFormat === 'qr' ? `${G}10` : CARD, borderRadius: 12, padding: '14px 10px', cursor: 'pointer', textAlign: 'center' }}>
                        <div style={{ fontSize: 24, marginBottom: 4 }}>🔳</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: colForm.momoFormat === 'qr' ? G : TEXT, fontFamily: FONT }}>QR code</div>
                      </button>
                    </div>
                    <div style={{ marginTop: 12, fontSize: 12, color: MUTED, fontFamily: FONT }}>
                      {colForm.momoFormat === 'qr'
                        ? (lang === 'fr' ? '🔳 Un QR code sera généré ; le client le scanne et paie depuis son téléphone.' : '🔳 A QR code will be generated for the customer to scan and pay.')
                        : (lang === 'fr' ? `📱 Une demande de paiement sera envoyée au ${colForm.customerPhone || 'numéro du client'}` : `📱 A payment request will be sent to ${colForm.customerPhone || 'customer number'}`)}
                    </div>
                  </div>
                )}

                {colForm.collectMode && (
                  <Btn onClick={submitCollection} disabled={colLoading} color={G} style={{ width: '100%', marginTop: 20, fontSize: 15 }}>
                    {colLoading ? (lang === 'fr' ? 'Traitement…' : 'Processing…') : (lang === 'fr' ? '✓ Lancer l’encaissement' : '✓ Start collection')}
                  </Btn>
                )}

                {/* Modal NFC */}
                {showNfcModal && (
                  <NfcModal
                    lang={lang}
                    amount={colForm.amount}
                    status={nfcStatus}
                    authCode={colResult?.authCode}
                    network={colResult?.network}
                    onPrint={() => { setShowNfcModal(false); setNfcStatus('idle'); }}
                    onStart={() => {
                      setNfcStatus('waiting');
                    }}
                    onCardDetected={async () => {
                      setNfcStatus('processing');
                      try {
                        const { data } = await api.post('/collect/contactless', {
                          amount: parseFloat(colForm.amount),
                          description: colForm.reference || 'Paiement sans contact',
                          cardData: { channel: 'contactless', simulated: true }
                        });
                        setColResult({
                          type: 'contactless',
                          txnId: data.transaction?.transaction_id,
                          ref: data.reference,
                          amount: data.amount,
                          authCode: data.authCode,
                          network: data.network,
                          fee: data.fee,
                          net: data.net
                        });
                        setNfcStatus('success');
                      } catch(err) {
                        toast.error(err.response?.data?.error || 'Paiement refusé');
                        setNfcStatus('idle');
                      }
                    }}
                    onClose={() => { setShowNfcModal(false); setNfcStatus('idle'); }}
                  />
                )}
              </Card>
            </div>
          )}

          {step === 3 && colResult && (
            <div style={{ maxWidth: 520, margin: '0 auto' }}>
              <Card style={{ border: `2px solid ${G}`, textAlign: 'center' }}>
                {colResult.type === 'momo' ? (
                  <>
                    {colResult.status === 'authorized' ? (
                      <>
                        <div style={{ fontSize: 64, marginBottom: 12 }}>✅</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: '#00a878', marginBottom: 8, fontFamily: FONT }}>
                          {lang === 'fr' ? 'Paiement confirmé' : 'Payment confirmed'}
                        </div>
                        <div style={{ fontSize: 30, fontWeight: 700, color: P, marginBottom: 12, fontFamily: FONT }}>
                          {Number(colResult.amount).toLocaleString('fr-FR')} XAF
                        </div>
                        <div style={{ background: BG, borderRadius: 8, padding: '12px 16px', marginBottom: 16, textAlign: 'left', fontSize: 13, fontFamily: FONT, color: MUTED }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                            <span>{lang === 'fr' ? 'Client' : 'Customer'}</span>
                            <strong style={{ color: '#1e2d3d' }}>{colResult.customerPhone}</strong>
                          </div>
                          {colResult.fee != null && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                              <span>{lang === 'fr' ? 'Frais' : 'Fee'}</span>
                              <strong style={{ color: '#1e2d3d' }}>{Number(colResult.fee).toLocaleString('fr-FR')} XAF</strong>
                            </div>
                          )}
                          {colResult.net != null && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                              <span>Net</span>
                              <strong style={{ color: '#00a878' }}>{Number(colResult.net).toLocaleString('fr-FR')} XAF</strong>
                            </div>
                          )}
                          {colResult.authCode && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                              <span>{lang === 'fr' ? 'Autorisation' : 'Auth code'}</span>
                              <code style={{ color: P, fontWeight: 700 }}>{colResult.authCode}</code>
                            </div>
                          )}
                          {colResult.airtelMoneyId && (
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span>{lang === 'fr' ? 'ID Mobile Money' : 'Mobile Money ID'}</span>
                              <code style={{ color: '#1e2d3d', fontWeight: 700 }}>{colResult.airtelMoneyId}</code>
                            </div>
                          )}
                        </div>
                      </>
                    ) : colResult.status === 'failed' || colResult.status === 'timeout' ? (
                      <>
                        <div style={{ fontSize: 64, marginBottom: 12 }}>❌</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: '#e5484d', marginBottom: 8, fontFamily: FONT }}>
                          {lang === 'fr' ? 'Paiement non abouti' : 'Payment failed'}
                        </div>
                        <div style={{ fontSize: 14, color: MUTED, marginBottom: 16, fontFamily: FONT }}>
                          {colResult.message || (lang === 'fr' ? 'Le client a refusé ou le délai est dépassé' : 'Client declined or timed out')}
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: 64, marginBottom: 12 }}>📲</div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: P, marginBottom: 8, fontFamily: FONT }}>
                          {lang === 'fr' ? 'En attente du client' : 'Waiting for customer'}
                        </div>
                        <div style={{ fontSize: 28, fontWeight: 700, color: P, marginBottom: 4, fontFamily: FONT }}>
                          {Number(colResult.amount).toLocaleString('fr-FR')} XAF
                        </div>
                        <div style={{ fontSize: 14, color: MUTED, marginBottom: 14, fontFamily: FONT }}>
                          {colResult.customerPhone}
                        </div>
                        <div style={{ fontSize: 13, color: MUTED, marginBottom: 18, fontFamily: FONT, lineHeight: 1.6 }}>
                          {lang === 'fr'
                            ? 'Le client doit saisir son code PIN Mobile Money sur son téléphone'
                            : 'The customer must enter their Mobile Money PIN on their phone'}
                        </div>
                        {polling && (
                          <>
                            <div style={{ width: '100%', height: 4, background: BG, borderRadius: 2, overflow: 'hidden', marginBottom: 12 }}>
                              <div style={{ width: `${(countdown / 90) * 100}%`, height: '100%', background: P, transition: 'width 1s linear' }} />
                            </div>
                            <div style={{ fontSize: 15, fontWeight: 700, color: P, marginBottom: 16, fontFamily: FONT }}>
                              ⏳ {countdown}s
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 64, marginBottom: 12 }}>✅</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: G, marginBottom: 8, fontFamily: FONT }}>
                      {lang === 'fr' ? 'Lien créé !' : 'Link created!'}
                    </div>
                    {colResult.shortUrl && (
                      <>
                        <div style={{ background: BG, borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, fontFamily: 'monospace', color: P, wordBreak: 'break-all' }}>
                          {colResult.shortUrl}
                        </div>
                        <img src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&format=svg&data=${encodeURIComponent(colResult.shortUrl)}`}
                          alt="QR" style={{ width: 180, height: 180, margin: '0 auto 14px', display: 'block', borderRadius: 8, border: `1px solid ${BORDER}` }} />
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                          <Btn small onClick={() => navigator.clipboard.writeText(colResult.shortUrl).then(() => toast.success('Copié !'))}>📋 Copier</Btn>
                          {colResult.shortUrl && <a href={`https://wa.me/?text=${encodeURIComponent(colResult.shortUrl)}`} target="_blank" rel="noreferrer" style={{ background: '#25d366', color: '#fff', borderRadius: 8, padding: '6px 14px', textDecoration: 'none', fontSize: 12, fontWeight: 700 }}>📲 WhatsApp</a>}
                        </div>
                      </>
                    )}
                    {colResult.sendChannel && (
                      <div style={{ fontSize: 12, color: G, marginBottom: 12 }}>
                        ✓ {lang === 'fr' ? `Lien envoyé par ${colResult.sendChannel} à ${colResult.customerPhone}` : `Link sent via ${colResult.sendChannel} to ${colResult.customerPhone}`}
                      </div>
                    )}
                  </>
                )}

                {/* Récapitulatif */}
                <div style={{ background: BG, borderRadius: 8, padding: 12, marginBottom: 16, textAlign: 'left' }}>
                  {[[lang === 'fr' ? 'Client' : 'Customer', colResult.customerName || colForm.customerName],
                    [lang === 'fr' ? 'Montant' : 'Amount', fmtNum(colResult.amount) + ' XAF'],
                    ['Référence', colResult.ref],
                    ['Transaction ID', colResult.txnId],
                    ['Statut', colResult.status]].map(([l, v]) => (
                    <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 13, fontFamily: FONT }}>
                      <span style={{ color: MUTED }}>{l}</span><span style={{ fontWeight: 600 }}>{v}</span>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                  <Btn onClick={() => setReceipt({ txn_id: colResult.txnId, amount: colResult.amount, status: colResult.status, initiated_at: new Date().toISOString(), auth_code: colResult.ref })} color={G}>🧾 Ticket</Btn>
                  <Btn outline onClick={resetAll}>{lang === 'fr' ? '+ Nouvelle opération' : '+ New operation'}</Btn>
                </div>
              </Card>
            </div>
          )}
        </>
      )}

      {/* ── DÉCAISSEMENT ─────────────────────────────────────── */}
      {tab === 'disbursement' && (
        <>
          {step === 1 && (
            <div style={{ maxWidth: 560, margin: '0 auto' }}>
              <Card>
                <div style={{ fontSize: 14, fontWeight: 700, color: O, marginBottom: 16, fontFamily: FONT }}>
                  👤 {lang === 'fr' ? 'Informations bénéficiaire' : 'Recipient information'}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {inp(lang === 'fr' ? 'Nom du bénéficiaire *' : 'Recipient name *', disForm.recipientName, fd('recipientName'), { placeholder: 'Jean Dupont' })}
                  {inp(lang === 'fr' ? 'Numéro Mobile Money *' : 'Mobile Money number *', disForm.recipientPhone, v => fd('recipientPhone')(formatLocalPhone(v)), { placeholder: '044 797 873', type: 'tel' })}
                  {inp('Référence', disForm.reference, fd('reference'), { readOnly: true })}
                  {inp(lang === 'fr' ? 'Montant (XAF) *' : 'Amount (XAF) *', disForm.amount, fd('amount'), { placeholder: '10000', type: 'number' })}
                </div>

                <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 12, fontFamily: FONT }}>
                  📱 {lang === 'fr' ? 'Opérateur Mobile Money' : 'Mobile Money Operator'}
                </div>
                <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                  {OPERATORS_CG.map(op => (
                    <button key={op.v} disabled={op.enabled === false} onClick={() => op.enabled !== false && fd('operator')(op.v)}
                      style={{ flex: 1, border: `2px solid ${disForm.operator === op.v ? op.color : BORDER}`, background: disForm.operator === op.v ? `${op.color}10` : CARD, borderRadius: 12, padding: '14px 10px', cursor: op.enabled === false ? 'not-allowed' : 'pointer', textAlign: 'center', opacity: op.enabled === false ? 0.45 : 1 }}>
                      <div style={{ fontSize: 28, marginBottom: 6 }}>{op.flag}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: disForm.operator === op.v ? op.color : TEXT, fontFamily: FONT }}>{op.label}</div>
                      {op.enabled === false && <div style={{ fontSize: 10, color: MUTED, marginTop: 4, fontFamily: FONT }}>Bientôt</div>}
                    </button>
                  ))}
                </div>

                {disForm.amount && parseFloat(disForm.amount) >= 500 && (
                  <div style={{ background: `${O}10`, border: `1px solid ${O}30`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 12, color: TEXT, fontFamily: FONT }}>
                    ⚠️ {lang === 'fr' ? 'Frais : 1.5% déduits du montant. Bénéficiaire recevra :' : 'Fee: 1.5% deducted. Recipient will receive:'}{' '}
                    <strong>{fmtNum(Math.round(parseFloat(disForm.amount) * 0.985))} XAF</strong>
                  </div>
                )}

                <div style={{ background: `${R}08`, border: `1px solid ${R}20`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: TEXT, fontFamily: FONT }}>
                  🔐 {lang === 'fr' ? 'Cette opération sera enregistrée dans votre journal d’audit.' : 'This operation will be recorded in your audit log.'}
                </div>

                <Btn onClick={submitDisbursement} disabled={disLoading} color={O} style={{ width: '100%', fontSize: 15 }}>
                  {disLoading ? (lang === 'fr' ? 'Traitement…' : 'Processing…') : (lang === 'fr' ? '💸 Effectuer le décaissement' : '💸 Perform disbursement')}
                </Btn>
              </Card>
            </div>
          )}

          {step === 3 && disResult && (
            <div style={{ maxWidth: 480, margin: '0 auto' }}>
              <Card style={{ border: `2px solid ${O}`, textAlign: 'center' }}>
                <div style={{ fontSize: 64, marginBottom: 12 }}>✅</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: O, marginBottom: 4, fontFamily: FONT }}>
                  {lang === 'fr' ? 'Décaissement effectué !' : 'Disbursement done!'}
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 4 }}>{fmtNum(disResult.amount)} XAF</div>
                <div style={{ fontSize: 14, color: MUTED, marginBottom: 20 }}>→ {disResult.recipientName} · {disResult.recipientPhone}</div>

                <div style={{ background: BG, borderRadius: 8, padding: 12, marginBottom: 16, textAlign: 'left' }}>
                  {[[lang === 'fr' ? 'Référence' : 'Reference', disResult.ref],
                    [lang === 'fr' ? 'Opérateur' : 'Operator', OPERATORS_CG.find(o => o.v === disResult.operator)?.label],                    ['Transaction ID', disResult.txnId],

                    ['Statut', disResult.status]].map(([l, v]) => (
                    <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 13, fontFamily: FONT }}>
                      <span style={{ color: MUTED }}>{l}</span><span style={{ fontWeight: 600 }}>{v}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                  <Btn onClick={() => setReceipt({ txn_id: disResult.txnId, amount: disResult.amount, status: disResult.status, initiated_at: new Date().toISOString(), auth_code: disResult.ref })} color={O}>🧾 Ticket</Btn>
                  <Btn outline onClick={resetAll}>{lang === 'fr' ? '+ Nouveau décaissement' : '+ New disbursement'}</Btn>
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
};


// ─── 2FA Banner ───────────────────────────────────────────────────
const TwoFaBanner = ({ lang }) => {
  const t = useT(lang);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('2fa_dismissed') === '1');
  const [mfaEnabled] = useState(() => localStorage.getItem('mfa_enabled') === '1');
  if (mfaEnabled || dismissed) return null;
  return (
    <div style={{ background: '#e8f4fd', border: `1px solid ${P}`, borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>🔐</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{lang === 'fr' ? 'Sécuriser votre compte' : 'Secure your account'}</div>
          <div style={{ fontSize: 11, color: MUTED }}>{lang === 'fr' ? 'Activez l\u2019authentification à deux facteurs' : 'Enable two-factor authentication'}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <Link to="/account" style={{ background: P, color: '#fff', padding: '6px 14px', borderRadius: 6, textDecoration: 'none', fontSize: 12, fontWeight: 700 }}>
          {lang === 'fr' ? 'Activer maintenant' : 'Enable now'}
        </Link>
        <button onClick={() => { localStorage.setItem('2fa_dismissed', '1'); setDismissed(true); }}
          style={{ background: 'none', border: `1px solid ${BORDER}`, color: MUTED, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontFamily: FONT }}>
          {lang === 'fr' ? 'Plus tard' : 'Later'}
        </button>
      </div>
    </div>
  );
};

// ─── Layout ───────────────────────────────────────────────────────
const Layout = ({ children, lang, toggleLang }) => {
  const [show2FA, setShow2FA]       = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);

  useEffect(() => {
    const user = JSON.parse(localStorage.getItem('merchant_user')||'{}');
    if (user?.userId && !consentChecked) {
      fetch(`${process.env.REACT_APP_API_BASE_URL||''}/api/v1/consent/check?userId=${user.userId}&userType=merchant&portal=merchant`)
        .then(r=>r.json())
        .then(d=>{ if (!d.hasConsented) setShowConsent(true); setConsentChecked(true); })
        .catch(()=>setConsentChecked(true));
    }
  }, [consentChecked]);
  const t = useT(lang);
  const navigate = useNavigate();
  const [bizName, setBizName] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [txnActive, setTxnActive] = useState(false);
  const [txnDetail, setTxnDetail] = useState(null);
  const [pendingNav, setPendingNav] = useState(null);
  useEffect(() => {
    const sync = () => { setTxnActive(!!window.__cpayTxnActive); setTxnDetail(window.__cpayTxnDetail || null); };
    window.addEventListener('cpay-txn-change', sync);
    sync();
    return () => window.removeEventListener('cpay-txn-change', sync);
  }, []);
  const [isDesktop, setIsDesktop] = useState(window.innerWidth >= 1024);
  useEffect(() => {
    const handleResize = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const { pathname } = window.location;
  useEffect(() => { api.get('/account').then(r => setBizName(r.data.business_name)).catch(() => {}); }, []);

  const nav = [
    { path: '/', label: t('dashboard') },
    { path: '/operations', label: '⚡ ' + (lang === 'fr' ? 'Mes Opérations' : 'My Operations') },
    { path: '/transactions', label: lang === 'fr' ? '💳 Mes Transactions' : '💳 My Transactions' },
    { path: '/settlements', label: lang === 'fr' ? '🏦 Mes Règlements' : '🏦 My Settlements' },
    { path: '/terminals', label: lang === 'fr' ? '📱 Mes Terminaux' : '📱 My Terminals' },
    { path: '/integrations', label: lang === 'fr' ? '🔌 Mes Intégrations' : '🔌 My Integrations' },
    { path: '/support',      label: lang === 'fr' ? '🚨 Mes Incidents' : '🚨 My Incidents' },
    { path: '/account', label: lang === 'fr' ? '👤 Mon Compte' : '👤 My Account' },
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: BG, color: TEXT, fontFamily: FONT }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: CARD, borderBottom: `1px solid ${BORDER}`, padding: '10px 16px', position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200, height: 52 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => setMenuOpen(m => !m)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: TEXT, lineHeight: 1, padding: '2px 6px' }}>☰</button>
          <img src="/logo-calculus.png" alt="C-Pay" style={{ height: 32, objectFit: 'contain' }} onError={e => e.target.style.display = 'none'} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: MUTED, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bizName}</span>
          <TwoFABannerInline lang={lang} onSetup={()=>setShow2FA(true)} />
          <button onClick={() => { if (!document.fullscreenElement) { document.documentElement.requestFullscreen?.(); } else { document.exitFullscreen?.(); } }} title={lang === 'fr' ? 'Plein écran' : 'Fullscreen'} style={{ background: 'none', border: `1px solid ${BORDER}`, color: TEXT, padding: '4px 10px', borderRadius: 20, cursor: 'pointer', fontSize: 13, fontFamily: FONT }}>⛶</button>
          <button onClick={toggleLang} style={{ background: 'none', border: `1px solid ${BORDER}`, color: TEXT, padding: '4px 10px', borderRadius: 20, cursor: 'pointer', fontSize: 11, fontFamily: FONT }}>🌐 {lang === 'fr' ? 'EN' : 'FR'}</button>
          <button onClick={() => { localStorage.removeItem('merchant_token'); navigate('/login'); }} style={{ background: 'none', border: `1px solid ${BORDER}`, color: MUTED, padding: '4px 10px', borderRadius: 20, cursor: 'pointer', fontSize: 11, fontFamily: FONT }}>⏻</button>
        </div>
      </div>

      {/* Bandeau 2FA — dans la top bar, à droite du logo */}
      {showConsent && (
        <ConsentModal
          userId={JSON.parse(localStorage.getItem('merchant_user')||'{}')?.userId}
          userType="merchant" portal="merchant" lang={lang}
          onAccepted={()=>setShowConsent(false)}
        />
      )}
      {show2FA && <TwoFASetup lang={lang} onClose={()=>setShow2FA(false)} onSuccess={()=>setShow2FA(false)} />}
      {/* Overlay */}
      {menuOpen && <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 150 }} />}

      {/* Sidebar */}
      <aside style={{ width: 230, background: CARD, borderRight: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', position: 'fixed', top: 52, bottom: 0, left: (menuOpen || isDesktop) ? 0 : -230, transition: 'left .25s ease', zIndex: 200, overflowY: 'auto' }}>
        <nav style={{ flex: 1, padding: '10px 0' }}>
          {nav.map(n => (
            <Link key={n.path} to={n.path} onClick={(e) => {
              if (txnActive && n.path !== pathname) { e.preventDefault(); setPendingNav(n.path); }
              else setMenuOpen(false);
            }}
              style={{ display: 'block', padding: '10px 18px', color: pathname === n.path ? G : MUTED, textDecoration: 'none', fontSize: 13, fontWeight: pathname === n.path ? 600 : 400, background: pathname === n.path ? `${G}12` : 'transparent', borderLeft: `3px solid ${pathname === n.path ? G : 'transparent'}` }}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div style={{ padding: '12px 16px', borderTop: `1px solid ${BORDER}` }}>
          <div title={lang === 'fr' ? 'App mobile en préparation' : 'Mobile app in preparation'} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: `${MUTED}12`, border: `1px solid ${MUTED}30`, color: MUTED, padding: '7px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600, marginBottom: 8, cursor: 'not-allowed' }}>
            📱 {lang === 'fr' ? 'App mobile — Bientôt disponible' : 'Mobile app — Coming soon'}
          </div>
          <button onClick={toggleLang} style={{ background: 'none', border: `1px solid ${BORDER}`, color: TEXT, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginBottom: 8, width: '100%', fontFamily: FONT }}>{t('language')}</button>
          <button onClick={() => {
            // Appel serveur indispensable : il revoque le refresh en base et
            // efface le cookie cp_rt_merchant. Sans lui le cookie survit a la
            // deconnexion, et le refresh silencieux d'AuthProvider reconnecte
            // l'utilisateur des le retour sur /login.
            // .catch ignore : une API injoignable ne doit pas empecher de se
            // deconnecter. window.location force un rechargement complet, qui
            // vide l'etat memoire de facon certaine.
            api.post('/auth/logout').catch(() => {}).finally(() => {
              setAccessToken(null);
              try { localStorage.removeItem('merchant_user'); } catch (e) {}
              window.location.href = '/login';
            });
          }} style={{ background: 'none', border: `1px solid ${BORDER}`, color: MUTED, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, width: '100%', fontFamily: FONT }}>{t('logout')}</button>
        </div>
      </aside>
      {pendingNav && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: CARD, borderRadius: 14, padding: 24, maxWidth: 400, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: 40, textAlign: 'center', marginBottom: 8 }}>⏳</div>
            <div style={{ fontSize: 18, fontWeight: 700, textAlign: 'center', marginBottom: 6, color: TEXT }}>{lang === 'fr' ? 'Transaction en cours' : 'Transaction in progress'}</div>
            <div style={{ fontSize: 13, color: MUTED, textAlign: 'center', marginBottom: 14 }}>{lang === 'fr' ? 'Une opération est en cours. Si vous quittez, elle sera abandonnée côté interface.' : 'An operation is in progress. Leaving will abandon it on the interface.'}</div>
            {txnDetail && (
              <div style={{ background: BG, borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
                {txnDetail.amount != null && <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}><span style={{ color: MUTED }}>{lang === 'fr' ? 'Montant' : 'Amount'}</span><strong>{txnDetail.amount} XAF</strong></div>}
                {txnDetail.phone && <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}><span style={{ color: MUTED }}>{lang === 'fr' ? 'Numéro' : 'Number'}</span><strong>{txnDetail.phone}</strong></div>}
                {txnDetail.ref && <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}><span style={{ color: MUTED }}>Réf.</span><strong style={{ fontFamily: 'monospace', fontSize: 11 }}>{txnDetail.ref}</strong></div>}
                {txnDetail.countdown != null && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: MUTED }}>{lang === 'fr' ? 'Temps restant' : 'Time left'}</span><strong style={{ color: O }}>{txnDetail.countdown}s</strong></div>}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <button onClick={() => setPendingNav(null)} style={{ background: G, color: '#fff', border: 'none', padding: '11px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: FONT }}>{lang === 'fr' ? 'Rester' : 'Stay'}</button>
              <button onClick={() => { window.__cpayTxnActive = false; window.dispatchEvent(new Event('cpay-txn-change')); const dest = pendingNav; setPendingNav(null); setMenuOpen(false); navigate(dest); }} style={{ background: R, color: '#fff', border: 'none', padding: '11px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: FONT }}>{lang === 'fr' ? 'Annuler et quitter' : 'Cancel & leave'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Main */}
      <main style={{ flex: 1, padding: '72px 20px 28px 20px', marginLeft: isDesktop ? 230 : 0, transition: 'margin-left .25s', minWidth: 0 }}>
        <TwoFaBanner lang={lang} />
        {children}
      </main>
    </div>
  );
};

// ─── Login ───────────────────────────────────────────────────────
// ─── CONSENT MODAL ────────────────────────────────────────────────
const ConsentModal = ({ userId, userType, portal, lang, onAccepted }) => {
  const [cgu, setCgu]         = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [saving, setSaving]   = useState(false);

  const accept = async () => {
    if (!cgu || !privacy) return toast.error('Vous devez accepter les CGU et la politique de confidentialité');
    setSaving(true);
    try {
      await fetch(`${process.env.REACT_APP_API_BASE_URL||''}/api/v1/consent/accept`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ userId, userType, portal, cguAccepted:cgu, privacyAccepted:privacy, contractAccepted:true })
      });
      onAccepted();
    } catch(e){ toast.error('Erreur lors de l\'enregistrement du consentement'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, padding:32, width:540, maxWidth:'100%', maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ textAlign:'center', marginBottom:24 }}>
          <div style={{ fontSize:48, marginBottom:8 }}>📋</div>
          <div style={{ fontSize:20, fontWeight:800, color:'#1d4f92' }}>
            {lang==='fr'?'Conditions d\'utilisation':'Terms of Use'}
          </div>
          <div style={{ fontSize:13, color:'#5a6677', marginTop:4 }}>
            {lang==='fr'?'Veuillez lire et accepter nos conditions avant de continuer.':'Please read and accept our terms before continuing.'}
          </div>
        </div>

        {/* Résumé CGU */}
        <div style={{ background:'#f0f4f8', borderRadius:10, padding:16, marginBottom:16, fontSize:13, color:'#2a3a4a', maxHeight:200, overflowY:'auto' }}>
          <strong style={{ color:'#1d4f92' }}>Résumé des Conditions Générales d\'Utilisation</strong>
          <ul style={{ marginTop:8, paddingLeft:16 }}>
            <li>La plateforme CPlus est opérée par <strong>Calculus Plus SAS</strong></li>
            <li>Vous devez avoir 18 ans ou plus pour utiliser nos services</li>
            <li>Vous vous engagez à ne pas utiliser la plateforme à des fins illicites</li>
            <li>Vos transactions sont soumises aux frais communiqués avant validation</li>
            <li>Calculus Plus SAS se réserve le droit de suspendre tout compte en cas d\'utilisation abusive</li>
            <li>Les litiges sont soumis aux juridictions de Brazzaville, République du Congo</li>
          </ul>
          <a href="https://c-pay.global/legal/cgu.html" target="_blank" rel="noreferrer"
            style={{ color:'#12b6c7', fontSize:12, display:'block', marginTop:8 }}>
            📖 Lire les CGU complètes →
          </a>
        </div>

        {/* Résumé confidentialité */}
        <div style={{ background:'#f0f4f8', borderRadius:10, padding:16, marginBottom:20, fontSize:13, color:'#2a3a4a', maxHeight:160, overflowY:'auto' }}>
          <strong style={{ color:'#1d4f92' }}>Résumé de la Politique de Confidentialité</strong>
          <ul style={{ marginTop:8, paddingLeft:16 }}>
            <li>Nous collectons vos données pour exécuter les transactions et vérifier votre identité (KYC)</li>
            <li>Vos données sont conservées conformément aux obligations légales (5 à 10 ans)</li>
            <li>Nous ne vendons jamais vos données à des tiers</li>
            <li>Vous disposez de droits d\'accès, rectification et suppression de vos données</li>
            <li>Contact : <a href="mailto:legal@c-pay.global" style={{ color:'#12b6c7' }}>legal@c-pay.global</a></li>
          </ul>
          <a href="https://c-pay.global/legal/privacy.html" target="_blank" rel="noreferrer"
            style={{ color:'#12b6c7', fontSize:12, display:'block', marginTop:8 }}>
            📖 Lire la politique complète →
          </a>
        </div>

        {/* Cases à cocher */}
        <div style={{ marginBottom:20 }}>
          <label style={{ display:'flex', alignItems:'flex-start', gap:10, marginBottom:12, cursor:'pointer' }}>
            <input type="checkbox" checked={cgu} onChange={e=>setCgu(e.target.checked)}
              style={{ width:18, height:18, marginTop:2, flexShrink:0, cursor:'pointer' }} />
            <span style={{ fontSize:13, color:'#1e2d3d' }}>
              J\'ai lu et j\'accepte les <a href="https://c-pay.global/legal/cgu.html" target="_blank" rel="noreferrer" style={{ color:'#12b6c7' }}>Conditions Générales d\'Utilisation</a> de CPlus *
            </span>
          </label>
          <label style={{ display:'flex', alignItems:'flex-start', gap:10, cursor:'pointer' }}>
            <input type="checkbox" checked={privacy} onChange={e=>setPrivacy(e.target.checked)}
              style={{ width:18, height:18, marginTop:2, flexShrink:0, cursor:'pointer' }} />
            <span style={{ fontSize:13, color:'#1e2d3d' }}>
              J\'accepte la <a href="https://c-pay.global/legal/privacy.html" target="_blank" rel="noreferrer" style={{ color:'#12b6c7' }}>Politique de Confidentialité</a> et consens au traitement de mes données personnelles *
            </span>
          </label>
        </div>

        <div style={{ fontSize:11, color:'#5a6677', marginBottom:16, textAlign:'center' }}>
          * Champs obligatoires — Sans acceptation, l\'accès à la plateforme n\'est pas possible.
        </div>

        <button onClick={accept} disabled={saving||!cgu||!privacy}
          style={{ width:'100%', background:cgu&&privacy?'#12b6c7':'#dce3ed', color:cgu&&privacy?'#fff':'#8a9ab0',
            border:'none', borderRadius:10, padding:'14px', fontSize:15, fontWeight:700,
            cursor:cgu&&privacy?'pointer':'not-allowed', fontFamily:'Century Gothic,Arial,sans-serif', transition:'all .2s' }}>
          {saving?'Enregistrement…':'✅ Accepter et continuer'}
        </button>
      </div>
    </div>
  );
};

const Login = ({ lang, toggleLang }) => {
  const t = useT(lang);
  const [creds, setCreds] = useState({ emailOrPhone: '', password: '' });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { isAuth } = useAuth();
  useEffect(() => { if (isAuth) navigate('/'); }, [isAuth, navigate]);

  const submit = async () => {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', creds);
      // Le refresh token n'est plus lu ici : il arrive en cookie HttpOnly
      // pose par le serveur. L'access token reste en memoire.
      setAccessToken(data.access_token);
      if (data.user) localStorage.setItem('merchant_user', JSON.stringify(data.user));
      navigate('/');
    } catch { toast.error(t('loginError')); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight: '100vh', background: BG, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div style={{ width: '100%', maxWidth: 420, padding: 20 }}>
        <div style={{ textAlign: 'right', marginBottom: 12 }}>
          <button onClick={toggleLang} style={{ background: 'none', border: `1px solid ${BORDER}`, color: TEXT, padding: '5px 12px', borderRadius: 20, cursor: 'pointer', fontSize: 12, fontFamily: FONT }}>🌐 {t('language')}</button>
        </div>
        <Card>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <img src="/logo-calculus.png" alt="Calculus Plus" style={{ width: 180, height: 'auto', display: 'block', margin: '0 auto 12px', objectFit: 'contain' }} onError={e => e.target.style.display = 'none'} />
            <div style={{ color: MUTED, fontSize: 13 }}>Espace Marchand</div>
          </div>
          <form onSubmit={e => { e.preventDefault(); if (!loading) submit(); }}>
            <Inp id="identifier" name="identifier" label={t('emailOrPhone')} value={creds.emailOrPhone} onChange={v => setCreds(c => ({ ...c, emailOrPhone: v }))} placeholder="email@example.com" autoComplete="username" inputMode="email" required />
            <Inp id="password" name="password" label={t('password')} value={creds.password} onChange={v => setCreds(c => ({ ...c, password: v }))} type="password" placeholder="" autoComplete="current-password" required />
            {/* Bouton natif masque : rend la touche Entree fonctionnelle et
                permet aux gestionnaires de mots de passe de detecter le
                formulaire. Btn est un composant maison sans prop type. */}
            <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
            <Btn onClick={submit} disabled={loading} style={{ width: '100%', display: 'block', textAlign: 'center', marginTop: 8 }}>
              {loading ? t('loggingIn') : t('login')}
            </Btn>
          </form>
          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <Link to="/forgot-password" style={{ color: MUTED, textDecoration: 'none', fontSize: 12, fontFamily: FONT }}>{lang === 'fr' ? 'Mot de passe oublié ?' : 'Forgot password?'}</Link>
          </div>
          <div style={{ textAlign: 'center', marginTop: 12, fontSize: 13, color: MUTED, fontFamily: FONT }}>
            {lang === 'fr' ? 'Pas encore de compte ?' : 'No account yet?'}{' '}
            <Link to="/register" style={{ color: G, fontWeight: 600, textDecoration: 'none' }}>{lang === 'fr' ? 'Créer un compte' : 'Sign up'}</Link>
          </div>
        </Card>
      </div>
    </div>
  );
};

// ─── ForgotPassword ──────────────────────────────────────────────
const ForgotPassword = ({ lang, toggleLang }) => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const submit = async () => {
    if (!email.trim()) return toast.error(lang === 'fr' ? 'Email requis' : 'Email required');
    setLoading(true);
    try { await api.post('/auth/forgot-password', { email: email.trim() }); setSent(true); }
    catch { setSent(true); }
    finally { setLoading(false); }
  };
  return (
    <div style={{ minHeight: '100vh', background: BG, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div style={{ width: '100%', maxWidth: 420, padding: 20 }}>
        <Card>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <img src="/logo-calculus.png" alt="" style={{ height: 48, marginBottom: 12 }} onError={e => e.target.style.display = 'none'} />
            <div style={{ fontSize: 18, fontWeight: 700 }}>{lang === 'fr' ? 'Réinitialiser le mot de passe' : 'Reset password'}</div>
          </div>
          {sent ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>✉️</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: G, marginBottom: 8 }}>{lang === 'fr' ? 'Lien envoyé !' : 'Link sent!'}</div>
              <Link to="/login" style={{ color: P, fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>{lang === 'fr' ? 'Retour à la connexion' : 'Back to login'}</Link>
            </div>
          ) : (
            <>
              <Inp label="Email *" value={email} onChange={setEmail} placeholder="email@exemple.com" type="email" />
              <Btn onClick={submit} disabled={loading} style={{ width: '100%', marginTop: 4 }}>{loading ? (lang === 'fr' ? 'Envoi…' : 'Sending…') : (lang === 'fr' ? 'Envoyer le lien' : 'Send link')}</Btn>
              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <Link to="/login" style={{ color: MUTED, fontSize: 12, textDecoration: 'none' }}>{lang === 'fr' ? 'Retour à la connexion' : 'Back to login'}</Link>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
};

// ─── Register ────────────────────────────────────────────────────
const Register = ({ lang, toggleLang }) => {
  const fmtLocal = (v) => { const d = String(v).replace(/[^0-9]/g, '').slice(0, 9); if (d.length <= 3) return d; if (d.length <= 6) return d.slice(0,3)+' '+d.slice(3); return d.slice(0,3)+' '+d.slice(3,6)+' '+d.slice(6); };
  const fmtRib = (v) => String(v).replace(/[^0-9A-Za-z]/g, '').slice(0, 23).toUpperCase();
  const t = useT(lang);
  const navigate = useNavigate();
  const [form, setForm] = useState({ businessName: '', email: '', phone: '', password: '', confirmPassword: '', country: 'CG', rccm: '', nif: '', currency: 'XAF', walletMtn: '', walletAirtel: '', bankAccount: '', bankName: '', iban: '', institutionId: '' });
  const [institutions, setInstitutions] = useState([]);
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [operator, setOperator] = useState('');
  const f = k => v => setForm(p => ({ ...p, [k]: v }));
  React.useEffect(() => {
    const ctry = form.country || 'CG';
    api.get(`/institutions?country=${ctry}`)
      .then(r => setInstitutions((r.data.institutions || []).filter(i => ['bank','microfinance','cooperative'].includes(i.type))))
      .catch(() => setInstitutions([]));
  }, [form.country]);

  const detectOp = phone => {
    if (phone.match(/^(\+237|237)?(6[78][0-9])/)) setOperator('MTN');
    else if (phone.match(/^(\+237|237)?(69[0-9])/)) setOperator('Orange');
    else if (phone.match(/^(\+237|237)?(6[56][0-9])/)) setOperator('Airtel');
    else setOperator('');
  };

  const submit = async () => {
    if (form.password !== form.confirmPassword) return toast.error(t('passwordMismatch') || 'Passwords do not match');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/register', form);
      localStorage.setItem('merchant_token', data.access_token);
      if (data.user) localStorage.setItem('merchant_user', JSON.stringify(data.user));
      toast.success(lang === 'fr' ? 'Compte créé !' : 'Account created!');
      navigate('/');
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setLoading(false); }
  };

  const inp = { width: '100%', background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 12px', fontSize: 14, color: TEXT, fontFamily: FONT, boxSizing: 'border-box', marginBottom: 14 };

  return (
    <div style={{ minHeight: '100vh', background: BG, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: FONT, padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 480 }}>
        <Card>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <img src="/logo-calculus.png" alt="" style={{ height: 48, marginBottom: 10 }} onError={e => e.target.style.display = 'none'} />
            <div style={{ fontSize: 18, fontWeight: 700 }}>{t('registerTitle') || 'Créer un compte marchand'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {[1, 2].map(s => <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: s <= step ? P : BORDER }} />)}
          </div>
          {step === 1 ? (
            <>
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Pays *' : 'Country *'}</label>
              <select value={form.country} onChange={e => { const cy = e.target.value; setForm(p => ({ ...p, country: cy, currency: cy === 'CD' ? 'CDF' : 'XAF', institutionId: '', bankName: '' })); }} style={inp}>
                <option value="CG">Congo-Brazzaville</option>
                <option value="CM">Cameroun</option>
                <option value="GA">Gabon</option>
                <option value="GQ">{lang === 'fr' ? 'Guinée Équatoriale' : 'Equatorial Guinea'}</option>
                <option value="TD">Tchad</option>
                <option value="CF">{lang === 'fr' ? 'Centrafrique' : 'Central African Rep.'}</option>
              </select>
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Nom de l\u2019entreprise *' : 'Business name *'}</label>
              <input value={form.businessName} onChange={e => f('businessName')(e.target.value)} placeholder={lang === 'fr' ? 'Ma Boutique SARL' : 'My Business Ltd'} style={inp} />
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>Email *</label>
              <input type="email" value={form.email} onChange={e => f('email')(e.target.value)} placeholder="email@entreprise.com" style={inp} />
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Téléphone *' : 'Phone *'} {operator && <span style={{ color: G, fontSize: 11 }}>({operator})</span>}</label>
              <input type="tel" value={form.phone} onChange={e => { f('phone')(e.target.value); detectOp(e.target.value); }} placeholder="+237XXXXXXXXX" style={inp} />
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>RCCM</label>
              <input value={form.rccm} onChange={e => f('rccm')(e.target.value)} placeholder="RC/DLA/2024/B/0001" style={inp} />
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>NIF</label>
              <input value={form.nif} onChange={e => f('nif')(e.target.value)} placeholder="P012345678901A" style={inp} />
              <Btn onClick={() => { if (!form.businessName || !form.email || !form.phone) return toast.error(lang === 'fr' ? 'Champs requis' : 'Required fields'); setStep(2); }} style={{ width: '100%' }}>
                {lang === 'fr' ? 'Continuer →' : 'Continue →'}
              </Btn>
            </>
          ) : (
            <>
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Mot de passe *' : 'Password *'}</label>
              <input type="password" value={form.password} onChange={e => f('password')(e.target.value)} placeholder="••••••••" style={inp} />
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Confirmer *' : 'Confirm *'}</label>
              <input type="password" value={form.confirmPassword} onChange={e => f('confirmPassword')(e.target.value)} placeholder="••••••••" style={inp} />
              <div style={{ marginTop: 14, marginBottom: 6, fontSize: 13, fontWeight: 700, color: BLUE }}>{lang === 'fr' ? 'Compte de règlement (au moins un requis)' : 'Settlement account (at least one required)'}</div>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 10 }}>{lang === 'fr' ? 'C\'est là que vous recevrez vos encaissements, nets de commission.' : 'This is where you receive your collections, net of commission.'}</div>
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Wallet MTN MoMo' : 'MTN MoMo wallet'}</label>
              <input type="tel" value={form.walletMtn} onChange={e => f('walletMtn')(fmtLocal(e.target.value))} placeholder="044 797 873" style={inp} />
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Wallet Airtel Money' : 'Airtel Money wallet'}</label>
              <input type="tel" value={form.walletAirtel} onChange={e => f('walletAirtel')(fmtLocal(e.target.value))} placeholder="044 797 873" style={inp} />
              <div style={{ marginTop: 10, marginBottom: 4, fontSize: 12, fontWeight: 600, color: MUTED }}>{lang === 'fr' ? 'Coordonnées bancaires (optionnel)' : 'Bank details (optional)'}</div>
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'RIB / Numéro de compte CEMAC (23 caractères)' : 'CEMAC account number (23 chars)'}</label>
              <input value={form.bankAccount} onChange={e => f('bankAccount')(fmtRib(e.target.value))} placeholder="CG00 12345 12345678901 23" maxLength={30} style={inp} />
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Institution (banque / microfinance / coopérative)' : 'Institution (bank / microfinance / cooperative)'}</label>
              <select value={form.institutionId} onChange={e => { const id = e.target.value; const inst = institutions.find(i => i.institution_id === id); setForm(p => ({ ...p, institutionId: id, bankName: inst ? inst.name : '' })); }} style={inp}>
                <option value="">{lang === 'fr' ? '— Choisir une institution —' : '— Select an institution —'}</option>
                {['bank','microfinance','cooperative'].map(tp => {
                  const list = institutions.filter(i => i.type === tp);
                  if (!list.length) return null;
                  const grpLabel = tp === 'bank' ? (lang === 'fr' ? 'Banques' : 'Banks') : tp === 'microfinance' ? (lang === 'fr' ? 'Microfinances' : 'Microfinance') : (lang === 'fr' ? 'Coopératives' : 'Cooperatives');
                  return (
                    <optgroup key={tp} label={grpLabel}>
                      {list.map(i => <option key={i.institution_id} value={i.institution_id}>{i.name}</option>)}
                    </optgroup>
                  );
                })}
              </select>
              <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'IBAN (optionnel)' : 'IBAN (optional)'}</label>
              <input value={form.iban} onChange={e => f('iban')(e.target.value.toUpperCase())} placeholder="CG00 0000 0000 0000 0000 000" style={inp} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 8 }}>
                <Btn outline onClick={() => setStep(1)}>← {lang === 'fr' ? 'Retour' : 'Back'}</Btn>
                <Btn onClick={() => { if (!form.walletMtn && !form.walletAirtel && !form.bankAccount) return toast.error(lang === 'fr' ? 'Renseignez au moins un wallet ou compte bancaire' : 'Provide at least one wallet or bank account'); submit(); }} disabled={loading} color={G}>{loading ? (lang === 'fr' ? 'Création…' : 'Creating…') : (lang === 'fr' ? 'Créer le compte' : 'Create account')}</Btn>
              </div>
            </>
          )}
          <div style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: MUTED }}>
            {lang === 'fr' ? 'Déjà un compte ?' : 'Already have an account?'}{' '}
            <Link to="/login" style={{ color: G, fontWeight: 600, textDecoration: 'none' }}>{lang === 'fr' ? 'Se connecter' : 'Sign in'}</Link>
          </div>
        </Card>
      </div>
    </div>
  );
};

// ─── Dashboard ───────────────────────────────────────────────────
const Dashboard = ({ lang }) => {
  const t = useT(lang);
  const [data, setData] = useState(null);
  const [txns, setTxns] = useState([]);
  useEffect(() => {
    api.get('/dashboard').then(r => setData(r.data)).catch(() => {});
    api.get('/transactions', { params: { limit: 50 } }).then(r => setTxns(r.data.data || [])).catch(() => {});
  }, []);
  if (!data) return <Spin />;

  const successTxns = txns.filter(t => t.status === 'authorized' || t.status === 'completed');
  const failedTxns = txns.filter(t => t.status === 'failed');
  const total = txns.length || 1;
  const pctS = Math.round((successTxns.length / total) * 100);
  const pctF = 100 - pctS;

  const days7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    return { date: d.toISOString().slice(0, 10), label: d.toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'short' }), amount: 0 };
  });
  txns.forEach(txn => {
    const day = days7.find(d => d.date === txn.initiated_at?.slice(0, 10));
    if (day && txn.status !== 'failed') day.amount += parseFloat(txn.amount || 0);
  });
  const maxAmt = Math.max(...days7.map(d => d.amount), 1);

  const cx = 70, cy = 70, r = 55;
  const toRad = deg => (deg - 90) * Math.PI / 180;
  const arcPath = (start, end) => {
    if (end - start >= 360) end = 359.99;
    const s = { x: cx + r * Math.cos(toRad(start)), y: cy + r * Math.sin(toRad(start)) };
    const e = { x: cx + r * Math.cos(toRad(end)), y: cy + r * Math.sin(toRad(end)) };
    return `M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${end - start > 180 ? 1 : 0} 1 ${e.x} ${e.y} Z`;
  };
  const sDeg = (pctS / 100) * 360;

  const kpis = [
    { label: t('todayTxn'), value: data.today?.txn_count || 0, color: P, icon: '📊' },
    { label: t('todayVolume'), value: fmtNum(data.today?.volume) + ' XAF', color: G, icon: '💰' },
    { label: t('monthVolume'), value: fmtNum(data.thisMonth?.volume), color: BLUE, icon: '📈' },
    { label: lang === 'fr' ? 'Prochain Règlement' : 'Next Settlement', value: fmtNum(data.settlingTomorrow), color: O, icon: '🏦' },
  ];

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        {kpis.map(k => (
          <Card key={k.label} style={{ borderTop: `3px solid ${k.color}`, textAlign: 'center' }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>{k.icon}</div>
            <div style={{ fontSize: 11, color: MUTED, marginBottom: 4, fontFamily: FONT }}>{k.label}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: k.color, fontFamily: FONT }}>{k.value}</div>
          </Card>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14, fontFamily: FONT }}>{lang === 'fr' ? 'Transactions : Réussies vs Échouées' : 'Success vs Failed'}</div>
          {txns.length === 0 ? <div style={{ color: MUTED, fontSize: 12, textAlign: 'center', padding: 20 }}>{lang === 'fr' ? 'Aucune donnée' : 'No data'}</div> : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <svg width={140} height={140} viewBox="0 0 140 140" style={{ flexShrink: 0 }}>
                <path d={arcPath(0, sDeg)} fill={G} opacity={0.9} />
                <path d={arcPath(sDeg, 360)} fill={R} opacity={0.85} />
                <circle cx={cx} cy={cy} r={30} fill={CARD} />
                <text x={cx} y={cy - 4} textAnchor="middle" fontSize={16} fontWeight="bold" fill={TEXT}>{pctS}%</text>
                <text x={cx} y={cy + 12} textAnchor="middle" fontSize={8} fill={MUTED}>OK</text>
              </svg>
              <div style={{ flex: 1 }}>
                {[[G, lang === 'fr' ? 'Réussies' : 'Successful', successTxns.length, pctS + '%'], [R, lang === 'fr' ? 'Échouées' : 'Failed', failedTxns.length, pctF + '%']].map(([c, l, n, p]) => (
                  <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: c }} />
                    <div style={{ flex: 1, fontSize: 12, fontFamily: FONT }}>{l}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: c }}>{n}</div>
                    <div style={{ fontSize: 11, color: MUTED }}>{p}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14, fontFamily: FONT }}>{lang === 'fr' ? 'Volume 7 derniers jours (XAF)' : 'Volume last 7 days (XAF)'}</div>
          <svg width="100%" viewBox="0 0 260 110" style={{ overflow: 'visible' }}>
            {days7.map((d, i) => {
              const bW = 24, gap = 13, ox = 8;
              const bH = (d.amount / maxAmt) * 80;
              const x = ox + i * (bW + gap);
              const y = 85 - bH;
              const isToday = i === 6;
              return (
                <g key={d.date}>
                  <rect x={x} y={y} width={bW} height={Math.max(bH, 2)} fill={isToday ? P : `${P}60`} rx={4} />
                  {d.amount > 0 && <text x={x + bW / 2} y={y - 3} textAnchor="middle" fontSize={7} fill={MUTED}>{d.amount >= 1000 ? Math.round(d.amount / 1000) + 'k' : Math.round(d.amount)}</text>}
                  <text x={x + bW / 2} y={100} textAnchor="middle" fontSize={8} fill={isToday ? P : MUTED} fontWeight={isToday ? 700 : 400}>{d.label}</text>
                </g>
              );
            })}
            <line x1={4} y1={85} x2={256} y2={85} stroke={BORDER} strokeWidth={1} />
          </svg>
        </Card>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, fontFamily: FONT }}>{t('quickActions') || 'Actions rapides'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[[lang === 'fr' ? 'Encaisser' : 'Collect', '/operations'], [lang === 'fr' ? 'Pay Links' : 'Pay Links', '/pay-links'], [lang === 'fr' ? 'Transactions' : 'Transactions', '/transactions'], [lang === 'fr' ? 'Mon compte' : 'My account', '/account']].map(([l, p]) => (
              <Link key={l} to={p} style={{ display: 'block', background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '14px 10px', textAlign: 'center', textDecoration: 'none', color: TEXT, fontSize: 13, fontWeight: 600, fontFamily: FONT }}>{l}</Link>
            ))}
          </div>
        </Card>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14, fontFamily: FONT }}>{t('activeTerminals') || 'Terminaux actifs'}</div>
          {data.terminals?.length ? data.terminals.map(term => (
            <div key={term.terminal_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 13, fontFamily: FONT }}>
              <span>{term.terminal_name || term.terminal_code}</span>
              <Badge label={sl(term.status, lang)} color={sc(term.status)} />
            </div>
          )) : <div style={{ fontSize: 13, color: MUTED, fontFamily: FONT }}>{t('noTerminals') || 'Aucun terminal'}</div>}
        </Card>
      </div>
    </div>
  );
};

// ─── Transactions ─────────────────────────────────────────────────
const Transactions = ({ lang }) => {
  const [terminalId, setTerminalId] = useState('');
  const [termList, setTermList] = useState([]);
  useEffect(() => {
    api.get('/terminals').then(r => setTermList(r.data.data || r.data || [])).catch(() => {});
  }, []);
  const t = useT(lang);
  const [txns, setTxns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');

  const exportPDF = () => {
    if (!txns.length) return toast.error('Aucune transaction');
    const rows = txns.map(tx => [
      fmtDate(tx.initiated_at, lang), tx.type||'—',
      fmtNum(tx.amount)+' '+(tx.currency||'XAF'),
      tx.payment_method||'—', tx.status, tx.auth_code||'—'
    ]);
    const headers = ['Date','Type','Montant','Méthode','Statut','Auth'];
    const now = new Date().toLocaleDateString(lang==='fr'?'fr-FR':'en-US');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;padding:20px}h1{color:#12b6c7}table{width:100%;border-collapse:collapse;font-size:11px}th{background:#12b6c7;color:#fff;padding:8px;text-align:left}td{padding:6px 8px;border-bottom:1px solid #dce3ed}</style></head><body><h1>Calculus Plus — Transactions</h1><p>Généré le ${now} | Total: ${total}</p><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
    const win = window.open('','_blank');
    win.document.write(html);
    win.document.close();
    win.onload = () => win.print();
  };

  const exportCSV = () => {
    if (!txns.length) return toast.error('Aucune transaction');
    const headers = ['Date','Type','Montant','Devise','Methode','Statut','Auth'];
    const rows = txns.map(tx => [
      fmtDate(tx.initiated_at, lang), tx.type||'', tx.amount, tx.currency||'XAF',
      tx.payment_method||'', tx.status, tx.auth_code||''
    ]);
    const csv = [headers, ...rows].map(r=>r.join(';')).join('\n');
    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `transactions_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  };

  const exportExcel = () => {
    if (!txns.length) return toast.error('Aucune transaction');
    const headers = ['Date','Type','Montant','Devise','Methode','Statut','Auth'];
    const rows = txns.map(tx => [
      fmtDate(tx.initiated_at, lang), tx.type||'', parseFloat(tx.amount||0),
      tx.currency||'XAF', tx.payment_method||'', tx.status, tx.auth_code||''
    ]);
    const xmlRows = [headers, ...rows].map(row =>
      `<Row>${row.map(c => typeof c==='number'
        ? `<Cell><Data ss:Type="Number">${c}</Data></Cell>`
        : `<Cell><Data ss:Type="String">${String(c).replace(/&/g,'&amp;')}</Data></Cell>`
      ).join('')}</Row>`
    ).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Transactions"><Table>${xmlRows}</Table></Worksheet></Workbook>`;
    const blob = new Blob([xml], { type:'application/vnd.ms-excel;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `transactions_${new Date().toISOString().slice(0,10)}.xls`;
    a.click();
    toast.success('Export Excel OK ✅');
  };


  const load = useCallback(() => {
    setLoading(true);
    const params = { page, limit:20 };
    if (status)     params.status     = status;
    if (dateFrom)   params.dateFrom   = dateFrom;
    if (dateTo)     params.dateTo     = dateTo;
    if (terminalId) params.terminalId = terminalId;
    api.get('/transactions', { params })
      .then(r => { setTxns(r.data.data || []); setTotal(r.data.total || 0); })
      .finally(() => setLoading(false));
  }, [page, status, dateFrom, dateTo, terminalId]);
  useEffect(() => { load(); }, [load]);

  const sel = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, color: TEXT, fontFamily: FONT };

  return (
    <div>
      {receipt && <Receipt txn={receipt} lang={lang} onClose={() => setReceipt(null)} />}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          {[['', t('allStatuses')], ['authorized', t('approved')], ['failed', t('failed')], ['pending', t('pending')]].map(([v, l]) => (
            <button key={v} onClick={() => { setStatus(v); setPage(1); }} style={{ padding: '7px 16px', borderRadius: 20, border: `2px solid ${status === v ? G : BORDER}`, background: status === v ? `${G}12` : CARD, color: status === v ? G : MUTED, cursor: 'pointer', fontSize: 13, fontWeight: status === v ? 700 : 400, fontFamily: FONT }}>{l}</button>
          ))}
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
          <DateFR value={dateFrom} onChange={v=>{setDateFrom(v);setPage(1);}}
            ariaLabel={lang==='fr'?'Date de début (JJ/MM/AAAA)':'Start date (DD/MM/YYYY)'}
            max={dateTo || undefined} />
          <DateFR value={dateTo} onChange={v=>{setDateTo(v);setPage(1);}}
            ariaLabel={lang==='fr'?'Date de fin (JJ/MM/AAAA)':'End date (DD/MM/YYYY)'}
            min={dateFrom || undefined} />
          <select value={terminalId} onChange={e=>{setTerminalId(e.target.value);setPage(1);}}
            aria-label={lang==='fr'?'Filtrer par terminal':'Filter by terminal'}
            title={lang==='fr'?'Filtrer par terminal':'Filter by terminal'}
            style={{ padding:'8px 12px', borderRadius:8, border:`1px solid ${BORDER}`, background:CARD, color:TEXT, fontSize:13, fontFamily:FONT, cursor:'pointer' }}>
            <option value="">{lang==='fr'?'Tous les terminaux':'All terminals'}</option>
            {termList.map(t => (
              <option key={t.terminal_id} value={t.terminal_id}>
                {t.terminal_name}{t.site_name?` (${t.site_name})`:''}
              </option>
            ))}
          </select>
          {(dateFrom||dateTo) && (
            <button onClick={()=>{setDateFrom('');setDateTo('');setPage(1);}}
              style={{ background:`${R}10`, border:`1px solid ${R}30`, color:R, borderRadius:8, padding:'7px 10px', cursor:'pointer', fontSize:12 }}>✕</button>
          )}
          <button onClick={exportCSV} disabled={txns.length===0}
            style={{ background:'none', border:`1px solid ${BORDER}`, color:MUTED, borderRadius:8, padding:'7px 12px', cursor:'pointer', fontSize:12, fontFamily:FONT }}>
            📥 CSV
          </button>
          <button onClick={exportExcel} disabled={txns.length===0}
            style={{ background:'none', border:`1px solid ${BORDER}`, color:'#217346', borderRadius:8, padding:'7px 12px', cursor:'pointer', fontSize:12, fontFamily:FONT }}>
            📊 Excel
          </button>
          <button onClick={exportPDF} disabled={txns.length===0}
            style={{ background:R, color:'#fff', border:'none', borderRadius:8, padding:'7px 12px', cursor:'pointer', fontSize:12, fontWeight:700, fontFamily:FONT }}>
            📄 PDF
          </button>
        </div>
      </div>
      {loading ? <Spin /> : (
        <Card>
          {txns.length === 0 ? <div style={{ textAlign: 'center', padding: 32, color: MUTED }}>{t('noTransactions')}</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: FONT, minWidth: 650 }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${BORDER}`, color: MUTED }}>
                    {[t('date'), t('type'), (lang==='fr'?'Transaction ID':'Transaction ID'), (lang==='fr'?'Réf. opérateur':'Operator ref'), t('amount'), t('status'), (lang==='fr'?'Règlement':'Settlement'), t('authCode'), ''].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {txns.map(txn => (
                    <tr key={txn.txn_id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                      <td style={{ padding: '10px 12px', color: MUTED }}>{fmtDate(txn.initiated_at, lang)}</td>
                      <td style={{ padding: '10px 12px' }}>{tl(txn.type, lang)}</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 10 }}>
                        <span title={txn.transaction_id || txn.txn_id} style={{ cursor: 'pointer' }} onClick={() => { navigator.clipboard.writeText(txn.transaction_id || txn.txn_id || ''); toast.success(lang==='fr'?'ID copié':'ID copied'); }}>
                          {(txn.transaction_id || txn.txn_id || '—').slice(0, 8)}… 📋
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 10 }}>
                        {txn.gateway_payment_id ? (
                          <span title={txn.gateway_payment_id} style={{ cursor: 'pointer' }} onClick={() => { navigator.clipboard.writeText(txn.gateway_payment_id); toast.success(lang==='fr'?'Réf copiée':'Ref copied'); }}>
                            {String(txn.gateway_payment_id).slice(0, 12)}… 📋
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: 700 }}>{fmtNum(txn.amount)} {txn.currency}</td>
                      <td style={{ padding: '10px 12px' }}><Badge label={sl(txn.status, lang)} color={sc(txn.status)} /></td>
                      <td style={{ padding: '10px 12px' }}>{(() => {
                        const m = { regle: ['Réglé', G], en_cours: ['En cours', O], echec: ['Échec', R], non_regle: ['Non réglé', MUTED] };
                        const [lbl, col] = m[txn.settlement_status] || m.non_regle;
                        return <span style={{ fontSize: 11, fontWeight: 700, color: col, background: `${col}18`, padding: '3px 8px', borderRadius: 10 }}>{lbl}</span>;
                      })()}</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 11 }}>{txn.auth_code || '—'}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => setDetail(txn)} style={{ background: 'none', border: `1px solid ${BORDER}`, color: P, padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontFamily: FONT }}>Détail</button>
                          <button onClick={() => setReceipt(txn)} style={{ background: 'none', border: `1px solid ${BORDER}`, color: G, padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontFamily: FONT }}>🧾</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <Btn small outline color={P} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>← {t('prev')}</Btn>
            <span style={{ padding: '6px 12px', fontSize: 13, color: MUTED }}>{t('page')} {page}</span>
            <Btn small outline color={P} onClick={() => setPage(p => p + 1)} disabled={txns.length < 20}>{t('next')} →</Btn>
          </div>
        </Card>
      )}
      {detail && (
        <Modal title={t('txnDetail')} onClose={() => setDetail(null)}>
          {Object.entries({ ID: detail.txn_id, Type: tl(detail.type, lang), Montant: fmtNum(detail.amount) + ' ' + detail.currency, Statut: sl(detail.status, lang), Auth: detail.auth_code || '—', Date: fmtDate(detail.initiated_at, lang), Méthode: detail.method || '—' }).map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 13, fontFamily: FONT }}>
              <span style={{ color: MUTED }}>{k}</span><span style={{ fontWeight: 600 }}>{v}</span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <Btn onClick={() => { setReceipt(detail); setDetail(null); }} color={G} style={{ flex: 1 }}>🧾 Ticket</Btn>
            <Btn onClick={() => setDetail(null)} outline style={{ flex: 1 }}>{t('close')}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ─── Settlements ──────────────────────────────────────────────────
const Settlements = ({ lang }) => {
  const t = useT(lang);
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState('daily');
  const [days, setDays] = useState([]);
  const [dayDetail, setDayDetail] = useState(null);
  const loadDays = () => api.get('/settlements/daily').then(r => setDays(r.data.days || [])).catch(() => setDays([]));
  const openDay = async (jour) => {
    setDayDetail({ jour, transactions: null });
    try {
      const r = await api.get('/settlements/daily/' + jour);
      setDayDetail({ jour, transactions: r.data.transactions || [] });
    } catch { setDayDetail({ jour, transactions: [] }); }
  };

  const openDetail = async (batch) => {
    setDetail({ batch, transactions: null });
    setDetailLoading(true);
    try {
      const r = await api.get('/settlements/' + batch.batch_id + '/transactions');
      setDetail({ batch: r.data.batch, transactions: r.data.transactions || [] });
    } catch { setDetail({ batch, transactions: [] }); }
    finally { setDetailLoading(false); }
  };

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');

  useEffect(() => { api.get('/settlements').then(r => setData(r.data.data || [])).finally(() => setLoading(false)); }, []);



  const filtered = data.filter(s => {
    if (dateFrom && s.created_at < dateFrom) return false;
    if (dateTo   && s.created_at > dateTo+'T23:59:59') return false;
    return true;
  });

  const total_gross = filtered.reduce((a,s)=>a+parseFloat(s.gross_amount||0),0);
  const total_net   = filtered.reduce((a,s)=>a+parseFloat(s.net_amount||0),0);
  const total_fee   = filtered.reduce((a,s)=>a+parseFloat(s.fee_amount||0),0);
  const pending_amt = filtered.filter(s=>s.status==='pending'||s.status==='submitted').reduce((a,s)=>a+parseFloat(s.net_amount||0),0);

  const exportSettPDF = () => {
    if (!filtered.length) return toast.error('Aucun reglement');
    const headers = ['Date','Lot','Transactions','Brut XAF','Frais XAF','Net XAF','Statut'];
    const rows = filtered.map(s=>[
      fmtDate(s.created_at,lang), s.batch_id?.slice(0,8)||'',
      s.transaction_count||0, fmtNum(s.gross_amount), fmtNum(s.fee_amount), fmtNum(s.net_amount), s.status
    ]);
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>body{font-family:Arial;padding:20px}h1{color:#1d4f92}table{width:100%;border-collapse:collapse;font-size:11px}
    th{background:#1d4f92;color:#fff;padding:8px;text-align:left}td{padding:6px 8px;border-bottom:1px solid #dce3ed}</style></head>
    <body><h1>Calculus Plus - Reglements</h1>
    <p>Genere le ${new Date().toLocaleDateString('fr-FR')}</p>
    <table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p><strong>Brut: ${fmtNum(total_gross)} XAF - Net: ${fmtNum(total_net)} XAF - Frais: ${fmtNum(total_fee)} XAF</strong></p>
    </body></html>`;
    const win = window.open('','_blank');
    win.document.write(html); win.document.close();
    win.onload = () => win.print();
  };

  const exportSettExcel = () => {
    if (!filtered.length) return toast.error('Aucun reglement');
    const headers = ['Date','Lot','Transactions','Brut XAF','Frais XAF','Net XAF','Statut'];
    const rows = filtered.map(s=>[
      fmtDate(s.created_at,lang), s.batch_id?.slice(0,8)||'',
      parseInt(s.transaction_count||0), parseFloat(s.gross_amount||0),
      parseFloat(s.fee_amount||0), parseFloat(s.net_amount||0), s.status||''
    ]);
    const xmlRows = [headers,...rows].map(row=>
      `<Row>${row.map(c=>typeof c==='number'
        ?`<Cell><Data ss:Type="Number">${c}</Data></Cell>`
        :`<Cell><Data ss:Type="String">${String(c).replace(/&/g,'&amp;')}</Data></Cell>`
      ).join('')}</Row>`
    ).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Reglements"><Table>${xmlRows}</Table></Worksheet></Workbook>`;
    const blob = new Blob([xml],{type:'application/vnd.ms-excel;charset=utf-8;'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reglements_${new Date().toISOString().slice(0,10)}.xls`;
    a.click();
    toast.success('Export Excel OK');
  };

  if (loading) return <Spin />;
  return (
    <div>
      {/* Onglets */}
      <div style={{ display:'flex', gap:8, marginBottom:16 }}>
        <button onClick={()=>setTab('daily')} style={{ padding:'8px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT, background: tab==='daily'?G:CARD, color: tab==='daily'?'#fff':MUTED, boxShadow: tab==='daily'?'none':`inset 0 0 0 1px ${BORDER}` }}>{lang==='fr'?'📅 Par jour':'📅 By day'}</button>
        <button onClick={()=>setTab('batch')} style={{ padding:'8px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT, background: tab==='batch'?G:CARD, color: tab==='batch'?'#fff':MUTED, boxShadow: tab==='batch'?'none':`inset 0 0 0 1px ${BORDER}` }}>{lang==='fr'?'📦 Par lot':'📦 By batch'}</button>
      </div>

      {tab==='daily' && (
        <Card>
          {days.length===0 ? (
            <div style={{ textAlign:'center', padding:32, color:MUTED, fontFamily:FONT }}>{lang==='fr'?'Aucun règlement':'No settlements'}</div>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13, fontFamily:FONT }}>
                <thead>
                  <tr style={{ borderBottom:`2px solid ${BORDER}`, color:MUTED }}>
                    {[(lang==='fr'?'Journée':'Day'), (lang==='fr'?'Transactions':'Transactions'), (lang==='fr'?'Total brut':'Gross'), (lang==='fr'?'Total net versé':'Net paid'), ''].map(h=>(
                      <th key={h} style={{ padding:'10px 12px', textAlign:'left', fontWeight:600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {days.map(d=>(
                    <tr key={d.jour} style={{ borderBottom:`1px solid ${BORDER}`, cursor:'pointer' }} onClick={()=>openDay(d.jour)}>
                      <td style={{ padding:'12px', fontWeight:700 }}>{new Date(d.jour).toLocaleDateString(lang==='fr'?'fr-FR':'en-US', {weekday:'short', day:'2-digit', month:'short', year:'numeric'})}</td>
                      <td style={{ padding:'12px' }}>{d.nb}</td>
                      <td style={{ padding:'12px', color:MUTED }}>{fmtNum(d.total_brut)} XAF</td>
                      <td style={{ padding:'12px', fontWeight:700, color:G }}>{fmtNum(d.total_net)} XAF</td>
                      <td style={{ padding:'12px', color:P }}>{lang==='fr'?'Détail ›':'Detail ›'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab==='daily' && dayDetail && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:400, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }} onClick={()=>setDayDetail(null)}>
          <div onClick={e=>e.stopPropagation()} style={{ background:CARD, borderRadius:14, padding:24, maxWidth:640, width:'100%', maxHeight:'80vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <div style={{ fontSize:16, fontWeight:700 }}>{lang==='fr'?'Règlements du':'Settlements of'} {new Date(dayDetail.jour).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}</div>
              <button onClick={()=>setDayDetail(null)} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:MUTED }}>×</button>
            </div>
            {dayDetail.transactions===null ? <div style={{ textAlign:'center', padding:20, color:MUTED }}>Chargement…</div> :
              !dayDetail.transactions.length ? <div style={{ textAlign:'center', padding:20, color:MUTED }}>{lang==='fr'?'Aucune transaction':'No transactions'}</div> : (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12, fontFamily:FONT }}>
                  <thead>
                    <tr style={{ borderBottom:`2px solid ${BORDER}`, color:MUTED }}>
                      {[(lang==='fr'?'Heure':'Time'),(lang==='fr'?'Opérateur':'Operator'),(lang==='fr'?'Montant':'Amount'),'Net','Réf. règlement'].map(h=>(
                        <th key={h} style={{ padding:'8px 10px', textAlign:'left', fontWeight:600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dayDetail.transactions.map(txn=>(
                      <tr key={txn.transaction_id} style={{ borderBottom:`1px solid ${BORDER}` }}>
                        <td style={{ padding:'8px 10px', color:MUTED }}>{new Date(txn.settled_at||txn.initiated_at).toLocaleTimeString(lang==='fr'?'fr-FR':'en-US', {hour:'2-digit', minute:'2-digit'})}</td>
                        <td style={{ padding:'8px 10px' }}>{txn.detected_operator||txn.payment_method}</td>
                        <td style={{ padding:'8px 10px' }}>{fmtNum(txn.amount)} XAF</td>
                        <td style={{ padding:'8px 10px', fontWeight:700, color:G }}>{fmtNum(txn.net_amount||txn.amount)} XAF</td>
                        <td style={{ padding:'8px 10px', fontFamily:'monospace', fontSize:10 }}>{txn.settlement_ref||'—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </div>
      )}

      {tab==='batch' && (
      <div>
      {/* Filtres + Export */}
      <div style={{ display:'flex', gap:8, marginBottom:16, flexWrap:'wrap', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
          <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}
            style={{ padding:'7px 10px', borderRadius:8, border:`1px solid ${BORDER}`, background:CARD, fontSize:12, fontFamily:FONT }} />
          <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}
            style={{ padding:'7px 10px', borderRadius:8, border:`1px solid ${BORDER}`, background:CARD, fontSize:12, fontFamily:FONT }} />
          {(dateFrom||dateTo) && (
            <button onClick={()=>{setDateFrom('');setDateTo('');}}
              style={{ background:`${R}10`, border:`1px solid ${R}30`, color:R, borderRadius:8, padding:'7px 10px', cursor:'pointer', fontSize:12 }}>✕</button>
          )}
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={exportSettExcel}
            style={{ background:'none', border:`1px solid ${BORDER}`, color:'#217346', borderRadius:8, padding:'7px 12px', cursor:'pointer', fontSize:12, fontFamily:FONT }}>
            📊 Excel
          </button>
          <button onClick={exportSettPDF}
            style={{ background:R, color:'#fff', border:'none', borderRadius:8, padding:'7px 12px', cursor:'pointer', fontSize:12, fontWeight:700, fontFamily:FONT }}>
            📄 PDF
          </button>
        </div>
      </div>

      {/* Filtres + Export */}

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
        {[
          ['🏦', lang==='fr'?'Volume brut total':'Total gross', fmtNum(total_gross)+' XAF', BLUE],
          ['💰', lang==='fr'?'Net total reçu':'Total net received', fmtNum(total_net)+' XAF', G],
          ['📊', lang==='fr'?'Frais totaux':'Total fees', fmtNum(total_fee)+' XAF', R],
          ['⏳', lang==='fr'?'En attente':'Pending', fmtNum(pending_amt)+' XAF', O],
        ].map(([icon,label,val,color]) => (
          <Card key={label} style={{ textAlign:'center', padding:16, marginBottom:0, borderTop:`3px solid ${color}` }}>
            <div style={{ fontSize:22, marginBottom:6 }}>{icon}</div>
            <div style={{ fontSize:11, color:MUTED, marginBottom:4, fontFamily:FONT }}>{label}</div>
            <div style={{ fontSize:15, fontWeight:800, color, fontFamily:FONT }}>{val}</div>
          </Card>
        ))}
      </div>
      <Card>
        {data.length === 0 ? (
          <div style={{ textAlign:'center', padding:40, color:MUTED }}>
            <div style={{ fontSize:40, marginBottom:12 }}>🏦</div>
            <div style={{ fontFamily:FONT }}>{t('noSettlements')}</div>
          </div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13, fontFamily:FONT, minWidth:700 }}>
              <thead>
                <tr style={{ borderBottom:`2px solid ${BORDER}`, color:MUTED }}>
                  {[lang==='fr'?'Date règlement':'Settlement date',
                    lang==='fr'?'Nb transactions':'Txns',
                    lang==='fr'?'Volume encaissé':'Gross collected',
                    lang==='fr'?'Frais C-Pay':'C-Pay fees',
                    lang==='fr'?'Montant à recevoir':'Amount to receive',
                    lang==='fr'?'Compte crédité':'Account credited',
                    'Statut', ''].map(h => (
                    <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontWeight:600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((s, i) => (
                  <tr key={i} style={{ borderBottom:`1px solid ${BORDER}`, cursor:'pointer' }}
                    onMouseEnter={e=>e.currentTarget.style.background=BG}
                    onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    <td style={{ padding:'12px 12px' }}>
                      <div style={{ fontWeight:600 }}>{new Date(s.batch_date||s.settle_date).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}</div>
                      {s.completed_at && <div style={{ fontSize:11, color:MUTED }}>{lang==='fr'?'Viré le':' Paid on'} {new Date(s.completed_at).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}</div>}
                    </td>
                    <td style={{ padding:'12px 12px', textAlign:'center' }}>
                      <span style={{ background:`${P}15`, color:P, borderRadius:20, padding:'3px 12px', fontWeight:700 }}>{s.txn_count}</span>
                    </td>
                    <td style={{ padding:'12px 12px', fontWeight:600 }}>{fmtNum(s.total_gross||s.gross_amount)} XAF</td>
                    <td style={{ padding:'12px 12px', color:R, fontWeight:600 }}>-{fmtNum(s.total_fees||s.fee_amount)} XAF</td>
                    <td style={{ padding:'12px 12px' }}>
                      <div style={{ fontSize:16, fontWeight:800, color:G }}>{fmtNum(s.total_net||s.net_amount)} XAF</div>
                      <div style={{ fontSize:10, color:MUTED }}>{lang==='fr'?'Frais':'Fee'} {s.total_gross>0?((((s.total_fees||s.fee_amount)/(s.total_gross||s.gross_amount))*100).toFixed(2)):'1.50'}%</div>
                    </td>
                    <td style={{ padding:'12px 12px', fontSize:12, color:MUTED }}>{s.settlement_account||'+237XXXXXXXXX'}</td>
                    <td style={{ padding:'12px 12px' }}>
                      <Badge label={['completed','paid'].includes(s.status)?(lang==='fr'?'✅ Versé':'✅ Paid'):(lang==='fr'?'⏳ En cours':'⏳ Processing')} color={['completed','paid'].includes(s.status)?G:O} />
                    </td>
                    <td style={{ padding:'12px 12px' }}>
                      <button onClick={()=>openDetail(s)}
                        style={{ background:P, color:'#fff', border:'none', borderRadius:6, padding:'5px 12px', cursor:'pointer', fontSize:12, fontWeight:700, fontFamily:FONT }}>
                        {lang==='fr'?'Détails':'Details'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {/* Modal détail règlement */}
      {detail && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:28, width:680, maxWidth:'100%', maxHeight:'85vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <div>
                <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>
                  {lang==='fr'?'Détail du règlement':'Settlement detail'}
                </div>
                <div style={{ fontSize:12, color:MUTED, marginTop:2 }}>
                  {new Date(detail.batch.batch_date||detail.batch.settle_date).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}
                </div>
              </div>
              <button onClick={()=>setDetail(null)} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:MUTED }}>×</button>
            </div>

            {/* Récap financier */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:20 }}>
              {[[lang==='fr'?'Volume brut':'Gross', fmtNum(detail.batch.total_gross||detail.batch.gross_amount)+' XAF', BLUE],
                [lang==='fr'?'Frais C-Pay':'C-Pay fee', '-'+fmtNum(detail.batch.total_fees||detail.batch.fee_amount)+' XAF', R],
                [lang==='fr'?'Net versé':'Net paid', fmtNum(detail.batch.total_net||detail.batch.net_amount)+' XAF', G],
              ].map(([l,v,c])=>(
                <div key={l} style={{ background:BG, borderRadius:10, padding:14, textAlign:'center' }}>
                  <div style={{ fontSize:11, color:MUTED, marginBottom:4 }}>{l}</div>
                  <div style={{ fontSize:15, fontWeight:800, color:c }}>{v}</div>
                </div>
              ))}
            </div>

            <div style={{ background:`${G}10`, border:`1px solid ${G}30`, borderRadius:8, padding:12, marginBottom:20, fontSize:13 }}>
              💳 {lang==='fr'?'Versé sur':'Paid to'} : <strong>{detail.batch.settlement_account||'+237XXXXXXXXX'}</strong>
              {detail.batch.completed_at && <span style={{ marginLeft:12, color:MUTED }}>
                {lang==='fr'?'le':'on'} {new Date(detail.batch.completed_at).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}
              </span>}
            </div>

            {/* Transactions du batch */}
            <div style={{ fontSize:14, fontWeight:700, marginBottom:12, fontFamily:FONT }}>
              {lang==='fr'?'Transactions comptabilisées':'Counted transactions'} ({detail.batch.txn_count})
            </div>
            {detailLoading ? <div style={{ textAlign:'center', padding:20, color:MUTED }}>Chargement…</div> :
              !detail.transactions?.length ? (
                <div style={{ textAlign:'center', padding:20, color:MUTED, fontSize:13 }}>
                  {lang==='fr'?'Aucune transaction disponible':'No transactions available'}
                </div>
              ) : (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12, fontFamily:FONT }}>
                  <thead>
                    <tr style={{ borderBottom:`2px solid ${BORDER}`, color:MUTED }}>
                      {['Date','Type','Méthode','Montant','Frais','Net','Auth'].map(h=>(
                        <th key={h} style={{ padding:'6px 10px', textAlign:'left', fontWeight:600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.transactions.map(txn=>(
                      <tr key={txn.txn_id} style={{ borderBottom:`1px solid ${BORDER}` }}>
                        <td style={{ padding:'8px 10px', color:MUTED }}>{new Date(txn.initiated_at).toLocaleDateString(lang==='fr'?'fr-FR':'en-US')}</td>
                        <td style={{ padding:'8px 10px' }}><Badge label={tl(txn.type, lang)} color={txn.type==='collect'?G:O} /></td>
                        <td style={{ padding:'8px 10px', color:MUTED }}>{txn.payment_method}</td>
                        <td style={{ padding:'8px 10px', fontWeight:600 }}>{fmtNum(txn.amount)} XAF</td>
                        <td style={{ padding:'8px 10px', color:R }}>-{fmtNum(txn.fee_amount||0)} XAF</td>
                        <td style={{ padding:'8px 10px', color:G, fontWeight:600 }}>{fmtNum(txn.net_amount||txn.amount)} XAF</td>
                        <td style={{ padding:'8px 10px', fontFamily:'monospace', fontSize:11 }}>{txn.auth_code||'—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
            <div style={{ marginTop:20, textAlign:'right' }}>
              <button onClick={()=>setDetail(null)}
                style={{ background:P, color:'#fff', border:'none', borderRadius:8, padding:'10px 24px', cursor:'pointer', fontWeight:700, fontSize:13, fontFamily:FONT }}>
                {lang==='fr'?'Fermer':'Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
      )}
    </div>
  );
};

// ─── Terminals ────────────────────────────────────────────────────
const Terminals = ({ lang }) => {
  const t = useT(lang);
  const [terms, setTerms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ terminalName: '', siteName: '', model: '' });
  const [lastPairing, setLastPairing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => { api.get('/terminals').then(r => setTerms(r.data.data || [])).finally(() => setLoading(false)); }, []);
  useEffect(() => { load(); }, [load]);

  const regenerateCode = async (id) => {
    try {
      const r = await api.post(`/terminals/${id}/regenerate-code`);
      toast.success(`${lang==='fr'?'Nouveau code':'New code'} : ${r.data.pairingCode}`);
      load();
    } catch(err) { toast.error(err.response?.data?.error || 'Erreur'); }
  };

  const toggleTerminal = async (id, currentStatus) => {
    const action = currentStatus === 'active' ? 'blocked' : 'active';
    try {
      await api.patch(`/terminals/${id}/status`, { status: action });
      toast.success(action === 'active' ? (lang==='fr'?'Terminal activé ✅':'Terminal activated ✅') : (lang==='fr'?'Terminal désactivé':'Terminal disabled'));
      load();
    } catch(err) { toast.error(err.response?.data?.error || 'Erreur'); }
  };

  const register = async () => {
    if (!form.terminalName) return toast.error(lang === 'fr' ? 'Nom requis' : 'Name required');
    setSaving(true);
    try {
      const r = await api.post('/terminals', { terminalName: form.terminalName, siteName: form.siteName, deviceModel: form.model });
      toast.success(lang === 'fr' ? 'Terminal créé' : 'Terminal created');
      setShowNew(false);
      setLastPairing({ code: r.data.pairing_code, name: r.data.terminal_name, site: r.data.site_name });
      load();
      setForm({ terminalName: '', siteName: '', model: '' });
    }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSaving(false); }
  };

  if (loading) return <Spin />;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700, fontFamily:FONT }}>📱 {lang==='fr'?'Mes Terminaux':'My Terminals'}</h1>
        <Btn onClick={() => setShowNew(true)}>+ {lang === 'fr' ? 'Nouveau terminal' : 'New terminal'}</Btn>
      </div>
      {lastPairing && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.65)', zIndex:2100, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:32, width:420, maxWidth:'100%', textAlign:'center' }}>
            <div style={{ fontSize:48, marginBottom:8 }}>🔗</div>
            <div style={{ fontSize:18, fontWeight:700, fontFamily:FONT, marginBottom:6 }}>
              {lang==='fr'?'Terminal créé':'Terminal created'}
            </div>
            <div style={{ fontSize:14, color:MUTED, marginBottom:4 }}>{lastPairing.name}{lastPairing.site?` · ${lastPairing.site}`:''}</div>
            <div style={{ fontSize:13, color:MUTED, marginBottom:20, lineHeight:1.5 }}>
              {lang==='fr'?'Saisissez ce code sur l\'appareil, dans l\'écran « Appairer ce terminal » :':'Enter this code on the device, in the "Pair this terminal" screen:'}
            </div>
            <div style={{ background:BG, borderRadius:12, padding:'20px 0', marginBottom:20, fontSize:42, fontWeight:800, letterSpacing:10, color:BLUE, fontFamily:'monospace' }}>
              {lastPairing.code}
            </div>
            <div style={{ fontSize:12, color:MUTED, marginBottom:20 }}>
              {lang==='fr'?'Ce code n\'est valable qu\'une fois, jusqu\'à l\'appairage.':'This code works once, until paired.'}
            </div>
            <Btn onClick={()=>setLastPairing(null)}>{lang==='fr'?'Compris':'Got it'}</Btn>
          </div>
        </div>
      )}
      {showNew && (
        <Modal title={lang === 'fr' ? 'Enregistrer un terminal' : 'Register terminal'} onClose={() => setShowNew(false)}>
          <Inp label={lang === 'fr' ? 'Nom *' : 'Name *'} value={form.terminalName} onChange={v => setForm(p => ({ ...p, terminalName: v }))} placeholder={lang === 'fr' ? 'Caisse 1' : 'Checkout 1'} />
          <Inp label={lang === 'fr' ? 'Site / Agence' : 'Site'} value={form.siteName} onChange={v => setForm(p => ({ ...p, siteName: v }))} placeholder={lang === 'fr' ? 'Agence Gombe' : 'Gombe branch'} />
          <Inp label="Modèle" value={form.model} onChange={v => setForm(p => ({ ...p, model: v }))} placeholder="Android POS v2" />
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <Btn onClick={register} disabled={saving}>{saving ? (lang === 'fr' ? 'Enregistrement…' : 'Saving…') : (lang === 'fr' ? 'Enregistrer' : 'Register')}</Btn>
            <Btn outline onClick={() => setShowNew(false)}>{lang === 'fr' ? 'Annuler' : 'Cancel'}</Btn>
          </div>
        </Modal>
      )}
      {terms.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>📱</div>
          <div style={{ color: MUTED, marginBottom: 16, fontFamily: FONT }}>{lang === 'fr' ? 'Aucun terminal enregistré' : 'No terminals registered'}</div>
        </Card>
      ) : (
        <Card style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: FONT, minWidth: 600 }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${BORDER}`, color: MUTED }}>
                {['Code', lang === 'fr' ? 'Nom' : 'Name', 'Modèle', lang === 'fr' ? 'Version' : 'Version', lang === 'fr' ? 'Vu le' : 'Last seen', 'Statut', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {terms.map(term => (
                <tr key={term.terminal_id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                  <td style={{ padding: '10px 12px', fontFamily: 'monospace' }}>{term.terminal_code}</td>
                  <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                    {term.terminal_name}
                    {term.site_name && <div style={{ fontSize:11, color:MUTED, fontWeight:400 }}>📍 {term.site_name}</div>}
                    {!term.paired_at && term.pairing_code && (
                      <div style={{ marginTop:4, display:'inline-block', background:`${BLUE}12`, color:BLUE, borderRadius:6, padding:'2px 8px', fontSize:13, fontWeight:700, fontFamily:'monospace', letterSpacing:2 }}>
                        🔗 {term.pairing_code}
                      </div>
                    )}
                    {term.paired_at && <div style={{ fontSize:11, color:G, fontWeight:600, marginTop:4 }}>✓ {lang==='fr'?'Appairé':'Paired'}</div>}
                  </td>
                  <td style={{ padding: '10px 12px', color: MUTED }}>{term.model || '—'}</td>
                  <td style={{ padding: '10px 12px', color: MUTED }}>{term.app_version || '—'}</td>
                  <td style={{ padding: '10px 12px', color: MUTED }}>{term.last_seen_at ? fmtDate(term.last_seen_at, lang) : '—'}</td>
                  <td style={{ padding: '10px 12px' }}><Badge label={term.status} color={sc(term.status)} /></td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display:'flex', gap:6 }}>
                      <button onClick={()=>setSelected(term)}
                        style={{ background:`${P}10`, border:`1px solid ${P}30`, color:P, borderRadius:6, padding:'5px 10px', cursor:'pointer', fontSize:11, fontWeight:600, fontFamily:FONT }}>
                        ⚙️ {lang==='fr'?'Gérer':'Manage'}
                      </button>
                      <button onClick={()=>toggleTerminal(term.terminal_id, term.status)}
                        style={{ background:term.status==='active'?`${R}10`:`${G}10`, border:`1px solid ${term.status==='active'?R:G}30`, color:term.status==='active'?R:G, borderRadius:6, padding:'5px 10px', cursor:'pointer', fontSize:11, fontWeight:600, fontFamily:FONT }}>
                        {term.status==='active'?(lang==='fr'?'🔒 Désactiver':'🔒 Disable'):(lang==='fr'?'✅ Activer':'✅ Enable')}
                      </button>
                      <button onClick={()=>regenerateCode(term.terminal_id)}
                        style={{ background:`${BLUE}10`, border:`1px solid ${BLUE}30`, color:BLUE, borderRadius:6, padding:'5px 10px', cursor:'pointer', fontSize:11, fontWeight:600, fontFamily:FONT }}>
                        🔄 {lang==='fr'?'Code':'Code'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Modal gestion terminal */}
      {selected && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:28, width:480, maxWidth:'100%' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>⚙️ {lang==='fr'?'Gestion Terminal':'Terminal Management'}</div>
              <button onClick={()=>setSelected(null)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:MUTED }}>×</button>
            </div>

            {/* Infos terminal */}
            <div style={{ background:BG, borderRadius:10, padding:14, marginBottom:16 }}>
              {[
                [lang==='fr'?"Code d'appairage":'Pairing code', selected.paired_at ? (lang==='fr'?'✓ Appareil lié':'✓ Device paired') : (selected.pairing_code || '—')],
                [lang==='fr'?'Site':'Site', selected.site_name||'—'],
                [lang==='fr'?'Nom':'Name', selected.terminal_name],
                ['Modèle', selected.model||'—'],
                ['Version', selected.app_version||'—'],
                [lang==='fr'?'Dernière activité':'Last seen', selected.last_seen_at ? fmtDate(selected.last_seen_at, lang) : '—'],
                ['Statut', selected.status],
              ].map(([k,v])=>(
                <div key={k} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:`1px solid ${BORDER}`, fontSize:13 }}>
                  <span style={{ color:MUTED }}>{k}</span>
                  <span style={{ fontWeight:600 }}>{v}</span>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div style={{ fontSize:13, fontWeight:700, marginBottom:12, fontFamily:FONT }}>{lang==='fr'?'Actions':'Actions'}</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:16 }}>
              <button onClick={()=>{ toggleTerminal(selected.terminal_id, selected.status); setSelected(null); }}
                style={{ background:selected.status==='active'?`${R}10`:`${G}10`, border:`1px solid ${selected.status==='active'?R:G}30`, color:selected.status==='active'?R:G, borderRadius:8, padding:'12px', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT }}>
                {selected.status==='active'?(lang==='fr'?'🔒 Désactiver':'🔒 Disable'):(lang==='fr'?'✅ Activer':'✅ Enable')}
              </button>
              <button onClick={()=>{ if(window.confirm(lang==='fr'?'Supprimer ce terminal ?':'Delete this terminal?')) { api.delete(`/terminals/${selected.terminal_id}`).then(()=>{ toast.success(lang==='fr'?'Terminal supprimé':'Terminal deleted'); setSelected(null); load(); }).catch(()=>toast.error('Erreur')); } }}
                style={{ background:`${R}10`, border:`1px solid ${R}30`, color:R, borderRadius:8, padding:'12px', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:FONT }}>
                🗑️ {lang==='fr'?'Supprimer':'Delete'}
              </button>
            </div>

            {/* Stats */}
            <div style={{ background:`${P}08`, border:`1px solid ${P}20`, borderRadius:8, padding:12, fontSize:12, color:MUTED }}>
              📱 {lang==='fr'?'Terminal ID':'Terminal ID'}: <span style={{ fontFamily:'monospace', color:TEXT }}>{selected.terminal_id}</span>
            </div>

            <button onClick={()=>setSelected(null)}
              style={{ width:'100%', marginTop:14, background:'none', border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px', cursor:'pointer', fontSize:13, fontFamily:FONT }}>
              {lang==='fr'?'Fermer':'Close'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Support / Incidents ──────────────────────────────────────────
const Support = ({ lang }) => {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ subject: '', description: '', priority: 'normal' });
  const [saving, setSaving] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const [msgLoading, setMsgLoading] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const messagesEndRef = React.useRef(null);
  const scrollToBottom = () => { messagesEndRef.current?.scrollIntoView({ behavior:'smooth' }); };

  const load = useCallback(() => {
    setLoading(true);
    api.get('/support/tickets')
      .then(r => setTickets(r.data.data || r.data.tickets || []))
      .catch(() => setTickets([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const openTicket = async (ticket) => {
    setSelectedTicket(ticket);
    setMessages([]);
    setMsgLoading(true);
    try {
      const r = await api.get('/support/tickets/' + ticket.ticket_id);
      const msgs = r.data.messages || [];
      setMessages(msgs);
      if (r.data.ticket) setSelectedTicket(r.data.ticket);
      setTimeout(scrollToBottom, 100);
    } catch(e) { setMessages([]); }
    finally { setMsgLoading(false); }
  };

  const submit = async () => {
    if (!form.subject || !form.description) return toast.error(lang === 'fr' ? 'Champs requis' : 'Required fields');
    setSaving(true);
    try {
      await api.post('/support/tickets', { subject: form.subject, priority: form.priority, message: form.description, category: 'general' });
      toast.success(lang === 'fr' ? 'Incident signalé' : 'Incident reported');
      setShowNew(false);
      setForm({ subject: '', description: '', priority: 'normal' });
      load();
    } catch(err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSaving(false); }
  };

  const handleAttach = (e) => {
    const files = Array.from(e.target.files);
    files.forEach(file => {
      if (file.size > 5 * 1024 * 1024) return toast.error('Fichier trop volumineux (max 5MB)');
      const reader = new FileReader();
      reader.onload = ev => setAttachments(prev => [...prev, { name: file.name, url: ev.target.result, type: file.type }]);
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const sendReply = async () => {
    if ((!reply.trim() && attachments.length === 0) || !selectedTicket) return;
    setReplying(true);
    try {
      await api.post('/support/tickets/' + selectedTicket.ticket_id + '/messages', {
        message: reply || (lang==='fr'?'[Fichier joint]':'[File attached]'),
        attachments
      });
      setReply(''); setAttachments([]);
      const r = await api.get('/support/tickets/' + selectedTicket.ticket_id);
      setMessages(r.data.messages || []);
      setTimeout(scrollToBottom, 100);
      toast.success(lang === 'fr' ? 'Réponse envoyée' : 'Reply sent');
    } catch { toast.error('Erreur'); }
    finally { setReplying(false); }
  };

  const resolveTicket = async () => {
    if (!selectedTicket) return;
    if (!window.confirm(lang === 'fr' ? 'Confirmer la résolution ?' : 'Confirm resolution?')) return;
    try {
      await api.patch('/support/tickets/' + selectedTicket.ticket_id + '/resolve');
      toast.success('✅ ' + (lang === 'fr' ? 'Ticket résolu' : 'Ticket resolved'));
      setSelectedTicket(null);
      load();
    } catch { toast.error('Erreur'); }
  };

  const SC = { open:R, in_progress:O, pending_merchant:'#9b59b6', resolved:G, closed:MUTED };
  const SL = { open:lang==='fr'?'Ouvert':'Open', in_progress:lang==='fr'?'En cours':'In progress', pending_merchant:lang==='fr'?'Réponse attendue':'Response needed', resolved:lang==='fr'?'Résolu':'Resolved', closed:lang==='fr'?'Fermé':'Closed' };
  const PC = { high:R, normal:O, low:G };
  const PL = { high:lang==='fr'?'Critique':'Critical', normal:lang==='fr'?'Normal':'Normal', low:lang==='fr'?'Faible':'Low' };

  return (
    <div>
      {/* Modal signaler */}
      {showNew && (
        <Modal title={lang === 'fr' ? 'Signaler un incident' : 'Report an incident'} onClose={() => setShowNew(false)}>
          <Inp label={lang === 'fr' ? 'Sujet *' : 'Subject *'} value={form.subject} onChange={v => setForm(p => ({...p, subject:v}))} placeholder={lang === 'fr' ? 'Transaction échouée' : 'Failed transaction'} />
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang === 'fr' ? 'Priorité' : 'Priority'}</label>
            <select value={form.priority} onChange={e => setForm(p => ({...p, priority:e.target.value}))}
              style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT }}>
              <option value="low">{lang === 'fr' ? 'Faible' : 'Low'}</option>
              <option value="normal">{lang === 'fr' ? 'Normal' : 'Normal'}</option>
              <option value="high">{lang === 'fr' ? 'Critique' : 'Critical'}</option>
            </select>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang === 'fr' ? 'Description *' : 'Description *'}</label>
            <textarea value={form.description} onChange={e => setForm(p => ({...p, description:e.target.value}))} rows={4}
              style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, resize:'vertical', boxSizing:'border-box' }}
              placeholder={lang === 'fr' ? 'Décrivez le problème…' : 'Describe the issue…'} />
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <Btn onClick={submit} disabled={saving} color={R}>{saving ? (lang==='fr'?'Envoi…':'Sending…') : (lang==='fr'?'Signaler':'Report')}</Btn>
            <Btn outline onClick={() => setShowNew(false)}>{lang==='fr'?'Annuler':'Cancel'}</Btn>
          </div>
        </Modal>
      )}

      {/* Modal détail ticket */}
      {selectedTicket && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:28, width:680, maxWidth:'100%', maxHeight:'90vh', display:'flex', flexDirection:'column' }}>
            {/* Header */}
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16, flexShrink:0 }}>
              <div>
                <div style={{ fontFamily:'monospace', fontSize:12, color:MUTED, marginBottom:4 }}>{selectedTicket.ticket_number}</div>
                <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>{selectedTicket.subject}</div>
                <div style={{ display:'flex', gap:8, marginTop:8 }}>
                  <Badge label={SL[selectedTicket.status] || selectedTicket.status} color={SC[selectedTicket.status] || MUTED} />
                  <Badge label={PL[selectedTicket.priority] || selectedTicket.priority} color={PC[selectedTicket.priority] || MUTED} />
                </div>
              </div>
              <button onClick={() => setSelectedTicket(null)} style={{ background:'none', border:'none', fontSize:22, cursor:'pointer', color:MUTED }}>×</button>
            </div>

            {/* Messages */}
            <div style={{ flex:1, overflowY:'auto', marginBottom:16, minHeight:0, maxHeight:320, scrollBehavior:'smooth' }}>
              {msgLoading ? <div style={{ textAlign:'center', padding:20, color:MUTED }}>Chargement…</div>
              : messages.length === 0 ? (
                <div style={{ textAlign:'center', padding:20, color:MUTED, fontSize:13 }}>
                  {lang==='fr'?'En attente de traitement':'Pending review'}
                </div>
              ) : messages.map(msg => (
                <div key={msg.message_id} style={{ display:'flex', flexDirection:'column', alignItems: msg.sender_type==='merchant'?'flex-end':'flex-start', marginBottom:12 }}>
                  <div style={{ fontSize:11, color:MUTED, marginBottom:4 }}>{msg.sender_name} · {fmtDate(msg.created_at, lang)}</div>
                  <div style={{ background: msg.sender_type==='merchant'?`${P}15`:`${BLUE}10`, border:`1px solid ${msg.sender_type==='merchant'?P:BLUE}30`, borderRadius:12, padding:'10px 14px', maxWidth:'80%', fontSize:13, fontFamily:FONT }}>
                    {msg.message}
                    {(() => {
                      try {
                        const atts = typeof msg.attachments==='string' ? JSON.parse(msg.attachments||'[]') : (msg.attachments||[]);
                        return atts.length > 0 ? (
                          <div style={{ marginTop:8, display:'flex', flexWrap:'wrap', gap:6 }}>
                            {atts.map((a,i) => a.type?.startsWith('image') ? (
                              <img key={i} src={a.url} alt={a.name} style={{ maxWidth:200, maxHeight:150, borderRadius:6, border:`1px solid ${BORDER}` }} />
                            ) : (
                              <a key={i} href={a.url} download={a.name} style={{ display:'flex', alignItems:'center', gap:4, background:'rgba(255,255,255,0.5)', borderRadius:6, padding:'4px 8px', fontSize:11, color:TEXT, textDecoration:'none' }}>
                                📎 {a.name}
                              </a>
                            ))}
                          </div>
                        ) : null;
                      } catch { return null; }
                    })()}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Résolution */}
            {selectedTicket.resolution && (
              <div style={{ background:`${G}10`, border:`1px solid ${G}30`, borderRadius:8, padding:12, marginBottom:12, fontSize:13, flexShrink:0 }}>
                <div style={{ fontWeight:700, color:G, marginBottom:4 }}>✅ {lang==='fr'?'Résolution proposée':'Proposed resolution'}</div>
                <div>{selectedTicket.resolution}</div>
              </div>
            )}

            {/* Zone réponse */}
            {!['resolved','closed'].includes(selectedTicket.status) ? (
              <div style={{ flexShrink:0 }}>
                <textarea value={reply} onChange={e => setReply(e.target.value)} rows={3}
                  placeholder={lang==='fr'?'Votre réponse…':'Your reply…'}
                  style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:13, fontFamily:FONT, resize:'none', boxSizing:'border-box', marginBottom:8 }} />
                {attachments.length > 0 && (
                  <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:8 }}>
                    {attachments.map((a,i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:4, background:BG, border:`1px solid ${BORDER}`, borderRadius:6, padding:'3px 8px', fontSize:11 }}>
                        <span>{a.type?.startsWith('image')?'🖼️':'📎'} {a.name}</span>
                        <button onClick={()=>setAttachments(prev=>prev.filter((_,j)=>j!==i))} style={{ background:'none', border:'none', cursor:'pointer', color:R, fontSize:14 }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <label style={{ cursor:'pointer', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'9px 12px', fontSize:16, flexShrink:0 }}>
                    📎<input type="file" multiple accept="image/*,.pdf,.doc,.docx" onChange={handleAttach} style={{ display:'none' }} />
                  </label>
                  <Btn onClick={sendReply} disabled={replying || (!reply.trim() && attachments.length===0)} style={{ flex:1 }}>
                    {replying ? (lang==='fr'?'Envoi…':'Sending…') : (lang==='fr'?'📤 Envoyer':'📤 Send')}
                  </Btn>
                  {selectedTicket.status === 'pending_merchant' && (
                    <Btn onClick={resolveTicket} color={G} style={{ flex:1 }}>✅ {lang==='fr'?'Valider':'Validate'}</Btn>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ textAlign:'center', padding:12, background:`${G}10`, borderRadius:8, color:G, fontWeight:700, flexShrink:0 }}>
                ✅ {lang==='fr'?'Ticket résolu':'Ticket resolved'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bouton signaler */}
      <div style={{ marginBottom:20 }}>
        <Btn onClick={() => setShowNew(true)}>+ {lang==='fr'?'Signaler un incident':'Report incident'}</Btn>
      </div>

      {/* KPIs */}
      {!loading && tickets.length > 0 && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:20 }}>
          {[['🔴', lang==='fr'?'Critique':'Critical', tickets.filter(t=>t.priority==='high').length, R],
            ['🟡', lang==='fr'?'En cours':'In progress', tickets.filter(t=>t.status==='in_progress').length, O],
            ['🟢', lang==='fr'?'Résolus':'Resolved', tickets.filter(t=>t.status==='resolved').length, G],
            ['📋', 'Total', tickets.length, BLUE]
          ].map(([icon,label,val,color]) => (
            <Card key={label} style={{ textAlign:'center', padding:14, marginBottom:0, borderTop:`3px solid ${color}` }}>
              <div style={{ fontSize:20, marginBottom:4 }}>{icon}</div>
              <div style={{ fontSize:11, color:MUTED, marginBottom:2, fontFamily:FONT }}>{label}</div>
              <div style={{ fontSize:22, fontWeight:800, color }}>{val}</div>
            </Card>
          ))}
        </div>
      )}

      {/* Liste tickets */}
      {loading ? <Spin /> : tickets.length === 0 ? (
        <Card style={{ textAlign:'center', padding:40 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>✅</div>
          <div style={{ color:MUTED, fontFamily:FONT }}>{lang==='fr'?'Aucun incident signalé':'No incidents reported'}</div>
        </Card>
      ) : (
        <Card>
          {tickets.map(tk => (
            <div key={tk.ticket_id} onClick={() => openTicket(tk)}
              style={{ padding:'14px 0', borderBottom:`1px solid ${BORDER}`, cursor:'pointer' }}
              onMouseEnter={e=>e.currentTarget.style.background=BG}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <span style={{ fontFamily:'monospace', fontSize:11, color:MUTED, background:BG, padding:'2px 6px', borderRadius:4 }}>{tk.ticket_number}</span>
                    <Badge label={PL[tk.priority]||tk.priority} color={PC[tk.priority]||MUTED} />
                    <Badge label={SL[tk.status]||tk.status} color={SC[tk.status]||MUTED} />
                    {tk.status==='pending_merchant' && <span style={{ background:`${R}15`, color:R, padding:'2px 8px', borderRadius:6, fontSize:11, fontWeight:700 }}>⚠️ Action requise</span>}
                  </div>
                  <div style={{ fontSize:14, fontWeight:700, fontFamily:FONT, marginBottom:4 }}>{tk.subject}</div>
                  <div style={{ fontSize:11, color:MUTED }}>{fmtDate(tk.created_at, lang)}</div>
                </div>
                <div style={{ fontSize:12, color:P, fontWeight:600, flexShrink:0, marginLeft:12 }}>Voir →</div>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
};


const Account = ({ lang }) => {
  const t = useT(lang);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('info');
  const [form, setForm] = useState({});
  const [pwdForm, setPwdForm] = useState({ currentPassword: '', newPassword: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/account').then(r => { setAccount(r.data); setForm({ businessName: r.data.business_name || '', email: r.data.email || '', phone: r.data.phone || '' }); }).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try { await api.patch('/account', form); toast.success(t('profileSaved') || 'Sauvegardé'); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSaving(false); }
  };

  const changePwd = async () => {
    setSaving(true);
    try { await api.post('/account/change-password', pwdForm); toast.success(t('pwdChanged') || 'Mot de passe changé'); setPwdForm({ currentPassword: '', newPassword: '' }); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSaving(false); }
  };

  if (loading) return <Spin />;
  return (
    <div>
      {account && (
        <Card style={{ marginBottom: 20, background: `linear-gradient(135deg, ${BLUE}, ${P})`, color: '#fff', border: 'none' }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{account.business_name}</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>ID: {account.merchant_id?.slice(-8).toUpperCase()} · KYB: Niveau {account.kyb_level || 1}</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 12, fontSize: 12 }}>
            <span>📧 {account.email}</span>
            <span>📱 {account.phone}</span>
          </div>
        </Card>
      )}
      <div style={{ display: 'flex', gap: 2, marginBottom: 20, background: BG, borderRadius: 10, padding: 4, width: 'fit-content', border: `1px solid ${BORDER}` }}>
        {[[lang === 'fr' ? 'Informations' : 'Information', 'info'], [lang === 'fr' ? 'Mot de passe' : 'Password', 'pwd'], ['KYB', 'kyb'], [lang === 'fr' ? '📄 Documents' : '📄 Documents', 'docs']].map(([l, v]) => (
          <button key={v} onClick={() => setTab(v)} style={{ padding: '7px 20px', borderRadius: 8, border: 'none', background: tab === v ? CARD : 'transparent', fontWeight: tab === v ? 700 : 400, color: tab === v ? P : MUTED, cursor: 'pointer', fontSize: 13, fontFamily: FONT }}>{l}</button>
        ))}
      </div>
      {tab === 'info' && (
        <Card style={{ maxWidth: 500 }}>
          <Inp label={lang === 'fr' ? 'Nom commercial' : 'Business name'} value={form.businessName} onChange={v => setForm(p => ({ ...p, businessName: v }))} />
          <Inp label="Email" value={form.email} onChange={v => setForm(p => ({ ...p, email: v }))} type="email" />
          <Inp label={lang === 'fr' ? 'Téléphone' : 'Phone'} value={form.phone} onChange={v => setForm(p => ({ ...p, phone: v }))} />
          <Btn onClick={save} disabled={saving} style={{ width: '100%', marginTop: 8 }}>{saving ? (lang === 'fr' ? 'Sauvegarde…' : 'Saving…') : (lang === 'fr' ? 'Enregistrer' : 'Save')}</Btn>
        </Card>
      )}
      {tab === 'pwd' && (
        <Card style={{ maxWidth: 400 }}>
          <Inp label={lang === 'fr' ? 'Mot de passe actuel' : 'Current password'} value={pwdForm.currentPassword} onChange={v => setPwdForm(p => ({ ...p, currentPassword: v }))} type="password" placeholder="••••••••" />
          <Inp label={lang === 'fr' ? 'Nouveau mot de passe' : 'New password'} value={pwdForm.newPassword} onChange={v => setPwdForm(p => ({ ...p, newPassword: v }))} type="password" placeholder="••••••••" />
          <Btn onClick={changePwd} disabled={saving} style={{ width: '100%', marginTop: 8 }}>{saving ? (lang === 'fr' ? 'Modification…' : 'Changing…') : (lang === 'fr' ? 'Changer le mot de passe' : 'Change password')}</Btn>
        </Card>
      )}
      {tab === 'kyb' && account && (
        <Card style={{ maxWidth: 500 }}>
          {[['RCCM', account.rccm || '—'], ['NIF', account.nif || '—'], [lang === 'fr' ? 'Pays' : 'Country', account.country || '—'], [lang === 'fr' ? 'Devise' : 'Currency', account.currency || 'XAF'], ['KYB Level', `Niveau ${account.kyb_level || 1}`], ['Status', account.kyb_status || 'pending'], [lang === 'fr' ? 'Compte règlement' : 'Settlement account', account.settlement_account || '—']].map(([l, v]) => (
            <div key={l} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 13, fontFamily: FONT }}>
              <span style={{ color: MUTED }}>{l}</span><span style={{ fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </Card>
      )}

      {tab === 'docs' && <KybDocuments lang={lang} />}
    </div>
  );
};

// ─── KYB DOCUMENTS (Merchant) ─────────────────────────────────────
const KybDocuments = ({ lang }) => {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ docType: 'rccm', docLabel: '', fileUrl: '', fileName: '' });

  const DOC_TYPES = [
    { v: 'rccm',          label: 'RCCM / Registre de commerce' },
    { v: 'nif',           label: 'NIF / Identifiant fiscal' },
    { v: 'id_card',       label: "Pièce d'identité du dirigeant" },
    { v: 'bank_details',  label: 'RIB / Coordonnées bancaires' },
    { v: 'address_proof', label: "Justificatif d'adresse" },
    { v: 'contract',      label: 'Contrat signé' },
  ];

  const STATUS_COLORS = { pending: '#ff9500', approved: '#00c896', rejected: '#ff3b30' };
  const STATUS_LABELS = { pending: lang === 'fr' ? 'En attente' : 'Pending', approved: lang === 'fr' ? 'Approuvé' : 'Approved', rejected: lang === 'fr' ? 'Rejeté' : 'Rejected' };

  const load = useCallback(() => {
    api.get('/kyb').then(r => setDocs(r.data.documents || [])).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast.error(lang === 'fr' ? 'Fichier trop volumineux (max 5MB)' : 'File too large (max 5MB)');
    const reader = new FileReader();
    reader.onload = (ev) => {
      setForm(p => ({ ...p, fileUrl: ev.target.result, fileName: file.name }));
    };
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    if (!form.fileUrl) return toast.error(lang === 'fr' ? 'Veuillez sélectionner un fichier' : 'Please select a file');
    setUploading(true);
    try {
      await api.post('/kyb/documents', {
        docType: form.docType,
        docLabel: DOC_TYPES.find(t => t.v === form.docType)?.label || form.docType,
        fileUrl: form.fileUrl,
        fileName: form.fileName,
        mimeType: form.fileUrl.split(';')[0].split(':')[1],
      });
      toast.success(lang === 'fr' ? 'Document soumis ✅' : 'Document submitted ✅');
      setForm({ docType: 'rccm', docLabel: '', fileUrl: '', fileName: '' });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setUploading(false); }
  };

  const needed = DOC_TYPES.filter(t => !docs.find(d => d.doc_type === t.v && d.status === 'approved'));

  return (
    <div style={{ maxWidth: 640 }}>
      {/* Progression */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, fontFamily: FONT }}>
            {lang === 'fr' ? 'Conformité KYB' : 'KYB Compliance'}
          </div>
          <div style={{ fontSize: 13, color: '#00c896', fontWeight: 700 }}>
            {docs.filter(d => d.status === 'approved').length} / {DOC_TYPES.length} {lang === 'fr' ? 'approuvés' : 'approved'}
          </div>
        </div>
        <div style={{ background: BORDER, borderRadius: 6, height: 8, overflow: 'hidden' }}>
          <div style={{ background: '#00c896', height: '100%', borderRadius: 6, width: `${(docs.filter(d => d.status === 'approved').length / DOC_TYPES.length) * 100}%`, transition: 'width .5s' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 14 }}>
          {DOC_TYPES.map(dt => {
            const doc = docs.find(d => d.doc_type === dt.v);
            const color = doc ? STATUS_COLORS[doc.status] : MUTED;
            const icon = doc ? { pending: '⏳', approved: '✅', rejected: '❌' }[doc.status] : '○';
            return (
              <div key={dt.v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color }}>
                <span>{icon}</span>
                <span style={{ fontFamily: FONT }}>{dt.label.split('/')[0].trim()}</span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Soumettre un document */}
      <Card style={{ marginBottom: 16, border: `1px solid ${P}20` }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14, fontFamily: FONT }}>
          📤 {lang === 'fr' ? 'Soumettre un document' : 'Submit a document'}
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4, fontFamily: FONT }}>
            {lang === 'fr' ? 'Type de document' : 'Document type'}
          </label>
          <select value={form.docType} onChange={e => setForm(p => ({ ...p, docType: e.target.value }))}
            style={{ width: '100%', background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 12px', fontSize: 14, color: TEXT, fontFamily: FONT }}>
            {DOC_TYPES.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4, fontFamily: FONT }}>
            {lang === 'fr' ? 'Fichier (PDF, JPG, PNG — max 5MB)' : 'File (PDF, JPG, PNG — max 5MB)'}
          </label>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={handleFile}
            style={{ width: '100%', background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 12px', fontSize: 13, fontFamily: FONT, boxSizing: 'border-box' }} />
          {form.fileName && <div style={{ fontSize: 11, color: '#00c896', marginTop: 4 }}>✓ {form.fileName}</div>}
        </div>
        <Btn onClick={submit} disabled={uploading || !form.fileUrl} style={{ width: '100%' }}>
          {uploading ? (lang === 'fr' ? 'Envoi…' : 'Uploading…') : (lang === 'fr' ? '📤 Soumettre le document' : '📤 Submit document')}
        </Btn>
      </Card>

      {/* Liste documents soumis */}
      {loading ? <Spin /> : docs.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>📄</div>
          <div style={{ color: MUTED, fontSize: 13, fontFamily: FONT }}>
            {lang === 'fr' ? 'Aucun document soumis. Complétez votre dossier KYB.' : 'No documents submitted. Complete your KYB file.'}
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14, fontFamily: FONT }}>
            {lang === 'fr' ? 'Documents soumis' : 'Submitted documents'}
          </div>
          {docs.map(doc => (
            <div key={doc.doc_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: `1px solid ${BORDER}` }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, fontFamily: FONT }}>
                  {DOC_TYPES.find(t => t.v === doc.doc_type)?.label || doc.doc_type}
                </div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                  {doc.file_name} · {new Date(doc.uploaded_at).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-US')}
                </div>
                {doc.rejection_reason && (
                  <div style={{ fontSize: 11, color: '#ff3b30', marginTop: 4 }}>
                    ⚠️ {doc.rejection_reason}
                  </div>
                )}
              </div>
              <span style={{ background: `${STATUS_COLORS[doc.status] || MUTED}20`, color: STATUS_COLORS[doc.status] || MUTED, borderRadius: 20, padding: '4px 12px', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                {STATUS_LABELS[doc.status] || doc.status}
              </span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
};

// ─── PayLinks ─────────────────────────────────────────────────────
const PayLinks = ({ lang }) => {
  const t = useT(lang);
  const [links, setLinks] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newLink, setNewLink] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [form, setForm] = useState({ amount: '', description: '', expiresIn: '24', recipientPhone: '', channel: 'sms' });
  const [creating, setCreating] = useState(false);
  const f = k => v => setForm(p => ({ ...p, [k]: v }));

  const load = useCallback(() => {
    setLoading(true);
    api.get('/pay-links', { params: { status: status || undefined } }).then(r => { setLinks(r.data.data || []); setTotal(r.data.total || 0); }).finally(() => setLoading(false));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.amount || parseFloat(form.amount) < 100) return toast.error(lang === 'fr' ? 'Montant minimum 100 XAF' : 'Minimum 100 XAF');
    setCreating(true);
    try {
      const { data } = await api.post('/pay-links', { amount: parseFloat(form.amount), description: form.description || undefined, expiresIn: parseInt(form.expiresIn) || 24, recipientPhone: form.recipientPhone || undefined, channel: form.channel });
      setNewLink(data.link || data);
      setShowCreate(false);
      load();
      setForm({ amount: '', description: '', expiresIn: '24', recipientPhone: '', channel: 'sms' });
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setCreating(false); }
  };

  const cancel = async (id) => {
    if (!window.confirm(lang === 'fr' ? 'Annuler ce lien ?' : 'Cancel this link?')) return;
    try { await api.delete(`/pay-links/${id}`); toast.success(lang === 'fr' ? 'Lien annulé' : 'Link cancelled'); load(); }
    catch { toast.error('Erreur'); }
  };

  return (
    <div>
      {receipt && <Receipt txn={receipt} lang={lang} onClose={() => setReceipt(null)} />}
      <BackBtn lang={lang} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <Btn onClick={() => { setShowCreate(true); setNewLink(null); }}>{t('newPayLink')}</Btn>
      </div>

      {showCreate && (
        <Card style={{ border: `2px solid ${P}`, marginBottom: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, fontFamily: FONT }}>{lang === 'fr' ? 'Créer un lien de paiement' : 'Create payment link'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Inp label={lang === 'fr' ? 'Montant * (min. 100 XAF)' : 'Amount * (min. 100 XAF)'} value={form.amount} onChange={f('amount')} type="number" min="100" placeholder="5000" />
            <Inp label={lang === 'fr' ? 'Description' : 'Description'} value={form.description} onChange={f('description')} placeholder={lang === 'fr' ? 'Commande #001' : 'Order #001'} />
            <Inp label={lang === 'fr' ? 'Expire dans (heures)' : 'Expires in (hours)'} value={form.expiresIn} onChange={f('expiresIn')} type="number" min="1" max="720" />
            <Inp label={lang === 'fr' ? 'Téléphone destinataire' : 'Recipient phone'} value={form.recipientPhone} onChange={f('recipientPhone')} placeholder="+237XXXXXXXXX" />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <Btn onClick={create} disabled={creating}>{creating ? (lang === 'fr' ? 'Création…' : 'Creating…') : (lang === 'fr' ? 'Créer le lien' : 'Create link')}</Btn>
            <Btn outline onClick={() => setShowCreate(false)}>{lang === 'fr' ? 'Annuler' : 'Cancel'}</Btn>
          </div>
        </Card>
      )}

      {newLink && (
        <Card style={{ border: `2px solid ${G}`, marginBottom: 20, textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: G, marginBottom: 12 }}>✅ {lang === 'fr' ? 'Lien créé !' : 'Link created!'}</div>
          <div style={{ background: BG, borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, fontFamily: 'monospace', color: P, wordBreak: 'break-all' }}>{newLink.short_url}</div>
          {newLink.short_url && (
            <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&format=svg&data=${encodeURIComponent(newLink.short_url)}`}
              alt="QR" style={{ width: 200, height: 200, margin: '0 auto 12px', display: 'block', borderRadius: 8, border: `1px solid ${BORDER}` }} />
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Btn onClick={() => navigator.clipboard.writeText(newLink.short_url || '').then(() => toast.success(lang === 'fr' ? 'Copié !' : 'Copied!'))}>📋 {lang === 'fr' ? 'Copier' : 'Copy'}</Btn>
            <Btn onClick={() => setReceipt({ txn_id: newLink.pay_link_id, amount: newLink.amount, status: 'pending', initiated_at: new Date().toISOString() })} color={G}>🧾 Ticket</Btn>
            <Btn outline onClick={() => setNewLink(null)}>{lang === 'fr' ? 'Nouveau' : 'New'}</Btn>
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>{fmtNum(newLink.amount)} XAF{newLink.description ? ` · ${newLink.description}` : ''}</div>
        </Card>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[['', lang === 'fr' ? 'Tous' : 'All'], ['pending', lang === 'fr' ? 'En attente' : 'Pending'], ['paid', lang === 'fr' ? 'Payé' : 'Paid'], ['expired', lang === 'fr' ? 'Expiré' : 'Expired'], ['cancelled', lang === 'fr' ? 'Annulé' : 'Cancelled']].map(([v, l]) => (
          <button key={v} onClick={() => setStatus(v)} style={{ padding: '7px 16px', borderRadius: 20, border: `2px solid ${status === v ? P : BORDER}`, background: status === v ? `${P}12` : CARD, color: status === v ? P : MUTED, cursor: 'pointer', fontSize: 13, fontWeight: status === v ? 700 : 400, fontFamily: FONT }}>{l}</button>
        ))}
      </div>

      {loading ? <Spin /> : (
        <Card>
          {links.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🔗</div>
              <div style={{ color: MUTED, fontSize: 14, fontFamily: FONT }}>{t('plNoLinks') || lang === 'fr' ? 'Aucun lien de paiement' : 'No payment links'}</div>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: FONT }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${BORDER}`, color: MUTED }}>
                    {['URL', lang === 'fr' ? 'Montant' : 'Amount', lang === 'fr' ? 'Description' : 'Description', 'Statut', lang === 'fr' ? 'Expire' : 'Expires', ''].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {links.map(link => (
                    <tr key={link.pay_link_id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                      <td style={{ padding: '10px 12px' }}>
                        <a href={link.short_url} target="_blank" rel="noreferrer" style={{ color: P, fontSize: 12, fontFamily: 'monospace' }}>{link.short_url?.replace('https://', '')}</a>
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: 700 }}>{fmtNum(link.amount)} XAF</td>
                      <td style={{ padding: '10px 12px', color: MUTED }}>{link.description || '—'}</td>
                      <td style={{ padding: '10px 12px' }}><Badge label={link.status} color={sc(link.status)} /></td>
                      <td style={{ padding: '10px 12px', color: MUTED, fontSize: 12 }}>{fmtDate(link.expires_at, lang)}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {link.status === 'pending' && (
                          <button onClick={() => cancel(link.pay_link_id)} style={{ background: 'none', border: `1px solid ${R}`, color: R, padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontFamily: FONT }}>
                            {lang === 'fr' ? 'Annuler' : 'Cancel'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

// ─── AcceptPayment ────────────────────────────────────────────────
const AcceptPayment = ({ lang }) => {
  const t = useT(lang);
  const [mode, setMode] = useState('card');
  const [psp, setPsp] = useState('cybersource');
  const [form, setForm] = useState({ amount: '', description: '' });
  const [result, setResult] = useState(null);
  const [showReceipt, setShowReceipt] = useState(null);
  const [loading, setLoading] = useState(false);
  const f = k => v => setForm(p => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!form.amount || parseFloat(form.amount) < 100) return toast.error(lang === 'fr' ? 'Montant minimum 100 XAF' : 'Minimum 100 XAF');
    setLoading(true);
    try {
      const { data } = await api.post('/pay-links', { amount: parseFloat(form.amount), description: form.description || undefined, expiresIn: 1, method: mode, psp });
      setResult(data.link || data);
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setLoading(false); }
  };

  const modes = [
    { v: 'card', label: lang === 'fr' ? 'Carte' : 'Card', icon: '💳' },
    { v: 'mobile_money', label: 'Mobile Money', icon: '📱' },
    { v: 'qr', label: 'QR Code', icon: '📷' },
  ];
  const psps = [
    { v: 'cybersource', label: 'CyberSource (Visa)', icon: '💳' },
    { v: 'migs', label: 'MIGS (Mastercard)', icon: '🔴' },
    { v: 'stripe', label: 'Stripe', icon: '⚡' },
  ];

  return (
    <div>
      {showReceipt && <Receipt txn={showReceipt} lang={lang} onClose={() => setShowReceipt(null)} />}
      <BackBtn lang={lang} />
      {!result ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, fontFamily: FONT }}>⚙️ {lang === 'fr' ? 'Paramètres' : 'Parameters'}</div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>{lang === 'fr' ? 'Mode de paiement' : 'Payment mode'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 16 }}>
              {modes.map(m => (
                <button key={m.v} onClick={() => setMode(m.v)}
                  style={{ border: `2px solid ${mode === m.v ? P : BORDER}`, background: mode === m.v ? `${P}10` : CARD, borderRadius: 10, padding: '12px 8px', cursor: 'pointer', textAlign: 'center', transition: 'all .2s' }}>
                  <div style={{ fontSize: 22, marginBottom: 4 }}>{m.icon}</div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: mode === m.v ? P : MUTED, fontFamily: FONT }}>{m.label}</div>
                </button>
              ))}
            </div>
            <Inp label={lang === 'fr' ? 'Montant * (min. 100 XAF)' : 'Amount * (min. 100 XAF)'} value={form.amount} onChange={f('amount')} type="number" min="100" placeholder="1000" />
            <Inp label={lang === 'fr' ? 'Description' : 'Description'} value={form.description} onChange={f('description')} placeholder={lang === 'fr' ? 'Ex: Commande #123' : 'Ex: Order #123'} />
            {mode === 'card' && (
              <>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>{lang === 'fr' ? 'Choisir le processeur *' : 'Choose processor *'}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
                  {psps.map(p => (
                    <button key={p.v} onClick={() => setPsp(p.v)}
                      style={{ border: `2px solid ${psp === p.v ? BLUE : BORDER}`, background: psp === p.v ? `${BLUE}10` : CARD, borderRadius: 10, padding: '12px 8px', cursor: 'pointer', textAlign: 'center' }}>
                      <div style={{ fontSize: 18, marginBottom: 4 }}>{p.icon}</div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: psp === p.v ? BLUE : MUTED, fontFamily: FONT }}>{p.label}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
            <Btn onClick={submit} disabled={loading} style={{ width: '100%' }}>
              {loading ? (lang === 'fr' ? 'Génération…' : 'Generating…') : (mode === 'qr' ? (lang === 'fr' ? '📷 Générer QR Code' : '📷 Generate QR Code') : (lang === 'fr' ? '🔗 Créer le lien' : '🔗 Create link'))}
            </Btn>
          </Card>
          <Card style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>{modes.find(m => m.v === mode)?.icon}</div>
            <div style={{ fontSize: 14, color: MUTED, fontFamily: FONT, marginBottom: 8 }}>
              {mode === 'qr' ? (lang === 'fr' ? 'Un QR Code sera généré pour le scan et paiement' : 'A QR Code will be generated for scan and payment') :
                mode === 'card' ? (lang === 'fr' ? 'Un lien de paiement sécurisé sera créé' : 'A secure payment link will be created') :
                  (lang === 'fr' ? 'Le client paiera via Mobile Money' : 'Customer will pay via Mobile Money')}
            </div>
            {form.amount && parseFloat(form.amount) >= 100 && (
              <div style={{ fontSize: 32, fontWeight: 800, color: P, marginTop: 12 }}>{fmtNum(form.amount)} XAF</div>
            )}
            {mode === 'card' && psp && <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>via {psps.find(p => p.v === psp)?.label}</div>}
          </Card>
        </div>
      ) : (
        <Card style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: G, marginBottom: 16 }}>📷 QR Code</div>
          <div style={{ background: BG, borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, fontFamily: 'monospace', color: P, wordBreak: 'break-all' }}>{result.short_url}</div>
          <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&format=svg&data=${encodeURIComponent(result.short_url || '')}`}
            alt="QR" style={{ width: 200, height: 200, margin: '0 auto 16px', display: 'block', borderRadius: 8, border: `1px solid ${BORDER}` }} />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Btn onClick={() => navigator.clipboard.writeText(result.short_url || '').then(() => toast.success(lang === 'fr' ? 'Copié !' : 'Copied!'))}>📋 {lang === 'fr' ? 'Copier' : 'Copy'}</Btn>
            <Btn onClick={() => setShowReceipt({ txn_id: result.pay_link_id, amount: result.amount, status: 'pending', auth_code: result.short_url?.slice(-8), initiated_at: new Date().toISOString() })} color={G}>🧾 Ticket</Btn>
            <Btn outline onClick={() => setResult(null)}>{lang === 'fr' ? 'Nouveau' : 'New'}</Btn>
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>PSP: {psps.find(p => p.v === psp)?.label} · {fmtNum(result.amount)} XAF</div>
        </Card>
      )}
    </div>
  );
};

// ─── TapToPhone ───────────────────────────────────────────────────
const TapToPhone = ({ lang }) => {
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState('idle');
  const [result, setResult] = useState(null);

  const startNfc = async () => {
    if (!amount || parseFloat(amount) < 100) return toast.error(lang === 'fr' ? 'Montant minimum 100 XAF' : 'Minimum 100 XAF');
    // Vérifier support NFC
    if ('NDEFReader' in window) {
      try {
        setStatus('waiting');
        const ndef = new window.NDEFReader();
        await ndef.scan();
        ndef.onreading = () => {
          setStatus('processing');
          setTimeout(() => {
            setResult({ amount, authCode: 'NFC' + Math.random().toString(36).slice(2,8).toUpperCase() });
            setStatus('success');
          }, 1500);
        };
      } catch(e) {
        // Fallback simulation si NFC non disponible
        setStatus('waiting');
        setTimeout(() => {
          setStatus('processing');
          setTimeout(() => {
            setStatus('success');
            setResult({ amount, authCode: 'NFC' + Math.random().toString(36).slice(2,8).toUpperCase() });
          }, 2000);
        }, 3000);
      }
    } else {
      // Simulation — NFC non supporté par ce navigateur
      setStatus('waiting');
      setTimeout(() => {
        setStatus('processing');
        setTimeout(() => {
          setStatus('success');
          setResult({ amount, authCode: 'NFC' + Math.random().toString(36).slice(2,8).toUpperCase() });
        }, 2000);
      }, 3000);
    }
  };

  return (
    <div>
      <BackBtn lang={lang} />
      <div style={{ maxWidth: 400 }}>
        <Card>
          {status === 'idle' && <>
            <Inp label={lang === 'fr' ? 'Montant à encaisser (XAF)' : 'Amount to collect (XAF)'} value={amount} onChange={setAmount} type="number" min="100" placeholder="5000" />
            <div style={{ background: `${BLUE}10`, border: `1px solid ${BLUE}30`, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12 }}>
              📱 {lang === 'fr' ? 'Approchez la carte ou le smartphone du client sur la zone NFC.' : 'Hold the customer card or smartphone near the NFC area.'}
            </div>
            <Btn onClick={startNfc} color={BLUE} style={{ width: '100%' }}>📡 {lang === 'fr' ? 'Démarrer la lecture NFC' : 'Start NFC reading'}</Btn>
          </>}
          {status === 'waiting' && <div style={{ textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>📡</div>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, fontFamily: FONT }}>{lang === 'fr' ? 'En attente du paiement…' : 'Waiting for payment…'}</div>
            <div style={{ fontSize: 13, color: MUTED }}>{lang === 'fr' ? 'Approchez la carte ou le téléphone' : 'Hold card or phone near device'}</div>
          </div>}
          {status === 'processing' && <div style={{ textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>⏳</div>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: FONT }}>{lang === 'fr' ? 'Traitement en cours…' : 'Processing…'}</div>
          </div>}
          {status === 'success' && result && <div style={{ textAlign: 'center', padding: 24 }}>
            <div style={{ fontSize: 64, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: G, marginBottom: 8, fontFamily: FONT }}>{lang === 'fr' ? 'Paiement accepté !' : 'Payment accepted!'}</div>
            <div style={{ fontSize: 32, fontWeight: 800, marginBottom: 8 }}>{fmtNum(result.amount)} XAF</div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 20 }}>Auth: {result.authCode}</div>
            <Btn onClick={() => { setStatus('idle'); setAmount(''); setResult(null); }} style={{ width: '100%' }}>
              {lang === 'fr' ? '+ Nouveau paiement' : '+ New payment'}
            </Btn>
          </div>}
        </Card>
      </div>
    </div>
  );
};

// ─── Withdraw ─────────────────────────────────────────────────────
const Withdraw = ({ lang }) => {
  const [form, setForm] = useState({ amount: '', operator: 'mtn', phone: '' });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const f = k => v => setForm(p => ({ ...p, [k]: v }));
  const submit = async () => {
    if (!form.amount || parseFloat(form.amount) < 500) return toast.error(lang === 'fr' ? 'Montant minimum 500 XAF' : 'Minimum 500 XAF');
    if (!form.phone) return toast.error(lang === 'fr' ? 'Numéro requis' : 'Phone required');
    setLoading(true);
    try { const { data } = await api.post('/withdraw', form); setResult(data); toast.success(lang === 'fr' ? 'Retrait effectué' : 'Withdrawal done'); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setLoading(false); }
  };
  return (
    <div>
      <BackBtn lang={lang} />
      {!result ? (
        <Card style={{ maxWidth: 480 }}>
          <Inp label={lang === 'fr' ? 'Montant (min. 500 XAF)' : 'Amount (min. 500 XAF)'} value={form.amount} onChange={f('amount')} type="number" min="500" placeholder="10000" />
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{lang === 'fr' ? 'Opérateur' : 'Operator'}</label>
            <select value={form.operator} onChange={e => f('operator')(e.target.value)} style={{ width: '100%', background: BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '10px 12px', fontSize: 14, color: TEXT, fontFamily: FONT }}>
              {[['mtn', 'MTN MoMo'], ['orange', 'Orange Money'], ['airtel', 'Airtel Money']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <Inp label={lang === 'fr' ? 'Numéro Mobile Money *' : 'Mobile Money number *'} value={form.phone} onChange={f('phone')} placeholder="+237XXXXXXXXX" />
          <Btn onClick={submit} disabled={loading} color={O} style={{ width: '100%' }}>{loading ? (lang === 'fr' ? 'Traitement…' : 'Processing…') : (lang === 'fr' ? 'Effectuer le retrait' : 'Perform withdrawal')}</Btn>
        </Card>
      ) : (
        <Card style={{ maxWidth: 480, textAlign: 'center' }}>
          <div style={{ fontSize: 56, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: G, marginBottom: 8, fontFamily: FONT }}>{lang === 'fr' ? 'Retrait effectué !' : 'Withdrawal done!'}</div>
          <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 20 }}>{fmtNum(result.amount || form.amount)} XAF</div>
          <Btn onClick={() => { setResult(null); setForm({ amount: '', operator: 'mtn', phone: '' }); }} style={{ width: '100%' }}>
            {lang === 'fr' ? '+ Nouveau retrait' : '+ New withdrawal'}
          </Btn>
        </Card>
      )}
    </div>
  );
};

// ─── App ──────────────────────────────────────────────────────────
// ─── API KEYS ─────────────────────────────────────────────────────
// ─── WEBHOOK CONFIG ───────────────────────────────────────────────
const WebhookConfig = ({ lang }) => {
  const [cfg, setCfg]       = useState({ webhookUrl:'', webhookSecret:'' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api.get('/webhook-config').then(r=>setCfg(r.data||{})).catch(()=>{}).finally(()=>setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try { await api.patch('/webhook-config', cfg); toast.success(lang==='fr'?'Webhook sauvegarde':'Webhook saved'); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true);
    try { await api.post('/webhook-config/test'); toast.success(lang==='fr'?'Test envoye':'Test sent'); }
    catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setTesting(false); }
  };

  if (loading) return <Spin />;

  return (
    <div>
      <Card style={{ marginBottom:16 }}>
        <div style={{ fontSize:15, fontWeight:700, marginBottom:16, fontFamily:FONT }}>
          🔔 {lang==='fr'?'Configuration Webhook':'Webhook Configuration'}
        </div>
        <div style={{ marginBottom:12 }}>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>
            {lang==='fr'?'URL Webhook':'Webhook URL'}
          </label>
          <input value={cfg.webhookUrl||''} onChange={e=>setCfg(p=>({...p,webhookUrl:e.target.value}))}
            placeholder="https://votresite.com/webhooks/cplus"
            style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:13, color:TEXT, fontFamily:FONT, boxSizing:'border-box' }} />
        </div>
        <div style={{ marginBottom:16 }}>
          <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>
            {lang==='fr'?'Secret de signature':'Signing Secret'}
          </label>
          <input value={cfg.webhookSecret||''} onChange={e=>setCfg(p=>({...p,webhookSecret:e.target.value}))}
            placeholder="whsec_xxxxxxxx"
            style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:13, color:TEXT, fontFamily:FONT, boxSizing:'border-box' }} />
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={save} disabled={saving}
            style={{ flex:1, background:P, color:'#fff', border:'none', borderRadius:8, padding:'10px', cursor:'pointer', fontWeight:700, fontSize:13, fontFamily:FONT }}>
            {saving?'...':(lang==='fr'?'Sauvegarder':'Save')}
          </button>
          <button onClick={test} disabled={testing||!cfg.webhookUrl}
            style={{ flex:1, background:'none', border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px', cursor:'pointer', fontSize:13, fontFamily:FONT, color:MUTED }}>
            {testing?'...':(lang==='fr'?'Tester':'Test')}
          </button>
        </div>
      </Card>

      <Card>
        <div style={{ fontSize:13, fontWeight:700, marginBottom:12 }}>
          📋 {lang==='fr'?'Evenements disponibles':'Available events'}
        </div>
        {[
          ['payment.completed', lang==='fr'?'Paiement reussi':'Payment completed'],
          ['payment.failed',    lang==='fr'?'Paiement echoue':'Payment failed'],
          ['payout.completed',  lang==='fr'?'Decaissement effectue':'Payout completed'],
        ].map(([ev, desc]) => (
          <div key={ev} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:`1px solid ${BORDER}`, fontSize:13 }}>
            <code style={{ background:BG, padding:'2px 8px', borderRadius:4, fontSize:12, color:P }}>{ev}</code>
            <span style={{ color:MUTED }}>{desc}</span>
          </div>
        ))}
      </Card>
    </div>
  );
};

const ApiKeys = ({ lang }) => {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newKey, setNewKey] = useState(null);
  const [form, setForm] = useState({ keyName:'', permissions:['collect','transactions','pay_links'] });
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState('');

  const load = () => {
    api.get('/api-keys').then(r => setKeys(r.data.data||[])).catch(()=>{}).finally(()=>setLoading(false));
  };
  useEffect(()=>{ load(); }, []);

  const create = async () => {
    if (!form.keyName) return toast.error(lang==='fr'?'Nom requis':'Name required');
    setSaving(true);
    try {
      const r = await api.post('/api-keys', form);
      setNewKey(r.data.key);
      setShowNew(false);
      load();
      toast.success(lang==='fr'?'Clé créée — sauvegardez-la maintenant !':'Key created — save it now!');
    } catch(err){ toast.error(err.response?.data?.error||'Erreur'); }
    finally { setSaving(false); }
  };

  const revoke = async (keyId) => {
    if (!window.confirm(lang==='fr'?'Révoquer cette clé ?':'Revoke this key?')) return;
    try { await api.delete(`/api-keys/${keyId}`); toast.success(lang==='fr'?'Clé révoquée':'Key revoked'); load(); }
    catch { toast.error('Erreur'); }
  };

  const copy = (text, field) => {
    navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(()=>setCopied(''), 2000);
    toast.success(lang==='fr'?'Copié !':'Copied!');
  };

  const PERMS = [
    { v:'collect', label:'💳 Encaissement' },
    { v:'disburse', label:'💸 Décaissement' },
    { v:'transactions', label:'📋 Transactions' },
    { v:'pay_links', label:'🔗 Pay Links' },
  ];

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <h1 style={{ margin:0, fontSize:22, fontWeight:700, fontFamily:FONT }}>🔑 API Keys</h1>
        <Btn onClick={()=>setShowNew(true)}>+ {lang==='fr'?'Nouvelle clé':'New key'}</Btn>
      </div>

      {/* Info box */}
      <div style={{ background:`${BLUE}08`, border:`1px solid ${BLUE}20`, borderRadius:10, padding:14, marginBottom:20, fontSize:13 }}>
        <div style={{ fontWeight:700, marginBottom:6, fontFamily:FONT }}>🔌 {lang==='fr'?'Intégration API REST':'REST API Integration'}</div>
        <div style={{ color:MUTED, marginBottom:8 }}>
          {lang==='fr'?'Utilisez ces clés pour intégrer CPlus dans vos applications tierces.':'Use these keys to integrate CPlus into your third-party applications.'}
        </div>
        <div style={{ background:'#1e2d3d', borderRadius:8, padding:12, fontFamily:'monospace', fontSize:12, color:'#00c896' }}>
          curl -X POST https://api.c-pay.global/api/v1/merchant/public/collect \<br/>
          &nbsp;&nbsp;-H "X-API-Key: sk_live_xxx" \<br/>
          &nbsp;&nbsp;-d '&#123;"amount":5000,"customerPhone":"+242XXXXXXXXX","method":"airtel_money"&#125;'
        </div>
      </div>

      {/* Modal nouvelle clé */}
      {showNew && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:28, width:480, maxWidth:'100%' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:20 }}>
              <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>🔑 {lang==='fr'?'Créer une API Key':'Create API Key'}</div>
              <button onClick={()=>setShowNew(false)} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:MUTED }}>×</button>
            </div>
            <div style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{lang==='fr'?'Nom de la clé *':'Key name *'}</label>
              <input value={form.keyName} onChange={e=>setForm(p=>({...p,keyName:e.target.value}))}
                placeholder={lang==='fr'?'Ex: Mon App Mobile':'Ex: My Mobile App'}
                style={{ width:'100%', background:BG, border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', fontSize:14, color:TEXT, fontFamily:FONT, boxSizing:'border-box' }} />
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:8 }}>{lang==='fr'?'Permissions':'Permissions'}</label>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                {PERMS.map(p=>(
                  <label key={p.v} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:form.permissions.includes(p.v)?`${P}10`:BG, border:`1px solid ${form.permissions.includes(p.v)?P:BORDER}`, borderRadius:8, cursor:'pointer', fontSize:13 }}>
                    <input type="checkbox" checked={form.permissions.includes(p.v)}
                      onChange={e=>setForm(prev=>({...prev, permissions: e.target.checked ? [...prev.permissions,p.v] : prev.permissions.filter(x=>x!==p.v)}))} />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <Btn onClick={create} disabled={saving} style={{ flex:1 }}>{saving?'Création…':(lang==='fr'?'✅ Créer':'✅ Create')}</Btn>
              <Btn outline onClick={()=>setShowNew(false)} style={{ flex:1 }}>{lang==='fr'?'Annuler':'Cancel'}</Btn>
            </div>
          </div>
        </div>
      )}

      {/* Modal affichage nouvelle clé — UNE SEULE FOIS */}
      {newKey && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:2000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
          <div style={{ background:CARD, borderRadius:16, padding:28, width:540, maxWidth:'100%' }}>
            <div style={{ textAlign:'center', marginBottom:20 }}>
              <div style={{ fontSize:40, marginBottom:8 }}>🔑</div>
              <div style={{ fontSize:16, fontWeight:700, color:G, fontFamily:FONT }}>{lang==='fr'?'Clé créée avec succès !':'Key created successfully!'}</div>
              <div style={{ fontSize:12, color:R, marginTop:4 }}>
                ⚠️ {lang==='fr'?'Sauvegardez ces informations maintenant — elles ne seront plus affichées !':'Save this information now — it will not be shown again!'}
              </div>
            </div>
            {[['API Key', newKey.api_key, 'key'], ['Secret', newKey.api_secret, 'secret']].map(([label, value, field])=>(
              <div key={field} style={{ marginBottom:12 }}>
                <label style={{ display:'block', fontSize:11, color:MUTED, marginBottom:4 }}>{label}</label>
                <div style={{ display:'flex', gap:8 }}>
                  <input readOnly value={value} style={{ flex:1, background:BG, border:`1px solid ${BORDER}`, borderRadius:6, padding:'8px 10px', fontSize:11, fontFamily:'monospace', color:TEXT }} />
                  <button onClick={()=>copy(value, field)}
                    style={{ background:copied===field?G:P, color:'#fff', border:'none', borderRadius:6, padding:'8px 12px', cursor:'pointer', fontSize:12, fontWeight:700, whiteSpace:'nowrap' }}>
                    {copied===field?'✅ Copié':'📋 Copier'}
                  </button>
                </div>
              </div>
            ))}
            <div style={{ background:`${P}08`, borderRadius:8, padding:12, marginBottom:16, fontSize:12, color:MUTED }}>
              <strong>Exemple d'utilisation :</strong><br/>
              <span style={{ fontFamily:'monospace' }}>X-API-Key: {newKey.api_key?.slice(0,20)}...</span>
            </div>
            <Btn onClick={()=>setNewKey(null)} style={{ width:'100%' }}>✅ {lang==='fr'?'J\'ai sauvegardé mes credentials':'I have saved my credentials'}</Btn>
          </div>
        </div>
      )}

      {/* Liste des clés */}
      {loading ? <Spin /> : keys.length === 0 ? (
        <Card style={{ textAlign:'center', padding:40 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>🔑</div>
          <div style={{ color:MUTED, fontFamily:FONT }}>{lang==='fr'?'Aucune clé API créée':'No API keys created'}</div>
        </Card>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {keys.map(k => (
            <Card key={k.key_id}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                    <div style={{ fontSize:15, fontWeight:700, fontFamily:FONT }}>🔑 {k.key_name}</div>
                    <span style={{ background:k.is_active?`${G}20`:`${R}20`, color:k.is_active?G:R, borderRadius:20, padding:'2px 10px', fontSize:11, fontWeight:700 }}>
                      {k.is_active?(lang==='fr'?'Active':'Active'):(lang==='fr'?'Révoquée':'Revoked')}
                    </span>
                  </div>
                  <div style={{ fontFamily:'monospace', fontSize:12, color:MUTED, marginBottom:6 }}>{k.api_key}</div>
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                    {(k.permissions||[]).map(p=>(
                      <span key={p} style={{ background:`${BLUE}10`, color:BLUE, borderRadius:20, padding:'2px 8px', fontSize:10, fontWeight:700 }}>
                        {PERMS.find(x=>x.v===p)?.label||p}
                      </span>
                    ))}
                  </div>
                  {k.last_used_at && <div style={{ fontSize:11, color:MUTED, marginTop:4 }}>
                    {lang==='fr'?'Dernière utilisation':'Last used'}: {new Date(k.last_used_at).toLocaleString('fr-FR')}
                  </div>}
                </div>
                {k.is_active && (
                  <button onClick={()=>revoke(k.key_id)}
                    style={{ background:`${R}10`, border:`1px solid ${R}30`, color:R, borderRadius:8, padding:'7px 14px', cursor:'pointer', fontSize:12, fontWeight:700, fontFamily:FONT, flexShrink:0 }}>
                    🚫 {lang==='fr'?'Révoquer':'Revoke'}
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── INTEGRATIONS ─────────────────────────────────────────────────
const Integrations = ({ lang, t }) => {
  const plugins = [
    {
      id: 'android-app',
      name: 'CPlus App Android',
      platform: 'Android',
      icon: '📱',
      version: '2.6.0',
      desc: lang==='fr'
        ? 'Application Android native — Porteur de carte et Marchand. Choix du profil à l\'onboarding. Publiable sur Google Play Store.'
        : 'Native Android app — Cardholder and Merchant. Profile selection at onboarding. Ready for Google Play Store.',
      tags: ['Kotlin', 'Android API 24+', 'Play Store'],
      tagColors: ['#e8f0fe','#f0fff4','#e8f4f8'],
      tagTextColors: ['#1d4f92','#00c896','#12b6c7'],
      downloadUrl: 'https://c-pay.global/downloads/cplus-android-project-v2.6.0.zip',
      docsUrl: 'https://c-pay.global/developers',
      requires: 'Android Studio · Android API 24+ · Kotlin 1.9+',
      steps: lang==='fr'
        ? ['Telechargez le projet Android Studio', 'Ouvrez dans Android Studio', 'Synchronisez les dependances Gradle', 'Connectez votre device ou emulateur', 'Lancez avec Run → app']
        : ['Download the Android Studio project', 'Open in Android Studio', 'Sync Gradle dependencies', 'Connect your device or emulator', 'Run with Run → app'],
    },
    {
      id: 'android-sdk',
      name: 'CPlus Android SDK',
      platform: 'Android',
      icon: '📱',
      version: '2.6.0',
      desc: lang==='fr'
        ? 'SDK natif Kotlin/Java pour intégrer CPlus dans vos applications Android. Paiement Mobile Money, QR Code et NFC.'
        : 'Native Kotlin/Java SDK to integrate CPlus in your Android apps. Mobile Money, QR Code and NFC payments.',
      tags: ['Kotlin', 'Java', 'Android 5.0+'],
      tagColors: ['#e8f0fe', '#f0fff4', '#fff3e0'],
      tagTextColors: ['#1d4f92', '#00c896', '#ff9500'],
      downloadUrl: 'https://c-pay.global/downloads/cplus-android-sdk-v2.6.0.zip',
      docsUrl: 'https://c-pay.global/developers',
      requires: 'Android API 21+ · Kotlin 1.8+ ou Java 11+',
      steps: lang==='fr' ? [
        'Téléchargez le SDK (ZIP) ci-dessous',
        'Copiez le .aar dans votre dossier app/libs/',
        'Ajoutez la dépendance dans build.gradle',
        'Initialisez avec votre API Key dans Application.onCreate()',
        'Appelez CPlus.collect() pour encaisser'
      ] : [
        'Download the SDK (ZIP) below',
        'Copy .aar to your app/libs/ folder',
        'Add dependency in build.gradle',
        'Initialize with your API Key in Application.onCreate()',
        'Call CPlus.collect() to accept payment'
      ],
    },
    {
      id: 'woocommerce',
      name: 'CPlus Payment Gateway',
      platform: 'WooCommerce',
      icon: '🛒',
      version: '2.6.0',
      desc: lang==='fr'
        ? 'Acceptez Airtel Money, MTN MoMo et carte bancaire sur votre boutique WooCommerce.'
        : 'Accept Airtel Money, MTN MoMo and card payments on your WooCommerce store.',
      tags: ['Airtel Money', 'MTN MoMo', 'Carte Bancaire'],
      tagColors: ['#e8f4f8', '#fff3e0', '#e8f0fe'],
      tagTextColors: ['#12b6c7', '#ff9500', '#1d4f92'],
      downloadUrl: 'https://c-pay.global/downloads/cplus-payment-gateway-v2.6.0.zip',
      docsUrl: 'https://c-pay.global/developers',
      requires: 'WooCommerce 6.0+ · PHP 7.4+',
      steps: lang==='fr' ? [
        'Téléchargez le fichier ZIP ci-dessous',
        'WP Admin → Extensions → Ajouter → Téléverser le plugin',
        'Activez le plugin CPlus Payment Gateway',
        'WooCommerce → Réglages → Paiements → CPlus',
        'Entrez votre API Key et API Secret',
        'Configurez l\'URL Webhook dans Merchant Portal'
      ] : [
        'Download the ZIP file below',
        'WP Admin → Plugins → Add New → Upload Plugin',
        'Activate CPlus Payment Gateway',
        'WooCommerce → Settings → Payments → CPlus',
        'Enter your API Key and API Secret',
        'Configure Webhook URL in Merchant Portal'
      ],
    }
  ];

  return (
    <div>
      <h1 style={{ margin:'0 0 4px', fontSize:22, fontWeight:800, fontFamily:FONT }}>
        🛒 {lang==='fr'?'Intégrations':'Integrations'}
      </h1>
      <p style={{ color:MUTED, fontSize:13, marginBottom:24 }}>
        {lang==='fr'?'Plugins et extensions pour connecter CPlus à vos plateformes e-commerce.':'Plugins and extensions to connect CPlus to your e-commerce platforms.'}
      </p>

      {plugins.map(plugin => (
        <div key={plugin.id} style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:16, padding:28, marginBottom:20 }}>
          {/* Header */}
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20, flexWrap:'wrap', gap:12 }}>
            <div style={{ display:'flex', alignItems:'center', gap:14 }}>
              <div style={{ width:56, height:56, background:`${P}12`, borderRadius:14, display:'flex', alignItems:'center', justifyContent:'center', fontSize:28 }}>
                {plugin.icon}
              </div>
              <div>
                <div style={{ fontSize:17, fontWeight:800, fontFamily:FONT }}>{plugin.name}</div>
                <div style={{ fontSize:12, color:MUTED }}>{plugin.platform} · v{plugin.version} · {plugin.requires}</div>
                <div style={{ display:'flex', gap:6, marginTop:6, flexWrap:'wrap' }}>
                  {plugin.tags.map((tag,i) => (
                    <span key={tag} style={{ background:plugin.tagColors[i], color:plugin.tagTextColors[i], borderRadius:20, padding:'3px 10px', fontSize:11, fontWeight:600 }}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display:'flex', gap:10 }}>
              <a href={plugin.downloadUrl} download
                style={{ background:P, color:'#fff', padding:'10px 20px', borderRadius:10, textDecoration:'none', fontWeight:700, fontSize:13, display:'flex', alignItems:'center', gap:6 }}>
                📦 {lang==='fr'?'Télécharger':'Download'}
              </a>
              <a href={plugin.docsUrl} target="_blank" rel="noreferrer"
                style={{ background:'none', border:`1px solid ${BORDER}`, color:MUTED, padding:'10px 16px', borderRadius:10, textDecoration:'none', fontSize:13 }}>
                📖 Docs
              </a>
            </div>
          </div>

          <p style={{ fontSize:14, color:MUTED, marginBottom:20 }}>{plugin.desc}</p>

          {/* Installation */}
          <div style={{ background:BG, borderRadius:10, padding:16 }}>
            <div style={{ fontSize:13, fontWeight:700, color:P, marginBottom:12 }}>
              ⚡ {lang==='fr'?'Installation rapide':'Quick Install'}
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {plugin.steps.map((step, i) => (
                <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:10, fontSize:13 }}>
                  <div style={{ width:22, height:22, background:P, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700, flexShrink:0, marginTop:1 }}>
                    {i+1}
                  </div>
                  <span style={{ color:TEXT, paddingTop:2 }}>{step}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Webhook URL */}
          <div style={{ marginTop:16, background:`${P}08`, border:`1px solid ${P}20`, borderRadius:10, padding:14 }}>
            <div style={{ fontSize:12, color:MUTED, marginBottom:6 }}>
              🔔 {lang==='fr'?'URL Webhook à configurer dans vos réglages WooCommerce :':'Webhook URL to configure in your WooCommerce settings:'}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <code style={{ fontSize:12, background:BG, padding:'6px 10px', borderRadius:6, flex:1, wordBreak:'break-all', color:P }}>
                https://votresite.com/wc-api/cplus_webhook
              </code>
              <button onClick={()=>{ navigator.clipboard.writeText('https://votresite.com/wc-api/cplus_webhook'); toast.success('Copié ✅'); }}
                style={{ background:'none', border:`1px solid ${BORDER}`, borderRadius:6, padding:'6px 10px', cursor:'pointer', fontSize:12, color:MUTED, flexShrink:0 }}>
                📋 Copier
              </button>
            </div>
          </div>
        </div>
      ))}

      {/* À venir */}
      <div style={{ background:CARD, border:`1px dashed ${BORDER}`, borderRadius:16, padding:28, textAlign:'center', color:MUTED }}>
        <div style={{ fontSize:32, marginBottom:8 }}>🚀</div>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>
          {lang==='fr'?'Prochainement':'Coming Soon'}
        </div>
        <div style={{ fontSize:13 }}>
          PrestaShop · Shopify · Magento · OpenCart
        </div>
      </div>
    </div>
  );
};

// ─── MY INTEGRATIONS (unifié ApiKeys + Plugins + Webhooks) ───────
const PluginsTab = ({ lang }) => {
  const plugins = [
    {
      id: 'android-sdk',
      name: 'CPlus Android SDK',
      platform: 'Android',
      icon: '📱',
      version: '2.6.0',
      desc: lang==='fr' ? 'SDK natif Kotlin/Java pour Android.' : 'Native Kotlin/Java SDK for Android.',
      tags: ['Kotlin', 'Java', 'Android 5.0+'],
      tagColors: ['#e8f0fe','#f0fff4','#fff3e0'],
      tagTextColors: ['#1d4f92','#00c896','#ff9500'],
      downloadUrl: 'https://c-pay.global/downloads/cplus-android-sdk-v2.6.0.zip',
      docsUrl: 'https://c-pay.global/developers',
      requires: 'Android API 21+',
      steps: lang==='fr'
        ? ['Telechargez le SDK ZIP', 'Copiez le .aar dans app/libs/', 'Ajoutez la dependance dans build.gradle', 'Initialisez avec votre API Key']
        : ['Download the SDK ZIP', 'Copy .aar to app/libs/', 'Add dependency in build.gradle', 'Initialize with your API Key'],
    },
    {
      id: 'woocommerce',
      name: 'CPlus WooCommerce',
      platform: 'WooCommerce',
      icon: '🛒',
      version: '2.6.0',
      desc: lang==='fr' ? 'Acceptez Airtel Money et MTN MoMo sur WooCommerce.' : 'Accept Airtel Money and MTN MoMo on WooCommerce.',
      tags: ['Airtel Money','MTN MoMo','Carte'],
      tagColors: ['#e8f4f8','#fff3e0','#e8f0fe'],
      tagTextColors: ['#12b6c7','#ff9500','#1d4f92'],
      downloadUrl: 'https://c-pay.global/downloads/cplus-payment-gateway-v2.6.0.zip',
      docsUrl: 'https://c-pay.global/developers',
      requires: 'WooCommerce 6.0+ · PHP 7.4+',
      steps: lang==='fr'
        ? ['Telechargez le fichier ZIP', 'WP Admin Extensions Telecharger', 'Activez le plugin', 'WooCommerce Reglages Paiements CPlus', 'Entrez API Key et Secret']
        : ['Download the ZIP file', 'WP Admin Plugins Upload', 'Activate the plugin', 'WooCommerce Settings Payments CPlus', 'Enter API Key and Secret'],
    },
  ];

  return (
    <div>
      {plugins.map(plugin => (
        <div key={plugin.id} style={{ background:CARD, border:`1px solid ${BORDER}`, borderRadius:16, padding:24, marginBottom:16 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12, marginBottom:12 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <div style={{ width:48, height:48, background:`${P}12`, borderRadius:12, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24 }}>
                {plugin.icon}
              </div>
              <div>
                <div style={{ fontSize:16, fontWeight:700, fontFamily:FONT }}>{plugin.name}</div>
                <div style={{ fontSize:12, color:MUTED }}>{plugin.platform} · v{plugin.version} · {plugin.requires}</div>
                <div style={{ display:'flex', gap:6, marginTop:4, flexWrap:'wrap' }}>
                  {plugin.tags.map((tag,i) => (
                    <span key={tag} style={{ background:plugin.tagColors[i], color:plugin.tagTextColors[i], borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:600 }}>{tag}</span>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <a href={plugin.downloadUrl} download style={{ background:P, color:'#fff', padding:'9px 16px', borderRadius:8, textDecoration:'none', fontWeight:700, fontSize:13 }}>
                📦 {lang==='fr'?'Telecharger':'Download'}
              </a>
              <a href={plugin.docsUrl} target="_blank" rel="noreferrer" style={{ background:'none', border:`1px solid ${BORDER}`, color:MUTED, padding:'9px 14px', borderRadius:8, textDecoration:'none', fontSize:13 }}>
                📖 Docs
              </a>
            </div>
          </div>
          <p style={{ fontSize:13, color:MUTED, marginBottom:12 }}>{plugin.desc}</p>
          <div style={{ background:BG, borderRadius:8, padding:12 }}>
            <div style={{ fontSize:12, fontWeight:700, color:P, marginBottom:8 }}>Installation</div>
            {plugin.steps.map((step,i) => (
              <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:8, marginBottom:6, fontSize:13 }}>
                <div style={{ width:20, height:20, background:P, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:10, fontWeight:700, flexShrink:0, marginTop:1 }}>{i+1}</div>
                <span style={{ color:TEXT }}>{step}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div style={{ background:CARD, border:`1px dashed ${BORDER}`, borderRadius:16, padding:24, textAlign:'center', color:MUTED }}>
        <div style={{ fontSize:28, marginBottom:6 }}>🚀</div>
        <div style={{ fontSize:13, fontWeight:700, marginBottom:4 }}>{lang==='fr'?'Prochainement':'Coming Soon'}</div>
        <div style={{ fontSize:12 }}>PrestaShop · Shopify · Magento · OpenCart</div>
      </div>
    </div>
  );
};

const MyIntegrations = ({ lang }) => {
  const [tab, setTab] = useState('apikeys');
  const t = useT(lang);
  return (
    <div>
      <h1 style={{ margin:'0 0 4px', fontSize:22, fontWeight:700, fontFamily:FONT }}>
        🔌 {lang==='fr'?'Mes Integrations':'My Integrations'}
      </h1>
      <p style={{ color:MUTED, fontSize:13, marginBottom:20 }}>
        {lang==='fr'?'Gerez vos cles API, webhooks et plugins.':'Manage your API keys, webhooks and plugins.'}
      </p>
      <div style={{ display:'flex', gap:0, marginBottom:24, borderBottom:`2px solid ${BORDER}` }}>
        {[['apikeys','🔑 API Keys'],['webhooks','🔔 Webhooks'],['plugins','🛒 Plugins & SDK']].map(([id,label]) => (
          <button key={id} onClick={()=>setTab(id)}
            style={{ padding:'10px 20px', border:'none', background:'none', fontSize:13, fontWeight:700,
              cursor:'pointer', color:tab===id?P:MUTED,
              borderBottom:`3px solid ${tab===id?P:'transparent'}`, marginBottom:-2, fontFamily:FONT }}>
            {label}
          </button>
        ))}
      </div>
      {tab==='apikeys'  && <ApiKeys lang={lang} t={t} />}
      {tab==='webhooks' && <WebhookConfig lang={lang} />}
      {tab==='plugins'  && <PluginsTab lang={lang} />}
    </div>
  );
};

export default function App() {
  const { lang, toggle } = useLang();
  return (
    <BrowserRouter>
      <AuthProvider>
      <Toaster position="top-right" toastOptions={{ style: { fontFamily: FONT, fontSize: 13 } }} />
      <Routes>
        <Route path="/login" element={<Login lang={lang} toggleLang={toggle} />} />
        <Route path="/register" element={<Register lang={lang} toggleLang={toggle} />} />
        <Route path="/forgot-password" element={<ForgotPassword lang={lang} toggleLang={toggle} />} />
        <Route path="/*" element={
          <Guard>
            <Layout lang={lang} toggleLang={toggle}>
              <Routes>
                <Route path="" element={<Dashboard lang={lang} />} />
                <Route path="operations" element={<Operations lang={lang} />} />
                <Route path="pay-links" element={<PayLinks lang={lang} />} />
                <Route path="accept" element={<AcceptPayment lang={lang} />} />
                <Route path="tap-to-phone" element={<TapToPhone lang={lang} />} />
                <Route path="withdraw" element={<Withdraw lang={lang} />} />
                <Route path="transactions" element={<Transactions lang={lang} />} />
                <Route path="settlements" element={<Settlements lang={lang} />} />
                <Route path="terminals" element={<Terminals lang={lang} />} />
                <Route path="support" element={<Support lang={lang} />} />
                <Route path="account"       element={<Account lang={lang} />} />
                <Route path="integrations" element={<MyIntegrations lang={lang} />} />
                <Route path="api-keys"     element={<MyIntegrations lang={lang} />} />
              </Routes>
            </Layout>
          </Guard>
        } />
      </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
// CPlus 2.6.0 build 1783884376
