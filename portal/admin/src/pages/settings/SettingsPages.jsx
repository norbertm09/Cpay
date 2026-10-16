import React, { useMemo, useState } from 'react';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, Tabs, FiltersBar, SearchInput, Select, Chips, StatusBadge, Badge, Modal, Field, Input, Switch, Callout, Skeleton, Stat, KeyValue, ConfirmDialog, EmptyState } from '../../components/ui';
import { useQuery, useDebounce } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { configApi, terminalsApi, monitorApi } from '../../services/api';
import { fmtDateTime, fmtNumber, fmtMoney, fmtDuration, methodLabel, countryName } from '../../utils/format';
import { ROLES, ROLE_LIST, roleLabel, roleTone, PERMS } from '../../utils/roles';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';
import { MerchantLink } from '../merchants/MerchantsPage';
import { ResetPasswordDialog } from '../merchants/MerchantUsersPage';

// ─── Terminaux ────────────────────────────────────────────────────
export function TerminalsPage() {
  const { hasRole } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const { get, set } = useUrlState();
  const status = get('status'), merchantId = get('merchantId');
  const [search, setSearch] = useState('');
  const list = useQuery(() => terminalsApi.list({ status: status || undefined, merchantId: merchantId || undefined }).then((r) => r.data.data || []), [status, merchantId]);
  const rows = useMemo(() => (list.data || []).filter((t) => !search || [t.terminal_code, t.terminal_name, t.business_name, t.device_model, t.android_id].some((v) => String(v || '').toLowerCase().includes(search.toLowerCase()))), [list.data, search]);
  const act = async (t, status2) => {
    try { if (status2 === 'unblock') await terminalsApi.unblock(t.terminal_id); else await terminalsApi.setStatus(t.terminal_id, status2); toast.success('Terminal mis à jour'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const cols = [
    { key: 'terminal_code', label: 'Terminal', render: (t) => <div><div className="cell-primary mono">{t.terminal_code}</div><div className="cell-sub">{t.terminal_name || '—'}</div></div> },
    { key: 'business_name', label: 'Marchand', render: (t) => <MerchantLink id={t.merchant_id} name={t.business_name} /> },
    { key: 'pairing', label: 'Appairage', render: (t) => (t.paired_at ? <Badge tone="success">appairé</Badge> : t.pairing_code ? <span className="mono strong" style={{ letterSpacing: 1 }}>{t.pairing_code}</span> : <span className="muted">—</span>) },
    { key: 'device_model', label: 'Appareil', render: (t) => <div className="small">{t.device_model || '—'}<div className="cell-sub mono">{t.android_id || ''}</div></div> },
    { key: 'app_version', label: 'Version', render: (t) => t.app_version || '—' },
    { key: 'last_seen_at', label: 'Vu le', render: (t) => <span className="cell-date">{t.last_seen_at ? fmtDateTime(t.last_seen_at) : 'jamais'}</span>, sortValue: (t) => t.last_seen_at },
    { key: 'status', label: 'Statut', render: (t) => <StatusBadge status={t.status} /> },
    ...(canWrite ? [{ key: 'actions', label: '', sortable: false, render: (t) => <div className="row-actions">{t.status === 'active' ? <Button size="xs" variant="danger-outline" onClick={() => act(t, 'blocked')}>Bloquer</Button> : <Button size="xs" variant="success" onClick={() => act(t, t.status === 'blocked' ? 'unblock' : 'active')}>{t.status === 'blocked' ? 'Débloquer' : 'Activer'}</Button>}</div> }] : []),
  ];
  return (
    <div className="page">
      <PageHeader title="Terminaux" subtitle="Terminaux Android des marchands (SoftPOS) : appairage, dernière activité, blocage." badge={<Badge>{fmtNumber(rows.length)}</Badge>} />
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <FiltersBar hasActive={!!(status || merchantId || search)} onReset={() => { setSearch(''); set({ status: '', merchantId: '' }); }}>
            <div className="grow"><SearchInput value={search} onChange={setSearch} placeholder="Code, nom, marchand, modèle, Android ID…" /></div>
            <Chips value={status} onChange={(v) => set({ status: v })} items={[{ value: 'active', label: 'Actifs' }, { value: 'inactive', label: 'Inactifs' }, { value: 'blocked', label: 'Bloqués' }]} />
            {merchantId && <Button size="sm" icon="x" onClick={() => set({ merchantId: '' })}>Marchand : {merchantId.slice(0, 8)}…</Button>}
          </FiltersBar>
        </div>
        <DataTable columns={cols} rows={rows} keyField="terminal_id" loading={list.loading} error={list.error} onRetry={list.reload} empty="Aucun terminal" emptyIcon="phone" columnTools storageKey="terminals" footerExtra={<span className="muted">100 terminaux au maximum (limite API)</span>} />
      </Card>
    </div>
  );
}

// ─── Fonctionnalités & pilote ─────────────────────────────────────
export function FeaturesPage() {
  const { hasRole } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const { get, set } = useUrlState({ tab: 'flags' });
  const tab = get('tab');
  const flags = useQuery(() => configApi.pilotFeatures().then((r) => r.data), []);
  const programs = useQuery(() => configApi.pilotPrograms().then((r) => r.data), [], { enabled: tab === 'programmes' });
  const readiness = useQuery(() => configApi.pilotReadiness().then((r) => r.data), [], { enabled: tab === 'readiness' });
  const [edit, setEdit] = useState(null); const [busy, setBusy] = useState(false);
  const toggle = async (f) => {
    try { await configApi.updateFeature(f.flag_key, { defaultEnabled: !f.default_enabled }); toast.success(`${f.display_name} ${f.default_enabled ? 'désactivée' : 'activée'} par défaut`); flags.refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const save = async () => {
    setBusy(true);
    try { await configApi.updateFeature(edit.flag_key, { displayName: edit.display_name, description: edit.description, status: edit.status, defaultEnabled: edit.default_enabled, pilotOnly: edit.pilot_only, rolloutPercent: Number(edit.rollout_percent) }); toast.success('Fonctionnalité mise à jour'); setEdit(null); flags.refresh(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const flagCols = [
    { key: 'display_name', label: 'Fonctionnalité', render: (f) => <div><div className="cell-primary">{f.display_name}</div><div className="cell-sub mono">{f.flag_key}</div>{f.description && <div className="cell-sub">{f.description}</div>}</div> },
    { key: 'status', label: 'Statut', render: (f) => <Badge tone={f.status === 'active' ? 'success' : f.status === 'audit' ? 'warn' : 'neutral'}>{f.status}</Badge> },
    { key: 'pilot_only', label: 'Périmètre', render: (f) => (f.pilot_only ? <Badge tone="cyan">pilote uniquement</Badge> : <Badge tone="info">général</Badge>) },
    { key: 'rollout_percent', label: 'Déploiement', render: (f) => <div style={{ minWidth: 120 }}><div className="between xs"><span>{f.rollout_percent} %</span></div><div className="progress"><div style={{ width: `${f.rollout_percent}%` }} /></div></div>, sortValue: (f) => Number(f.rollout_percent) },
    { key: 'default_enabled', label: 'Activée par défaut', render: (f) => <Switch checked={!!f.default_enabled} disabled={!canWrite} onChange={() => toggle(f)} /> },
    ...(canWrite ? [{ key: 'actions', label: '', sortable: false, render: (f) => <Button size="xs" onClick={() => setEdit({ ...f })}>Modifier</Button> }] : []),
  ];
  const progCols = [
    { key: 'name', label: 'Programme', render: (p) => <div><div className="cell-primary">{p.name}</div><div className="cell-sub mono">{p.pilot_key} · cible {p.target_version}</div></div> },
    { key: 'status', label: 'Statut', render: (p) => <StatusBadge status={p.status} /> },
    { key: 'country_scope', label: 'Pays', render: (p) => (p.country_scope || []).map((c) => <Badge key={c}>{c}</Badge>) },
    { key: 'start_at', label: 'Période', render: (p) => <span className="small">{fmtDateTime(p.start_at)} → {fmtDateTime(p.end_at)}</span> },
    { key: 'success_metrics', label: 'Indicateurs', render: (p) => <span className="mono xs muted">{JSON.stringify(p.success_metrics || {})}</span> },
  ];
  const readyCols = [
    { key: 'display_name', label: 'Contrôle', render: (c) => <div><div className="cell-primary">{c.display_name}</div><div className="cell-sub">{c.category} · {c.check_key}</div></div> },
    { key: 'required', label: 'Obligatoire', render: (c) => (c.required ? <Badge tone="warn">oui</Badge> : <Badge>non</Badge>) },
    { key: 'status', label: 'Statut', render: (c) => <StatusBadge status={c.status} /> },
    { key: 'evidence', label: 'Preuve', render: (c) => <span className="small">{c.evidence || '—'}</span> },
    { key: 'updated_at', label: 'Mis à jour', render: (c) => <span className="cell-date">{fmtDateTime(c.updated_at)}</span> },
  ];
  return (
    <div className="page">
      <PageHeader title="Fonctionnalités & pilote" subtitle="Drapeaux de fonctionnalités, programmes pilotes et contrôles de préparation à la production." badge={flags.data?.mode && <Badge tone="info">mode {flags.data.mode}</Badge>} />
      <Tabs value={tab} onChange={(v) => set({ tab: v })} items={[{ value: 'flags', label: 'Fonctionnalités', icon: 'toggle', count: flags.data?.data?.length }, { value: 'programmes', label: 'Programmes pilotes', icon: 'rocket' }, { value: 'readiness', label: 'Préparation production', icon: 'check' }]} />
      {tab === 'flags' && <Card flush><DataTable columns={flagCols} rows={flags.data?.data || []} keyField="flag_key" loading={flags.loading} error={flags.error} onRetry={flags.reload} empty="Aucune fonctionnalité" emptyIcon="toggle" /></Card>}
      {tab === 'programmes' && <Card flush><DataTable columns={progCols} rows={programs.data?.data || []} keyField="pilot_id" loading={programs.loading} error={programs.error} onRetry={programs.reload} empty="Aucun programme pilote" emptyIcon="rocket" /></Card>}
      {tab === 'readiness' && (
        <div className="stack">
          {readiness.data && <Callout tone={readiness.data.ready ? 'success' : 'warn'}>{readiness.data.ready ? 'Tous les contrôles obligatoires sont satisfaits.' : `${(readiness.data.blockers || []).length} contrôle(s) obligatoire(s) non satisfait(s).`}</Callout>}
          <Card flush><DataTable columns={readyCols} rows={readiness.data?.data || []} keyField="check_key" loading={readiness.loading} error={readiness.error} onRetry={readiness.reload} empty="Aucun contrôle" emptyIcon="check" /></Card>
        </div>
      )}
      {edit && (
        <Modal title={`Modifier ${edit.display_name}`} sub={<span className="mono">{edit.flag_key}</span>} onClose={() => !busy && setEdit(null)} footer={<><Button onClick={() => setEdit(null)} disabled={busy}>Annuler</Button><Button variant="primary" loading={busy} onClick={save}>Enregistrer</Button></>}>
          <div className="form-grid">
            <Field label="Nom" className="full"><Input value={edit.display_name || ''} onChange={(v) => setEdit((e) => ({ ...e, display_name: v }))} /></Field>
            <Field label="Description" className="full"><Input value={edit.description || ''} onChange={(v) => setEdit((e) => ({ ...e, description: v }))} /></Field>
            <Field label="Statut"><Select value={edit.status} onChange={(v) => setEdit((e) => ({ ...e, status: v }))} options={['audit', 'active', 'disabled']} /></Field>
            <Field label="Déploiement (%)"><Input type="number" min="0" max="100" value={edit.rollout_percent} onChange={(v) => setEdit((e) => ({ ...e, rollout_percent: v }))} /></Field>
            <div><Switch checked={!!edit.default_enabled} onChange={(v) => setEdit((e) => ({ ...e, default_enabled: v }))} label="Activée par défaut" /></div>
            <div><Switch checked={!!edit.pilot_only} onChange={(v) => setEdit((e) => ({ ...e, pilot_only: v }))} label="Réservée aux marchands pilotes" /></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Administrateurs ──────────────────────────────────────────────
export function AdminsPage() {
  const { admin, isSuperAdmin } = useAuth();
  const list = useQuery(() => configApi.adminUsers().then((r) => r.data.data || []), []);
  const [create, setCreate] = useState(false); const [edit, setEdit] = useState(null); const [reset, setReset] = useState(null); const [toggle, setToggle] = useState(null);
  const [form, setForm] = useState({ email: '', password: '', firstName: '', lastName: '', role: 'support_agent' }); const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await configApi.createAdmin(form); toast.success('Administrateur créé'); setCreate(false); setForm({ email: '', password: '', firstName: '', lastName: '', role: 'support_agent' }); list.refresh(); }
    catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try { await configApi.updateAdmin(edit.admin_id, { role: edit.role, firstName: edit.first_name, lastName: edit.last_name }); toast.success('Administrateur mis à jour'); setEdit(null); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const setActive = async (u) => {
    try { await configApi.updateAdmin(u.admin_id, { isActive: !u.is_active }); toast.success(u.is_active ? 'Compte désactivé' : 'Compte activé'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); throw e; }
  };
  const cols = [
    { key: 'name', label: 'Administrateur', render: (u) => <div><div className="cell-primary">{`${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email}{u.admin_id === admin?.adminId && <Badge tone="info"> vous</Badge>}</div><div className="cell-sub">{u.email}</div></div>, sortValue: (u) => `${u.first_name} ${u.last_name}` },
    { key: 'role', label: 'Rôle', render: (u) => <Badge tone={roleTone(u.role)}>{roleLabel(u.role)}</Badge> },
    { key: 'is_active', label: 'Statut', render: (u) => <StatusBadge status={u.is_active ? 'active' : 'inactive'} /> },
    { key: 'last_login_at', label: 'Dernière connexion', render: (u) => <span className="cell-date">{u.last_login_at ? fmtDateTime(u.last_login_at) : 'jamais'}</span>, sortValue: (u) => u.last_login_at },
    { key: 'created_at', label: 'Créé le', render: (u) => <span className="cell-date">{fmtDateTime(u.created_at)}</span> },
    ...(isSuperAdmin ? [{ key: 'actions', label: '', sortable: false, render: (u) => u.admin_id !== admin?.adminId && (
      <div className="row-actions">
        <Button size="xs" onClick={() => setEdit({ ...u })}>Modifier</Button>
        <Button size="xs" icon="key" onClick={() => setReset({ id: u.admin_id, label: u.email })}>Réinitialiser</Button>
        <Button size="xs" variant={u.is_active ? 'danger-outline' : 'success'} onClick={() => setToggle(u)}>{u.is_active ? 'Désactiver' : 'Activer'}</Button>
      </div>
    ) }] : []),
  ];
  return (
    <div className="page">
      <PageHeader title="Administrateurs" subtitle="Comptes du back-office et leurs rôles." badge={<Badge>{fmtNumber(list.data?.length)}</Badge>} actions={isSuperAdmin && <Button variant="primary" icon="plus" onClick={() => setCreate(true)}>Nouvel administrateur</Button>} />
      <Card title="Rôles et droits" dense>
        <div className="grid grid-4" style={{ gap: 12 }}>
          {ROLE_LIST.map((r) => <div key={r} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 12 }}><Badge tone={roleTone(r)}>{roleLabel(r)}</Badge><div className="xs muted mt-2">{{ super_admin: 'Tous les droits : administrateurs, audit, tenants, banques, connecteurs, caisse, règlements.', ops_admin: 'Marchands, caisse, transactions, fraude, connecteurs, rails, support et CRM.', finance_admin: 'Règlements J+1, virements en attente, consultation des transactions.', support_agent: 'Tickets, réclamations, leads, conversations, consultation.' }[r]}</div></div>)}
        </div>
      </Card>
      <Card flush><DataTable columns={cols} rows={list.data || []} keyField="admin_id" loading={list.loading} error={list.error} onRetry={list.reload} empty="Aucun administrateur" emptyIcon="usershield" /></Card>
      {create && (
        <Modal title="Nouvel administrateur" onClose={() => !busy && setCreate(false)} footer={<><Button onClick={() => setCreate(false)} disabled={busy}>Annuler</Button><Button variant="primary" type="submit" form="create-admin" loading={busy}>Créer</Button></>}>
          <form id="create-admin" className="form-grid" onSubmit={submit}>
            <Field label="Prénom"><Input value={form.firstName} onChange={(v) => setForm((f) => ({ ...f, firstName: v }))} /></Field>
            <Field label="Nom"><Input value={form.lastName} onChange={(v) => setForm((f) => ({ ...f, lastName: v }))} /></Field>
            <Field label="E-mail" required className="full"><Input type="email" value={form.email} onChange={(v) => setForm((f) => ({ ...f, email: v }))} required placeholder="prenom.nom@c-pay.global" /></Field>
            <Field label="Mot de passe initial" required hint="À transmettre par un canal sûr ; 10 caractères minimum."><Input type="password" autoComplete="new-password" value={form.password} onChange={(v) => setForm((f) => ({ ...f, password: v }))} required minLength={10} /></Field>
            <Field label="Rôle" required><Select value={form.role} onChange={(v) => setForm((f) => ({ ...f, role: v }))} options={ROLE_LIST.map((r) => ({ value: r, label: ROLES[r].label }))} /></Field>
          </form>
        </Modal>
      )}
      {edit && (
        <Modal title={`Modifier ${edit.email}`} onClose={() => !busy && setEdit(null)} size="sm" footer={<><Button onClick={() => setEdit(null)} disabled={busy}>Annuler</Button><Button variant="primary" loading={busy} onClick={save}>Enregistrer</Button></>}>
          <div className="stack">
            <Field label="Prénom"><Input value={edit.first_name || ''} onChange={(v) => setEdit((e) => ({ ...e, first_name: v }))} /></Field>
            <Field label="Nom"><Input value={edit.last_name || ''} onChange={(v) => setEdit((e) => ({ ...e, last_name: v }))} /></Field>
            <Field label="Rôle"><Select value={edit.role} onChange={(v) => setEdit((e) => ({ ...e, role: v }))} options={ROLE_LIST.map((r) => ({ value: r, label: ROLES[r].label }))} /></Field>
          </div>
        </Modal>
      )}
      {reset && <ResetPasswordDialog user={reset} type="admin" onClose={() => setReset(null)} />}
      {toggle && <ConfirmDialog title={`${toggle.is_active ? 'Désactiver' : 'Activer'} ${toggle.email}`} tone={toggle.is_active ? 'danger' : 'success'} confirmLabel={toggle.is_active ? 'Désactiver' : 'Activer'} message={toggle.is_active ? 'Le compte ne pourra plus se connecter au back-office.' : 'Le compte retrouve l’accès au back-office.'} onConfirm={() => setActive(toggle)} onClose={() => setToggle(null)} />}
    </div>
  );
}

// ─── Journal d'audit ──────────────────────────────────────────────
export function AuditPage() {
  const { get, set, page, setPage } = useUrlState();
  const [search, setSearch] = useState(get('q')); const q = useDebounce(search);
  const [sel, setSel] = useState(null);
  const list = useQuery(() => configApi.auditLogs({ page, limit: 50 }).then((r) => r.data.data || []), [page]);
  const rows = useMemo(() => (list.data || []).filter((l) => !q || [l.action, l.actor_email, l.entity_type, l.entity_id, JSON.stringify(l.new_values || '')].some((v) => String(v || '').toLowerCase().includes(q.toLowerCase()))), [list.data, q]);
  const cols = [
    { key: 'created_at', label: 'Date', render: (l) => <span className="cell-date">{fmtDateTime(l.created_at)}</span>, sortValue: (l) => l.created_at },
    { key: 'actor_email', label: 'Acteur', render: (l) => <div className="small">{l.actor_email || '—'}<div className="cell-sub">{l.actor_type}</div></div> },
    { key: 'action', label: 'Action', render: (l) => <span className="mono small strong">{l.action}</span> },
    { key: 'entity_type', label: 'Entité', render: (l) => <div className="small">{l.entity_type || '—'}<div className="cell-sub mono">{l.entity_id ? `${String(l.entity_id).slice(0, 8)}…` : ''}</div></div> },
    { key: 'ip_address', label: 'IP', render: (l) => <span className="mono small">{l.ip_address || '—'}</span> },
    { key: 'new_values', label: 'Détails', render: (l) => <span className="xs muted truncate" style={{ maxWidth: 320, display: 'inline-block' }}>{l.new_values ? JSON.stringify(l.new_values) : '—'}</span> },
  ];
  return (
    <div className="page">
      <PageHeader title="Journal d’audit" subtitle="Toutes les actions sensibles effectuées par les administrateurs (50 par page)." badge={<Badge tone="navy">super_admin</Badge>} />
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}><FiltersBar hasActive={!!q} onReset={() => { setSearch(''); set({ q: '' }); }}><div className="grow"><SearchInput value={search} onChange={(v) => { setSearch(v); set({ q: v }); }} placeholder="Filtrer la page : action, acteur, entité…" /></div></FiltersBar></div>
        <DataTable columns={cols} rows={rows} keyField="log_id" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={50} onPage={setPage} onRowClick={setSel} dense empty="Aucune entrée" emptyIcon="list" />
      </Card>
      {sel && (
        <Modal title={sel.action} sub={`${sel.actor_email || sel.actor_type} · ${fmtDateTime(sel.created_at)}`} onClose={() => setSel(null)} footer={<Button onClick={() => setSel(null)}>Fermer</Button>}>
          <div className="stack">
            <KeyValue rows={[['Entité', `${sel.entity_type || '—'} ${sel.entity_id || ''}`], ['Adresse IP', sel.ip_address]]} />
            {sel.old_values && <div><div className="small strong mb-2">Avant</div><div className="code-block">{JSON.stringify(sel.old_values, null, 2)}</div></div>}
            {(sel.new_values || sel.after_state) && <div><div className="small strong mb-2">Après</div><div className="code-block">{JSON.stringify(sel.new_values || sel.after_state, null, 2)}</div></div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Monitoring ───────────────────────────────────────────────────
export function MonitoringPage() {
  const [auto, setAuto] = useState(true);
  const { get, set } = useUrlState();
  const filter = get('status');
  const live = useQuery(() => monitorApi.live().then((r) => r.data), [], { interval: auto ? 8000 : 0 });
  const health = useQuery(() => monitorApi.health().then((r) => r.data).catch((e) => e.response?.data || { status: 'unreachable' }), [], { interval: auto ? 15000 : 0 });
  const txns = live.data?.data || [];
  const shown = filter ? txns.filter((t) => t.status === filter) : txns;
  const count = (s) => txns.filter((t) => t.status === s).length;
  const h = health.data;
  const cols = [
    { key: 'initiated_at', label: 'Heure', render: (t) => <span className="cell-date">{fmtDateTime(t.initiated_at)}</span>, sortValue: (t) => t.initiated_at },
    { key: 'business_name', label: 'Marchand', render: (t) => <span className="cell-primary">{t.business_name}</span> },
    { key: 'country', label: 'Pays', render: (t) => countryName(t.country) },
    { key: 'payment_method', label: 'Méthode', render: (t) => methodLabel(t.payment_method) },
    { key: 'operator', label: 'Opérateur', render: (t) => t.detected_operator || t.detected_network || '—' },
    { key: 'amount', label: 'Montant', align: 'right', render: (t) => <span className="amount">{fmtMoney(t.amount, t.currency)}</span>, sortValue: (t) => Number(t.amount) },
    { key: 'status', label: 'Statut', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'settlement_status', label: 'Règlement', render: (t) => <StatusBadge status={t.settlement_status || 'non_regle'} /> },
  ];
  return (
    <div className="page">
      <PageHeader title="Monitoring" subtitle="Flux des transactions des 24 dernières heures et santé de l’API." actions={<><Switch checked={auto} onChange={setAuto} label="Actualisation automatique" /><Button icon="refresh" onClick={() => { live.refresh(); health.refresh(); }}>Actualiser</Button></>} />
      <div className="grid grid-4">
        <Stat label="API" value={h?.status === 'ok' ? 'Opérationnelle' : h?.status === 'degraded' ? 'Dégradée' : 'Injoignable'} sub={h?.version ? `v${h.version} · ${h.env || ''} · ${fmtDuration(h.uptime)}` : null} icon="server" tone={h?.status === 'ok' ? 'success' : 'error'} small />
        <Stat label="Base de données" value={h?.db === 'connected' ? 'Connectée' : h?.db || '—'} icon="server" tone={h?.db === 'connected' ? 'success' : 'error'} small />
        <Stat label="Transactions 24 h" value={fmtNumber(txns.length)} sub={`${count('authorized')} autorisées · ${count('failed')} échouées`} icon="activity" small />
        <Stat label="Horodatage du flux" value={live.data?.timestamp ? fmtDateTime(live.data.timestamp) : '—'} icon="clock" tone="cyan" small />
      </div>
      <Card flush title="Transactions en direct" actions={<Chips value={filter} onChange={(v) => set({ status: v })} items={[{ value: 'authorized', label: 'Autorisées', count: count('authorized') }, { value: 'pending', label: 'En attente', count: count('pending') }, { value: 'failed', label: 'Échouées', count: count('failed') }]} />}>
        {live.loading && !live.data ? <div className="card-body"><Skeleton lines={5} /></div> : !shown.length ? <EmptyState icon="activity" title="Aucune transaction sur les 24 dernières heures" /> : <DataTable columns={cols} rows={shown} keyField="transaction_id" dense columnTools storageKey="monitoring" />}
      </Card>
    </div>
  );
}
