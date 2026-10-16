import React, { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, Tabs, FiltersBar, SearchInput, Select, StatusBadge, Badge, Modal, Field, Input, KeyValue, SecretOnce, Callout, Skeleton, ErrorState, Stat, ConfirmDialog } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { partnersApi } from '../../services/api';
import { fmtDateTime, fmtDate, fmtMoney, fmtNumber, countryName, COUNTRIES } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';

const match = (s, q) => String(s || '').toLowerCase().includes(q.toLowerCase());
const COUNTRY_OPTS = Object.entries(COUNTRIES).map(([value, label]) => ({ value, label }));

// ─── Banques ──────────────────────────────────────────────────────
const EMPTY_BANK = { bankName: '', bankCode: '', country: 'CG', contactEmail: '', contactPhone: '', address: '', city: '', swift: '', adminFirstName: '', adminLastName: '', adminEmail: '', adminPhone: '' };
function CreateBankModal({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_BANK); const [busy, setBusy] = useState(false); const [result, setResult] = useState(null); const [error, setError] = useState(null);
  const f = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const { data } = await partnersApi.createBank(form); setResult(data); onCreated(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  if (result) {
    return (
      <Modal title="Banque partenaire créée" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>J’ai transmis les accès</Button>}>
        <div className="stack">
          <Callout tone="success">{result.bank?.bank_name} ({result.bank?.bank_code}) est créée. L’administrateur {result.admin?.email} se connecte sur <b>partners.c-pay.global</b>.</Callout>
          <SecretOnce label={`Mot de passe temporaire de ${result.admin?.email}`} value={result.admin?.tempPassword} />
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Nouvelle banque partenaire" sub="Un compte administrateur de banque est créé avec un mot de passe temporaire affiché une seule fois." onClose={onClose} size="lg" footer={<><Button onClick={onClose}>Annuler</Button><Button variant="primary" type="submit" form="create-bank" loading={busy}>Créer la banque</Button></>}>
      <form id="create-bank" className="form-grid" onSubmit={submit}>
        {error && <div className="full"><Callout tone="error">{error}</Callout></div>}
        <div className="form-section full">Banque</div>
        <Field label="Nom de la banque" required className="full"><Input value={form.bankName} onChange={f('bankName')} required /></Field>
        <Field label="Code banque" required><Input value={form.bankCode} onChange={f('bankCode')} placeholder="BCK-001" required /></Field>
        <Field label="SWIFT"><Input value={form.swift} onChange={f('swift')} /></Field>
        <Field label="Pays"><Select value={form.country} onChange={f('country')} options={COUNTRY_OPTS} /></Field>
        <Field label="Ville"><Input value={form.city} onChange={f('city')} /></Field>
        <Field label="Adresse" className="full"><Input value={form.address} onChange={f('address')} /></Field>
        <Field label="E-mail contact"><Input type="email" value={form.contactEmail} onChange={f('contactEmail')} /></Field>
        <Field label="Téléphone contact"><Input value={form.contactPhone} onChange={f('contactPhone')} /></Field>
        <div className="form-section full">Administrateur de la banque</div>
        <Field label="Prénom" required><Input value={form.adminFirstName} onChange={f('adminFirstName')} required /></Field>
        <Field label="Nom"><Input value={form.adminLastName} onChange={f('adminLastName')} /></Field>
        <Field label="E-mail" required><Input type="email" value={form.adminEmail} onChange={f('adminEmail')} required /></Field>
        <Field label="Téléphone"><Input value={form.adminPhone} onChange={f('adminPhone')} /></Field>
      </form>
    </Modal>
  );
}

export function BanksPage() {
  const { isSuperAdmin, hasRole } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const list = useQuery(() => partnersApi.banks().then((r) => r.data.data || []), []);
  const [search, setSearch] = useState(''); const [create, setCreate] = useState(false); const [toggle, setToggle] = useState(null);
  const rows = useMemo(() => (list.data || []).filter((b) => !search || match(b.bank_name, search) || match(b.bank_code, search) || match(b.city, search)), [list.data, search]);
  const setStatus = async (b) => {
    try { await partnersApi.setBankStatus(b.bank_id, b.status === 'active' ? 'suspended' : 'active'); toast.success('Statut mis à jour'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); throw e; }
  };
  const cols = [
    { key: 'bank_name', label: 'Banque', render: (b) => <div><div className="cell-primary">{b.bank_name}</div><div className="cell-sub mono">{b.bank_code}{b.swift ? ` · ${b.swift}` : ''}</div></div> },
    { key: 'country', label: 'Pays / ville', render: (b) => <>{countryName(b.country)}{b.city ? <span className="muted"> · {b.city}</span> : null}</> },
    { key: 'contact_email', label: 'Contact', render: (b) => <div className="small">{b.contact_email || '—'}<div className="cell-sub">{b.contact_phone || ''}</div></div> },
    { key: 'agency_count', label: 'Agences', align: 'right', render: (b) => fmtNumber(b.agency_count), sortValue: (b) => Number(b.agency_count) },
    { key: 'agent_count', label: 'Agents', align: 'right', render: (b) => fmtNumber(b.agent_count), sortValue: (b) => Number(b.agent_count) },
    { key: 'status', label: 'Statut', render: (b) => <StatusBadge status={b.status} /> },
    { key: 'created_at', label: 'Créée le', render: (b) => <span className="cell-date">{fmtDate(b.created_at)}</span>, sortValue: (b) => b.created_at },
    { key: 'actions', label: '', sortable: false, render: (b) => <div className="row-actions"><Button size="xs" to={`/partenaires/banques/${b.bank_id}`}>Ouvrir</Button>{canWrite && <Button size="xs" variant={b.status === 'active' ? 'danger-outline' : 'success'} onClick={() => setToggle(b)}>{b.status === 'active' ? 'Suspendre' : 'Activer'}</Button>}</div> },
  ];
  return (
    <div className="page">
      <PageHeader title="Banques partenaires" subtitle="Réseau de distribution : banques, leurs agences et agents." badge={<Badge>{fmtNumber(list.data?.length)}</Badge>} actions={isSuperAdmin && <Button variant="primary" icon="plus" onClick={() => setCreate(true)}>Nouvelle banque</Button>} />
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}><FiltersBar><div className="grow"><SearchInput value={search} onChange={setSearch} placeholder="Nom, code, ville…" /></div></FiltersBar></div>
        <DataTable columns={cols} rows={rows} keyField="bank_id" loading={list.loading} error={list.error} onRetry={list.reload} empty="Aucune banque partenaire" emptyIcon="bank" />
      </Card>
      {create && <CreateBankModal onClose={() => setCreate(false)} onCreated={list.refresh} />}
      {toggle && <ConfirmDialog title={`${toggle.status === 'active' ? 'Suspendre' : 'Activer'} ${toggle.bank_name}`} tone={toggle.status === 'active' ? 'danger' : 'success'} confirmLabel={toggle.status === 'active' ? 'Suspendre' : 'Activer'} message={toggle.status === 'active' ? 'Les utilisateurs de la banque perdent l’accès au portail partenaires.' : 'La banque retrouve l’accès au portail partenaires.'} onConfirm={() => setStatus(toggle)} onClose={() => setToggle(null)} />}
    </div>
  );
}

export function BankDetailPage() {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const { get, set } = useUrlState({ tab: 'infos' });
  const tab = get('tab');
  const bank = useQuery(() => partnersApi.bank(id).then((r) => r.data), [id]);
  const agencies = useQuery(() => partnersApi.bankAgencies(id).then((r) => r.data.data || []), [id]);
  const agents = useQuery(() => partnersApi.bankAgents(id).then((r) => r.data.data || []), [id]);
  const [edit, setEdit] = useState(null); const [busy, setBusy] = useState(false);
  const b = bank.data;
  const save = async () => {
    setBusy(true);
    try { await partnersApi.updateBank(id, edit); toast.success('Banque mise à jour'); setEdit(null); bank.refresh(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  if (bank.loading && !b) return <Card><Skeleton lines={6} /></Card>;
  if (!b) return <Card><ErrorState error={bank.error} onRetry={bank.reload} title="Banque introuvable" /></Card>;
  const agencyCols = [
    { key: 'agency_name', label: 'Agence', render: (a) => <div><div className="cell-primary">{a.agency_name}</div><div className="cell-sub mono">{a.agency_code}</div></div> },
    { key: 'city', label: 'Ville', render: (a) => a.city || '—' }, { key: 'agent_count', label: 'Agents', align: 'right', render: (a) => fmtNumber(a.agent_count) },
    { key: 'float_balance', label: 'Float', align: 'right', render: (a) => <span className="amount">{fmtMoney(a.float_balance, 'XAF')}</span>, sortValue: (a) => Number(a.float_balance) },
    { key: 'status', label: 'Statut', render: (a) => <StatusBadge status={a.status} /> },
  ];
  const agentCols = [
    { key: 'name', label: 'Agent', render: (a) => <div><div className="cell-primary">{a.first_name} {a.last_name}</div><div className="cell-sub">{a.email}</div></div> },
    { key: 'agency_name', label: 'Agence' },
    { key: 'float_balance', label: 'Float', align: 'right', render: (a) => <span className="amount">{fmtMoney(a.float_balance, 'XAF')}</span> },
    { key: 'float_limit', label: 'Limite', align: 'right', render: (a) => <span className="num">{fmtMoney(a.float_limit, 'XAF')}</span> },
    { key: 'status', label: 'Statut', render: (a) => <StatusBadge status={a.status} /> },
  ];
  return (
    <div className="page">
      <PageHeader crumbs={[{ label: 'Partenaires', to: '/partenaires/banques' }, { label: 'Banques', to: '/partenaires/banques' }, { label: b.bank_name }]} title={b.bank_name} badge={<StatusBadge status={b.status} />} subtitle={`${b.bank_code}${b.swift ? ` · ${b.swift}` : ''} · ${countryName(b.country)}${b.city ? ` · ${b.city}` : ''}`}
        actions={canWrite && <Button icon="sliders" onClick={() => setEdit({ bankName: b.bank_name, bankCode: b.bank_code, swift: b.swift || '', city: b.city || '', address: b.address || '', contactEmail: b.contact_email || '', contactPhone: b.contact_phone || '' })}>Modifier</Button>} />
      <div className="grid grid-3">
        <Stat label="Agences" value={fmtNumber(b.agency_count)} icon="pin" small />
        <Stat label="Agents" value={fmtNumber(b.agent_count)} icon="users" tone="cyan" small />
        <Stat label="Agents actifs" value={fmtNumber((agents.data || []).filter((a) => a.status === 'active').length)} icon="check" tone="success" small />
      </div>
      <Tabs value={tab} onChange={(v) => set({ tab: v })} items={[{ value: 'infos', label: 'Informations', icon: 'bank' }, { value: 'agences', label: 'Agences', icon: 'pin', count: agencies.data?.length }, { value: 'agents', label: 'Agents', icon: 'users', count: agents.data?.length }]} />
      {tab === 'infos' && <Card title="Informations"><KeyValue rows={[['Nom', b.bank_name], ['Code', b.bank_code], ['SWIFT', b.swift], ['Pays', countryName(b.country)], ['Ville', b.city], ['Adresse', b.address], ['E-mail', b.contact_email], ['Téléphone', b.contact_phone], ['Créée le', fmtDateTime(b.created_at)]]} /></Card>}
      {tab === 'agences' && <Card flush><DataTable columns={agencyCols} rows={agencies.data || []} keyField="agency_id" loading={agencies.loading} error={agencies.error} onRetry={agencies.reload} dense empty="Aucune agence" emptyIcon="pin" /></Card>}
      {tab === 'agents' && <Card flush><DataTable columns={agentCols} rows={agents.data || []} keyField="agent_id" loading={agents.loading} error={agents.error} onRetry={agents.reload} dense empty="Aucun agent" emptyIcon="users" /></Card>}
      {edit && (
        <Modal title="Modifier la banque" onClose={() => !busy && setEdit(null)} footer={<><Button onClick={() => setEdit(null)} disabled={busy}>Annuler</Button><Button variant="primary" loading={busy} onClick={save}>Enregistrer</Button></>}>
          <div className="form-grid">
            {[['bankName', 'Nom', 'full'], ['bankCode', 'Code'], ['swift', 'SWIFT'], ['city', 'Ville'], ['address', 'Adresse'], ['contactEmail', 'E-mail'], ['contactPhone', 'Téléphone']].map(([k, l, cls]) => (
              <Field key={k} label={l} className={cls || ''}><Input value={edit[k]} onChange={(v) => setEdit((e) => ({ ...e, [k]: v }))} /></Field>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Agences / agents (toutes banques) ────────────────────────────
export function AgenciesPage() {
  const list = useQuery(() => partnersApi.agencies().then((r) => r.data.data || []), []);
  const [search, setSearch] = useState('');
  const rows = useMemo(() => (list.data || []).filter((a) => !search || match(a.agency_name, search) || match(a.agency_code, search) || match(a.bank_name, search) || match(a.city, search)), [list.data, search]);
  const cols = [
    { key: 'agency_name', label: 'Agence', render: (a) => <div><div className="cell-primary">{a.agency_name}</div><div className="cell-sub mono">{a.agency_code}</div></div> },
    { key: 'bank_name', label: 'Banque' }, { key: 'city', label: 'Ville', render: (a) => a.city || '—' },
    { key: 'agent_count', label: 'Agents', align: 'right', render: (a) => fmtNumber(a.agent_count), sortValue: (a) => Number(a.agent_count) },
    { key: 'float_balance', label: 'Float', align: 'right', render: (a) => <span className="amount">{fmtMoney(a.float_balance, 'XAF')}</span>, sortValue: (a) => Number(a.float_balance) },
    { key: 'status', label: 'Statut', render: (a) => <StatusBadge status={a.status} /> },
  ];
  return (
    <div className="page">
      <PageHeader title="Agences" subtitle="Toutes les agences des banques partenaires." badge={<Badge>{fmtNumber(list.data?.length)}</Badge>} />
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}><FiltersBar><div className="grow"><SearchInput value={search} onChange={setSearch} placeholder="Nom, code, banque, ville…" /></div></FiltersBar></div>
        <DataTable columns={cols} rows={rows} keyField="agency_id" loading={list.loading} error={list.error} onRetry={list.reload} empty="Aucune agence" emptyIcon="pin" columnTools storageKey="agencies" />
      </Card>
    </div>
  );
}

export function AgentsPage() {
  const list = useQuery(() => partnersApi.agents().then((r) => r.data.data || []), []);
  const [search, setSearch] = useState('');
  const rows = useMemo(() => (list.data || []).filter((a) => !search || match(`${a.first_name} ${a.last_name}`, search) || match(a.email, search) || match(a.agency_name, search) || match(a.bank_name, search)), [list.data, search]);
  const cols = [
    { key: 'name', label: 'Agent', render: (a) => <div><div className="cell-primary">{a.first_name} {a.last_name}</div><div className="cell-sub">{a.email}</div></div>, sortValue: (a) => `${a.first_name} ${a.last_name}` },
    { key: 'agency_name', label: 'Agence' }, { key: 'bank_name', label: 'Banque' },
    { key: 'float_balance', label: 'Float', align: 'right', render: (a) => <span className="amount">{fmtMoney(a.float_balance, 'XAF')}</span>, sortValue: (a) => Number(a.float_balance) },
    { key: 'float_limit', label: 'Limite', align: 'right', render: (a) => <span className="num">{fmtMoney(a.float_limit, 'XAF')}</span> },
    { key: 'status', label: 'Statut', render: (a) => <StatusBadge status={a.status} /> },
  ];
  return (
    <div className="page">
      <PageHeader title="Agents" subtitle="Tous les agents du réseau de distribution." badge={<Badge>{fmtNumber(list.data?.length)}</Badge>} />
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}><FiltersBar><div className="grow"><SearchInput value={search} onChange={setSearch} placeholder="Nom, e-mail, agence, banque…" /></div></FiltersBar></div>
        <DataTable columns={cols} rows={rows} keyField="agent_id" loading={list.loading} error={list.error} onRetry={list.reload} empty="Aucun agent" emptyIcon="users" columnTools storageKey="agents" />
      </Card>
    </div>
  );
}

// ─── Tenants ──────────────────────────────────────────────────────
const EMPTY_TENANT = { bankId: '', subdomain: '', displayName: '', primaryColor: '#1d4f92', secondaryColor: '#12306e', accentColor: '#f07800', logoUrl: '', supportEmail: '', supportPhone: '' };
export function TenantsPage() {
  const { isSuperAdmin } = useAuth();
  const list = useQuery(() => partnersApi.tenants().then((r) => r.data.data || []), []);
  const banks = useQuery(() => partnersApi.banks().then((r) => r.data.data || []), []);
  const [edit, setEdit] = useState(null); const [busy, setBusy] = useState(false);
  const setF = (k, v) => setEdit((e) => ({ ...e, form: { ...e.form, [k]: v } }));
  const save = async () => {
    const f = edit.form;
    if (!edit.id && (!f.bankId || !f.subdomain || !f.displayName)) return toast.error('Banque, sous-domaine et nom requis');
    if (!edit.id && !/^[a-z0-9-]+$/.test(f.subdomain)) return toast.error('Sous-domaine : minuscules, chiffres et tirets uniquement');
    setBusy(true);
    try {
      if (edit.id) await partnersApi.updateTenant(edit.id, { displayName: f.displayName, primaryColor: f.primaryColor, secondaryColor: f.secondaryColor, accentColor: f.accentColor, logoUrl: f.logoUrl, supportEmail: f.supportEmail, supportPhone: f.supportPhone });
      else await partnersApi.createTenant(f);
      toast.success(edit.id ? 'Tenant mis à jour' : 'Tenant créé'); setEdit(null); list.refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
    return undefined;
  };
  const toggle = async (t) => {
    try { await partnersApi.updateTenant(t.tenant_id, { isActive: !t.is_active }); toast.success(t.is_active ? 'Tenant désactivé' : 'Tenant activé'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const Color = ({ k, label }) => (
    <Field label={label}><div className="row"><input type="color" value={edit.form[k] || '#000000'} onChange={(e) => setF(k, e.target.value)} aria-label={label} style={{ width: 40, height: 36, border: '1px solid var(--border-strong)', borderRadius: 6, padding: 2, background: '#fff' }} /><Input value={edit.form[k]} onChange={(v) => setF(k, v)} className="mono" /></div></Field>
  );
  const cols = [
    { key: 'display_name', label: 'Tenant', render: (t) => <div className="row"><span style={{ width: 28, height: 28, borderRadius: 6, background: `linear-gradient(135deg, ${t.secondary_color || '#12306e'}, ${t.primary_color || '#1d4f92'})`, flexShrink: 0 }} /><div><div className="cell-primary">{t.display_name}</div><div className="cell-sub">{t.bank_name} · {t.bank_code}</div></div></div> },
    { key: 'subdomain', label: 'Portail', render: (t) => <a href={`https://${t.subdomain}.partners.c-pay.global`} target="_blank" rel="noreferrer" className="small">{t.subdomain}.partners.c-pay.global</a> },
    { key: 'user_count', label: 'Utilisateurs', align: 'right', render: (t) => fmtNumber(t.user_count) }, { key: 'agent_count', label: 'Agents', align: 'right', render: (t) => fmtNumber(t.agent_count) },
    { key: 'support_email', label: 'Support', render: (t) => <span className="small">{t.support_email || '—'}</span> },
    { key: 'is_active', label: 'Statut', render: (t) => <StatusBadge status={t.is_active ? 'active' : 'inactive'} /> },
    ...(isSuperAdmin ? [{ key: 'actions', label: '', sortable: false, render: (t) => <div className="row-actions"><Button size="xs" onClick={() => setEdit({ id: t.tenant_id, form: { ...EMPTY_TENANT, displayName: t.display_name, primaryColor: t.primary_color, secondaryColor: t.secondary_color, accentColor: t.accent_color, logoUrl: t.logo_url || '', supportEmail: t.support_email || '', supportPhone: t.support_phone || '' } })}>Modifier</Button><Button size="xs" variant={t.is_active ? 'danger-outline' : 'success'} onClick={() => toggle(t)}>{t.is_active ? 'Désactiver' : 'Activer'}</Button></div> }] : []),
  ];
  return (
    <div className="page">
      <PageHeader title="Tenants partenaires" subtitle="Chaque banque partenaire accède à son portail via un sous-domaine, avec son logo, ses couleurs et son nom." badge={<Badge>{fmtNumber(list.data?.length)}</Badge>} actions={isSuperAdmin && <Button variant="primary" icon="plus" onClick={() => setEdit({ id: null, form: { ...EMPTY_TENANT } })}>Nouveau tenant</Button>} />
      <Card flush><DataTable columns={cols} rows={list.data || []} keyField="tenant_id" loading={list.loading} error={list.error} onRetry={list.reload} empty="Aucun tenant configuré" emptyIcon="globe" /></Card>
      {edit && (
        <Modal title={edit.id ? 'Modifier le tenant' : 'Nouveau tenant'} onClose={() => !busy && setEdit(null)} size="lg" footer={<><Button onClick={() => setEdit(null)} disabled={busy}>Annuler</Button><Button variant="primary" loading={busy} onClick={save}>Enregistrer</Button></>}>
          <div className="form-grid">
            {!edit.id && <>
              <Field label="Banque partenaire" required><Select value={edit.form.bankId} onChange={(v) => setF('bankId', v)} placeholder="Choisir une banque" options={(banks.data || []).filter((b) => !(list.data || []).some((t) => t.bank_id === b.bank_id)).map((b) => ({ value: b.bank_id, label: `${b.bank_name} (${b.bank_code})` }))} /></Field>
              <Field label="Sous-domaine" required hint={`${edit.form.subdomain || 'sousdomaine'}.partners.c-pay.global`}><Input value={edit.form.subdomain} onChange={(v) => setF('subdomain', v.toLowerCase())} placeholder="afriland" /></Field>
            </>}
            <Field label="Nom d’affichage" required className="full"><Input value={edit.form.displayName} onChange={(v) => setF('displayName', v)} /></Field>
            <Field label="URL du logo" className="full"><Input type="url" value={edit.form.logoUrl} onChange={(v) => setF('logoUrl', v)} placeholder="https://…/logo.png" /></Field>
            <Color k="primaryColor" label="Couleur principale" /><Color k="secondaryColor" label="Couleur secondaire" /><Color k="accentColor" label="Couleur d’accent" />
            <Field label="E-mail support"><Input type="email" value={edit.form.supportEmail} onChange={(v) => setF('supportEmail', v)} /></Field>
            <Field label="Téléphone support"><Input value={edit.form.supportPhone} onChange={(v) => setF('supportPhone', v)} /></Field>
            <div className="full" style={{ background: `linear-gradient(135deg, ${edit.form.secondaryColor}, ${edit.form.primaryColor})`, borderRadius: 10, padding: 16, color: '#fff', textAlign: 'center' }}>
              <div className="small strong">Aperçu de la page de connexion</div>
              {edit.form.logoUrl && <img src={edit.form.logoUrl} alt="" style={{ height: 32, marginTop: 8, objectFit: 'contain' }} />}
              <div className="xs" style={{ opacity: .9, marginTop: 4 }}>{edit.form.displayName || 'Nom de la banque'}</div>
              <span className="btn btn-sm mt-3" style={{ background: edit.form.accentColor, color: '#fff', borderColor: edit.form.accentColor }}>Se connecter</span>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
