import React, { useState } from 'react';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, Tabs, StatusBadge, Badge, Callout, Modal, Field, Input, Select, Textarea } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { monitorApi, supportApi } from '../../services/api';
import api from '../../services/api';
import { fmtDateTime, fmtMoney, shortId } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';

// Porteurs de carte : l'API admin n'expose ni liste ni fiche porteur (voir README
// « points ouverts »). Le back-office s'appuie sur ce qui existe : notifications
// de dépôt KYC (revue via PATCH /cardholders/:id/kyc/documents/:docId),
// réclamations porteurs (GET /claims) et incidents (GET /incidents).

function KycInbox() {
  const q = useQuery(() => monitorApi.notifications().then((r) => (r.data.data || []).filter((n) => n.type === 'kyc_document_submitted')), []);
  const [review, setReview] = useState(null);
  const [form, setForm] = useState({ docId: '', status: 'approved', reason: '' });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!form.docId.trim()) return toast.error('Identifiant du document requis');
    setBusy(true);
    try {
      await api.patch(`/cardholders/${review.entity_id}/kyc/documents/${form.docId.trim()}`, { status: form.status, rejectionReason: form.status === 'rejected' ? form.reason : undefined });
      toast.success(form.status === 'approved' ? 'Document approuvé, porteur notifié' : 'Document rejeté, porteur notifié');
      await monitorApi.markRead(review.notification_id).catch(() => {});
      setReview(null); q.refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
    return undefined;
  };
  const cols = [
    { key: 'created_at', label: 'Déposé le', render: (n) => <span className="cell-date">{fmtDateTime(n.created_at)}</span>, sortValue: (n) => n.created_at },
    { key: 'message', label: 'Dépôt', render: (n) => <div><div className="cell-primary">{n.message}</div><div className="cell-sub">{n.metadata?.docLabel || n.metadata?.docType} · {n.metadata?.fileName || ''}</div></div> },
    { key: 'entity_id', label: 'Porteur', render: (n) => <span className="mono small">{shortId(n.entity_id, 13)}</span> },
    { key: 'is_read', label: 'Traitement', render: (n) => <StatusBadge status={n.is_read ? 'done' : 'pending'} /> },
    { key: 'actions', label: '', sortable: false, render: (n) => <Button size="xs" variant="primary" onClick={() => { setReview(n); setForm({ docId: '', status: 'approved', reason: '' }); }}>Réviser</Button> },
  ];
  return (
    <div className="stack">
      <Callout tone="info">Les dépôts de documents KYC des porteurs arrivent ici via les notifications. L’API ne renvoyant pas la liste des documents d’un porteur, l’identifiant du document doit être saisi (il figure dans la notification d’origine ou dans la base).</Callout>
      <Card flush title="Documents KYC déposés" sub="50 dernières notifications">
        <DataTable columns={cols} rows={q.data || []} keyField="notification_id" loading={q.loading} error={q.error} onRetry={q.reload} dense empty="Aucun dépôt KYC porteur récent" emptyIcon="idcard" />
      </Card>
      {review && (
        <Modal title="Réviser un document KYC" sub={review.message} onClose={() => !busy && setReview(null)} size="sm" footer={<><Button onClick={() => setReview(null)} disabled={busy}>Annuler</Button><Button variant={form.status === 'rejected' ? 'danger' : 'success'} loading={busy} onClick={submit}>{form.status === 'rejected' ? 'Rejeter' : 'Approuver'}</Button></>}>
          <div className="stack">
            <Field label="Porteur"><Input value={review.entity_id} disabled className="mono" /></Field>
            <Field label="Identifiant du document (doc_id)" required><Input value={form.docId} onChange={(v) => setForm((f) => ({ ...f, docId: v }))} className="mono" placeholder="UUID du document" /></Field>
            <Field label="Décision"><Select value={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v }))} options={[{ value: 'approved', label: 'Approuver' }, { value: 'rejected', label: 'Rejeter' }]} /></Field>
            {form.status === 'rejected' && <Field label="Motif (envoyé par SMS au porteur)" required><Textarea rows={3} value={form.reason} onChange={(v) => setForm((f) => ({ ...f, reason: v }))} /></Field>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ClaimsTab() {
  const list = useQuery(() => supportApi.cardholderClaims().then((r) => r.data.data || []), []);
  const cols = [
    { key: 'claim_ref', label: 'Référence', render: (c) => <span className="mono strong">{c.claim_ref}</span> },
    { key: 'opened_at', label: 'Ouverte le', render: (c) => <span className="cell-date">{fmtDateTime(c.opened_at)}</span>, sortValue: (c) => c.opened_at },
    { key: 'holder', label: 'Porteur', render: (c) => <div><div className="cell-primary">{`${c.first_name || ''} ${c.last_name || ''}`.trim() || '—'}</div><div className="cell-sub">{c.email}</div></div> },
    { key: 'claim_type', label: 'Type', render: (c) => <Badge tone="info">{c.claim_type}</Badge> },
    { key: 'txn_amount', label: 'Montant', align: 'right', render: (c) => <span className="num">{c.txn_amount ? fmtMoney(c.txn_amount) : '—'}</span> },
    { key: 'description', label: 'Description', render: (c) => <span className="small">{c.description}</span> },
    { key: 'status', label: 'Statut', render: (c) => <StatusBadge status={c.status} /> },
  ];
  return <Card flush title="Réclamations des porteurs" sub="50 dernières, lecture seule"><DataTable columns={cols} rows={list.data || []} keyField="claim_id" loading={list.loading} error={list.error} onRetry={list.reload} dense empty="Aucune réclamation" emptyIcon="flag" /></Card>;
}

function IncidentsTab() {
  const list = useQuery(() => supportApi.incidents().then((r) => r.data.data || []), []);
  const cols = [
    { key: 'detected_at', label: 'Détecté le', render: (i) => <span className="cell-date">{fmtDateTime(i.detected_at)}</span>, sortValue: (i) => i.detected_at },
    { key: 'incident_type', label: 'Type', render: (i) => <Badge tone="warn">{i.incident_type || i.type || '—'}</Badge> },
    { key: 'severity', label: 'Sévérité', render: (i) => i.severity || '—' },
    { key: 'description', label: 'Description', render: (i) => <span className="small">{i.description || i.title || '—'}</span> },
    { key: 'status', label: 'Statut', render: (i) => <StatusBadge status={i.status || 'open'} /> },
  ];
  return <Card flush title="Incidents" sub="50 derniers incidents détectés"><DataTable columns={cols} rows={list.data || []} keyField="incident_id" loading={list.loading} error={list.error} onRetry={list.reload} dense empty="Aucun incident" emptyIcon="alert" /></Card>;
}

export default function CardholdersPage() {
  const { get, set } = useUrlState({ tab: 'kyc' });
  const tab = get('tab');
  return (
    <div className="page">
      <PageHeader title="Porteurs de carte" subtitle="Revue KYC, réclamations et incidents des porteurs." badge={<Badge tone="warn">API partielle</Badge>} />
      <Callout tone="warn">La liste et la fiche des porteurs (cartes, transactions) ne sont pas exposées par l’API admin actuelle (aucune route GET /admin/cardholders). Les fonctions ci-dessous s’appuient sur les routes existantes ; la liste complète sera ajoutée lorsque le backend l’exposera.</Callout>
      <Tabs value={tab} onChange={(v) => set({ tab: v })} items={[{ value: 'kyc', label: 'Revue KYC', icon: 'idcard' }, { value: 'reclamations', label: 'Réclamations', icon: 'flag' }, { value: 'incidents', label: 'Incidents', icon: 'alert' }]} />
      {tab === 'kyc' && <KycInbox />}
      {tab === 'reclamations' && <ClaimsTab />}
      {tab === 'incidents' && <IncidentsTab />}
    </div>
  );
}
