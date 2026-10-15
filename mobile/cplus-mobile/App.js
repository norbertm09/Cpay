import React, { useEffect, useMemo, useState } from 'react';
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
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import QRCode from 'react-native-qrcode-svg';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://api.c-pay.global';
const API = `${API_BASE}/api/v1`;

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
};

const money = (v, currency = '') => `${Number(v || 0).toLocaleString('fr-FR')} ${currency || ''}`.trim();
const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function apiFetch(path, { token, method = 'GET', body, idempotent = false } = {}) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotent) headers['Idempotency-Key'] = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

function useSession() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState(null);

  useEffect(() => {
    AsyncStorage.getItem('cplus_session')
      .then((raw) => raw && setSession(JSON.parse(raw)))
      .finally(() => setReady(true));
  }, []);

  const save = async (next) => {
    setSession(next);
    if (next) await AsyncStorage.setItem('cplus_session', JSON.stringify(next));
    else await AsyncStorage.removeItem('cplus_session');
  };

  return { ready, session, save };
}

export default function App() {
  const { ready, session, save } = useSession();
  const [tab, setTab] = useState('home');
  const { width } = useWindowDimensions();
  const profile = width >= 900 ? 'tablet' : width >= 520 ? 'tpe' : 'phone';

  if (!ready) return <Splash />;
  if (!session) return <AuthScreen onSession={save} />;

  const isAdmin = session.type === 'admin';
  const tabs = isAdmin
    ? [['home', 'Accueil'], ['apis', 'APIs'], ['merchants', 'Marchands'], ['monitoring', 'Monitoring'], ['pilot', 'Pilot']]
    : [['home', 'Accueil'], ['collect', 'Encaisser'], ['links', 'QR/Lien'], ['history', 'Historique'], ['rails', 'Rails'], ['tokens', 'Tokens'], ['integrations', 'CRM/Compta'], ['pilot', 'Pilot'], ['support', 'Support']];

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <View style={s.top}>
        <View>
          <Text style={s.brand}>CPlus 2.6.0</Text>
          <Text style={s.sub}>{isAdmin ? 'Administrateur' : session.user?.businessName || 'Marchand'}</Text>
        </View>
        <Pressable style={s.ghostBtn} onPress={() => save(null)}><Text style={s.ghostText}>Sortir</Text></Pressable>
      </View>
      <Text style={s.deviceHint}>{profile === 'tablet' ? 'Mode tablette' : profile === 'tpe' ? 'Mode TPE' : 'Mode telephone'}</Text>
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
  return <View style={s.center}><ActivityIndicator color={C.cyan} /><Text style={s.muted}>CPlus 2.6.0</Text></View>;
}

function AuthScreen({ onSession }) {
  const [mode, setMode] = useState('merchant');
  const [register, setRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    emailOrPhone: '',
    email: '',
    phone: '',
    password: '',
    businessName: '',
  });

  const patch = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setLoading(true);
    try {
      const path = mode === 'admin'
        ? '/admin/auth/login'
        : register ? '/merchant/auth/register' : '/merchant/auth/login';
      const body = mode === 'admin'
        ? { email: form.email || form.emailOrPhone, password: form.password }
        : register
          ? { businessName: form.businessName, email: form.email, phone: form.phone, password: form.password }
          : { emailOrPhone: form.emailOrPhone, password: form.password };
      const data = await apiFetch(path, { method: 'POST', body });
      await onSession({
        type: mode,
        token: data.access_token,
        refreshToken: data.refresh_token,
        user: data.user || data.admin,
      });
    } catch (err) {
      Alert.alert('Connexion', err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={s.auth}>
        <Text style={s.logo}>CPlus 2.6.0</Text>
        <Text style={s.muted}>Plateforme mobile Android & iOS</Text>
        <Segment value={mode} onChange={(v) => { setMode(v); setRegister(false); }} items={[['merchant', 'Marchand'], ['admin', 'Admin']]} />
        {mode === 'merchant' && <Segment value={register ? 'register' : 'login'} onChange={(v) => setRegister(v === 'register')} items={[['login', 'Connexion'], ['register', 'Créer compte']]} />}
        {mode === 'merchant' && register && <Field label="Nom commercial" value={form.businessName} onChange={(v) => patch('businessName', v)} />}
        {mode === 'merchant' && register && <Field label="Téléphone" value={form.phone} onChange={(v) => patch('phone', v)} keyboardType="phone-pad" placeholder="+243..." />}
        {(register || mode === 'admin') && <Field label="Email" value={form.email} onChange={(v) => patch('email', v)} keyboardType="email-address" placeholder={mode === 'admin' ? 'admin@c-pay.global' : 'merchant@c-pay.global'} />}
        {mode === 'merchant' && !register && <Field label="Email ou téléphone" value={form.emailOrPhone} onChange={(v) => patch('emailOrPhone', v)} />}
        <Field label="Mot de passe" value={form.password} onChange={(v) => patch('password', v)} secureTextEntry />
        <Button label={loading ? 'Traitement...' : register ? 'Créer le compte' : 'Se connecter'} onPress={submit} disabled={loading} />
      </ScrollView>
    </SafeAreaView>
  );
}

function MerchantApp({ tab, session }) {
  if (tab === 'collect') return <PaymentScreen session={session} />;
  if (tab === 'links') return <LinkScreen session={session} />;
  if (tab === 'history') return <HistoryScreen session={session} />;
  if (tab === 'rails') return <RailsScreen session={session} />;
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
    apiFetch('/merchant/account', { token: session.token })
      .then(setAccount)
      .catch((e) => Alert.alert('Compte', e.message))
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
          <Tile title="Encaisser" text="Mobile Money, carte, QR et lien." />
          <Tile title="Retrait" text="Payout Mobile Money et rails connectés." />
          <Tile title="Visa rails" text="Visa Direct et Account/Wallet depuis la plateforme." />
        </>
      )}
    </Screen>
  );
}

function PaymentScreen({ session }) {
  const [type, setType] = useState('collect');
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [description, setDescription] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setResult(null);
    try {
      const data = await apiFetch(`/${type}`, {
        token: session.token,
        method: 'POST',
        idempotent: true,
        body: { amount: Number(amount), customerPhone: phone, description },
      });
      setResult(data);
    } catch (e) {
      Alert.alert(type === 'collect' ? 'Encaissement' : 'Retrait', e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Text style={s.h1}>Encaissement & retrait</Text>
      <Segment value={type} onChange={setType} items={[['collect', 'Encaisser'], ['payout', 'Retrait']]} />
      <Field label="Montant" value={amount} onChange={setAmount} keyboardType="decimal-pad" />
      <Field label="Téléphone client" value={phone} onChange={setPhone} keyboardType="phone-pad" placeholder="+243..." />
      <Field label="Description" value={description} onChange={setDescription} />
      <Button label={loading ? 'Traitement...' : type === 'collect' ? 'Encaisser' : 'Envoyer retrait'} onPress={submit} disabled={loading} />
      {result && <ResultCard result={result} />}
    </Screen>
  );
}

function LinkScreen({ session }) {
  const [mode, setMode] = useState('qr-code');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [phone, setPhone] = useState('');
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);

  const generate = async () => {
    setLoading(true);
    setPayload(null);
    try {
      const data = await apiFetch(`/${mode}`, {
        token: session.token,
        method: 'POST',
        idempotent: true,
        body: { amount: Number(amount), description },
      });
      setPayload(data);
    } catch (e) {
      Alert.alert(mode === 'qr-code' ? 'QR Code' : 'Pay Link', e.message);
    } finally {
      setLoading(false);
    }
  };

  const link = payload?.url || payload?.shortUrl || payload?.short_url;
  const qrContent = payload?.qrContent || payload?.qr_content || link;
  const shareText = compact(payload?.shareText || `Payer ${amount} via CPlus 2.6.0 : ${link}`);

  const share = async () => link && Share.share({ message: shareText, url: link });
  const copy = async () => {
    await Clipboard.setStringAsync(link || qrContent || '');
    Alert.alert('Copie', 'Lien copié');
  };
  const whatsapp = () => link && Linking.openURL(`whatsapp://send?text=${encodeURIComponent(shareText)}`).catch(() => Share.share({ message: shareText }));
  const sms = () => link && Linking.openURL(`sms:?body=${encodeURIComponent(shareText)}`);
  const serverSend = async (channel) => {
    if (!payload?.linkId && !payload?.shortId && !payload?.id) return Alert.alert('Envoi', 'Identifiant Pay Link manquant');
    if (!phone) return Alert.alert('Envoi', 'Téléphone destinataire requis');
    const id = payload.linkId || payload.shortId || payload.id;
    try {
      await apiFetch(`/pay-link/${id}/send`, { token: session.token, method: 'POST', body: { channel, phone } });
      Alert.alert('Envoi', `${channel} envoyé`);
    } catch (e) {
      Alert.alert('Envoi', e.message);
    }
  };

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
          {qrContent ? <View style={s.qr}><QRCode value={qrContent} size={220} /></View> : null}
          {link ? <Text style={s.link}>{link}</Text> : null}
          <View style={s.row}>
            <MiniButton label="Partager" onPress={share} />
            <MiniButton label="WhatsApp" onPress={whatsapp} />
            <MiniButton label="SMS" onPress={sms} />
          </View>
          <MiniButton label="Copier le lien" onPress={copy} full />
          {mode === 'pay-link' && (
            <>
              <Field label="Téléphone envoi serveur" value={phone} onChange={setPhone} keyboardType="phone-pad" />
              <View style={s.row}>
                <MiniButton label="API WhatsApp" onPress={() => serverSend('whatsapp')} />
                <MiniButton label="SMPP SMS" onPress={() => serverSend('sms')} />
              </View>
            </>
          )}
        </View>
      )}
    </Screen>
  );
}

function HistoryScreen({ session }) {
  const [view, setView] = useState('transactions');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch(`/merchant/${view}`, { token: session.token });
      setItems(data.data || []);
    } catch (e) {
      Alert.alert('Historique', e.message);
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
        <View style={s.card} key={item.transaction_id || item.batch_id || idx}>
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

function RailsScreen({ session }) {
  const [mode, setMode] = useState('visa-wallet');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [pan, setPan] = useState('');
  const [wallet, setWallet] = useState('');
  const [reference, setReference] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    setResult(null);
    try {
      let path = '/rails/visa-payouts/v3/payouts';
      let body = {};
      const txnId = reference || `${Date.now()}`;
      if (mode === 'visa-push') {
        path = '/rails/visa-direct/push-funds';
        body = { txnId, amount: Number(amount), currency, recipientPrimaryAccountNumber: pan, recipient: { name: 'Recipient' } };
      } else if (mode === 'visa-pull') {
        path = '/rails/visa-direct/pull-funds';
        body = { txnId, amount: Number(amount), currency, senderPrimaryAccountNumber: pan };
      } else {
        body = {
          txnId,
          amount: Number(amount),
          currency,
          payoutMethod: 'W',
          recipientDetail: {
            firstName: 'Client',
            lastName: 'CPlus',
            type: 'I',
            wallet: {
              countryCode: 'COD',
              accountIdentifier: wallet,
              accountIdentifierType: 'PHONE',
              currencyCode: currency,
            },
          },
        };
      }
      const data = await apiFetch(path, { token: session.token, method: 'POST', body });
      setResult(data);
    } catch (e) {
      Alert.alert('Rails', e.message);
    } finally {
      setLoading(false);
    }
  };

  const query = async () => {
    setLoading(true);
    try {
      const data = await apiFetch(`/rails/visa-payouts/v3/payouts?id=${encodeURIComponent(reference)}&idType=CLIENT_REFERENCE_ID`, { token: session.token });
      setResult(data);
    } catch (e) {
      Alert.alert('Query', e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <Text style={s.h1}>Rails Visa</Text>
      <Segment value={mode} onChange={setMode} items={[['visa-wallet', 'Wallet'], ['visa-push', 'Push'], ['visa-pull', 'Pull']]} />
      <Field label="Référence" value={reference} onChange={setReference} placeholder="optionnel" />
      <Field label="Montant" value={amount} onChange={setAmount} keyboardType="decimal-pad" />
      <Field label="Devise" value={currency} onChange={setCurrency} />
      {mode === 'visa-wallet'
        ? <Field label="Wallet / téléphone" value={wallet} onChange={setWallet} keyboardType="phone-pad" />
        : <Field label="PAN / carte" value={pan} onChange={setPan} keyboardType="number-pad" />}
      <Button label={loading ? 'Traitement...' : 'Exécuter'} onPress={submit} disabled={loading} />
      <MiniButton label="Query payout par référence" onPress={query} full />
      {result && <JsonBox data={result} />}
    </Screen>
  );
}

function TokensScreen({ session }) {
  const [tokens, setTokens] = useState([]);
  const [form, setForm] = useState({ provider: 'network_token', tokenRef: '', customerRef: '', network: '', last4: '' });
  const load = () => apiFetch('/merchant/tokens', { token: session.token }).then((d) => setTokens(d.data || []));
  useEffect(() => { load().catch((e) => Alert.alert('Tokens', e.message)); }, []);
  const create = async () => {
    try {
      await apiFetch('/merchant/tokens', { token: session.token, method: 'POST', body: form });
      setForm({ provider: 'network_token', tokenRef: '', customerRef: '', network: '', last4: '' });
      load();
    } catch (e) { Alert.alert('Tokenisation', e.message); }
  };
  const revoke = async (id) => {
    await apiFetch(`/merchant/tokens/${id}`, { token: session.token, method: 'DELETE' });
    load();
  };
  return (
    <Screen>
      <Text style={s.h1}>Tokenisation</Text>
      <Text style={s.muted}>Stocke uniquement des tokens PSP/reseau. Le PAN brut est refuse.</Text>
      <Field label="Provider token" value={form.provider} onChange={(v) => setForm(f => ({ ...f, provider: v }))} />
      <Field label="Token ref (pas le PAN)" value={form.tokenRef} onChange={(v) => setForm(f => ({ ...f, tokenRef: v }))} />
      <Field label="Client ref" value={form.customerRef} onChange={(v) => setForm(f => ({ ...f, customerRef: v }))} />
      <View style={s.row}><View style={{ flex: 1 }}><Field label="Réseau" value={form.network} onChange={(v) => setForm(f => ({ ...f, network: v }))} /></View><View style={{ flex: 1 }}><Field label="Last4" value={form.last4} onChange={(v) => setForm(f => ({ ...f, last4: v }))} keyboardType="number-pad" /></View></View>
      <Button label="Créer token" onPress={create} />
      {tokens.map(t => <View style={s.card} key={t.token_id}><Text style={s.cardTitle}>{t.provider} {t.network || ''} ****{t.last4 || '----'}</Text><Text style={s.muted}>{t.customer_ref || 'client non renseigne'} · {t.status}</Text><MiniButton label="Révoquer" onPress={() => revoke(t.token_id)} full /></View>)}
    </Screen>
  );
}

function IntegrationsScreen({ session }) {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ integrationType: 'accounting', provider: 'webhook', displayName: '', endpointUrl: '', status: 'inactive' });
  const load = () => apiFetch('/merchant/integrations', { token: session.token }).then((d) => setItems(d.data || []));
  useEffect(() => { load().catch((e) => Alert.alert('Integrations', e.message)); }, []);
  const save = async () => {
    try {
      await apiFetch('/merchant/integrations', { token: session.token, method: 'POST', body: form });
      setForm({ integrationType: 'accounting', provider: 'webhook', displayName: '', endpointUrl: '', status: 'inactive' });
      load();
    } catch (e) { Alert.alert('Integrations', e.message); }
  };
  const exportCsv = async () => {
    const url = `${API}/merchant/exports/transactions?format=csv`;
    Linking.openURL(url).catch(() => Alert.alert('Export', 'Ouvrir depuis le portail web pour telecharger le CSV.'));
  };
  return (
    <Screen>
      <Text style={s.h1}>CRM & comptabilité</Text>
      <Text style={s.muted}>Webhook signe pour pousser transactions et règlements vers ERP, CRM ou logiciel comptable.</Text>
      <Segment value={form.integrationType} onChange={(v) => setForm(f => ({ ...f, integrationType: v }))} items={[['accounting', 'Compta'], ['crm', 'CRM'], ['erp', 'ERP'], ['webhook', 'Webhook']]} />
      <Field label="Nom" value={form.displayName} onChange={(v) => setForm(f => ({ ...f, displayName: v }))} />
      <Field label="Provider" value={form.provider} onChange={(v) => setForm(f => ({ ...f, provider: v }))} placeholder="sage, odoo, quickbooks, salesforce..." />
      <Field label="Endpoint URL" value={form.endpointUrl} onChange={(v) => setForm(f => ({ ...f, endpointUrl: v }))} keyboardType="url" />
      <Button label="Enregistrer connecteur" onPress={save} />
      <MiniButton label="Exporter transactions CSV" onPress={exportCsv} full />
      {items.map(i => <View style={s.card} key={i.integration_id}><Text style={s.cardTitle}>{i.display_name}</Text><Text style={s.muted}>{i.integration_type} · {i.provider} · {i.status}</Text><Text style={s.link}>{i.endpoint_url || 'endpoint non renseigne'}</Text></View>)}
    </Screen>
  );
}

function SupportScreen({ session }) {
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ subject: '', category: 'general', priority: 'normal', message: '' });
  const load = () => apiFetch('/merchant/support/tickets', { token: session.token }).then((d) => setTickets(d.data || []));
  useEffect(() => { load().catch((e) => Alert.alert('Support', e.message)); }, []);
  const create = async () => {
    const data = await apiFetch('/merchant/support/tickets', { token: session.token, method: 'POST', body: form });
    setSelected(data);
    setForm({ subject: '', category: 'general', priority: 'normal', message: '' });
    load();
  };
  const reply = async () => {
    const data = await apiFetch(`/merchant/support/tickets/${selected.ticket_id}/messages`, { token: session.token, method: 'POST', body: { message } });
    setSelected(data);
    setMessage('');
    load();
  };
  return (
    <Screen>
      <Text style={s.h1}>Support</Text>
      <Field label="Sujet" value={form.subject} onChange={(v) => setForm(f => ({ ...f, subject: v }))} />
      <Field label="Message" value={form.message} onChange={(v) => setForm(f => ({ ...f, message: v }))} multiline />
      <Button label="Créer ticket" onPress={create} />
      {tickets.map(t => <Pressable key={t.ticket_id} style={s.card} onPress={() => apiFetch(`/merchant/support/tickets/${t.ticket_id}`, { token: session.token }).then(setSelected)}><Text style={s.cardTitle}>{t.ticket_number}</Text><Text style={s.muted}>{t.subject} · {t.status}</Text></Pressable>)}
      {selected && <View style={s.card}><Text style={s.cardTitle}>{selected.subject}</Text>{selected.messages?.map(m => <Text key={m.message_id} style={s.muted}>{m.sender_name}: {m.message}</Text>)}<Field label="Réponse" value={message} onChange={setMessage} multiline /><MiniButton label="Envoyer" onPress={reply} full /></View>}
    </Screen>
  );
}

function AdminApp({ tab, session }) {
  if (tab === 'apis') return <AdminApis session={session} />;
  if (tab === 'merchants') return <AdminMerchants session={session} />;
  if (tab === 'monitoring') return <AdminMonitoring session={session} />;
  if (tab === 'pilot') return <PilotScreen session={session} />;
  return <AdminHome session={session} />;
}

function PilotScreen({ session }) {
  const [state, setState] = useState(null);
  const isAdmin = session.type === 'admin';

  useEffect(() => {
    const path = isAdmin ? '/admin/pilot/features' : '/merchant/pilot/state';
    apiFetch(path, { token: session.token })
      .then(setState)
      .catch((e) => Alert.alert('Pilot', e.message));
  }, [isAdmin, session.token]);

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
    apiFetch('/admin/stats/global', { token: session.token }).then(setStats).catch(() => {});
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
    </Screen>
  );
}

function AdminApis({ session }) {
  const [items, setItems] = useState([]);
  const [defaults, setDefaults] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [configs, countries] = await Promise.all([
        apiFetch('/admin/api-configs', { token: session.token }),
        apiFetch('/admin/country-defaults', { token: session.token }),
      ]);
      setItems(configs.data || []);
      setDefaults(countries.data || []);
    } catch (e) {
      Alert.alert('APIs', e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const test = async (key) => {
    try {
      const data = await apiFetch(`/admin/api-configs/${key}/test`, { token: session.token, method: 'POST' });
      Alert.alert(key, data.ok ? 'Connexion OK' : data.reason || 'Test échoué');
    } catch (e) {
      Alert.alert(key, e.message);
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

function AdminMerchants({ session }) {
  const [items, setItems] = useState([]);
  const [country, setCountry] = useState('CD');
  const [form, setForm] = useState({ businessName: '', email: '', phone: '' });
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/admin/merchants?limit=30', { token: session.token });
      setItems(data.data || []);
    } catch (e) {
      Alert.alert('Marchands', e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      const data = await apiFetch('/admin/merchants', { token: session.token, method: 'POST', body: { ...form, country } });
      Alert.alert('Marchand créé', data.temporaryPassword ? `Mot de passe temporaire: ${data.temporaryPassword}` : 'Compte créé');
      setForm({ businessName: '', email: '', phone: '' });
      load();
    } catch (e) {
      Alert.alert('Création', e.message);
    }
  };

  return (
    <Screen>
      <Text style={s.h1}>Marchands</Text>
      <Text style={s.section}>Créer un marchand</Text>
      <Field label="Business" value={form.businessName} onChange={(v) => setForm({ ...form, businessName: v })} />
      <Field label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} keyboardType="email-address" />
      <Field label="Téléphone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} keyboardType="phone-pad" />
      <Field label="Pays" value={country} onChange={setCountry} />
      <Button label="Créer et affecter APIs pays" onPress={create} />
      <Text style={s.section}>Liste</Text>
      {loading && <ActivityIndicator color={C.cyan} />}
      {items.map((m) => <Tile key={m.merchant_id} title={m.business_name} text={`${m.country} | ${m.currency} | ${m.merchant_status}`} />)}
    </Screen>
  );
}

function AdminMonitoring({ session }) {
  const [activity, setActivity] = useState([]);
  const [stats, setStats] = useState(null);

  const load = async () => {
    try {
      const [a, sdata] = await Promise.all([
        apiFetch('/admin/activity/live', { token: session.token }),
        apiFetch('/admin/stats/global', { token: session.token }),
      ]);
      setActivity(a.data || []);
      setStats(sdata);
    } catch (e) {
      Alert.alert('Monitoring', e.message);
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

function Screen({ children }) {
  return <ScrollView style={s.screen} contentContainerStyle={s.screenInner}><View style={s.responsive}>{children}</View></ScrollView>;
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
  const color = v.includes('active') || v.includes('authorized') || v.includes('completed') ? C.green : v.includes('fail') || v.includes('suspend') ? C.red : C.darkBlue;
  return <Text style={[s.badge, { color, backgroundColor: `${color}18` }]}>{label}</Text>;
}

function Tile({ title, text }) {
  return <View style={s.card}><Text style={s.cardTitle}>{title}</Text><Text style={s.muted}>{text}</Text></View>;
}

function InfoGrid({ items }) {
  return (
    <View style={s.grid}>
      {items.map(([k, v]) => <View style={s.info} key={k}><Text style={s.label}>{k}</Text><Text style={s.infoVal}>{v || '-'}</Text></View>)}
    </View>
  );
}

function ResultCard({ result }) {
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{result.success ? 'Accepté' : 'Refusé'}</Text>
      <Text style={s.muted}>{result.message || result.error || result.status}</Text>
      <Text style={s.amount}>{money(result.amount, result.currency)}</Text>
      <Text style={s.muted}>Ref: {result.txnId || result.authCode || '-'}</Text>
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
  top: { paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.card },
  deviceHint: { backgroundColor: C.card, color: C.muted, fontSize: 11, paddingHorizontal: 18, paddingBottom: 6 },
  ghostBtn: { borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  ghostText: { color: C.muted, fontWeight: '700' },
  tabs: { backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border },
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
  qr: { alignItems: 'center', backgroundColor: '#fff', padding: 16, borderRadius: 8 },
  link: { color: C.darkBlue, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  info: { width: '48%', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12 },
  infoVal: { color: C.text, fontSize: 16, fontWeight: '900', marginTop: 4 },
  json: { backgroundColor: '#111827', borderRadius: 8, padding: 12, maxHeight: 260 },
  jsonText: { color: '#e5e7eb', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 },
});
