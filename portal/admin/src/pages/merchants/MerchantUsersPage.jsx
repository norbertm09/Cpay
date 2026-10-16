import React, { useRef, useState } from 'react';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, FiltersBar, SearchInput, Badge, StatusBadge, Modal, Field, Input, Select, SecretOnce, Callout, ConfirmDialog } from '../../components/ui';
import { useQuery, useDebounce } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { usersApi } from '../../services/api';
import { fmtDateTime, fmtNumber } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';
import { MerchantLink } from './MerchantsPage';

const LIMIT = 20;
const ROLE = { owner: ['Propriétaire', 'navy'], manager: ['Gestionnaire', 'info'], cashier: ['Caissier', 'neutral'], viewer: ['Lecteur', 'neutral'] };

// Réinitialisation (vague 3) : POST /users/:id/reset-password → tempPassword affiché UNE fois.
export function ResetPasswordDialog({ user, type = 'merchant', onClose }) {
  const [result, setResult] = useState(null);
  const done = useRef(false);
  const run = async () => {
    try { const { data } = await usersApi.resetPassword(user.id, type); done.current = true; setResult(data); }
    catch (e) { toast.error(errorMessage(e, 'Réinitialisation impossible')); throw e; }
  };
  if (result) {
    return (
      <Modal title="Mot de passe réinitialisé" onClose={onClose} size="sm" footer={<Button variant="primary" onClick={onClose}>J’ai transmis le mot de passe</Button>}>
        <div className="stack">
          <SecretOnce label={`Mot de passe temporaire de ${result.email}`} value={result.tempPassword} />
          <div className="small muted">{result.message}</div>
        </div>
      </Modal>
    );
  }
  return (
    <ConfirmDialog title={`Réinitialiser le mot de passe de ${user.label}`} confirmLabel="Générer un mot de passe temporaire" tone="primary"
      message="Un mot de passe temporaire sera généré et affiché une seule fois. Toutes les sessions de l’utilisateur seront révoquées ; il devra le changer à sa prochaine connexion. La 2FA éventuelle est conservée."
      onConfirm={run} onClose={() => { if (!done.current) onClose(); }} />
  );
}

export function CreateUserModal({ merchantId, onClose, onCreated }) {
  const [form, setForm] = useState({ email: '', phone: '', firstName: '', lastName: '', password: '', role: 'cashier', merchantId: merchantId || '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  const f = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await usersApi.create(form); toast.success('Utilisateur créé'); onCreated?.(); onClose(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Nouvel utilisateur marchand" onClose={onClose} footer={<><Button onClick={onClose}>Annuler</Button><Button variant="primary" type="submit" form="create-user" loading={busy}>Créer</Button></>}>
      <form id="create-user" className="form-grid" onSubmit={submit}>
        {error && <div className="full"><Callout tone="error">{error}</Callout></div>}
        <Field label="Prénom"><Input value={form.firstName} onChange={f('firstName')} /></Field>
        <Field label="Nom"><Input value={form.lastName} onChange={f('lastName')} /></Field>
        <Field label="E-mail" required><Input type="email" value={form.email} onChange={f('email')} required /></Field>
        <Field label="Téléphone"><Input value={form.phone} onChange={f('phone')} placeholder="+237…" /></Field>
        <Field label="Mot de passe initial" required hint="Transmettez-le par un canal sûr."><Input type="password" value={form.password} onChange={f('password')} autoComplete="new-password" required /></Field>
        <Field label="Rôle"><Select value={form.role} onChange={f('role')} options={Object.entries(ROLE).map(([value, [label]]) => ({ value, label }))} /></Field>
        <Field label="Identifiant du marchand (UUID)" required className="full" hint={merchantId ? 'Pré-rempli depuis la fiche marchand.' : undefined}><Input value={form.merchantId} onChange={f('merchantId')} className="mono" required disabled={!!merchantId} /></Field>
      </form>
    </Modal>
  );
}

export const userColumns = ({ canWrite, onToggle, onReset, withMerchant = true }) => [
  { key: 'name', label: 'Utilisateur', render: (u) => <div><div className="cell-primary">{`${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email}</div><div className="cell-sub">{u.email}</div></div>, sortValue: (u) => `${u.first_name} ${u.last_name}` },
  { key: 'phone', label: 'Téléphone', render: (u) => u.phone || '—' },
  ...(withMerchant ? [{ key: 'business_name', label: 'Marchand', render: (u) => <MerchantLink id={u.merchant_id} name={u.business_name} /> }] : []),
  { key: 'role', label: 'Rôle', render: (u) => <Badge tone={ROLE[u.role]?.[1] || 'neutral'}>{ROLE[u.role]?.[0] || u.role}</Badge> },
  { key: 'is_active', label: 'Statut', render: (u) => <StatusBadge status={u.is_active ? 'active' : 'inactive'} /> },
  { key: 'last_login_at', label: 'Dernière connexion', render: (u) => <span className="cell-date">{u.last_login_at ? fmtDateTime(u.last_login_at) : 'jamais'}</span>, sortValue: (u) => u.last_login_at },
  ...(canWrite ? [{ key: 'actions', label: '', sortable: false, render: (u) => (
    <div className="row-actions">
      <Button size="xs" icon="key" onClick={() => onReset(u)}>Réinitialiser</Button>
      <Button size="xs" variant={u.is_active ? 'danger-outline' : 'success'} onClick={() => onToggle(u)}>{u.is_active ? 'Désactiver' : 'Activer'}</Button>
    </div>
  ) }] : []),
];

export default function MerchantUsersPage() {
  const { hasRole } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const { get, set, page, setPage } = useUrlState();
  const [search, setSearch] = useState(get('search'));
  const q = useDebounce(search);
  const [create, setCreate] = useState(false);
  const [reset, setReset] = useState(null);
  const list = useQuery(() => usersApi.list({ page, limit: LIMIT, search: q || undefined }).then((r) => r.data), [page, q]);

  const toggle = async (u) => {
    try { await usersApi.setActive(u.user_id, !u.is_active); toast.success(u.is_active ? 'Compte désactivé' : 'Compte activé'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="page">
      <PageHeader crumbs={[{ label: 'Marchands', to: '/marchands' }, { label: 'Utilisateurs' }]} title="Utilisateurs marchands" badge={list.data?.total !== undefined && <Badge>{fmtNumber(list.data.total)}</Badge>}
        subtitle="Comptes des portails marchands (propriétaires, caissiers…). Réinitialisation de mot de passe avec affichage unique."
        actions={canWrite && <Button variant="primary" icon="plus" onClick={() => setCreate(true)}>Nouvel utilisateur</Button>} />
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <FiltersBar hasActive={!!q} onReset={() => { setSearch(''); set({ search: '', page: '' }); }}>
            <div className="grow"><SearchInput value={search} onChange={(v) => { setSearch(v); set({ search: v, page: '' }); }} placeholder="E-mail, prénom ou nom…" /></div>
          </FiltersBar>
        </div>
        <DataTable columns={userColumns({ canWrite, onToggle: toggle, onReset: (u) => setReset({ id: u.user_id, label: u.email }) })} rows={list.data?.data || []} keyField="user_id"
          loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} total={list.data?.total} onPage={setPage} empty="Aucun utilisateur" emptyIcon="users" />
      </Card>
      {create && <CreateUserModal onClose={() => setCreate(false)} onCreated={list.refresh} />}
      {reset && <ResetPasswordDialog user={reset} onClose={() => setReset(null)} />}
    </div>
  );
}
