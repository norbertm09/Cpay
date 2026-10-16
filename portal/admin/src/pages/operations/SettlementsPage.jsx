import React, { useState } from 'react';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, Tabs, Stat, Chips, StatusBadge, Badge, Modal, Field, Input, Textarea, Callout, ConfirmDialog, KeyValue } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { financeApi } from '../../services/api';
import { fmtMoney, fmtNumber, fmtDate, fmtDateTime, countryName } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';
import { MerchantLink } from '../merchants/MerchantsPage';

const LIMIT = 20;

// Lots de règlement J+1 (settlement_batches) : valider / rejeter, export CSV, lancement manuel.
function BatchesTab() {
  const { get, set, page, setPage } = useUrlState();
  const status = get('status'), merchantId = get('merchantId');
  const list = useQuery(() => financeApi.batches({ status: status || undefined, merchantId: merchantId || undefined, page, limit: LIMIT }).then((r) => r.data), [status, merchantId, page]);
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState(null); // 'validate' | 'reject'
  const [ref, setRef] = useState(''); const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(false);
  const summary = list.data?.summary || {};
  const act = async () => {
    setBusy(true);
    try {
      if (mode === 'validate') { await financeApi.validateBatch(sel.batch_id, { reference: ref, notes }); toast.success('Règlement validé'); }
      else { await financeApi.rejectBatch(sel.batch_id, notes); toast.success('Règlement rejeté'); }
      setSel(null); setMode(null); setRef(''); setNotes(''); list.refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const runSettlement = async () => {
    try { const { data } = await financeApi.runSettlement(); toast.success(data.message || 'Règlement J+1 exécuté'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); throw e; }
  };
  const exportCsv = async () => {
    try {
      const { data } = await financeApi.exportCsv();
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url; a.download = 'reglements.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  const cols = [
    { key: 'batch_date', label: 'Date du lot', render: (s) => fmtDate(s.batch_date), sortValue: (s) => s.batch_date },
    { key: 'business_name', label: 'Marchand', render: (s) => <div><div className="cell-primary"><MerchantLink id={s.merchant_id} name={s.business_name} /></div><div className="cell-sub mono">{s.settlement_account}</div></div> },
    { key: 'txn_count', label: 'Transactions', align: 'right', render: (s) => fmtNumber(s.txn_count) },
    { key: 'total_gross', label: 'Brut', align: 'right', render: (s) => <span className="num">{fmtMoney(s.total_gross, s.currency)}</span> },
    { key: 'total_fees', label: 'Frais', align: 'right', render: (s) => <span className="num">{fmtMoney(s.total_fees, s.currency)}</span> },
    { key: 'total_net', label: 'Net à verser', align: 'right', render: (s) => <span className="amount">{fmtMoney(s.total_net, s.currency)}</span>, sortValue: (s) => Number(s.total_net) },
    { key: 'status', label: 'Statut', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'completed_at', label: 'Versé le', render: (s) => <span className="cell-date">{fmtDateTime(s.completed_at)}</span> },
    { key: 'actions', label: '', sortable: false, render: (s) => (s.status === 'pending' || s.status === 'submitted') && <div className="row-actions"><Button size="xs" variant="primary" onClick={() => { setSel(s); setMode('validate'); }}>Valider</Button><Button size="xs" variant="danger-outline" onClick={() => { setSel(s); setMode('reject'); }}>Rejeter</Button></div> },
  ];
  return (
    <div className="stack-lg">
      <div className="grid grid-3">
        <Stat label="Lots (filtre courant)" value={fmtNumber(list.data?.total)} icon="receipt" small />
        <Stat label="Volume brut" value={fmtMoney(summary.total_gross)} icon="trending" tone="accent" small />
        <Stat label="Net à verser" value={fmtMoney(summary.total_net)} icon="banknote" tone="success" small />
      </div>
      <Card flush title="Lots de règlement J+1" actions={<>
        <Chips value={status} onChange={(v) => set({ status: v, page: '' })} items={[{ value: 'pending', label: 'En attente' }, { value: 'submitted', label: 'Soumis' }, { value: 'completed', label: 'Versés' }, { value: 'failed', label: 'Échoués' }]} />
        {merchantId && <Button size="sm" icon="x" onClick={() => set({ merchantId: '' })}>Marchand : {merchantId.slice(0, 8)}…</Button>}
        <Button size="sm" icon="download" onClick={exportCsv}>Export CSV</Button>
        <Button size="sm" icon="bolt" onClick={() => setRun(true)}>Lancer le règlement J+1</Button>
      </>}>
        <DataTable columns={cols} rows={list.data?.data || []} keyField="batch_id" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} total={list.data?.total} onPage={setPage} dense empty="Aucun lot de règlement" emptyIcon="receipt" />
      </Card>
      {sel && (
        <Modal title={mode === 'validate' ? 'Valider le règlement' : 'Rejeter le règlement'} sub={`${sel.business_name} · lot du ${fmtDate(sel.batch_date)}`} onClose={() => !busy && setSel(null)} size="sm"
          footer={<><Button onClick={() => setSel(null)} disabled={busy}>Annuler</Button><Button variant={mode === 'validate' ? 'success' : 'danger'} loading={busy} onClick={act} disabled={mode === 'reject' && notes.trim().length < 3}>{mode === 'validate' ? 'Valider' : 'Rejeter'}</Button></>}>
          <div className="stack">
            <KeyValue rows={[['Brut', fmtMoney(sel.total_gross, sel.currency)], ['Frais', fmtMoney(sel.total_fees, sel.currency)], ['Net', <b>{fmtMoney(sel.total_net, sel.currency)}</b>], ['Compte', <span className="mono">{sel.settlement_account}</span>], ['Transactions', fmtNumber(sel.txn_count)]]} />
            {mode === 'validate' ? <>
              <Field label="Référence du virement"><Input value={ref} onChange={setRef} placeholder="REF-VIREMENT-001" /></Field>
              <Field label="Notes"><Textarea value={notes} onChange={setNotes} rows={2} /></Field>
              <Callout tone="info">Le lot passe en « Versé » et l’action est tracée (journal PCI).</Callout>
            </> : <>
              <Callout tone="error">Le lot passe en « Échoué ». Indiquez le motif pour l’équipe.</Callout>
              <Field label="Motif" required><Textarea value={notes} onChange={setNotes} rows={3} /></Field>
            </>}
          </div>
        </Modal>
      )}
      {run && <ConfirmDialog title="Lancer le règlement J+1 maintenant" confirmLabel="Lancer" message="Exécute immédiatement le règlement automatique des transactions éligibles (normalement planifié chaque nuit)." onConfirm={runSettlement} onClose={() => setRun(false)} />}
    </div>
  );
}

// Virements bancaires en attente (merchant_transfers pending_settlement, legacy /transfer/payout)
function PayoutsTab() {
  const list = useQuery(() => financeApi.payouts('pending_settlement').then((r) => r.data), []);
  const summary = useQuery(() => financeApi.payoutsSummary().then((r) => r.data), []);
  const [sel, setSel] = useState(null); const [mode, setMode] = useState(null);
  const [ref, setRef] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const act = async () => {
    setBusy(true);
    try {
      if (mode === 'complete') { if (!ref.trim()) throw new Error('Référence bancaire requise'); await financeApi.completePayout(sel.transferId, { settlementRef: ref, note }); toast.success('Virement marqué effectué, marchand notifié'); }
      else { if (note.trim().length < 3) throw new Error('Motif requis'); await financeApi.rejectPayout(sel.transferId, note); toast.success('Retrait rejeté, solde marchand recrédité'); }
      setSel(null); setMode(null); setRef(''); setNote(''); list.refresh(); summary.refresh();
    } catch (e) { toast.error(e.response ? errorMessage(e) : e.message); } finally { setBusy(false); }
  };
  const cols = [
    { key: 'createdAt', label: 'Demandé le', render: (t) => <span className="cell-date">{fmtDateTime(t.createdAt)}</span>, sortValue: (t) => t.createdAt },
    { key: 'reference', label: 'Référence', render: (t) => <span className="mono strong">{t.reference}</span> },
    { key: 'merchant', label: 'Marchand', render: (t) => <div><div className="cell-primary">{t.merchant}</div><div className="cell-sub">{t.merchantEmail}</div></div> },
    { key: 'bank', label: 'Banque', render: (t) => <div>{t.bank} <span className="muted small">{countryName(t.country)}</span><div className="cell-sub mono">{t.accountNumber} · {t.accountName}</div></div> },
    { key: 'amount', label: 'Montant', align: 'right', render: (t) => <span className="num">{fmtMoney(t.amount)}</span> },
    { key: 'net', label: 'Net à virer', align: 'right', render: (t) => <span className="amount">{fmtMoney(t.net)}</span>, sortValue: (t) => Number(t.net) },
    { key: 'status', label: 'Statut', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'actions', label: '', sortable: false, render: (t) => <div className="row-actions"><Button size="xs" variant="primary" onClick={() => { setSel(t); setMode('complete'); }}>Virement effectué</Button><Button size="xs" variant="danger-outline" onClick={() => { setSel(t); setMode('reject'); }}>Rejeter</Button></div> },
  ];
  return (
    <div className="stack-lg">
      <div className="grid grid-4">
        <Stat label="Retraits en attente" value={fmtNumber(summary.data?.pending)} icon="clock" tone={summary.data?.pending ? 'warn' : ''} small />
        <Stat label="Montant à virer" value={fmtMoney(summary.data?.pendingAmount)} icon="banknote" tone="accent" small />
        <Stat label="Retraits traités" value={fmtNumber(summary.data?.completed)} icon="check" tone="success" small />
        <Stat label="Montant traité" value={fmtMoney(summary.data?.completedAmount)} icon="receipt" small />
      </div>
      <Callout tone="info">Retraits bancaires de l’ancien parcours (statut <span className="mono">pending_settlement</span>). Les virements de la caisse (vague 4) se traitent dans <b>Opérations → Caisse</b>, qui couvre aussi ces statuts.</Callout>
      <Card flush title="Virements bancaires à effectuer">
        <DataTable columns={cols} rows={list.data?.data || []} keyField="transferId" loading={list.loading} error={list.error} onRetry={list.reload} dense empty="Aucun retrait bancaire en attente" emptyIcon="check" />
      </Card>
      {sel && (
        <Modal title={mode === 'complete' ? 'Confirmer le virement' : 'Rejeter le retrait'} sub={`${sel.reference} · ${sel.merchant}`} onClose={() => !busy && setSel(null)} size="sm"
          footer={<><Button onClick={() => setSel(null)} disabled={busy}>Annuler</Button><Button variant={mode === 'complete' ? 'success' : 'danger'} loading={busy} onClick={act}>{mode === 'complete' ? 'Marquer effectué' : 'Rejeter'}</Button></>}>
          <div className="stack">
            <KeyValue rows={[['Net à virer', <b>{fmtMoney(sel.net)}</b>], ['Banque', sel.bank], ['Compte', <span className="mono">{sel.accountNumber}</span>], ['Intitulé', sel.accountName]]} />
            {mode === 'complete' ? <>
              <Field label="Référence bancaire" required><Input value={ref} onChange={setRef} /></Field>
              <Field label="Note interne"><Input value={note} onChange={setNote} /></Field>
              <Callout tone="info">Le marchand reçoit un e-mail de confirmation avec la référence.</Callout>
            </> : <>
              <Callout tone="error">Le retrait passe en « Échoué » et le net est recrédité sur le solde du marchand.</Callout>
              <Field label="Motif" required><Textarea value={note} onChange={setNote} rows={3} /></Field>
            </>}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function SettlementsPage() {
  const { get, set } = useUrlState({ tab: 'lots' });
  const tab = get('tab');
  return (
    <div className="page">
      <PageHeader title="Règlements" subtitle="Lots de règlement J+1 des marchands et virements bancaires en attente." badge={<Badge tone="success">Finance</Badge>} />
      <Tabs value={tab} onChange={(v) => set({ tab: v, page: '', status: '' })} items={[{ value: 'lots', label: 'Lots de règlement', icon: 'receipt' }, { value: 'virements', label: 'Virements en attente', icon: 'bank' }]} />
      {tab === 'lots' ? <BatchesTab /> : <PayoutsTab />}
    </div>
  );
}
