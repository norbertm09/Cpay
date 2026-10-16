import React, { useState } from 'react';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, Tabs, Chips, StatusBadge, Badge, Modal, Field, Input, Select, Textarea, Switch, ConfirmDialog, Callout } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { fraudApi } from '../../services/api';
import { fmtDateTime, shortId } from '../../utils/format';
import { severityOf } from '../../utils/status';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';
import { MerchantLink } from '../merchants/MerchantsPage';

const LIMIT = 25;
const scoreTone = (s) => (s >= 80 ? 'error' : s >= 40 ? 'warn' : 'success');

function EventsTab({ canWrite }) {
  const { get, set, page, setPage } = useUrlState();
  const action = get('action');
  const list = useQuery(() => fraudApi.events({ action: action || undefined, limit: LIMIT, offset: (page - 1) * LIMIT }).then((r) => r.data), [action, page]);
  const review = async (e, outcome) => {
    try { await fraudApi.review(e.event_id, outcome); toast.success('Revue enregistrée'); list.refresh(); }
    catch (err) { toast.error(errorMessage(err)); }
  };
  const cols = [
    { key: 'created_at', label: 'Date', render: (e) => <span className="cell-date">{fmtDateTime(e.created_at)}</span> },
    { key: 'business_name', label: 'Marchand', render: (e) => <MerchantLink id={e.merchant_id} name={e.business_name} /> },
    { key: 'transaction_id', label: 'Transaction', render: (e) => <span className="mono small">{shortId(e.transaction_id)}</span> },
    { key: 'total_score', label: 'Score', align: 'right', render: (e) => <Badge tone={scoreTone(e.total_score)}>{e.total_score}</Badge>, sortValue: (e) => Number(e.total_score) },
    { key: 'action_taken', label: 'Décision', render: (e) => <StatusBadge status={e.action_taken} /> },
    { key: 'rules_triggered', label: 'Règles déclenchées', render: (e) => <span className="small muted">{Array.isArray(e.rules_triggered) ? e.rules_triggered.map((r) => r.ruleName || r.rule_name || r).join(', ') : '—'}</span> },
    { key: 'review_outcome', label: 'Revue', render: (e) => <StatusBadge status={e.review_outcome || 'pending'} /> },
    ...(canWrite ? [{ key: 'actions', label: '', sortable: false, render: (e) => (!e.review_outcome || e.review_outcome === 'pending') && <div className="row-actions"><Button size="xs" variant="success" onClick={() => review(e, 'false_positive')}>Faux positif</Button><Button size="xs" variant="danger-outline" onClick={() => review(e, 'confirmed_fraud')}>Fraude confirmée</Button></div> }] : []),
  ];
  return (
    <Card flush title="Événements de fraude" actions={<Chips value={action} onChange={(v) => set({ action: v, page: '' })} items={[{ value: 'block', label: 'Bloqués' }, { value: 'review', label: 'À revoir' }, { value: 'allow', label: 'Autorisés' }]} />}>
      <DataTable columns={cols} rows={list.data?.data || []} keyField="event_id" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} total={list.data?.total} onPage={setPage} dense empty="Aucun événement de fraude" emptyIcon="shield" />
    </Card>
  );
}

const EMPTY_RULE = { rule_name: '', rule_type: 'velocity', action: 'review', risk_score_add: 50, priority: 100, conditions: '{}' };
function RulesTab({ canWrite }) {
  const list = useQuery(() => fraudApi.rules().then((r) => r.data.data || []), []);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const toggle = async (r) => {
    try { await fraudApi.updateRule(r.rule_id, { is_active: !r.is_active }); toast.success(r.is_active ? 'Règle désactivée' : 'Règle activée'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const save = async () => {
    let conditions;
    try { conditions = JSON.parse(edit.form.conditions || '{}'); } catch (e) { return toast.error('Conditions : JSON invalide'); }
    setBusy(true);
    try {
      const payload = { ...edit.form, conditions, risk_score_add: Number(edit.form.risk_score_add), priority: Number(edit.form.priority) };
      if (edit.id) await fraudApi.updateRule(edit.id, payload); else await fraudApi.createRule(payload);
      toast.success('Règle enregistrée'); setEdit(null); list.refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
    return undefined;
  };
  const setF = (k, v) => setEdit((e) => ({ ...e, form: { ...e.form, [k]: v } }));
  const cols = [
    { key: 'rule_name', label: 'Règle', render: (r) => <span className="cell-primary">{r.rule_name}</span> },
    { key: 'rule_type', label: 'Type', render: (r) => <Badge tone="info">{r.rule_type}</Badge> },
    { key: 'action', label: 'Décision', render: (r) => <StatusBadge status={r.action} /> },
    { key: 'risk_score_add', label: 'Score ajouté', align: 'right', render: (r) => <Badge tone={scoreTone(r.risk_score_add)}>+{r.risk_score_add}</Badge>, sortValue: (r) => Number(r.risk_score_add) },
    { key: 'priority', label: 'Priorité', align: 'right', sortValue: (r) => Number(r.priority) },
    { key: 'conditions', label: 'Conditions', render: (r) => <span className="mono xs muted truncate" style={{ maxWidth: 260, display: 'inline-block' }}>{JSON.stringify(r.conditions || {})}</span> },
    { key: 'is_active', label: 'Active', render: (r) => <Switch checked={!!r.is_active} disabled={!canWrite} onChange={() => toggle(r)} /> },
    ...(canWrite ? [{ key: 'actions', label: '', sortable: false, render: (r) => <div className="row-actions"><Button size="xs" onClick={() => setEdit({ id: r.rule_id, form: { ...EMPTY_RULE, ...r, conditions: JSON.stringify(r.conditions || {}, null, 2) } })}>Modifier</Button></div> }] : []),
  ];
  return (
    <Card flush title="Règles de détection" sub="Évaluées par priorité croissante ; le score cumulé détermine la décision." actions={canWrite && <Button size="sm" variant="primary" icon="plus" onClick={() => setEdit({ id: null, form: { ...EMPTY_RULE } })}>Nouvelle règle</Button>}>
      <DataTable columns={cols} rows={list.data || []} keyField="rule_id" loading={list.loading} error={list.error} onRetry={list.reload} dense empty="Aucune règle" emptyIcon="shield" defaultSort={{ key: 'priority', dir: 'asc' }} />
      {edit && (
        <Modal title={edit.id ? 'Modifier la règle' : 'Nouvelle règle'} onClose={() => !busy && setEdit(null)} footer={<><Button onClick={() => setEdit(null)} disabled={busy}>Annuler</Button><Button variant="primary" loading={busy} onClick={save}>Enregistrer</Button></>}>
          <div className="form-grid">
            <Field label="Nom" required className="full"><Input value={edit.form.rule_name} onChange={(v) => setF('rule_name', v)} /></Field>
            <Field label="Type"><Select value={edit.form.rule_type} onChange={(v) => setF('rule_type', v)} options={['velocity', 'amount', 'geo', 'device', 'pattern']} /></Field>
            <Field label="Décision"><Select value={edit.form.action} onChange={(v) => setF('action', v)} options={[{ value: 'allow', label: 'Autoriser' }, { value: 'review', label: 'À revoir' }, { value: 'block', label: 'Bloquer' }]} /></Field>
            <Field label="Score ajouté (0-100)"><Input type="number" min="0" max="100" value={edit.form.risk_score_add} onChange={(v) => setF('risk_score_add', v)} /></Field>
            <Field label="Priorité"><Input type="number" min="0" value={edit.form.priority} onChange={(v) => setF('priority', v)} /></Field>
            <Field label="Conditions (JSON)" className="full"><Textarea className="mono" rows={5} value={edit.form.conditions} onChange={(v) => setF('conditions', v)} /></Field>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function AlertsTab({ canWrite }) {
  const { get, set, page, setPage } = useUrlState({ resolved: 'false' });
  const severity = get('severity'), resolved = get('resolved') === 'true';
  const list = useQuery(() => fraudApi.alerts({ severity: severity || undefined, resolved, page, limit: LIMIT }).then((r) => r.data), [severity, resolved, page]);
  const [resolve, setResolve] = useState(null);
  const doResolve = async (note) => {
    try { await fraudApi.resolveAlert(resolve.alert_id, note); toast.success('Alerte résolue'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); throw e; }
  };
  const cols = [
    { key: 'severity', label: 'Sévérité', render: (a) => { const s = severityOf(a.severity); return <Badge tone={s.tone} dot>{s.label}</Badge>; }, sortValue: (a) => Number(a.severity) },
    { key: 'flag_type', label: 'Type', render: (a) => <Badge tone="info">{a.flag_type}</Badge> },
    { key: 'business_name', label: 'Marchand', render: (a) => <MerchantLink id={a.merchant_id} name={a.business_name || shortId(a.merchant_id)} /> },
    { key: 'description', label: 'Description', render: (a) => <span className="small">{a.description}</span> },
    { key: 'created_at', label: 'Date', render: (a) => <span className="cell-date">{fmtDateTime(a.created_at)}</span>, sortValue: (a) => a.created_at },
    { key: 'resolved', label: 'Statut', render: (a) => <StatusBadge status={a.resolved ? 'resolved' : 'open'} /> },
    ...(canWrite ? [{ key: 'actions', label: '', sortable: false, render: (a) => !a.resolved && <Button size="xs" variant="success" onClick={() => setResolve(a)}>Résoudre</Button> }] : []),
  ];
  return (
    <Card flush title="Alertes AML" actions={<>
      <Chips value={severity} onChange={(v) => set({ severity: v, page: '' })} items={[{ value: '4', label: 'Critique' }, { value: '3', label: 'Élevée' }, { value: '2', label: 'Moyenne' }, { value: '1', label: 'Faible' }]} />
      <Switch checked={resolved} onChange={(v) => set({ resolved: v ? 'true' : 'false', page: '' })} label="Afficher les résolues" />
    </>}>
      {list.forbidden ? <div className="card-body"><Callout tone="warn">La lecture des alertes AML n’est pas disponible pour votre rôle.</Callout></div> : (
        <DataTable columns={cols} rows={list.data?.data || []} keyField="alert_id" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} total={list.data?.total} onPage={setPage} dense empty={resolved ? 'Aucune alerte résolue' : 'Aucune alerte ouverte'} emptyIcon="shield" />
      )}
      {resolve && <ConfirmDialog title="Résoudre l’alerte" tone="success" confirmLabel="Résoudre" message={resolve.description} reason={{ label: 'Note de résolution', required: true, placeholder: 'Décrivez comment l’alerte a été traitée…' }} onConfirm={doResolve} onClose={() => setResolve(null)} />}
    </Card>
  );
}

export default function FraudPage() {
  const { hasRole } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const { get, set } = useUrlState({ tab: 'evenements' });
  const tab = get('tab');
  const alerts = useQuery(() => fraudApi.alerts({ resolved: false, limit: 1 }).then((r) => r.data.total).catch(() => null), []);
  return (
    <div className="page">
      <PageHeader title="Fraude & alertes" subtitle="Décisions du moteur anti-fraude, règles de détection et alertes de conformité (AML)." />
      <Tabs value={tab} onChange={(v) => set({ tab: v, page: '', action: '', severity: '' })} items={[{ value: 'evenements', label: 'Événements', icon: 'shield' }, { value: 'regles', label: 'Règles', icon: 'sliders' }, { value: 'alertes', label: 'Alertes AML', icon: 'alert', count: alerts.data ?? undefined }]} />
      {tab === 'evenements' && <EventsTab canWrite={canWrite} />}
      {tab === 'regles' && <RulesTab canWrite={canWrite} />}
      {tab === 'alertes' && <AlertsTab canWrite={canWrite} />}
    </div>
  );
}
