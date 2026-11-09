import React, { useState } from 'react';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, Stat, Chips, StatusBadge, Badge, Modal, Field, Textarea, Callout, KeyValue } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { merchantsApi } from '../../services/api';
import { fmtMoney, fmtNumber, fmtDate, fmtDateTime, countryName } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';
import { MerchantLink } from './MerchantsPage';

const LIMIT = 50;
// Statuts de account_deletion_requests (migration 014) : pending → processed | rejected | cancelled (par le marchand)
const STATUS_MAP = {
  pending: { label: 'À traiter', tone: 'warn' },
  processed: { label: 'Compte fermé', tone: 'success' },
  rejected: { label: 'Refusée', tone: 'error' },
  cancelled: { label: 'Annulée par le marchand', tone: 'neutral' },
};
const CHANNELS = { app: 'Application', web: 'Formulaire web', support: 'Support', android: 'Android', expo: 'Mobile' };

// Demandes de suppression de compte marchand (lot 4 : exigence Google Play / App Store ; lot 7 : traitement
// depuis le back-office). Le traitement `processed` désactive les utilisateurs, suspend le marchand et révoque les
// sessions côté API ; `rejected` conserve le compte et exige un motif communiqué au marchand.
export default function AccountDeletionsPage() {
  const { get, set, page, setPage } = useUrlState({ status: 'pending' });
  const status = get('status');
  const list = useQuery(() => merchantsApi.deletionRequests({ status: status || 'all', page, limit: LIMIT }).then((r) => r.data), [status, page]);
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState(null); // 'processed' | 'rejected'
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = list.data?.data || [];
  const pendingCount = status === 'pending' ? rows.length : null;
  const close = () => { if (!busy) { setSel(null); setMode(null); setNote(''); } };
  const act = async () => {
    setBusy(true);
    try {
      await merchantsApi.processDeletion(sel.requestId, { status: mode, note: note.trim() || undefined });
      toast.success(mode === 'processed' ? 'Compte fermé : utilisateurs désactivés, marchand suspendu, sessions révoquées' : 'Demande refusée, compte conservé');
      setSel(null); setMode(null); setNote(''); list.refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const retractOver = (r) => r.retractUntil && new Date(r.retractUntil).getTime() <= Date.now();
  const cols = [
    { key: 'requestedAt', label: 'Demandée le', render: (r) => <span className="cell-date">{fmtDateTime(r.requestedAt)}</span>, sortValue: (r) => r.requestedAt },
    { key: 'businessName', label: 'Marchand', render: (r) => <div><div className="cell-primary"><MerchantLink id={r.merchantId} name={r.businessName} /></div><div className="cell-sub">{countryName(r.country)} · {CHANNELS[r.channel] || r.channel || '—'}</div></div> },
    { key: 'reason', label: 'Motif du marchand', render: (r) => <span className="cell-sub">{r.reason || '—'}</span> },
    { key: 'balanceAtRequest', label: 'Solde à la demande', align: 'right', render: (r) => <span className="num">{r.balanceAtRequest == null ? '—' : fmtMoney(r.balanceAtRequest, r.currency)}</span>, sortValue: (r) => Number(r.balanceAtRequest || 0) },
    { key: 'retractUntil', label: 'Rétractation jusqu’au', render: (r) => r.status === 'pending' ? <span className={retractOver(r) ? 'cell-date' : 'cell-date text-muted'}>{fmtDate(r.retractUntil)}{!retractOver(r) && <Badge tone="info">délai en cours</Badge>}</span> : '—' },
    { key: 'status', label: 'Statut', render: (r) => <StatusBadge status={r.status} map={STATUS_MAP} /> },
    { key: 'processedAt', label: 'Traitée le', render: (r) => <span className="cell-date">{fmtDateTime(r.processedAt)}</span> },
    { key: 'actions', label: '', sortable: false, render: (r) => r.status === 'pending' && (
      <div className="row-actions">
        <Button size="xs" variant="danger-outline" onClick={() => { setSel(r); setMode('processed'); }}>Fermer le compte</Button>
        <Button size="xs" onClick={() => { setSel(r); setMode('rejected'); }}>Refuser</Button>
      </div>
    ) },
  ];
  return (
    <div className="stack-lg">
      <PageHeader title="Demandes de suppression de compte" subtitle="Demandes déposées depuis les applications ou la page c-pay.global/legal/suppression-compte. Délai de rétractation de 30 jours avant fermeture." badge={<Badge tone="info">Opérations</Badge>} />
      <div className="grid grid-3">
        <Stat label="À traiter (page courante)" value={pendingCount == null ? '—' : fmtNumber(pendingCount)} icon="shield" tone="warn" small />
        <Stat label="Délai de rétractation" value="30 jours" icon="calendar" small />
        <Stat label="Fermeture = suspension" value="utilisateurs désactivés" icon="users" tone="accent" small />
      </div>
      <Callout tone="info">Attendre la fin du délai de rétractation sauf demande explicite du marchand. Un solde non nul doit être reversé avant la fermeture (Caisse → virement) : la fermeture ne déclenche aucun paiement.</Callout>
      <Card flush title="Demandes" actions={<Chips value={status} onChange={(v) => set({ status: v || 'all', page: '' })} items={[{ value: 'pending', label: 'À traiter' }, { value: 'processed', label: 'Comptes fermés' }, { value: 'rejected', label: 'Refusées' }, { value: 'cancelled', label: 'Annulées' }]} />}>
        <DataTable columns={cols} rows={rows} keyField="requestId" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} total={rows.length < LIMIT ? (page - 1) * LIMIT + rows.length : undefined} onPage={setPage} dense empty="Aucune demande" emptyIcon="shield" />
      </Card>
      {sel && (
        <Modal title={mode === 'processed' ? 'Fermer le compte marchand' : 'Refuser la demande'} sub={`${sel.businessName || sel.merchantId} · demande du ${fmtDate(sel.requestedAt)}`} onClose={close} size="sm"
          footer={<><Button onClick={close} disabled={busy}>Annuler</Button><Button variant={mode === 'processed' ? 'danger' : 'primary'} loading={busy} onClick={act} disabled={mode === 'rejected' && note.trim().length < 3}>{mode === 'processed' ? 'Fermer le compte' : 'Refuser'}</Button></>}>
          <div className="stack">
            <KeyValue rows={[['Motif', sel.reason || '—'], ['Canal', CHANNELS[sel.channel] || sel.channel || '—'], ['Solde à la demande', sel.balanceAtRequest == null ? '—' : fmtMoney(sel.balanceAtRequest, sel.currency)], ['Rétractation jusqu’au', fmtDate(sel.retractUntil)], ['E-mail', sel.email || '—']]} />
            {mode === 'processed' ? <>
              {!retractOver(sel) && <Callout tone="warn">Le délai de rétractation n’est pas écoulé : ne fermer que sur demande explicite et vérifiée du marchand.</Callout>}
              {Number(sel.balanceAtRequest) > 0 && <Callout tone="warn">Solde non nul à la demande : vérifier qu’il a été reversé.</Callout>}
              <Callout tone="error">Irréversible depuis le portail : les utilisateurs sont désactivés, le marchand passe en statut suspendu et toutes les sessions sont révoquées. Les données comptables sont conservées (obligations légales).</Callout>
              <Field label="Note interne (facultative)"><Textarea value={note} onChange={setNote} rows={2} aria-label="Note" /></Field>
            </> : <>
              <Field label="Motif du refus (communiqué au marchand)" required><Textarea value={note} onChange={setNote} rows={3} aria-label="Motif du refus" placeholder="Ex. : litige en cours, solde à régulariser…" /></Field>
            </>}
          </div>
        </Modal>
      )}
    </div>
  );
}
