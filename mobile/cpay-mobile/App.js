import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import QRCode from 'react-native-qrcode-svg';

// ─── Configuration ───────────────────────────────────────────────
const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://api.c-pay.global';
const API = `${API_BASE}/api/v1`;
const APP_NAME = 'C-Pay';
const APP_EDITOR = 'Calculus Plus SAS';
const APP_VERSION = '2.7.0';

// Message affiche pour toute fonction desactivee cote serveur (410 FEATURE_DISABLED)
// ou pour une route qui n'existe plus (404 sans corps JSON).
const FEATURE_PENDING = 'Fonctionnalité en cours d’intégration';
const PENDING_CONFIRMATION = 'En attente de confirmation';

// Rafraichissement proactif : 60 s avant l'expiration de l'access token (15 min).
const REFRESH_MARGIN_MS = 60 * 1000;
const DEFAULT_EXPIRES_IN = 900;

// Suivi d'un encaissement en attente : toutes les 3 s pendant 90 s maximum.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 90 * 1000;

// Confirmation forte (caisse) : nombre de saisies avant abandon.
const STEP_UP_ATTEMPTS = 3;

const C = {
  bg: '#f6f8fb',
  card: '#ffffff',
  blue: '#1f5fa8',
  darkBlue: '#1d4f92',
  cyan: '#12b6c7',
  text: '#243247',
  muted: '#5a6270',
  border: '#d7dee8',
  red: '#e53935',
  green: '#12805c',
  amber: '#b26a00',
};

const money = (v, currency = '') => `${Number(v || 0).toLocaleString('fr-FR')} ${currency || ''}`.trim();
const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const newIdempotencyKey = () => `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;

// ─── Erreurs API ─────────────────────────────────────────────────
class ApiError extends Error {
  constructor(message, { status = 0, code = null, data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

class AuthError extends Error {
  constructor(message = 'Session expirée, veuillez vous reconnecter') {
    super(message);
    this.name = 'AuthError';
  }
}

// 410 FEATURE_DISABLED, ou route supprimee (404 sans corps JSON d'erreur) :
// la fonction est affichee comme « en cours d'intégration », jamais comme une panne.
const isFeatureUnavailable = (err) =>
  !!err && (err.code === 'FEATURE_DISABLED' || err.status === 410 || (err.status === 404 && !err.data?.error));

const userMessage = (err) => (isFeatureUnavailable(err) ? FEATURE_PENDING : err?.message || 'Erreur inattendue');

// ─── Session (expo-secure-store) ─────────────────────────────────
// Forme : { mode: 'merchant' | 'admin', accessToken, refreshToken, expiresAt, user, mustChangePassword }
// Les jetons sont stockes dans le Keychain / Keystore (expo-secure-store), jamais
// dans AsyncStorage. Le profil utilisateur (non secret) est stocke a part pour
// rester sous la limite de 2 Ko par entree de SecureStore. AsyncStorage ne garde
// que des preferences non sensibles (dernier mode de connexion).
const SECURE_SESSION_KEY = 'cpay.session';
const SECURE_USER_KEY = 'cpay.user';
const PREF_MODE_KEY = 'cpay.pref.mode';

const secureGet = async (key) => {
  try { return await SecureStore.getItemAsync(key); } catch { return null; }
};
const secureSet = async (key, value) => {
  try { await SecureStore.setItemAsync(key, value); } catch { /* SecureStore indisponible (web, simulateur) : session en memoire seulement */ }
};
const secureDelete = async (key) => {
  try { await SecureStore.deleteItemAsync(key); } catch { /* idem */ }
};

async function loadStoredSession() {
  const [raw, rawUser] = await Promise.all([secureGet(SECURE_SESSION_KEY), secureGet(SECURE_USER_KEY)]);
  if (!raw) return null;
  try {
    const base = JSON.parse(raw);
    if (!base?.accessToken || !base?.refreshToken || !base?.mode) return null;
    let user = null;
    try { user = rawUser ? JSON.parse(rawUser) : null; } catch { user = null; }
    return { ...base, user };
  } catch {
    return null;
  }
}

async function persistSession(session) {
  if (!session) {
    await Promise.all([secureDelete(SECURE_SESSION_KEY), secureDelete(SECURE_USER_KEY)]);
    return;
  }
  const { user, ...tokens } = session;
  await Promise.all([
    secureSet(SECURE_SESSION_KEY, JSON.stringify(tokens)),
    secureSet(SECURE_USER_KEY, JSON.stringify(user || null)),
  ]);
}

// Magasin de session partage entre les ecrans React et le client HTTP : quand un
// refresh echoue dans apiFetch, la session est videe ici et l'UI revient au login.
const authStore = {
  session: null,
  listeners: new Set(),
  get() { return this.session; },
  async set(next) {
    this.session = next;
    this.listeners.forEach((fn) => fn(next));
    await persistSession(next);
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
};

// Construit une session a partir d'une reponse { access_token, refresh_token, expires_in, user|admin, mustChangePassword }
const sessionFromResponse = (mode, data, previous = null) => ({
  mode,
  accessToken: data.access_token,
  refreshToken: data.refresh_token,
  expiresAt: Date.now() + (Number(data.expires_in) || DEFAULT_EXPIRES_IN) * 1000,
  user: data.user || data.admin || previous?.user || null,
  mustChangePassword: data.mustChangePassword !== undefined ? !!data.mustChangePassword : !!previous?.mustChangePassword,
});

// ─── Rafraichissement (vol unique) ───────────────────────────────
// Un seul appel /auth/refresh a la fois : les requetes concurrentes attendent la
// meme promesse. Le refresh est opaque et tourne a chaque usage ; reutiliser un
// jeton consomme renvoie 401 REFRESH_REUSED et revoque toutes les sessions.
let refreshInFlight = null;

async function doRefresh() {
  const current = authStore.get();
  if (!current?.refreshToken) throw new AuthError();
  let res;
  let data = {};
  try {
    res = await fetch(`${API}/${current.mode}/auth/refresh`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    });
    data = await res.json().catch(() => ({}));
  } catch (networkErr) {
    // Reseau indisponible : on garde la session, l'appelant recevra une erreur reseau.
    throw new ApiError('Réseau indisponible', { status: 0, code: 'NETWORK' });
  }
  if (!res.ok || !data.access_token || !data.refresh_token) {
    await authStore.set(null);
    throw new AuthError(data.code === 'REFRESH_REUSED' ? 'Session révoquée par sécurité, veuillez vous reconnecter' : undefined);
  }
  const next = sessionFromResponse(current.mode, data, current);
  await authStore.set(next);
  return next;
}

function refreshSession() {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

// ─── Client HTTP ─────────────────────────────────────────────────
// auth: true  -> Bearer + refresh proactif (< 60 s) + refresh unique sur 401 puis rejeu.
// auth: false -> appel anonyme (login, 2FA, refresh, logout).
async function apiFetch(path, { auth = true, method = 'GET', body, idempotencyKey, _retried = false } = {}) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  if (auth) {
    let session = authStore.get();
    if (!session?.accessToken) throw new AuthError();
    if (!session.expiresAt || session.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      session = await refreshSession();
    }
    headers.Authorization = `Bearer ${session.accessToken}`;
  }

  let res;
  try {
    res = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new ApiError('Réseau indisponible', { status: 0, code: 'NETWORK' });
  }
  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && auth && !_retried) {
    await refreshSession(); // jette AuthError (session videe) si le refresh echoue
    return apiFetch(path, { auth, method, body, idempotencyKey, _retried: true });
  }
  if (res.status === 401 && auth) {
    await authStore.set(null);
    throw new AuthError();
  }
  if (!res.ok) {
    throw new ApiError(data.error || data.message || `HTTP ${res.status}`, { status: res.status, code: data.code || null, data });
  }
  return data;
}

async function logout() {
  const current = authStore.get();
  if (current?.refreshToken) {
    try {
      await fetch(`${API}/${current.mode}/auth/logout`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${current.accessToken}` },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
    } catch { /* le refresh expire de lui-meme cote serveur */ }
  }
  await authStore.set(null);
}

function useSession() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState(authStore.get());

  useEffect(() => {
    const unsubscribe = authStore.subscribe(setSession);
    (async () => {
      const stored = await loadStoredSession();
      if (stored) {
        authStore.session = stored;
        setSession(stored);
        // Revalidation au demarrage : profil frais + mustChangePassword ;
        // un refresh impossible renvoie au login.
        try {
          const me = await apiFetch(`/${stored.mode}/auth/me`);
          const live = authStore.get();
          if (live) await authStore.set({ ...live, user: me.user || me.admin || live.user, mustChangePassword: !!me.mustChangePassword });
        } catch (e) {
          // AuthError : la session a deja ete videe par apiFetch ; erreur reseau ou
          // autre : on garde la session stockee.
        }
      }
      setReady(true);
    })();
    return unsubscribe;
  }, []);

  return { ready, session };
}

// ─── Application ─────────────────────────────────────────────────
export default function App() {
  const { ready, session } = useSession();
  const [tab, setTab] = useState('home');
  const { width } = useWindowDimensions();
  const profile = width >= 900 ? 'tablet' : width >= 520 ? 'tpe' : 'phone';

  useEffect(() => { setTab('home'); }, [session?.mode, session?.user?.userId, session?.user?.adminId]);

  if (!ready) return <Splash />;
  if (!session) return <AuthScreen />;
  if (session.mustChangePassword) return <ChangePasswordScreen session={session} />;

  const isAdmin = session.mode === 'admin';
  const tabs = isAdmin
    ? [['home', 'Accueil'], ['apis', 'APIs'], ['merchants', 'Marchands'], ['monitoring', 'Monitoring'], ['rails', 'Rails'], ['pilot', 'Pilot']]
    : [['home', 'Caisse'], ['collect', 'Encaisser'], ['withdraw', 'Retirer'], ['transfers', 'Transférer'], ['journal', 'Journal'], ['links', 'QR/Lien'], ['history', 'Historique'], ['tokens', 'Tokens'], ['integrations', 'CRM/Compta'], ['pilot', 'Pilot'], ['support', 'Support']];

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <View style={s.top}>
        <View>
          <Text style={s.brand}>{APP_NAME}</Text>
          <Text style={s.sub}>{isAdmin ? 'Administrateur' : session.user?.businessName || 'Marchand'}</Text>
        </View>
        <Pressable style={s.ghostBtn} onPress={logout}><Text style={s.ghostText}>Sortir</Text></Pressable>
      </View>
      <Text style={s.deviceHint}>{profile === 'tablet' ? 'Mode tablette' : profile === 'tpe' ? 'Mode TPE' : 'Mode téléphone'}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabs}>
        {tabs.map(([key, label]) => (
          <Pressable key={key} onPress={() => setTab(key)} style={[s.tab, tab === key && s.tabOn]}>
            <Text style={[s.tabText, tab === key && s.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {isAdmin ? <AdminApp tab={tab} session={session} /> : <MerchantApp tab={tab} session={session} onNavigate={setTab} />}
      <StepUpHost />
    </SafeAreaView>
  );
}

function Splash() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={C.cyan} />
      <Text style={s.logo}>{APP_NAME}</Text>
      <Text style={s.muted}>par {APP_EDITOR}</Text>
    </View>
  );
}

// ─── Connexion / inscription / 2FA ───────────────────────────────
function AuthScreen() {
  const [mode, setMode] = useState('merchant');
  const [register, setRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mfa, setMfa] = useState(null); // { mfaToken }
  const [code, setCode] = useState('');
  const [form, setForm] = useState({ emailOrPhone: '', email: '', phone: '', password: '', businessName: '' });

  useEffect(() => {
    AsyncStorage.getItem(PREF_MODE_KEY).then((v) => { if (v === 'admin' || v === 'merchant') setMode(v); }).catch(() => {});
  }, []);

  const patch = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const finish = async (data) => {
    AsyncStorage.setItem(PREF_MODE_KEY, mode).catch(() => {});
    await authStore.set(sessionFromResponse(mode, data));
  };

  const submit = async () => {
    setLoading(true);
    try {
      const path = mode === 'admin'
        ? '/admin/auth/login'
        : register ? '/merchant/auth/register' : '/merchant/auth/login';
      const body = mode === 'admin'
        ? { email: (form.email || form.emailOrPhone).trim(), password: form.password }
        : register
          ? { businessName: form.businessName, email: form.email.trim(), phone: form.phone.trim(), password: form.password }
          : { emailOrPhone: form.emailOrPhone.trim(), password: form.password };
      const data = await apiFetch(path, { auth: false, method: 'POST', body });
      if (data.mfaRequired && data.mfaToken) {
        setMfa({ mfaToken: data.mfaToken });
        setCode('');
        return;
      }
      await finish(data);
    } catch (err) {
      Alert.alert(register ? 'Inscription' : 'Connexion', userMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const validateCode = async () => {
    const clean = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return Alert.alert('Code 2FA', 'Saisissez le code à 6 chiffres de votre application d’authentification.');
    setLoading(true);
    try {
      const data = await apiFetch(`/${mode}/auth/2fa/validate`, { auth: false, method: 'POST', body: { mfaToken: mfa.mfaToken, code: clean } });
      await finish(data);
    } catch (err) {
      if (err.code === 'INVALID_MFA_TOKEN') {
        // Jeton MFA expire (5 min) : retour a l'ecran de connexion.
        setMfa(null);
        Alert.alert('Code 2FA', 'Délai dépassé, veuillez vous reconnecter.');
      } else {
        Alert.alert('Code 2FA', userMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  if (mfa) {
    return (
      <SafeAreaView style={s.safe}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={s.auth} keyboardShouldPersistTaps="handled">
          <Text style={s.logo}>{APP_NAME}</Text>
          <Text style={s.h1}>Vérification en deux étapes</Text>
          <Text style={s.muted}>Saisissez le code à 6 chiffres généré par votre application d’authentification.</Text>
          <Field label="Code à 6 chiffres" value={code} onChange={(v) => setCode(v.replace(/[^0-9]/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6} autoFocus />
          <Button label={loading ? 'Vérification...' : 'Valider'} onPress={validateCode} disabled={loading || code.length !== 6} />
          <MiniButton label="Annuler" onPress={() => setMfa(null)} full />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={s.auth} keyboardShouldPersistTaps="handled">
        <Text style={s.logo}>{APP_NAME}</Text>
        <Text style={s.muted}>par {APP_EDITOR} · Android & iOS</Text>
        <Segment value={mode} onChange={(v) => { setMode(v); setRegister(false); }} items={[['merchant', 'Marchand'], ['admin', 'Admin']]} />
        {mode === 'merchant' && <Segment value={register ? 'register' : 'login'} onChange={(v) => setRegister(v === 'register')} items={[['login', 'Connexion'], ['register', 'Créer compte']]} />}
        {mode === 'merchant' && register && <Field label="Nom commercial" value={form.businessName} onChange={(v) => patch('businessName', v)} />}
        {mode === 'merchant' && register && <Field label="Téléphone" value={form.phone} onChange={(v) => patch('phone', v)} keyboardType="phone-pad" placeholder="+242..." />}
        {(register || mode === 'admin') && <Field label="Email" value={form.email} onChange={(v) => patch('email', v)} keyboardType="email-address" autoCapitalize="none" placeholder={mode === 'admin' ? 'admin@c-pay.global' : 'marchand@exemple.com'} />}
        {mode === 'merchant' && !register && <Field label="Email ou téléphone" value={form.emailOrPhone} onChange={(v) => patch('emailOrPhone', v)} autoCapitalize="none" />}
        <Field label="Mot de passe" value={form.password} onChange={(v) => patch('password', v)} secureTextEntry />
        {register && <Text style={s.muted}>10 caractères minimum.</Text>}
        <Button label={loading ? 'Traitement...' : register ? 'Créer le compte' : 'Se connecter'} onPress={submit} disabled={loading} />
        <Text style={s.footer}>{APP_NAME} {APP_VERSION} · {APP_EDITOR}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Changement de mot de passe force (mustChangePassword) ───────
function ChangePasswordScreen({ session }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (newPassword.length < 10) return Alert.alert('Mot de passe', 'Le nouveau mot de passe doit contenir au moins 10 caractères.');
    if (newPassword !== confirm) return Alert.alert('Mot de passe', 'Les deux saisies ne correspondent pas.');
    if (newPassword === currentPassword) return Alert.alert('Mot de passe', 'Le nouveau mot de passe doit être différent de l’actuel.');
    setLoading(true);
    try {
      await apiFetch(`/${session.mode}/auth/change-password`, { method: 'POST', body: { currentPassword, newPassword } });
      // Le serveur revoque toutes les sessions (refresh) : on repasse par le login.
      await authStore.set(null);
      Alert.alert('Mot de passe modifié', 'Reconnectez-vous avec votre nouveau mot de passe.');
    } catch (err) {
      Alert.alert('Mot de passe', userMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={s.auth} keyboardShouldPersistTaps="handled">
        <Text style={s.logo}>{APP_NAME}</Text>
        <Text style={s.h1}>Nouveau mot de passe requis</Text>
        <Text style={s.muted}>Votre mot de passe est temporaire. Choisissez-en un nouveau avant de continuer.</Text>
        <Field label="Mot de passe actuel" value={currentPassword} onChange={setCurrentPassword} secureTextEntry />
        <Field label="Nouveau mot de passe (10 caractères min.)" value={newPassword} onChange={setNewPassword} secureTextEntry />
        <Field label="Confirmer le nouveau mot de passe" value={confirm} onChange={setConfirm} secureTextEntry />
        <Button label={loading ? 'Enregistrement...' : 'Enregistrer'} onPress={submit} disabled={loading} />
        <MiniButton label="Se déconnecter" onPress={logout} full />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Marchand ────────────────────────────────────────────────────
function MerchantApp({ tab, session, onNavigate }) {
  if (tab === 'collect') return <CollectScreen session={session} />;
  if (tab === 'withdraw') return <WithdrawScreen session={session} />;
  if (tab === 'transfers') return <TransfersScreen session={session} />;
  if (tab === 'journal') return <JournalScreen session={session} />;
  if (tab === 'links') return <LinkScreen session={session} />;
  if (tab === 'history') return <HistoryScreen session={session} />;
  if (tab === 'tokens') return <TokensScreen session={session} />;
  if (tab === 'integrations') return <IntegrationsScreen session={session} />;
  if (tab === 'pilot') return <PilotScreen session={session} />;
  if (tab === 'support') return <SupportScreen session={session} />;
  return <CaisseHome session={session} onNavigate={onNavigate} />;
}

// ─── Caisse marchande (vague 4, docs/CAISSE-API.md) ──────────────
// Vocation : encaisser (Mobile Money, carte), retirer vers son wallet, transférer
// wallet ↔ banque, journal unique. Toute création de mouvement porte Idempotency-Key.
const CASH_TYPES = [['', 'Tous'], ['collect', 'Encaissements'], ['withdraw', 'Retraits'], ['transfer_out', 'Vers banque'], ['transfer_in', 'Approvisionnements']];
const OPERATORS = [['mtn_momo', 'MTN MoMo'], ['orange_money', 'Orange Money'], ['airtel_money', 'Airtel Money'], ['moov_money', 'Moov Money'], ['wave', 'Wave'], ['express_union', 'Express Union'], ['mpesa', 'M-Pesa'], ['free_money', 'Free Money']];
const QUICK_AMOUNTS = [1000, 2000, 5000, 10000, 25000];

const operatorLabel = (code) => {
  if (!code) return 'Mobile Money';
  const key = String(code).toLowerCase();
  const hit = OPERATORS.find(([k]) => k === key) || OPERATORS.find(([k]) => k.startsWith(`${key}_`));
  return hit ? hit[1] : String(code).replace(/_/g, ' ');
};
// Opérateur du wallet déduit d'une détection /detect/phone (codes MTN, ORANGE, WAVE…).
const operatorCodeFor = (d) => {
  const op = String(d?.operator || '').toLowerCase();
  const brand = String(d?.brand || '§').toLowerCase();
  const hit = OPERATORS.find(([k, l]) => k === op || k.startsWith(`${op}_`) || l.toLowerCase().includes(brand));
  return hit ? hit[0] : null;
};
const transferStatusLabel = (st) => ({
  pending: 'En attente', processing: 'En cours', pending_manual: 'Traitement J+1', awaiting_funds: 'Virement attendu',
  completed: 'Effectué', failed: 'Échoué', cancelled: 'Annulé', rejected: 'Rejeté', authorized: 'Autorisé', expired: 'Expiré',
}[st] || st || '—');
const fmtDate = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '');
const parseAmount = (v) => Number(String(v || '').replace(/\s/g, '').replace(',', '.'));

// Messages dédiés aux codes de la caisse (INSUFFICIENT_BALANCE, DAILY_LIMIT_EXCEEDED, WALLET_MISSING…).
const cashMessage = (err, currency = 'XAF') => {
  if (!err) return 'Erreur';
  if (isFeatureUnavailable(err)) return FEATURE_PENDING;
  switch (err.code) {
    case 'INSUFFICIENT_BALANCE': return `Solde insuffisant${err.data?.available != null ? ` — disponible : ${money(err.data.available, currency)}` : ''}`;
    case 'DAILY_LIMIT_EXCEEDED': return 'Plafond journalier de retrait atteint (selon votre niveau KYB)';
    case 'WALLET_MISSING': return 'Aucun wallet Mobile Money enregistré : ajoutez-le avant de retirer';
    case 'STEP_UP_REQUIRED': return 'Confirmation requise (code 2FA ou mot de passe)';
    case 'CURRENCY_MISMATCH': return 'La devise du numéro client ne correspond pas à celle de votre compte';
    case 'FUNDING_UNAVAILABLE': return 'Aucun compte de collecte C-Pay pour votre devise — contactez le support';
    case 'MERCHANT_INACTIVE': return 'Compte marchand inactif — contactez le support';
    default:
      if (err.status === 429) return 'Trop de tentatives — réessayez dans quelques minutes';
      return err.message || 'Erreur';
  }
};

// ─── Confirmation forte (step-up, §6) ────────────────────────────
// { code } (TOTP) si le 2FA du compte est actif (session.user.mfaEnabled via /auth/me),
// sinon { password }. Sur 428 STEP_UP_REQUIRED { methods } on relit la méthode annoncée
// et on redemande, 3 essais au plus. Le modal est hébergé une seule fois (StepUpHost).
const stepUpStore = {
  request: null,
  listeners: new Set(),
  set(r) { this.request = r; this.listeners.forEach((fn) => fn(r)); },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};
const requestStepUp = (method, title) => new Promise((resolve) => stepUpStore.set({ method, title, resolve }));

async function withStepUp(session, title, fn) {
  let method = session?.user?.mfaEnabled ? 'totp' : 'password';
  for (let attempt = 0; attempt < STEP_UP_ATTEMPTS; attempt += 1) {
    const confirm = await requestStepUp(method, title);
    if (!confirm) return null; // annulé par l'utilisateur
    try {
      return await fn(confirm);
    } catch (e) {
      if (e.status === 428 || e.code === 'STEP_UP_REQUIRED') {
        method = e.data?.methods?.[0] || method;
        if (attempt < STEP_UP_ATTEMPTS - 1) continue;
      }
      throw e;
    }
  }
  return null;
}

function StepUpHost() {
  const [req, setReq] = useState(stepUpStore.request);
  const [value, setValue] = useState('');
  useEffect(() => stepUpStore.subscribe((r) => { setReq(r); setValue(''); }), []);
  if (!req) return null;
  const totp = req.method === 'totp';
  const done = (confirm) => { const r = req; stepUpStore.set(null); r.resolve(confirm); };
  const valid = totp ? /^\d{6}$/.test(value) : value.length > 0;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => done(null)}>
      <View style={s.modalBg}>
        <View style={s.modalCard}>
          <Text style={s.cardTitle}>{req.title || 'Confirmation requise'}</Text>
          <Text style={s.muted}>{totp ? 'Saisissez le code à 6 chiffres de votre application d’authentification.' : 'Saisissez votre mot de passe pour confirmer l’opération.'}</Text>
          <Field
            label={totp ? 'Code 2FA' : 'Mot de passe'}
            value={value}
            onChange={(v) => setValue(totp ? v.replace(/[^0-9]/g, '').slice(0, 6) : v)}
            keyboardType={totp ? 'number-pad' : 'default'}
            secureTextEntry={!totp}
            maxLength={totp ? 6 : undefined}
            autoFocus
          />
          <Button label="Confirmer" onPress={() => valid && done(totp ? { code: value } : { password: value })} disabled={!valid} />
          <MiniButton label="Annuler" onPress={() => done(null)} full />
        </View>
      </View>
    </Modal>
  );
}

// ─── Hooks caisse ────────────────────────────────────────────────
function useCashSummary() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    setError(null);
    try { setSummary(await apiFetch('/merchant/cash/summary')); } catch (e) { if (!(e instanceof AuthError)) setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  return { summary, error, loading, reload: load };
}

// Détection live de l'opérateur : POST /detect/phone (public), debounce 450 ms.
function usePhoneDetection(phone) {
  const [detection, setDetection] = useState(null);
  const [detecting, setDetecting] = useState(false);
  useEffect(() => {
    const clean = String(phone || '').trim();
    if (clean.replace(/\D/g, '').length < 8) { setDetection(null); setDetecting(false); return undefined; }
    let cancelled = false;
    setDetecting(true);
    const timer = setTimeout(async () => {
      try {
        const d = await apiFetch('/detect/phone', { auth: false, method: 'POST', body: { phone: clean } });
        if (!cancelled) setDetection(d);
      } catch (e) {
        if (!cancelled) setDetection(e.data?.code ? e.data : { success: false, error: 'Détection indisponible (réseau)', code: 'NETWORK' });
      } finally {
        if (!cancelled) setDetecting(false);
      }
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [phone]);
  return { detection, detecting };
}

// Suivi d'un encaissement : GET /merchant/cash/collect/:txnId toutes les 3 s, 90 s max,
// puis « En attente de confirmation ».
function useCashCollectPolling(result, setResult) {
  const [polling, setPolling] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const txnId = result?.txnId;
    const pending = !!result && (!result.status || result.status === 'pending');
    if (!txnId || !pending) { setPolling(false); return undefined; }
    let cancelled = false;
    let timer = null;
    const startedAt = Date.now();
    setPolling(true);
    setTimedOut(false);
    const tick = async () => {
      if (cancelled) return;
      try {
        const st = await apiFetch(`/merchant/cash/collect/${encodeURIComponent(txnId)}`);
        if (cancelled) return;
        if (st.status && st.status !== 'pending') { setResult({ ...result, ...st }); setPolling(false); return; }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof AuthError) { setPolling(false); return; }
        // erreur passagère : on continue jusqu'au délai maximum
      }
      if (Date.now() - startedAt >= POLL_MAX_MS) { setPolling(false); setTimedOut(true); return; }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [result?.txnId, result?.status]);
  return { polling, timedOut };
}

// ─── Caisse : accueil ────────────────────────────────────────────
function CaisseHome({ session, onNavigate }) {
  const { summary, error, loading, reload } = useCashSummary();
  const cur = summary?.currency || session.user?.currency || 'XAF';
  const bal = summary?.balance || {};
  const today = summary?.today || {};
  const p = summary?.profile;
  const walletMissing = !!p && !p.wallet?.phone;
  const noBank = !!p && !(p.bankAccounts > 0);
  const tiles = [
    ['collect', '📥', 'Encaisser', 'Mobile Money · Carte'],
    ['withdraw', '📤', 'Retirer', 'Vers mon wallet'],
    ['transfers', '🏦', 'Transférer', 'Wallet ↔ banque'],
    ['journal', '📒', 'Journal', 'Tous les mouvements'],
  ];
  return (
    <Screen>
      <View style={s.rowBetween}>
        <View><Text style={s.h1}>Caisse</Text><Text style={s.muted}>{session.user?.businessName || 'Marchand'}</Text></View>
        <Pressable style={s.ghostBtn} onPress={reload}><Text style={s.ghostText}>↻ Actualiser</Text></Pressable>
      </View>
      {loading && !summary ? <ActivityIndicator color={C.cyan} /> : null}
      {error ? <Notice title="Caisse" text={isFeatureUnavailable(error) ? 'Caisse en cours d’activation sur votre compte' : cashMessage(error, cur)} /> : null}
      <View style={s.balanceCard}>
        <Text style={s.balanceLabel}>Solde disponible</Text>
        <Text style={s.balanceValue}>{money(bal.available, cur)}</Text>
        <Text style={s.balanceSub}>En attente : {money(bal.pending, cur)}{bal.reserved ? ` · Réservé : ${money(bal.reserved, cur)}` : ''}</Text>
      </View>
      <View style={s.card}>
        <View style={s.rowBetween}><Text style={s.cardTitle}>Aujourd’hui</Text><Text style={s.muted}>{today.collectedCount || 0} encaissement(s)</Text></View>
        <Text style={s.amount}>{money(today.collected, cur)}</Text>
        <InfoGrid items={[
          ['📱 Mobile Money', money(today.byMethod?.mobile_money, cur)],
          ['💳 Carte', money(today.byMethod?.card, cur)],
          ['📤 Retiré', money((today.withdrawn || 0) + (today.transfersOut || 0), cur)],
          ['💰 Approvisionné', money(today.transfersIn, cur)],
        ]} />
      </View>
      {walletMissing ? <Pressable onPress={() => onNavigate('withdraw')}><Notice title="Wallet manquant" text="Enregistrez votre wallet Mobile Money pour pouvoir retirer vos fonds →" /></Pressable> : null}
      {noBank ? <Pressable onPress={() => onNavigate('transfers')}><Notice title="Compte bancaire" text="Ajoutez un compte bancaire vérifié (portail marchand) pour transférer vers votre banque →" /></Pressable> : null}
      {p?.cardAcceptance === 'unavailable' ? <Text style={s.muted}>ℹ️ L’acceptation carte n’est pas encore disponible dans votre pays.</Text> : null}
      {p?.cardAcceptance === 'tap_to_phone_pending' ? <Text style={s.muted}>ℹ️ Tap-to-Phone en cours de certification — utilisez le lien de paiement carte.</Text> : null}
      <View style={s.tiles}>
        {tiles.map(([key, icon, title, sub]) => {
          const primary = key === 'collect';
          return (
            <Pressable key={key} style={[s.tile, primary && s.tileOn]} onPress={() => onNavigate(key)}>
              <Text style={s.tileIcon}>{icon}</Text>
              <Text style={[s.tileTitle, primary && { color: C.card }]}>{title}</Text>
              <Text style={[s.tileSub, primary && { color: '#d9ffffff' }]}>{sub}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={s.section}>Autres</Text>
      <View style={s.row}>
        <MiniButton label="QR / Lien" onPress={() => onNavigate('links')} />
        <MiniButton label="Historique" onPress={() => onNavigate('history')} />
        <MiniButton label="Support" onPress={() => onNavigate('support')} />
      </View>
    </Screen>
  );
}

// ─── Encaisser ───────────────────────────────────────────────────
function CollectScreen({ session }) {
  const [mode, setMode] = useState('mobile_money');
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [description, setDescription] = useState('');
  const [operator, setOperator] = useState(null); // service forcé (Wave, Express Union…)
  const [result, setResult] = useState(null);
  const [card, setCard] = useState(null);         // { shortUrl, expiresAt } | { unavailable: true }
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const idemKey = useRef(newIdempotencyKey());
  const { detection, detecting } = usePhoneDetection(mode === 'mobile_money' ? phone : '');
  const { polling, timedOut } = useCashCollectPolling(result, setResult);
  const cur = session.user?.currency || 'XAF';

  useEffect(() => { idemKey.current = newIdempotencyKey(); }, [amount, phone, description, operator, mode]);
  useEffect(() => { setOperator(null); }, [detection?.phone, detection?.operator]);

  const alternatives = (detection?.alternatives || []).filter((a) => a.operator && a.operator !== detection?.operator);

  const submit = async () => {
    const amt = parseAmount(amount);
    if (!amt || amt <= 0) return Alert.alert('Encaissement', 'Montant invalide.');
    if (mode === 'mobile_money') {
      if (!phone.trim()) return Alert.alert('Encaissement', 'Numéro du client requis.');
      if (detection && !detection.success && !operator) {
        return Alert.alert('Encaissement', alternatives.length ? 'Choisissez un service de paiement.' : (detection.error || 'Numéro non pris en charge.'));
      }
    }
    setLoading(true);
    setResult(null);
    setCard(null);
    try {
      const body = mode === 'card'
        ? { amount: amt, method: 'card', description: description || undefined }
        : { amount: amt, method: 'mobile_money', customerPhone: detection?.phone || phone.trim(), operator: operator || undefined, description: description || undefined };
      const data = await apiFetch('/merchant/cash/collect', { method: 'POST', idempotencyKey: idemKey.current, body });
      idemKey.current = newIdempotencyKey();
      if (mode === 'card') setCard(data.payLink || { unavailable: true }); else setResult({ ...data, customerPhone: body.customerPhone });
    } catch (e) {
      if (e instanceof AuthError) return;
      if (isFeatureUnavailable(e)) { if (mode === 'card') setCard({ unavailable: true }); else setUnavailable(true); } else Alert.alert('Encaissement', cashMessage(e, cur));
    } finally {
      setLoading(false);
    }
  };

  const reset = () => { setResult(null); setCard(null); setAmount(''); setPhone(''); setDescription(''); setOperator(null); };

  return (
    <Screen>
      <Text style={s.h1}>Encaisser</Text>
      <Segment value={mode} onChange={(v) => { setMode(v); setResult(null); setCard(null); }} items={[['mobile_money', 'Mobile Money'], ['card', 'Carte'], ['nfc', 'NFC']]} />
      {mode === 'nfc' ? <Notice title="Sans contact (Tap-to-Phone)" text={FEATURE_PENDING} /> : null}
      {mode === 'mobile_money' && unavailable ? <Notice title="Encaissement" text={FEATURE_PENDING} /> : null}
      {mode !== 'nfc' && !(mode === 'mobile_money' && unavailable) && !result && (
        <>
          <Field label={`Montant (${cur})`} value={amount} onChange={setAmount} keyboardType="decimal-pad" placeholder="5 000" />
          <Chips value={null} onChange={(v) => setAmount(String(v))} items={QUICK_AMOUNTS.map((a) => [a, money(a)])} />
          {mode === 'mobile_money' && (
            <>
              <Field label="Numéro du client" value={phone} onChange={setPhone} keyboardType="phone-pad" placeholder="+237 6 70 00 00 00" />
              {(detecting || detection) ? (
                <View style={s.detect}>
                  {detecting && !detection ? <Text style={s.muted}>Détection de l’opérateur…</Text> : null}
                  {detection ? (
                    <>
                      <Text style={s.detectMain}>{detection.success ? `📱 ${detection.brand || operatorLabel(detection.operator)}` : `⚠️ ${detection.error || 'Opérateur non reconnu'}`}</Text>
                      <Text style={s.muted}>{[detection.countryName || detection.country, detection.currency].filter(Boolean).join(' · ')}{detection.currency && detection.currency !== cur ? ` — ⚠️ devise différente de votre compte (${cur})` : ''}</Text>
                      {alternatives.length ? (
                        <>
                          <Text style={s.label}>Ou payer via :</Text>
                          <Chips value={operator || '__detected'} onChange={(v) => setOperator(v === '__detected' ? null : v)} items={[...(detection.success ? [['__detected', `Détecté : ${detection.brand || operatorLabel(detection.operator)}`]] : []), ...alternatives.map((a) => [a.operator, a.brand || operatorLabel(a.operator)])]} />
                        </>
                      ) : null}
                    </>
                  ) : null}
                </View>
              ) : null}
            </>
          )}
          {mode === 'card' ? <Text style={s.muted}>Le client paie par carte sur la page sécurisée pay.c-pay.global (lien + QR).</Text> : null}
          <Field label="Description (optionnel)" value={description} onChange={setDescription} />
          <Button label={loading ? 'Traitement...' : mode === 'card' ? 'Créer le lien de paiement carte' : 'Encaisser maintenant'} onPress={submit} disabled={loading || polling} />
        </>
      )}
      {result ? <CashCollectResult result={result} polling={polling} timedOut={timedOut} currency={result.currency || cur} onNew={reset} /> : null}
      {card ? <CardLinkCard card={card} amount={parseAmount(amount)} currency={cur} onNew={reset} /> : null}
    </Screen>
  );
}

function CashCollectResult({ result, polling, timedOut, currency, onNew }) {
  const pending = !result.status || result.status === 'pending';
  const ok = result.status === 'authorized';
  const title = pending ? (timedOut ? PENDING_CONFIRMATION : 'Demande envoyée au client') : ok ? 'Paiement reçu' : result.status === 'expired' ? 'Délai dépassé' : 'Paiement refusé';
  const text = pending
    ? (timedOut ? 'Le client n’a pas encore confirmé sur son téléphone. Le statut sera mis à jour dans le Journal.' : 'Le client doit saisir son code PIN Mobile Money sur son téléphone.')
    : ok ? `Net ${money(result.net ?? result.amount, currency)}${result.fee ? ` · frais ${money(result.fee, currency)}` : ''}` : (result.error || result.message || '');
  const share = () => Share.share({ message: compact(`C-Pay — Encaissement ${money(result.amount, currency)} · Réf ${result.reference || result.txnId || '-'} · ${title}`) });
  return (
    <View style={s.card}>
      <View style={s.rowBetween}><Text style={s.cardTitle}>{title}</Text>{polling ? <ActivityIndicator color={C.cyan} /> : null}</View>
      <Text style={s.amount}>{money(result.amount, currency)}</Text>
      <Text style={s.muted}>{text}</Text>
      <Text style={s.muted}>{result.operatorLabel || operatorLabel(result.operator)}{result.customerPhone ? ` · ${result.customerPhone}` : ''}</Text>
      <Text style={s.muted}>Réf : {result.reference || result.txnId || '-'}</Text>
      <Badge label={pending ? (timedOut ? PENDING_CONFIRMATION : 'pending') : result.status} />
      <View style={s.row}>
        {ok ? <MiniButton label="Partager le reçu" onPress={share} /> : null}
        {result.receiptUrl ? <MiniButton label="Reçu" onPress={() => Linking.openURL(result.receiptUrl)} /> : null}
        {!polling ? <MiniButton label="Nouvel encaissement" onPress={onNew} /> : null}
      </View>
    </View>
  );
}

// Carte : lien de paiement hébergé + QR (rendu local via react-native-qrcode-svg).
function CardLinkCard({ card, amount, currency, onNew }) {
  if (card.unavailable) return <Notice title="Paiement carte" text={FEATURE_PENDING} />;
  const link = card.shortUrl;
  const shareText = compact(`Payer ${money(amount, currency)} par carte via ${APP_NAME} : ${link}`);
  const copy = async () => { await Clipboard.setStringAsync(link || ''); Alert.alert('Copie', 'Lien copié'); };
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Lien de paiement carte</Text>
      <Text style={s.amount}>{money(amount, currency)}</Text>
      {link ? <View style={s.qr}><QRCode value={link} size={220} /></View> : <Text style={s.muted}>Lien indisponible</Text>}
      {link ? <Text style={s.link}>{link}</Text> : null}
      {card.expiresAt ? <Text style={s.muted}>Expire le {fmtDate(card.expiresAt)}</Text> : null}
      <View style={s.row}>
        <MiniButton label="Copier" onPress={copy} />
        <MiniButton label="Partager" onPress={() => link && Share.share({ message: shareText, url: link })} />
        <MiniButton label="Ouvrir" onPress={() => link && Linking.openURL(link)} />
      </View>
      <MiniButton label="Nouvel encaissement" onPress={onNew} full />
    </View>
  );
}

// ─── Retirer ─────────────────────────────────────────────────────
function WithdrawScreen({ session }) {
  const { summary, error, reload } = useCashSummary();
  const [wallet, setWallet] = useState(undefined); // undefined = chargement, null = aucun
  const [editing, setEditing] = useState(false);
  const [op, setOp] = useState('mtn_momo');
  const [wphone, setWphone] = useState('');
  const { detection } = usePhoneDetection(editing ? wphone : '');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [last, setLast] = useState(null);
  const idemKey = useRef(newIdempotencyKey());
  const cur = summary?.currency || session.user?.currency || 'XAF';
  const available = summary?.balance?.available || 0;
  const limits = summary?.limits || {};

  const loadWallet = () => apiFetch('/merchant/cash/wallet')
    .then((w) => setWallet(w?.phone ? w : null))
    .catch((e) => { if (isFeatureUnavailable(e)) setUnavailable(true); setWallet(null); });
  useEffect(() => { loadWallet(); }, []);
  useEffect(() => { if (error && isFeatureUnavailable(error)) setUnavailable(true); }, [error]);
  useEffect(() => { if (detection?.success) { const code = operatorCodeFor(detection); if (code) setOp(code); } }, [detection]);
  useEffect(() => { idemKey.current = newIdempotencyKey(); }, [amount, description]);

  const openForm = () => { setOp(wallet?.operator || 'mtn_momo'); setWphone(wallet?.phone || ''); setEditing(true); };

  const saveWallet = async () => {
    if (!wphone.trim()) return Alert.alert('Wallet', 'Numéro requis.');
    try {
      const w = await withStepUp(session, 'Enregistrer le wallet', (confirm) => apiFetch('/merchant/cash/wallet', { method: 'PUT', body: { operator: op, phone: detection?.phone || wphone.trim(), confirm } }));
      if (!w) return;
      setWallet(w?.phone ? w : { operator: op, phone: detection?.phone || wphone.trim(), verifiedAt: null });
      setEditing(false);
    } catch (e) {
      if (e instanceof AuthError) return;
      if (isFeatureUnavailable(e)) setUnavailable(true); else Alert.alert('Wallet', cashMessage(e, cur));
    }
  };

  const submit = async () => {
    const amt = parseAmount(amount);
    if (!amt || amt <= 0) return Alert.alert('Retrait', 'Montant invalide.');
    if (!wallet) { openForm(); return Alert.alert('Retrait', cashMessage({ code: 'WALLET_MISSING' }, cur)); }
    if (summary && amt > available) return Alert.alert('Retrait', `Solde insuffisant — disponible : ${money(available, cur)}`);
    if (limits.withdrawDailyRemaining != null && amt > limits.withdrawDailyRemaining) return Alert.alert('Retrait', `Plafond journalier : il vous reste ${money(limits.withdrawDailyRemaining, cur)} aujourd’hui`);
    setLoading(true);
    try {
      const data = await withStepUp(session, `Retrait de ${money(amt, cur)}`, (confirm) => apiFetch('/merchant/cash/withdraw', { method: 'POST', idempotencyKey: idemKey.current, body: { amount: amt, description: description || undefined, confirm } }));
      if (!data) return;
      idemKey.current = newIdempotencyKey();
      setLast(data);
      setAmount('');
      setDescription('');
      reload();
      loadWallet();
    } catch (e) {
      if (e instanceof AuthError) return;
      if (isFeatureUnavailable(e)) setUnavailable(true);
      else { if (e.code === 'WALLET_MISSING') setWallet(null); Alert.alert('Retrait', cashMessage(e, cur)); }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Text style={s.h1}>Retirer</Text>
      <Text style={s.muted}>Du solde disponible vers votre wallet Mobile Money.</Text>
      <View style={s.balanceCard}>
        <Text style={s.balanceLabel}>Disponible</Text>
        <Text style={s.balanceValue}>{money(available, cur)}</Text>
        {limits.withdrawDailyRemaining != null ? <Text style={s.balanceSub}>Reste aujourd’hui : {money(limits.withdrawDailyRemaining, cur)}{limits.withdrawDailyMax != null ? ` / ${money(limits.withdrawDailyMax, cur)}` : ''}</Text> : null}
      </View>
      {unavailable ? <Notice title="Retrait" text={FEATURE_PENDING} /> : null}
      <Text style={s.section}>Wallet de destination</Text>
      {wallet === undefined ? <ActivityIndicator color={C.cyan} /> : (
        <View style={s.card}>
          <Text style={s.cardTitle}>{wallet ? `📱 ${operatorLabel(wallet.operator)}` : 'Aucun wallet enregistré'}</Text>
          <Text style={s.muted}>{wallet ? wallet.phone : 'Nécessaire pour recevoir vos retraits.'}</Text>
          {wallet ? <Badge label={wallet.verifiedAt ? 'Vérifié' : 'Vérifié après le premier retrait'} /> : null}
          {!editing ? <MiniButton label={wallet ? 'Modifier' : 'Enregistrer mon wallet'} onPress={openForm} full /> : null}
          {editing && (
            <>
              <Text style={s.label}>Opérateur</Text>
              <Chips value={op} onChange={setOp} items={OPERATORS} />
              <Field label="Numéro du wallet" value={wphone} onChange={setWphone} keyboardType="phone-pad" placeholder="+237 6 70 00 00 00" />
              {detection ? <Text style={s.muted}>{detection.success ? `📱 ${detection.brand || operatorLabel(detection.operator)} · ${detection.countryName || detection.country || ''}` : `⚠️ ${detection.error || 'Opérateur non reconnu'} — choisissez-le manuellement`}</Text> : null}
              <View style={s.row}><MiniButton label="Annuler" onPress={() => setEditing(false)} /><MiniButton label="Enregistrer" onPress={saveWallet} /></View>
            </>
          )}
        </View>
      )}
      <Text style={s.section}>Montant</Text>
      <Field label={`Montant à retirer (${cur})`} value={amount} onChange={setAmount} keyboardType="decimal-pad" placeholder="50 000" />
      <Field label="Libellé (optionnel)" value={description} onChange={setDescription} placeholder="Caisse du soir" />
      <Button label={loading ? 'Traitement...' : 'Retirer'} onPress={submit} disabled={loading || unavailable} />
      {last ? (
        <View style={s.card}>
          <Text style={s.cardTitle}>Retrait demandé</Text>
          <Text style={s.amount}>{money(last.net ?? last.amount, cur)}</Text>
          <Text style={s.muted}>Réf : {last.reference || last.transferId || '-'}{last.fee ? ` · frais ${money(last.fee, cur)}` : ''}</Text>
          {last.wallet ? <Text style={s.muted}>Vers {operatorLabel(last.wallet.operator)} {last.wallet.phone}</Text> : null}
          <Badge label={transferStatusLabel(last.status)} />
        </View>
      ) : null}
    </Screen>
  );
}

// ─── Transférer ──────────────────────────────────────────────────
function TransfersScreen({ session }) {
  const { summary, reload } = useCashSummary();
  const [direction, setDirection] = useState('wallet_to_bank');
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState([]);
  const [instructions, setInstructions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const idemKey = useRef(newIdempotencyKey());
  const cur = summary?.currency || session.user?.currency || 'XAF';
  const available = summary?.balance?.available || 0;
  const minTransfer = summary?.limits?.transferMin || 1000;

  const loadAccounts = () => apiFetch('/merchant/bank-accounts')
    .then((d) => {
      const list = (d.data || []).filter((a) => a.status === 'verified' || a.status === 'active');
      setAccounts(list);
      setAccountId((current) => current || list.find((a) => a.isDefault)?.accountId || list[0]?.accountId || null);
    })
    .catch(() => {});
  const loadList = () => apiFetch('/merchant/cash/transfers?limit=20')
    .then((d) => setItems(d.data || []))
    .catch((e) => { if (isFeatureUnavailable(e)) setUnavailable(true); });
  useEffect(() => { loadAccounts(); loadList(); }, []);
  useEffect(() => { idemKey.current = newIdempotencyKey(); }, [amount, description, direction, accountId]);

  const submit = async () => {
    const toBank = direction === 'wallet_to_bank';
    const amt = parseAmount(amount);
    if (!amt || amt < minTransfer) return Alert.alert('Transfert', `Montant minimum : ${money(minTransfer, cur)}`);
    if (toBank && !accountId) return Alert.alert('Transfert', 'Aucun compte bancaire vérifié. Ajoutez-en un depuis le portail marchand.');
    if (toBank && summary && amt > available) return Alert.alert('Transfert', `Solde insuffisant — disponible : ${money(available, cur)}`);
    setLoading(true);
    try {
      const title = toBank ? `Transfert de ${money(amt, cur)} vers la banque` : `Approvisionnement de ${money(amt, cur)}`;
      const data = await withStepUp(session, title, (confirm) => apiFetch('/merchant/cash/transfers', {
        method: 'POST',
        idempotencyKey: idemKey.current,
        body: { direction, accountId: toBank ? accountId : undefined, amount: amt, description: description || undefined, confirm },
      }));
      if (!data) return;
      idemKey.current = newIdempotencyKey();
      setAmount('');
      setDescription('');
      if (data.instructions || data.direction === 'bank_to_wallet') setInstructions(data);
      else Alert.alert('Transfert demandé', `Réf ${data.reference || data.transferId}\nStatut : ${transferStatusLabel(data.status)}${data.status === 'pending_manual' ? '\nExécuté par les opérations C-Pay (J+1 ouvré).' : ''}${data.fee ? `\nFrais : ${money(data.fee, cur)}` : ''}`);
      reload();
      loadList();
    } catch (e) {
      if (e instanceof AuthError) return;
      if (isFeatureUnavailable(e)) setUnavailable(true); else Alert.alert('Transfert', cashMessage(e, cur));
    } finally {
      setLoading(false);
    }
  };

  const cancel = (t) => Alert.alert('Annuler ce transfert ?', `${t.reference || t.transferId} — ${money(t.amount, cur)}`, [
    { text: 'Non', style: 'cancel' },
    { text: 'Oui, annuler', style: 'destructive', onPress: async () => {
      try { await apiFetch(`/merchant/cash/transfers/${encodeURIComponent(t.transferId)}/cancel`, { method: 'POST' }); loadList(); reload(); } catch (e) { if (!(e instanceof AuthError)) Alert.alert('Annulation', cashMessage(e, cur)); }
    } },
  ]);

  const toBank = direction === 'wallet_to_bank';
  return (
    <Screen>
      <Text style={s.h1}>Transférer</Text>
      <View style={s.balanceCard}><Text style={s.balanceLabel}>Disponible</Text><Text style={s.balanceValue}>{money(available, cur)}</Text></View>
      {unavailable ? <Notice title="Transferts" text={FEATURE_PENDING} /> : null}
      <Segment value={direction} onChange={(v) => { setDirection(v); setInstructions(null); }} items={[['wallet_to_bank', 'Wallet → Banque'], ['bank_to_wallet', 'Banque → Wallet']]} />
      {instructions ? <FundingInstructions transfer={instructions} currency={cur} onClose={() => setInstructions(null)} /> : null}
      {toBank ? (
        <>
          <Text style={s.label}>Compte bancaire vérifié</Text>
          {accounts.length ? (
            <Chips value={accountId} onChange={setAccountId} items={accounts.map((a) => [a.accountId, `🏦 ${a.bankName || a.institution?.name || 'Banque'} ${a.accountMasked || (a.accountNumber ? `…${String(a.accountNumber).slice(-4)}` : '')}`])} />
          ) : <Notice title="Compte bancaire" text="Aucun compte bancaire vérifié. Ajoutez-en un depuis le portail marchand (merchant.c-pay.global)." />}
        </>
      ) : <Text style={s.muted}>Vous recevrez les coordonnées du compte de collecte C-Pay et une référence à indiquer sur votre virement. Le solde est crédité à réception.</Text>}
      <Field label={`Montant (${cur})`} value={amount} onChange={setAmount} keyboardType="decimal-pad" placeholder="200 000" />
      <Field label="Libellé (optionnel)" value={description} onChange={setDescription} />
      <Button label={loading ? 'Traitement...' : toBank ? 'Transférer vers la banque' : 'Créer l’ordre d’approvisionnement'} onPress={submit} disabled={loading || unavailable} />
      <View style={s.rowBetween}><Text style={s.section}>Mes transferts</Text><MiniButton label="↻" onPress={loadList} /></View>
      {!items.length ? <Text style={s.muted}>Aucun transfert pour le moment.</Text> : null}
      {items.map((t) => {
        const funding = t.direction === 'bank_to_wallet' || t.direction === 'funding';
        const canCancel = t.status === 'awaiting_funds' || t.status === 'pending_manual';
        return (
          <View style={s.card} key={t.transferId}>
            <Text style={s.cardTitle}>{funding ? '💰 Approvisionnement' : `🏦 Vers ${t.bankAccount?.bankName || 'la banque'} ${t.bankAccount?.accountMasked || ''}`}</Text>
            <Text style={s.muted}>{t.reference || t.transferId} · {fmtDate(t.createdAt)}</Text>
            <Text style={[s.amount, { color: funding ? C.green : C.amber }]}>{funding ? '+ ' : '- '}{money(t.amount, t.currency || cur)}</Text>
            <Badge label={transferStatusLabel(t.status)} />
            {(canCancel || (t.instructions && t.status === 'awaiting_funds')) ? (
              <View style={s.row}>
                {t.instructions && t.status === 'awaiting_funds' ? <MiniButton label="Instructions" onPress={() => setInstructions(t)} /> : null}
                {canCancel ? <MiniButton label="Annuler" onPress={() => cancel(t)} /> : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </Screen>
  );
}

function FundingInstructions({ transfer, currency, onClose }) {
  const i = transfer.instructions || {};
  const rows = [
    ['Banque', i.bankName], ['Titulaire', i.accountName], ['Numéro de compte', i.accountNumber],
    ['IBAN', i.iban], ['SWIFT / BIC', i.swift], ['Référence à indiquer sur le virement', i.reference || transfer.reference],
  ].filter(([, v]) => v);
  const copy = async (v) => { await Clipboard.setStringAsync(String(v)); Alert.alert('Copie', 'Copié'); };
  const all = [`Virement C-Pay ${money(transfer.amount, currency)}`, ...rows.map(([k, v]) => `${k} : ${v}`)].join('\n');
  return (
    <View style={[s.card, { borderColor: C.green }]}>
      <Text style={[s.cardTitle, { color: C.green }]}>Instructions de virement</Text>
      <Text style={s.amount}>{money(transfer.amount, currency)}</Text>
      {rows.map(([k, v]) => (
        <View style={s.rowBetween} key={k}>
          <View style={{ flex: 1 }}><Text style={s.label}>{k}</Text><Text style={s.infoVal}>{v}</Text></View>
          <Pressable style={s.copyBtn} onPress={() => copy(v)}><Text style={s.miniText}>Copier</Text></Pressable>
        </View>
      ))}
      {i.expiresAt ? <Text style={s.muted}>À virer avant le {fmtDate(i.expiresAt)}</Text> : null}
      <View style={s.row}><MiniButton label="Tout copier" onPress={() => copy(all)} /><MiniButton label="Fermer" onPress={onClose} /></View>
    </View>
  );
}

// ─── Journal ─────────────────────────────────────────────────────
function JournalScreen({ session }) {
  const PAGE = 30;
  const [type, setType] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const cur = session.user?.currency || 'XAF';

  const load = async (reset, offset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const d = await apiFetch(`/merchant/cash/history?limit=${PAGE}&offset=${offset}${type ? `&type=${encodeURIComponent(type)}` : ''}`);
      setItems((prev) => (reset ? (d.data || []) : [...prev, ...(d.data || [])]));
      setTotal(d.total || 0);
      if (d.totals) setTotals(d.totals);
    } catch (e) {
      if (!(e instanceof AuthError)) setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(true, 0); }, [type]);
  const hasMore = items.length < total;
  const typeLabel = (t) => ({ collect: 'Encaissement', withdraw: 'Retrait', transfer_out: 'Transfert vers banque', transfer_in: 'Approvisionnement' }[t] || t || 'Mouvement');
  const icon = (t) => ({ collect: '📥', withdraw: '📤', transfer_out: '🏦', transfer_in: '💰' }[t] || '💳');
  const methodLabel = (m) => (m === 'mobile_money' ? '📱 Mobile Money' : m === 'card' ? '💳 Carte' : m === 'bank' ? '🏦 Banque' : m ? operatorLabel(m) : null);

  return (
    <Screen>
      <View style={s.rowBetween}><Text style={s.h1}>Journal de caisse</Text><MiniButton label="↻" onPress={() => load(true, 0)} /></View>
      <Chips value={type} onChange={setType} items={CASH_TYPES} />
      <InfoGrid items={[['Entrées', `+ ${money(totals?.in, cur)}`], ['Sorties', `- ${money(totals?.out, cur)}`]]} />
      <Text style={s.muted}>{items.length} / {total} mouvement(s)</Text>
      {error ? <Notice title="Journal" text={isFeatureUnavailable(error) ? 'Caisse en cours d’activation sur votre compte' : cashMessage(error, cur)} /> : null}
      {items.map((e, idx) => {
        const incoming = e.type === 'collect' || e.type === 'transfer_in';
        return (
          <View style={s.card} key={e.id || idx}>
            <View style={s.rowBetween}>
              <Text style={s.cardTitle}>{icon(e.type)} {typeLabel(e.type)}</Text>
              <Text style={[s.amount, { fontSize: 17, color: incoming ? C.green : C.amber }]}>{incoming ? '+ ' : '- '}{money(e.amount, cur)}</Text>
            </View>
            <Text style={s.muted}>{[e.reference, e.counterparty, methodLabel(e.method)].filter(Boolean).join(' · ')}</Text>
            <View style={s.rowBetween}>
              <Text style={s.muted}>{fmtDate(e.createdAt)}{e.fee ? ` · frais ${money(e.fee, cur)}` : ''}</Text>
              <Badge label={transferStatusLabel(e.status)} />
            </View>
          </View>
        );
      })}
      {loading ? <ActivityIndicator color={C.cyan} /> : null}
      {!loading && !items.length && !error ? <Text style={s.muted}>Aucun mouvement.</Text> : null}
      {hasMore && !loading ? <MiniButton label="Charger plus" onPress={() => load(false, items.length)} full /> : null}
    </Screen>
  );
}

// QR Code et Pay Link reposent tous deux sur POST /merchant/pay-links : le QR est le
// rendu local de l'URL courte du lien (plus de route /qr-code cote serveur).
function LinkScreen() {
  const [mode, setMode] = useState('qr-code');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [phone, setPhone] = useState('');
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const idemKey = useRef(newIdempotencyKey());

  useEffect(() => { idemKey.current = newIdempotencyKey(); }, [amount, description]);

  const generate = async () => {
    if (!amount || Number(amount) <= 0) return Alert.alert('Lien de paiement', 'Montant invalide.');
    setLoading(true);
    setPayload(null);
    try {
      const data = await apiFetch('/merchant/pay-links', {
        method: 'POST',
        idempotencyKey: idemKey.current,
        body: { amount: Number(amount), description: description || undefined },
      });
      idemKey.current = newIdempotencyKey();
      setPayload(data.link || data);
    } catch (e) {
      if (e instanceof AuthError) return;
      if (isFeatureUnavailable(e)) setUnavailable(true);
      else Alert.alert(mode === 'qr-code' ? 'QR Code' : 'Pay Link', userMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const link = payload?.short_url || payload?.shortUrl || payload?.url;
  const linkId = payload?.short_id || payload?.shortId || payload?.pay_link_id || payload?.linkId || payload?.id;
  const shareText = compact(`Payer ${money(amount, payload?.currency)} via ${APP_NAME} : ${link}`);

  const share = async () => link && Share.share({ message: shareText, url: link });
  const copy = async () => {
    await Clipboard.setStringAsync(link || '');
    Alert.alert('Copie', 'Lien copié');
  };
  const whatsapp = () => link && Linking.openURL(`whatsapp://send?text=${encodeURIComponent(shareText)}`).catch(() => Share.share({ message: shareText }));
  const sms = () => link && Linking.openURL(`sms:?body=${encodeURIComponent(shareText)}`);
  const serverSend = async (channel) => {
    if (!linkId) return Alert.alert('Envoi', 'Identifiant Pay Link manquant');
    if (!phone) return Alert.alert('Envoi', 'Téléphone destinataire requis (format +242...)');
    try {
      await apiFetch(`/merchant/pay-links/${encodeURIComponent(linkId)}/send`, { method: 'POST', body: { channel, phone: phone.trim() } });
      Alert.alert('Envoi', channel === 'whatsapp' ? 'Lien envoyé par WhatsApp' : 'Lien envoyé par SMS');
    } catch (e) {
      if (e instanceof AuthError) return;
      Alert.alert('Envoi', userMessage(e));
    }
  };

  if (unavailable) return <Screen><Text style={s.h1}>QR Code & Pay Link</Text><Notice title="Lien de paiement" text={FEATURE_PENDING} /></Screen>;

  return (
    <Screen>
      <Text style={s.h1}>QR Code & Pay Link</Text>
      <Segment value={mode} onChange={setMode} items={[['qr-code', 'QR Code'], ['pay-link', 'Pay Link']]} />
      <Field label="Montant" value={amount} onChange={setAmount} keyboardType="decimal-pad" />
      <Field label="Description" value={description} onChange={setDescription} />
      <Button label={loading ? 'Génération...' : 'Générer'} onPress={generate} disabled={loading} />
      {payload && (
        <View style={s.card}>
          <Text style={s.cardTitle}>{mode === 'qr-code' ? 'QR de paiement' : 'Lien de paiement'}</Text>
          {link ? <View style={s.qr}><QRCode value={link} size={220} /></View> : null}
          {link ? <Text style={s.link}>{link}</Text> : null}
          {payload.expires_at ? <Text style={s.muted}>Expire le {new Date(payload.expires_at).toLocaleString('fr-FR')}</Text> : null}
          <View style={s.row}>
            <MiniButton label="Partager" onPress={share} />
            <MiniButton label="WhatsApp" onPress={whatsapp} />
            <MiniButton label="SMS" onPress={sms} />
          </View>
          <MiniButton label="Copier le lien" onPress={copy} full />
          {mode === 'pay-link' && (
            <>
              <Field label="Téléphone envoi serveur" value={phone} onChange={setPhone} keyboardType="phone-pad" placeholder="+242..." />
              <View style={s.row}>
                <MiniButton label="API WhatsApp" onPress={() => serverSend('whatsapp')} />
                <MiniButton label="SMS" onPress={() => serverSend('sms')} />
              </View>
            </>
          )}
        </View>
      )}
    </Screen>
  );
}

function HistoryScreen() {
  const [view, setView] = useState('transactions');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch(`/merchant/${view}`);
      setItems(data.data || []);
    } catch (e) {
      if (!(e instanceof AuthError)) Alert.alert('Historique', userMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [view]);

  return (
    <Screen>
      <Text style={s.h1}>Historique</Text>
      <Segment value={view} onChange={setView} items={[['transactions', 'Transactions'], ['settlements', 'Règlements']]} />
      {loading ? <ActivityIndicator color={C.cyan} /> : items.map((item, idx) => (
        <View style={s.card} key={item.transaction_id || item.batch_id || item.settlement_id || idx}>
          <Text style={s.cardTitle}>{item.type || item.status || 'Règlement'}</Text>
          <Text style={s.muted}>{item.transaction_id || item.batch_id || item.created_at}</Text>
          <Text style={s.amount}>{money(item.amount || item.total_gross || item.net_amount, item.currency)}</Text>
          <Badge label={item.status || item.settlement_status || 'n/a'} />
        </View>
      ))}
      {!loading && !items.length && <Text style={s.muted}>Aucune donnée.</Text>}
    </Screen>
  );
}

// Rails Visa : reserves aux administrateurs super_admin / ops_admin ; aucune
// donnee carte brute (PAN) n'est acceptee par le serveur (RAW_PAN_NOT_ALLOWED).
function RailsScreen() {
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [wallet, setWallet] = useState('');
  const [reference, setReference] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const run = async (fn, title) => {
    setLoading(true);
    setResult(null);
    try {
      setResult(await fn());
    } catch (e) {
      if (e instanceof AuthError) return;
      if (isFeatureUnavailable(e)) setUnavailable(true);
      else Alert.alert(title, userMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const submit = () => run(() => apiFetch('/rails/visa-payouts/v3/payouts', {
    method: 'POST',
    body: {
      txnId: reference || `${Date.now()}`,
      amount: Number(amount),
      currency,
      payoutMethod: 'W',
      recipientDetail: {
        firstName: 'Client',
        lastName: APP_NAME,
        type: 'I',
        wallet: { countryCode: 'COD', accountIdentifier: wallet, accountIdentifierType: 'PHONE', currencyCode: currency },
      },
    },
  }), 'Rails');

  const query = () => run(() => apiFetch(`/rails/visa-payouts/v3/payouts?id=${encodeURIComponent(reference)}&idType=CLIENT_REFERENCE_ID`), 'Query');

  if (unavailable) return <Screen><Text style={s.h1}>Rails Visa</Text><Notice title="Rails Visa" text={FEATURE_PENDING} /></Screen>;

  return (
    <Screen>
      <Text style={s.h1}>Rails Visa</Text>
      <Text style={s.muted}>Visa Account & Wallet payout (rôles super_admin / ops_admin). Les données carte brutes sont refusées par la plateforme.</Text>
      <Field label="Référence" value={reference} onChange={setReference} placeholder="optionnel" />
      <Field label="Montant" value={amount} onChange={setAmount} keyboardType="decimal-pad" />
      <Field label="Devise" value={currency} onChange={setCurrency} autoCapitalize="characters" />
      <Field label="Wallet / téléphone" value={wallet} onChange={setWallet} keyboardType="phone-pad" />
      <Button label={loading ? 'Traitement...' : 'Exécuter le payout'} onPress={submit} disabled={loading} />
      <MiniButton label="Query payout par référence" onPress={query} full />
      {result && <JsonBox data={result} />}
    </Screen>
  );
}

function TokensScreen() {
  const [tokens, setTokens] = useState([]);
  const [form, setForm] = useState({ provider: 'network_token', tokenRef: '', customerRef: '', network: '', last4: '' });
  const onError = (title) => (e) => { if (!(e instanceof AuthError)) Alert.alert(title, userMessage(e)); };
  const load = () => apiFetch('/merchant/tokens').then((d) => setTokens(d.data || []));
  useEffect(() => { load().catch(onError('Tokens')); }, []);
  const create = async () => {
    try {
      await apiFetch('/merchant/tokens', { method: 'POST', body: form });
      setForm({ provider: 'network_token', tokenRef: '', customerRef: '', network: '', last4: '' });
      load();
    } catch (e) { onError('Tokenisation')(e); }
  };
  const revoke = async (id) => {
    try { await apiFetch(`/merchant/tokens/${id}`, { method: 'DELETE' }); load(); } catch (e) { onError('Tokenisation')(e); }
  };
  return (
    <Screen>
      <Text style={s.h1}>Tokenisation</Text>
      <Text style={s.muted}>Stocke uniquement des tokens PSP/réseau. Le PAN brut est refusé.</Text>
      <Field label="Provider token" value={form.provider} onChange={(v) => setForm(f => ({ ...f, provider: v }))} />
      <Field label="Token ref (pas le PAN)" value={form.tokenRef} onChange={(v) => setForm(f => ({ ...f, tokenRef: v }))} />
      <Field label="Client ref" value={form.customerRef} onChange={(v) => setForm(f => ({ ...f, customerRef: v }))} />
      <View style={s.row}><View style={{ flex: 1 }}><Field label="Réseau" value={form.network} onChange={(v) => setForm(f => ({ ...f, network: v }))} /></View><View style={{ flex: 1 }}><Field label="Last4" value={form.last4} onChange={(v) => setForm(f => ({ ...f, last4: v }))} keyboardType="number-pad" /></View></View>
      <Button label="Créer token" onPress={create} />
      {tokens.map(t => <View style={s.card} key={t.token_id}><Text style={s.cardTitle}>{t.provider} {t.network || ''} ****{t.last4 || '----'}</Text><Text style={s.muted}>{t.customer_ref || 'client non renseigné'} · {t.status}</Text><MiniButton label="Révoquer" onPress={() => revoke(t.token_id)} full /></View>)}
    </Screen>
  );
}

function IntegrationsScreen() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ integrationType: 'accounting', provider: 'webhook', displayName: '', endpointUrl: '', status: 'inactive' });
  const onError = (e) => { if (!(e instanceof AuthError)) Alert.alert('Intégrations', userMessage(e)); };
  const load = () => apiFetch('/merchant/integrations').then((d) => setItems(d.data || []));
  useEffect(() => { load().catch(onError); }, []);
  const save = async () => {
    try {
      await apiFetch('/merchant/integrations', { method: 'POST', body: form });
      setForm({ integrationType: 'accounting', provider: 'webhook', displayName: '', endpointUrl: '', status: 'inactive' });
      load();
    } catch (e) { onError(e); }
  };
  const exportCsv = () => Alert.alert('Export CSV', 'L’export des transactions (CSV) se télécharge depuis le portail marchand : https://merchant.c-pay.global');
  return (
    <Screen>
      <Text style={s.h1}>CRM & comptabilité</Text>
      <Text style={s.muted}>Webhook signé pour pousser transactions et règlements vers ERP, CRM ou logiciel comptable.</Text>
      <Segment value={form.integrationType} onChange={(v) => setForm(f => ({ ...f, integrationType: v }))} items={[['accounting', 'Compta'], ['crm', 'CRM'], ['erp', 'ERP'], ['webhook', 'Webhook']]} />
      <Field label="Nom" value={form.displayName} onChange={(v) => setForm(f => ({ ...f, displayName: v }))} />
      <Field label="Provider" value={form.provider} onChange={(v) => setForm(f => ({ ...f, provider: v }))} placeholder="sage, odoo, quickbooks, salesforce..." />
      <Field label="Endpoint URL" value={form.endpointUrl} onChange={(v) => setForm(f => ({ ...f, endpointUrl: v }))} keyboardType="url" autoCapitalize="none" />
      <Button label="Enregistrer connecteur" onPress={save} />
      <MiniButton label="Exporter transactions CSV" onPress={exportCsv} full />
      {items.map(i => <View style={s.card} key={i.integration_id}><Text style={s.cardTitle}>{i.display_name}</Text><Text style={s.muted}>{i.integration_type} · {i.provider} · {i.status}</Text><Text style={s.link}>{i.endpoint_url || 'endpoint non renseigné'}</Text></View>)}
    </Screen>
  );
}

function SupportScreen() {
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ subject: '', category: 'general', priority: 'normal', message: '' });
  const onError = (e) => { if (!(e instanceof AuthError)) Alert.alert('Support', userMessage(e)); };
  const load = () => apiFetch('/merchant/support/tickets').then((d) => setTickets(d.data || []));
  useEffect(() => { load().catch(onError); }, []);
  const create = async () => {
    try {
      const data = await apiFetch('/merchant/support/tickets', { method: 'POST', body: form });
      setSelected(data);
      setForm({ subject: '', category: 'general', priority: 'normal', message: '' });
      load();
    } catch (e) { onError(e); }
  };
  const reply = async () => {
    try {
      const data = await apiFetch(`/merchant/support/tickets/${selected.ticket_id}/messages`, { method: 'POST', body: { message } });
      setSelected(data);
      setMessage('');
      load();
    } catch (e) { onError(e); }
  };
  const open = (id) => apiFetch(`/merchant/support/tickets/${id}`).then(setSelected).catch(onError);
  return (
    <Screen>
      <Text style={s.h1}>Support</Text>
      <Field label="Sujet" value={form.subject} onChange={(v) => setForm(f => ({ ...f, subject: v }))} />
      <Field label="Message" value={form.message} onChange={(v) => setForm(f => ({ ...f, message: v }))} multiline />
      <Button label="Créer ticket" onPress={create} />
      {tickets.map(t => <Pressable key={t.ticket_id} style={s.card} onPress={() => open(t.ticket_id)}><Text style={s.cardTitle}>{t.ticket_number}</Text><Text style={s.muted}>{t.subject} · {t.status}</Text></Pressable>)}
      {selected && <View style={s.card}><Text style={s.cardTitle}>{selected.subject}</Text>{selected.messages?.map(m => <Text key={m.message_id} style={s.muted}>{m.sender_name}: {m.message}</Text>)}<Field label="Réponse" value={message} onChange={setMessage} multiline /><MiniButton label="Envoyer" onPress={reply} full /></View>}
    </Screen>
  );
}

// ─── Administration ──────────────────────────────────────────────
function AdminApp({ tab, session }) {
  if (tab === 'apis') return <AdminApis />;
  if (tab === 'merchants') return <AdminMerchants />;
  if (tab === 'monitoring') return <AdminMonitoring />;
  if (tab === 'rails') return <RailsScreen />;
  if (tab === 'pilot') return <PilotScreen session={session} />;
  return <AdminHome session={session} />;
}

function PilotScreen({ session }) {
  const [state, setState] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const isAdmin = session.mode === 'admin';

  useEffect(() => {
    const path = isAdmin ? '/admin/pilot/features' : '/merchant/pilot/state';
    apiFetch(path)
      .then(setState)
      .catch((e) => {
        if (e instanceof AuthError) return;
        if (isFeatureUnavailable(e)) setUnavailable(true);
        else Alert.alert('Pilot', userMessage(e));
      });
  }, [isAdmin]);

  if (unavailable) return <Screen><Text style={s.h1}>Pilot Control</Text><Notice title="Pilot" text={FEATURE_PENDING} /></Screen>;
  if (!state) return <Screen><ActivityIndicator color={C.cyan} /></Screen>;

  const flags = isAdmin ? (state.data || []) : (state.flags || []);
  const enrollments = state.enrollments || [];

  return (
    <Screen>
      <Text style={s.h1}>Pilot Control</Text>
      <InfoGrid items={[
        ['Mode', state.mode || 'audit'],
        ['Fonctions', flags.length],
        ['Pilote', enrollments[0]?.pilot_key || (isAdmin ? 'Admin' : 'Non enrôlé')],
        ['Statut', enrollments[0]?.enrollment_status || '-'],
      ]} />
      {!isAdmin && enrollments.map((e) => <Tile key={e.pilot_key} title={e.name} text={`${e.pilot_key} | version ${e.target_version} | rollout ${e.rollout_percent}%`} />)}
      <Text style={s.section}>Feature flags</Text>
      {flags.map((f) => (
        <View style={s.card} key={f.flag_key}>
          <Text style={s.cardTitle}>{f.display_name}</Text>
          <Text style={s.muted}>{f.flag_key} | {f.pilot_only ? 'Pilote' : 'Global'} | rollout {f.rollout_percent}%</Text>
          <Badge label={f.status} />
        </View>
      ))}
    </Screen>
  );
}

function AdminHome({ session }) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    apiFetch('/admin/stats/global').then(setStats).catch(() => {});
  }, []);
  return (
    <Screen>
      <Text style={s.h1}>Administration mobile</Text>
      <InfoGrid items={[
        ['Admin', session.user?.email],
        ['Rôle', session.user?.role],
        ['Marchands', stats?.merchants?.total || stats?.total_merchants || '-'],
        ['Transactions', stats?.today?.total || '-'],
      ]} />
      <Tile title="APIs" text="Consulter, tester et suivre les providers actifs." />
      <Tile title="Marchands" text="Créer, rechercher et contrôler les comptes." />
      <Tile title="Monitoring" text="Activité temps réel et statistiques globales." />
      <Tile title="Rails" text="Visa Account & Wallet payout (super_admin / ops_admin)." />
    </Screen>
  );
}

function AdminApis() {
  const [items, setItems] = useState([]);
  const [defaults, setDefaults] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [configs, countries] = await Promise.all([
        apiFetch('/admin/api-configs'),
        apiFetch('/admin/country-defaults'),
      ]);
      setItems(configs.data || []);
      setDefaults(countries.data || []);
    } catch (e) {
      if (!(e instanceof AuthError)) Alert.alert('APIs', userMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const test = async (key) => {
    try {
      const data = await apiFetch(`/admin/api-configs/${encodeURIComponent(key)}/test`, { method: 'POST' });
      Alert.alert(key, data.ok ? 'Connexion OK' : data.reason || 'Test échoué');
    } catch (e) {
      if (!(e instanceof AuthError)) Alert.alert(key, userMessage(e));
    }
  };

  return (
    <Screen>
      <Text style={s.h1}>Gestion des APIs</Text>
      {loading && <ActivityIndicator color={C.cyan} />}
      <Text style={s.section}>Defaults pays</Text>
      {defaults.map((d) => <Tile key={d.country} title={`${d.country} - ${d.currency}`} text={`${(d.mobile_money_providers || []).join(', ')} | Carte: ${d.default_card_gateway}`} />)}
      <Text style={s.section}>Providers</Text>
      {items.map((p) => (
        <View style={s.card} key={p.provider_key}>
          <Text style={s.cardTitle}>{p.display_name}</Text>
          <Text style={s.muted}>{p.provider_key} | {p.provider_type} | {p.country || 'global'}</Text>
          <Badge label={p.status} />
          <MiniButton label="Tester" onPress={() => test(p.provider_key)} full />
        </View>
      ))}
    </Screen>
  );
}

function AdminMerchants() {
  const [items, setItems] = useState([]);
  const [country, setCountry] = useState('CG');
  const [form, setForm] = useState({ businessName: '', email: '', phone: '' });
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/admin/merchants?limit=30');
      setItems(data.data || []);
    } catch (e) {
      if (!(e instanceof AuthError)) Alert.alert('Marchands', userMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      const data = await apiFetch('/admin/merchants', { method: 'POST', body: { ...form, country } });
      Alert.alert('Marchand créé', data.temporaryPassword ? `Mot de passe temporaire : ${data.temporaryPassword}\nLe marchand devra le changer à sa première connexion.` : 'Compte créé');
      setForm({ businessName: '', email: '', phone: '' });
      load();
    } catch (e) {
      if (!(e instanceof AuthError)) Alert.alert('Création', userMessage(e));
    }
  };

  return (
    <Screen>
      <Text style={s.h1}>Marchands</Text>
      <Text style={s.section}>Créer un marchand</Text>
      <Field label="Business" value={form.businessName} onChange={(v) => setForm({ ...form, businessName: v })} />
      <Field label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} keyboardType="email-address" autoCapitalize="none" />
      <Field label="Téléphone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} keyboardType="phone-pad" />
      <Field label="Pays" value={country} onChange={setCountry} autoCapitalize="characters" />
      <Button label="Créer et affecter APIs pays" onPress={create} />
      <Text style={s.section}>Liste</Text>
      {loading && <ActivityIndicator color={C.cyan} />}
      {items.map((m) => <Tile key={m.merchant_id} title={m.business_name} text={`${m.country} | ${m.currency} | ${m.merchant_status}`} />)}
    </Screen>
  );
}

function AdminMonitoring() {
  const [activity, setActivity] = useState([]);
  const [stats, setStats] = useState(null);

  const load = async () => {
    try {
      const [a, sdata] = await Promise.all([
        apiFetch('/admin/activity/live'),
        apiFetch('/admin/stats/global'),
      ]);
      setActivity(a.data || []);
      setStats(sdata);
    } catch (e) {
      if (!(e instanceof AuthError)) Alert.alert('Monitoring', userMessage(e));
    }
  };
  useEffect(() => { load(); }, []);

  return (
    <Screen>
      <Text style={s.h1}>Monitoring</Text>
      {stats && <JsonBox data={stats} />}
      <Text style={s.section}>Activité récente</Text>
      {activity.map((t) => (
        <View style={s.card} key={t.transaction_id}>
          <Text style={s.cardTitle}>{t.business_name || 'Transaction'}</Text>
          <Text style={s.amount}>{money(t.amount, t.currency)}</Text>
          <Text style={s.muted}>{t.payment_method} | {t.status} | {t.detected_country}</Text>
        </View>
      ))}
    </Screen>
  );
}

// ─── Composants ──────────────────────────────────────────────────
function Screen({ children }) {
  return <ScrollView style={s.screen} contentContainerStyle={s.screenInner} keyboardShouldPersistTaps="handled"><View style={s.responsive}>{children}</View></ScrollView>;
}

function Segment({ value, onChange, items }) {
  return (
    <View style={s.segment}>
      {items.map(([key, label]) => (
        <Pressable key={key} onPress={() => onChange(key)} style={[s.segItem, value === key && s.segOn]}>
          <Text style={[s.segText, value === key && s.segTextOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// Puces à sélection unique, sur plusieurs lignes (opérateurs, comptes, filtres).
function Chips({ value, onChange, items }) {
  return (
    <View style={s.chips}>
      {items.map(([key, label]) => (
        <Pressable key={String(key)} onPress={() => onChange(key)} style={[s.chip, value === key && value !== null && s.chipOn]}>
          <Text style={[s.chipText, value === key && value !== null && s.chipTextOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Field({ label, value, onChange, ...props }) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} placeholderTextColor="#8a94a6" style={s.input} {...props} />
    </View>
  );
}

function Button({ label, onPress, disabled }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[s.btn, disabled && { opacity: 0.6 }]}>
      <Text style={s.btnText}>{label}</Text>
    </Pressable>
  );
}

function MiniButton({ label, onPress, full }) {
  return (
    <Pressable onPress={onPress} style={[s.mini, full && { alignSelf: 'stretch' }]}>
      <Text style={s.miniText}>{label}</Text>
    </Pressable>
  );
}

function Badge({ label }) {
  const v = String(label || '').toLowerCase();
  const color = v.includes('active') || v.includes('authorized') || v.includes('completed') ? C.green
    : v.includes('fail') || v.includes('suspend') ? C.red
      : v.includes('attente') || v.includes('pending') || v.includes('intégration') ? C.amber
        : C.darkBlue;
  return <Text style={[s.badge, { color, backgroundColor: `${color}18` }]}>{label}</Text>;
}

function Tile({ title, text, badge }) {
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      <Text style={s.muted}>{text}</Text>
      {badge ? <Badge label={badge} /> : null}
    </View>
  );
}

// Encart informatif (fonction en cours d'integration) : ce n'est pas une erreur.
function Notice({ title, text }) {
  return (
    <View style={s.notice}>
      <Text style={s.noticeTitle}>{title}</Text>
      <Text style={s.noticeText}>{text}</Text>
    </View>
  );
}

function InfoGrid({ items }) {
  return (
    <View style={s.grid}>
      {items.map(([k, v]) => <View style={s.info} key={k}><Text style={s.label}>{k}</Text><Text style={s.infoVal}>{v || '-'}</Text></View>)}
    </View>
  );
}

function JsonBox({ data }) {
  const text = useMemo(() => JSON.stringify(data, null, 2), [data]);
  return <ScrollView horizontal style={s.json}><Text style={s.jsonText}>{text}</Text></ScrollView>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? 28 : 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, gap: 12 },
  auth: { padding: 24, gap: 14 },
  logo: { fontSize: 34, fontWeight: '900', color: C.cyan, marginTop: 28 },
  brand: { fontSize: 21, fontWeight: '900', color: C.cyan },
  sub: { color: C.muted, marginTop: 2 },
  footer: { color: C.muted, fontSize: 11, textAlign: 'center', marginTop: 16 },
  top: { paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.card },
  deviceHint: { backgroundColor: C.card, color: C.muted, fontSize: 11, paddingHorizontal: 18, paddingBottom: 6 },
  ghostBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  ghostText: { color: C.muted, fontWeight: '700' },
  tabs: { backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border, flexGrow: 0 },
  tab: { minWidth: 96, paddingVertical: 11, paddingHorizontal: 10, alignItems: 'center' },
  tabOn: { borderBottomWidth: 3, borderBottomColor: C.cyan },
  tabText: { color: C.muted, fontSize: 12, fontWeight: '700' },
  tabTextOn: { color: C.cyan },
  screen: { flex: 1 },
  screenInner: { padding: 18, paddingBottom: 48 },
  responsive: { width: '100%', maxWidth: 980, alignSelf: 'center', gap: 12 },
  h1: { fontSize: 25, fontWeight: '900', color: C.text },
  section: { fontSize: 15, fontWeight: '900', color: C.darkBlue, marginTop: 8 },
  muted: { color: C.muted },
  segment: { flexDirection: 'row', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 3, gap: 3 },
  segItem: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 6 },
  segOn: { backgroundColor: C.cyan },
  segText: { color: C.muted, fontWeight: '800', fontSize: 12 },
  segTextOn: { color: C.card },
  field: { gap: 5 },
  label: { color: C.muted, fontSize: 12, fontWeight: '700' },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11, color: C.text, fontSize: 15 },
  btn: { backgroundColor: C.cyan, borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  btnText: { color: C.card, fontWeight: '900', fontSize: 15 },
  mini: { borderWidth: 1, borderColor: C.cyan, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center', flex: 1, marginTop: 8 },
  miniText: { color: C.cyan, fontWeight: '900', fontSize: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 14, gap: 7 },
  cardTitle: { color: C.text, fontSize: 16, fontWeight: '900' },
  amount: { color: C.cyan, fontSize: 22, fontWeight: '900' },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, overflow: 'hidden', fontWeight: '900', fontSize: 11 },
  notice: { backgroundColor: '#fff7e6', borderWidth: 1, borderColor: '#f3d9a4', borderRadius: 8, padding: 16, gap: 6 },
  noticeTitle: { color: C.amber, fontWeight: '900', fontSize: 15 },
  noticeText: { color: C.text, fontSize: 14 },
  qr: { alignItems: 'center', backgroundColor: '#fff', padding: 16, borderRadius: 8 },
  link: { color: C.darkBlue, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  info: { width: '48%', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12 },
  infoVal: { color: C.text, fontSize: 16, fontWeight: '900', marginTop: 4 },
  json: { backgroundColor: '#111827', borderRadius: 8, padding: 12, maxHeight: 260 },
  // Caisse (vague 4)
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  balanceCard: { backgroundColor: C.darkBlue, borderRadius: 12, padding: 18, gap: 4 },
  balanceLabel: { color: '#b3ffffff', fontSize: 12, fontWeight: '700' },
  balanceValue: { color: C.card, fontSize: 30, fontWeight: '900' },
  balanceSub: { color: '#d9ffffff', fontSize: 12 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { width: '48%', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 14, alignItems: 'center', gap: 2 },
  tileOn: { backgroundColor: C.cyan, borderColor: C.cyan },
  tileIcon: { fontSize: 26 },
  tileTitle: { color: C.darkBlue, fontSize: 16, fontWeight: '900' },
  tileSub: { color: C.muted, fontSize: 11 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: C.cyan, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, backgroundColor: C.card },
  chipOn: { backgroundColor: C.cyan },
  chipText: { color: C.cyan, fontWeight: '800', fontSize: 12 },
  chipTextOn: { color: C.card },
  detect: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12, gap: 6 },
  detectMain: { color: C.text, fontWeight: '900', fontSize: 14 },
  copyBtn: { borderWidth: 1, borderColor: C.cyan, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10 },
  modalBg: { flex: 1, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 420, backgroundColor: C.card, borderRadius: 12, padding: 18, gap: 10 },
  jsonText: { color: '#e5e7eb', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 },
});
