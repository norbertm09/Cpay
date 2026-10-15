import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
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
    : [['home', 'Accueil'], ['collect', 'Encaisser'], ['links', 'QR/Lien'], ['history', 'Historique'], ['tokens', 'Tokens'], ['integrations', 'CRM/Compta'], ['pilot', 'Pilot'], ['support', 'Support']];

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
      {isAdmin ? <AdminApp tab={tab} session={session} /> : <MerchantApp tab={tab} session={session} />}
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
function MerchantApp({ tab, session }) {
  if (tab === 'collect') return <PaymentScreen session={session} />;
  if (tab === 'links') return <LinkScreen session={session} />;
  if (tab === 'history') return <HistoryScreen session={session} />;
  if (tab === 'tokens') return <TokensScreen session={session} />;
  if (tab === 'integrations') return <IntegrationsScreen session={session} />;
  if (tab === 'pilot') return <PilotScreen session={session} />;
  if (tab === 'support') return <SupportScreen session={session} />;
  return <MerchantHome session={session} />;
}

function MerchantHome({ session }) {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/merchant/account')
      .then(setAccount)
      .catch((e) => { if (!(e instanceof AuthError)) Alert.alert('Compte', userMessage(e)); })
      .finally(() => setLoading(false));
  }, []);

  return (
    <Screen>
      <Text style={s.h1}>Tableau de bord</Text>
      {loading ? <ActivityIndicator color={C.cyan} /> : (
        <>
          <InfoGrid items={[
            ['Business', account?.business_name || session.user?.businessName],
            ['Pays', account?.country || session.user?.country],
            ['Devise', account?.currency || session.user?.currency],
            ['KYB', `Niveau ${account?.kyb_level ?? session.user?.kybLevel ?? 0}`],
          ]} />
          <Text style={s.section}>Fonctions disponibles</Text>
          <Tile title="Encaisser" text="Mobile Money (MTN MoMo, Airtel Money), QR et lien de paiement." />
          <Tile title="Retrait" text={FEATURE_PENDING} badge={FEATURE_PENDING} />
          <Tile title="Historique" text="Transactions et règlements." />
        </>
      )}
    </Screen>
  );
}

// Suivi d'un encaissement en attente : GET /merchant/collect/:id/status toutes
// les 3 s, 90 s maximum, puis « En attente de confirmation ».
function usePendingCollect(result, setResult) {
  const [polling, setPolling] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const txnId = result?.txnId || result?.transactionId;
    const isPending = !!result && (result.pending === true || result.status === 'pending');
    if (!txnId || !isPending) { setPolling(false); return undefined; }

    let cancelled = false;
    let timer = null;
    const startedAt = Date.now();
    setPolling(true);
    setTimedOut(false);

    const tick = async () => {
      if (cancelled) return;
      try {
        const status = await apiFetch(`/merchant/collect/${encodeURIComponent(txnId)}/status`);
        if (cancelled) return;
        if (status.status && status.status !== 'pending') {
          setResult({ ...result, ...status, success: status.status === 'authorized' || status.status === 'completed', pending: false });
          setPolling(false);
          return;
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof AuthError) { setPolling(false); return; }
        if (isFeatureUnavailable(e)) { setPolling(false); setTimedOut(true); return; }
        // erreur passagere : on continue jusqu'au delai maximum
      }
      if (Date.now() - startedAt >= POLL_MAX_MS) {
        setPolling(false);
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [result?.txnId, result?.transactionId, result?.status, result?.pending]);

  return { polling, timedOut };
}

function PaymentScreen() {
  const [type, setType] = useState('collect');
  const [method, setMethod] = useState('mtn_momo');
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [description, setDescription] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // Une cle d'idempotence par tentative : conservee tant que la demande n'a pas abouti,
  // pour qu'un rejeu (reseau) ne cree pas un second encaissement.
  const idemKey = useRef(newIdempotencyKey());
  const { polling, timedOut } = usePendingCollect(result, setResult);

  useEffect(() => { idemKey.current = newIdempotencyKey(); }, [amount, phone, description, method]);

  const submit = async () => {
    if (!amount || Number(amount) <= 0) return Alert.alert('Encaissement', 'Montant invalide.');
    if (!phone) return Alert.alert('Encaissement', 'Téléphone client requis.');
    setLoading(true);
    setResult(null);
    try {
      const data = await apiFetch('/merchant/collect', {
        method: 'POST',
        idempotencyKey: idemKey.current,
        body: { amount: Number(amount), customerPhone: phone.trim(), method, description: description || undefined },
      });
      idemKey.current = newIdempotencyKey();
      setResult(data);
    } catch (e) {
      if (e instanceof AuthError) return;
      if (isFeatureUnavailable(e)) setUnavailable(true);
      else Alert.alert('Encaissement', userMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Text style={s.h1}>Encaissement & retrait</Text>
      <Segment value={type} onChange={(v) => { setType(v); setResult(null); }} items={[['collect', 'Encaisser'], ['payout', 'Retrait']]} />
      {type === 'payout' || unavailable ? (
        <Notice title={type === 'payout' ? 'Retrait' : 'Encaissement'} text={FEATURE_PENDING} />
      ) : (
        <>
          <Segment value={method} onChange={setMethod} items={[['mtn_momo', 'MTN MoMo'], ['airtel_money', 'Airtel Money']]} />
          <Field label="Montant (XAF)" value={amount} onChange={setAmount} keyboardType="decimal-pad" />
          <Field label="Téléphone client" value={phone} onChange={setPhone} keyboardType="phone-pad" placeholder="+242..." />
          <Field label="Description" value={description} onChange={setDescription} />
          <Button label={loading ? 'Traitement...' : 'Encaisser'} onPress={submit} disabled={loading || polling} />
          {result && <ResultCard result={result} polling={polling} timedOut={timedOut} />}
        </>
      )}
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

function ResultCard({ result, polling, timedOut }) {
  const pending = result.pending === true || result.status === 'pending';
  const title = pending ? (timedOut ? PENDING_CONFIRMATION : 'Demande envoyée') : result.success ? 'Accepté' : 'Refusé';
  return (
    <View style={s.card}>
      <View style={s.row}>
        <Text style={s.cardTitle}>{title}</Text>
        {polling ? <ActivityIndicator color={C.cyan} /> : null}
      </View>
      <Text style={s.muted}>{timedOut ? 'Le client n’a pas encore confirmé sur son téléphone. Le statut sera mis à jour dans l’historique.' : result.label || result.message || result.error || result.status}</Text>
      <Text style={s.amount}>{money(result.amount, result.currency || 'XAF')}</Text>
      <Text style={s.muted}>Réf : {result.reference || result.txnId || result.authCode || '-'}</Text>
      <Badge label={pending ? (timedOut ? PENDING_CONFIRMATION : 'pending') : result.status || (result.success ? 'authorized' : 'failed')} />
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
  jsonText: { color: '#e5e7eb', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 },
});
