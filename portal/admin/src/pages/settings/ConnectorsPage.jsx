import React, { useState } from 'react';
import { Button, Card, PageHeader, Tabs, Chips, StatusBadge, Badge, Modal, Field, Input, Select, Textarea, Callout, Skeleton, ErrorState, EmptyState } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { configApi } from '../../services/api';
import { fmtDateTime, countryName } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';

// Connecteurs opérateurs : GET /api-configs (secrets masqués : api_key_masked, api_secret_status),
// GET /api-configs/:id, PUT /api-configs/:key, POST /api-configs/:key/test, GET /api-configs/env-status, GET /country-defaults.
const COUNTRIES = [['cd', 'RD Congo'], ['cm', 'Cameroun'], ['cg', 'Congo'], ['sn', 'Sénégal'], ['ci', 'Côte d’Ivoire']];
const CATALOG = {
  cd: { mobile: [['airtel_money', 'Airtel Money'], ['afrimoney', 'Afrimoney'], ['mpesa', 'M-Pesa'], ['orange_money_cd', 'Orange Money']], psp: [['cybersource', 'CyberSource']] },
  cm: { mobile: [['orange_money_cm', 'Orange Money'], ['mtn_momo_cm', 'MTN MoMo']], psp: [['cybersource', 'CyberSource']] },
  cg: { mobile: [['airtel_money_cg', 'Airtel Money'], ['mtn_momo_cg', 'MTN MoMo']], psp: [['cybersource', 'CyberSource'], ['migs', 'Mastercard Gateway']] },
  sn: { mobile: [['orange_money_sn', 'Orange Money'], ['wave_sn', 'Wave'], ['free_money_sn', 'Free Money']], psp: [['cybersource', 'CyberSource']] },
  ci: { mobile: [['orange_money_ci', 'Orange Money'], ['mtn_momo_ci', 'MTN MoMo'], ['wave_ci', 'Wave'], ['moov_money_ci', 'Moov Money']], psp: [['cybersource', 'CyberSource']] },
};
const DOCS = {
  mtn: 'Identifiants séparés Collection / Disbursement (momodeveloper.mtn.com). Callback : https://api.c-pay.global/api/v1/webhooks/mtn',
  airtel: 'OAuth2 client_credentials, token 180 s. Identifiants séparés Collection / Disbursement. Callback : https://api.c-pay.global/api/v1/webhooks/airtel',
  cybersource: 'Signature HTTP HMAC-SHA256 : Merchant ID, Key ID et Shared Secret. Webhook : https://api.c-pay.global/api/v1/webhooks/psp/cybersource',
  migs: 'Mastercard Gateway : Merchant ID + API password. Webhook : https://api.c-pay.global/api/v1/webhooks/psp/migs',
};
const docFor = (key) => Object.entries(DOCS).find(([k]) => key.includes(k))?.[1];

const SecretLine = ({ label, state }) => (
  <div className="between small"><span className="mono">{label}</span>{state?.configured || state === 'configured' || (typeof state === 'string' && state.startsWith('***')) ? <Badge tone="success">configuré {typeof state === 'string' && state.startsWith('***') ? state : state?.last4 ? `••••${state.last4}` : ''}</Badge> : <Badge tone="neutral">non configuré</Badge>}</div>
);

function ConfigModal({ provider, config, onClose, onSaved }) {
  const detail = useQuery(() => (config?.config_id ? configApi.apiConfig(config.config_id).then((r) => r.data?.data || r.data) : Promise.resolve(config || {})), [config?.config_id]);
  const d = detail.data || config || {};
  const [form, setForm] = useState({ status: config?.status || 'inactive', environment: config?.extra_params?.environment || 'sandbox', baseUrl: config?.base_url || '', baseUrlSandbox: config?.extra_params?.base_url_sandbox || '', merchantIdSandbox: config?.extra_params?.merchant_id_sandbox || '', merchantIdProd: config?.extra_params?.merchant_id_prod || '', apiKey: '', apiSecret: '', notes: config?.notes || '' });
  const [busy, setBusy] = useState(false);
  const f = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const payload = { status: form.status, notes: form.notes, baseUrl: form.baseUrl || undefined, extraParams: { environment: form.environment, base_url_sandbox: form.baseUrlSandbox, merchant_id_sandbox: form.merchantIdSandbox, merchant_id_prod: form.merchantIdProd } };
      if (form.apiKey) payload.apiKey = form.apiKey;
      if (form.apiSecret) payload.apiSecret = form.apiSecret;
      await configApi.updateApiConfig(provider.key, payload);
      toast.success('Connecteur enregistré'); onSaved(); onClose();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const extraSecrets = Object.entries(d.extra_params || {}).filter(([, v]) => v && typeof v === 'object' && 'configured' in v);
  return (
    <Modal title={`Configurer ${provider.name}`} sub={<span className="mono">{provider.key}</span>} onClose={() => !busy && onClose()} size="lg" footer={<><Button onClick={onClose} disabled={busy}>Annuler</Button><Button variant="primary" loading={busy} onClick={save}>Enregistrer</Button></>}>
      <div className="stack-lg">
        {docFor(provider.key) && <Callout tone="info">{docFor(provider.key)}</Callout>}
        <div className="secret-box" style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}>
          <div className="small strong mb-2">Secrets enregistrés — jamais affichés en clair, chiffrés au repos</div>
          {detail.loading ? <Skeleton lines={2} /> : (
            <div className="stack" style={{ gap: 4 }}>
              <SecretLine label="api_key" state={d.api_key && typeof d.api_key === 'object' ? d.api_key : d.api_key_masked} />
              <SecretLine label="api_secret" state={d.api_secret && typeof d.api_secret === 'object' ? d.api_secret : d.api_secret_status} />
              {extraSecrets.map(([k, v]) => <SecretLine key={k} label={k} state={v} />)}
            </div>
          )}
          <div className="xs muted mt-2">Laissez les champs secrets vides pour conserver les valeurs actuelles ; saisissez une valeur pour la remplacer.</div>
        </div>
        <div className="form-grid">
          <Field label="Environnement actif"><Select value={form.environment} onChange={f('environment')} options={[{ value: 'sandbox', label: 'Sandbox / staging' }, { value: 'production', label: 'Production' }]} /></Field>
          <Field label="Statut"><Select value={form.status} onChange={f('status')} options={[{ value: 'active', label: 'Actif' }, { value: 'inactive', label: 'Inactif' }, { value: 'testing', label: 'Test' }]} /></Field>
          <Field label="URL de base (production)"><Input value={form.baseUrl} onChange={f('baseUrl')} placeholder="https://api.operateur.com" className="mono" /></Field>
          <Field label="URL de base (sandbox)"><Input value={form.baseUrlSandbox} onChange={f('baseUrlSandbox')} placeholder="https://sandbox.operateur.com" className="mono" /></Field>
          <Field label="Identifiant marchand (production)"><Input value={form.merchantIdProd} onChange={f('merchantIdProd')} className="mono" /></Field>
          <Field label="Identifiant marchand (sandbox)"><Input value={form.merchantIdSandbox} onChange={f('merchantIdSandbox')} className="mono" /></Field>
          <Field label="Clé API / client ID / API user" hint="Vide = conserver"><Input type="password" autoComplete="off" value={form.apiKey} onChange={f('apiKey')} /></Field>
          <Field label="Secret API / client secret / API key" hint="Vide = conserver"><Input type="password" autoComplete="off" value={form.apiSecret} onChange={f('apiSecret')} /></Field>
          <Field label="Notes internes" className="full"><Textarea rows={2} value={form.notes} onChange={f('notes')} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function ProviderCard({ provider, config, env, canWrite, onEdit, onTested }) {
  const [busy, setBusy] = useState(false);
  const status = config?.status || 'inactive';
  const cls = config?.last_test_ok === true ? 'ok' : config?.last_test_ok === false ? 'ko' : status === 'active' ? 'active' : '';
  const test = async () => {
    setBusy(true);
    try { const { data } = await configApi.testApiConfig(provider.key); if (data.ok) toast.success(`${provider.name} : connexion établie`); else toast.error(`${provider.name} : ${data.reason || 'échec du test'}`); onTested(); }
    catch (e) { toast.error(errorMessage(e, 'Test impossible')); } finally { setBusy(false); }
  };
  return (
    <div className={`card provider-card ${cls}`}>
      <div className="card-body dense between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="row-wrap"><span className="strong">{provider.name}</span><StatusBadge status={status} />{config && <StatusBadge status={config.extra_params?.environment || 'sandbox'} />}</div>
          <div className="xs muted mt-2 mono">{provider.key}</div>
          <div className="row-wrap xs mt-2">
            {config?.last_test_ok === true && <Badge tone="success" dot>connecté</Badge>}
            {config?.last_test_ok === false && <Badge tone="error" dot>déconnecté</Badge>}
            {config?.last_tested_at && <span className="muted">testé le {fmtDateTime(config.last_tested_at)}</span>}
            {env && <Badge tone={env.configured ? 'success' : 'neutral'}>variables d’environnement {env.configured ? 'présentes' : 'absentes'}{env.env ? ` · ${env.env}` : ''}</Badge>}
          </div>
          {config?.last_error && <div className="xs error mt-2">{config.last_error}</div>}
        </div>
        <div className="row">
          {canWrite && <Button size="sm" icon="sliders" onClick={onEdit}>Configurer</Button>}
          <Button size="sm" variant="ghost" icon="wifi" loading={busy} onClick={test} disabled={!config}>Tester</Button>
        </div>
      </div>
    </div>
  );
}

export default function ConnectorsPage() {
  const { hasRole } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const { get, set } = useUrlState({ tab: 'operateurs', country: 'cd' });
  const tab = get('tab'), country = get('country');
  const configs = useQuery(() => configApi.apiConfigs({}).then((r) => r.data.data || []), []);
  const env = useQuery(() => configApi.envStatus().then((r) => r.data).catch(() => ({})), []);
  const defaults = useQuery(() => configApi.countryDefaults().then((r) => r.data.data || []), [], { enabled: tab === 'pays' });
  const [edit, setEdit] = useState(null);
  const byKey = (k) => (configs.data || []).find((c) => c.provider_key === k);
  const cat = CATALOG[country] || CATALOG.cd;
  const others = (configs.data || []).filter((c) => c.provider_type !== 'notification' && !Object.values(CATALOG).some((cc) => [...cc.mobile, ...cc.psp].some(([k]) => k === c.provider_key)));
  const section = (title, items) => (
    <div className="stack">
      <h3>{title}</h3>
      {items.map(([key, name]) => <ProviderCard key={key} provider={{ key, name }} config={byKey(key)} env={env.data?.[key]} canWrite={canWrite} onEdit={() => setEdit({ provider: { key, name }, config: byKey(key) })} onTested={configs.refresh} />)}
    </div>
  );
  return (
    <div className="page">
      <PageHeader title="Connecteurs opérateurs" subtitle="Mobile Money et processeurs de paiement par pays : identifiants (chiffrés, jamais relus), environnement, tests de connexion." actions={<Button icon="refresh" onClick={configs.refresh}>Actualiser</Button>} />
      <Tabs value={tab} onChange={(v) => set({ tab: v })} items={[{ value: 'operateurs', label: 'Opérateurs & PSP', icon: 'plug' }, { value: 'pays', label: 'Défauts par pays', icon: 'globe' }, { value: 'autres', label: 'Autres connecteurs', icon: 'list', count: others.length || undefined }]} />
      {tab === 'operateurs' && (
        <>
          <Chips value={country} onChange={(v) => set({ country: v || 'cd' })} items={COUNTRIES.map(([value, label]) => ({ value, label }))} />
          {configs.loading && !configs.data ? <Card><Skeleton lines={4} /></Card> : configs.error ? <Card><ErrorState error={configs.error} onRetry={configs.reload} /></Card> : (
            <div className="grid grid-2">{section('Mobile Money', cat.mobile)}{section('Processeurs de paiement (cartes)', cat.psp)}</div>
          )}
        </>
      )}
      {tab === 'pays' && (
        <Card flush title="Défauts d’assignation par pays" sub="Opérateurs et passerelle carte assignés automatiquement à la création d’un marchand (country_payment_defaults, lecture seule).">
          {defaults.loading ? <div className="card-body"><Skeleton /></div> : !(defaults.data || []).length ? <EmptyState icon="globe" title="Aucun défaut configuré" /> : (
            <div className="table-wrap"><table className="table table-dense"><thead><tr><th>Pays</th><th>Devise</th><th>Mobile Money</th><th>Passerelle carte</th><th>Mis à jour</th></tr></thead>
              <tbody>{defaults.data.map((d) => <tr key={d.country}><td className="cell-primary">{countryName(d.country)} <span className="muted">({d.country})</span></td><td>{d.currency}</td><td>{(d.mobile_money_providers || []).map((p) => <Badge key={p}>{p}</Badge>)}</td><td>{d.default_card_gateway || '—'}</td><td className="cell-date">{fmtDateTime(d.updated_at)}</td></tr>)}</tbody></table></div>
          )}
        </Card>
      )}
      {tab === 'autres' && (
        <Card flush title="Connecteurs hors catalogue" sub="Configurations présentes en base mais absentes du catalogue par pays">
          {!others.length ? <EmptyState icon="plug" title="Aucun autre connecteur" /> : (
            <div className="table-wrap"><table className="table table-dense"><thead><tr><th>Clé</th><th>Nom</th><th>Type</th><th>Pays</th><th>Statut</th><th>Dernier test</th><th></th></tr></thead>
              <tbody>{others.map((c) => <tr key={c.config_id}><td className="mono small">{c.provider_key}</td><td>{c.display_name}</td><td>{c.provider_type}</td><td>{c.country || '—'}</td><td><StatusBadge status={c.status} /></td><td className="cell-date">{fmtDateTime(c.last_tested_at)}</td><td className="row-actions-cell">{canWrite && <Button size="xs" onClick={() => setEdit({ provider: { key: c.provider_key, name: c.display_name || c.provider_key }, config: c })}>Configurer</Button>}</td></tr>)}</tbody></table></div>
          )}
        </Card>
      )}
      {edit && <ConfigModal provider={edit.provider} config={edit.config} onClose={() => setEdit(null)} onSaved={configs.refresh} />}
    </div>
  );
}
