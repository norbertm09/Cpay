import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, FiltersBar, SearchInput, Select, StatusBadge, Badge, Modal, Field, Input, SecretOnce, Callout, ConfirmDialog } from '../../components/ui';
import { useQuery, useDebounce } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { merchantsApi } from '../../services/api';
import { fmtMoney, fmtNumber, fmtDate, countryName, COUNTRIES } from '../../utils/format';
import { kybTone } from '../../utils/status';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';

const LIMIT = 20;
const STATUSES = [{ value: 'pending', label: 'En attente' }, { value: 'active', label: 'Actif' }, { value: 'suspended', label: 'Suspendu' }, { value: 'closed', label: 'Fermé' }];

export default function MerchantsPage() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const { get, set, page, setPage } = useUrlState();
  const [search, setSearch] = useState(get('search'));
  const q = useDebounce(search);
  const status = get('status'), country = get('country'), kyb = get('kyb');
  const [create, setCreate] = useState(false);
  const [suspend, setSuspend] = useState(null);

  const list = useQuery(() => merchantsApi.list({ page, limit: LIMIT, search: q || undefined, status: status || undefined, country: country || undefined }).then((r) => r.data), [page, q, status, country]);
  // Pas de filtre KYB côté API : appliqué sur la page courante, signalé dans le pied de tableau.
  const rows = useMemo(() => (list.data?.data || []).filter((m) => !kyb || String(m.kyb_level) === kyb), [list.data, kyb]);

  const setStatus = async (m, st, reason) => {
    try { await merchantsApi.setStatus(m.merchant_id, { status: st, reason }); toast.success(st === 'active' ? 'Marchand activé' : 'Marchand suspendu'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); throw e; }
  };

  const columns = [
    { key: 'business_name', label: 'Entreprise', render: (m) => <div><div className="cell-primary">{m.business_name}</div><div className="cell-sub">{m.email}</div></div> },
    { key: 'country', label: 'Pays', render: (m) => <>{countryName(m.country)} <span className="muted">· {m.currency}</span></> },
    { key: 'phone', label: 'Téléphone', hidden: true },
    { key: 'kyb_level', label: 'KYB', render: (m) => <Badge tone={kybTone(m.kyb_level)}>Niveau {m.kyb_level ?? 0}</Badge>, sortValue: (m) => Number(m.kyb_level) },
    { key: 'merchant_status', label: 'Statut', render: (m) => <StatusBadge status={m.merchant_status} /> },
    { key: 'txn_count', label: 'Transactions', align: 'right', render: (m) => <span className="num">{fmtNumber(m.txn_count)}</span>, sortValue: (m) => Number(m.txn_count) },
    { key: 'total_volume', label: 'Volume', align: 'right', render: (m) => <span className="amount">{fmtMoney(m.total_volume, m.currency)}</span>, sortValue: (m) => Number(m.total_volume) },
    { key: 'created_at', label: 'Inscrit le', render: (m) => <span className="cell-date">{fmtDate(m.created_at)}</span>, sortValue: (m) => m.created_at },
    { key: 'actions', label: '', sortable: false, render: (m) => (
      <div className="row-actions">
        <Button size="xs" to={`/marchands/${m.merchant_id}`}>Ouvrir</Button>
        {canWrite && (m.merchant_status === 'active'
          ? <Button size="xs" variant="danger-outline" onClick={() => setSuspend(m)}>Suspendre</Button>
          : m.merchant_status !== 'closed' && <Button size="xs" variant="success" onClick={() => setStatus(m, 'active')}>Activer</Button>)}
      </div>
    ) },
  ];
  const hasActive = !!(q || status || country || kyb);

  return (
    <div className="page">
      <PageHeader title="Marchands" badge={list.data?.total !== undefined && <Badge tone="neutral">{fmtNumber(list.data.total)}</Badge>}
        subtitle="Comptes marchands, niveaux KYB, activité et accès rapides aux fiches."
        actions={<>
          <Button icon="users" to="/marchands/utilisateurs">Utilisateurs marchands</Button>
          {canWrite && <Button variant="primary" icon="plus" onClick={() => setCreate(true)}>Nouveau marchand</Button>}
        </>} />
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <FiltersBar hasActive={hasActive} onReset={() => { setSearch(''); set({ search: '', status: '', country: '', kyb: '', page: '' }); }}>
            <div className="grow"><SearchInput value={search} onChange={(v) => { setSearch(v); set({ search: v, page: '' }); }} placeholder="Nom, e-mail ou téléphone…" /></div>
            <Select value={status} onChange={(v) => set({ status: v, page: '' })} options={STATUSES} placeholder="Tous les statuts" aria-label="Statut" />
            <Select value={country} onChange={(v) => set({ country: v, page: '' })} options={Object.entries(COUNTRIES).map(([value, label]) => ({ value, label }))} placeholder="Tous les pays" aria-label="Pays" />
            <Select value={kyb} onChange={(v) => set({ kyb: v })} options={[{ value: '0', label: 'KYB niveau 0' }, { value: '1', label: 'KYB niveau 1' }, { value: '2', label: 'KYB niveau 2' }]} placeholder="Tous niveaux KYB" aria-label="Niveau KYB" />
          </FiltersBar>
        </div>
        <DataTable columns={columns} rows={rows} keyField="merchant_id" loading={list.loading} error={list.error} onRetry={list.reload}
          page={page} limit={LIMIT} total={list.data?.total} onPage={setPage} onRowClick={(m) => navigate(`/marchands/${m.merchant_id}`)} columnTools storageKey="merchants"
          empty="Aucun marchand ne correspond à ces critères" emptyIcon="store"
          footerExtra={kyb ? <span className="muted"> · filtre KYB appliqué sur la page courante</span> : null} />
      </Card>
      {create && <CreateMerchantModal onClose={() => setCreate(false)} onCreated={() => list.refresh()} />}
      {suspend && (
        <ConfirmDialog title={`Suspendre ${suspend.business_name}`} tone="danger" confirmLabel="Suspendre"
          message="Le marchand ne pourra plus encaisser ni accéder à son portail tant qu’il est suspendu. Le motif est enregistré dans le journal d’audit."
          reason={{ label: 'Motif de la suspension', required: true }} onConfirm={(r) => setStatus(suspend, 'suspended', r)} onClose={() => setSuspend(null)} />
      )}
    </div>
  );
}

// POST /merchants : crée le marchand, son utilisateur propriétaire et assigne les
// opérateurs par défaut du pays. Sans mot de passe fourni, un mot de passe
// temporaire est renvoyé UNE fois (temporaryPassword).
export function CreateMerchantModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ businessName: '', phone: '', email: '', country: 'CM', currency: '', rccm: '', nif: '', settlementType: 'mobile_money', settlementAccount: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const f = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const payload = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
      const { data } = await merchantsApi.create(payload);
      setResult(data); onCreated?.();
    } catch (err) { setError(errorMessage(err, 'Création impossible')); }
    finally { setBusy(false); }
  };
  if (result) {
    return (
      <Modal title="Marchand créé" onClose={onClose} footer={<><Button to={`/marchands/${result.merchant?.merchant_id}`} onClick={onClose}>Ouvrir la fiche</Button><Button variant="primary" onClick={onClose}>Terminer</Button></>}>
        <div className="stack">
          <Callout tone="success">{result.merchant?.business_name} est créé ({countryName(result.merchant?.country)}, {result.merchant?.currency}). Opérateurs assignés : {(result.apiDefaults?.assignedProviders || []).join(', ') || 'défauts du pays'}.</Callout>
          {result.temporaryPassword
            ? <SecretOnce label={`Mot de passe temporaire de ${result.user?.email}`} value={result.temporaryPassword} />
            : <div className="small muted">Le mot de passe saisi n’est pas affiché. Le propriétaire ({result.user?.email}) peut se connecter dès maintenant.</div>}
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Nouveau marchand" sub="Un compte propriétaire est créé avec l’e-mail indiqué." onClose={onClose} size="lg"
      footer={<><Button onClick={onClose}>Annuler</Button><Button variant="primary" form="create-merchant" type="submit" loading={busy}>Créer le marchand</Button></>}>
      <form id="create-merchant" onSubmit={submit} className="form-grid">
        {error && <div className="full"><Callout tone="error">{error}</Callout></div>}
        <div className="form-section full">Entreprise</div>
        <Field label="Raison sociale" required className="full"><Input value={form.businessName} onChange={f('businessName')} required /></Field>
        <Field label="Téléphone" required hint="Le pays peut être détecté à partir de l’indicatif."><Input value={form.phone} onChange={f('phone')} placeholder="+237 6XX XXX XXX" required /></Field>
        <Field label="E-mail du propriétaire" required><Input type="email" value={form.email} onChange={f('email')} required /></Field>
        <Field label="Pays"><Select value={form.country} onChange={f('country')} options={Object.entries(COUNTRIES).map(([value, label]) => ({ value, label }))} /></Field>
        <Field label="Devise" hint="Vide = devise par défaut du pays"><Input value={form.currency} onChange={(v) => f('currency')(v.toUpperCase().slice(0, 3))} placeholder="XAF" /></Field>
        <Field label="RCCM"><Input value={form.rccm} onChange={f('rccm')} /></Field>
        <Field label="NIF"><Input value={form.nif} onChange={f('nif')} /></Field>
        <div className="form-section full">Règlement</div>
        <Field label="Type de règlement"><Select value={form.settlementType} onChange={f('settlementType')} options={[{ value: 'mobile_money', label: 'Mobile Money' }, { value: 'bank', label: 'Virement bancaire' }]} /></Field>
        <Field label="Compte de règlement" hint="Vide = numéro de téléphone"><Input value={form.settlementAccount} onChange={f('settlementAccount')} placeholder="Numéro ou IBAN" /></Field>
        <div className="form-section full">Accès</div>
        <Field label="Mot de passe initial" className="full" hint="Laissez vide pour générer un mot de passe temporaire, affiché une seule fois (10 caractères minimum sinon)."><Input type="password" value={form.password} onChange={f('password')} autoComplete="new-password" /></Field>
      </form>
    </Modal>
  );
}

export const MerchantLink = ({ id, name }) => (id ? <Link to={`/marchands/${id}`}>{name || id}</Link> : <span>{name || '—'}</span>);
