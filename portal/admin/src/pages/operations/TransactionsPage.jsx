import React, { useEffect, useState } from 'react';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, FiltersBar, Select, Input, StatusBadge, Badge, Modal, Field, Callout } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { txnApi } from '../../services/api';
import { fmtMoney, fmtDateTime, fmtNumber, methodLabel, countryName } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';
import TransactionDrawer from './TransactionDrawer';
import { MerchantLink } from '../merchants/MerchantsPage';

const LIMIT = 25;

// Réconciliation manuelle des transactions pending : POST /reconcile (super_admin / ops_admin)
function ReconcileModal({ onClose, onDone }) {
  const [maxAgeHours, setMax] = useState('24');
  const [minAgeMinutes, setMin] = useState('5');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const run = async () => {
    setBusy(true);
    try { const { data } = await txnApi.reconcile({ maxAgeHours: Number(maxAgeHours), minAgeMinutes: Number(minAgeMinutes) }); setResult(data || {}); onDone?.(); }
    catch (e) { toast.error(errorMessage(e, 'Réconciliation impossible')); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Réconcilier les transactions en attente" onClose={busy ? undefined : onClose} size="sm"
      footer={result ? <Button variant="primary" onClick={onClose}>Fermer</Button> : <><Button onClick={onClose}>Annuler</Button><Button variant="primary" loading={busy} onClick={run}>Lancer</Button></>}>
      {result ? (
        <div className="stack">
          <Callout tone="success">Réconciliation terminée.</Callout>
          <div className="kv">
            <div>Examinées</div><div>{fmtNumber(result.scanned ?? result.checked ?? result.total)}</div>
            <div>Autorisées</div><div className="success">{fmtNumber(result.authorized ?? 0)}</div>
            <div>Échouées</div><div className="error">{fmtNumber(result.failed ?? 0)}</div>
            <div>Toujours en attente</div><div>{fmtNumber(result.still_pending ?? 0)}</div>
            <div>Ignorées / erreurs</div><div>{fmtNumber(result.skipped ?? 0)} / {fmtNumber(result.errors ?? 0)}</div>
          </div>
          {result.by_provider && <div className="code-block">{JSON.stringify(result.by_provider, null, 2)}</div>}
        </div>
      ) : (
        <div className="stack">
          <Callout tone="info">Interroge les opérateurs (MTN, Airtel, Orange, Wave, Africell, CyberSource…) pour les transactions restées en attente et met à jour leur statut. L’opération est tracée dans le journal d’audit.</Callout>
          <div className="form-grid">
            <Field label="Ancienneté maximale (heures)" hint="1 à 720"><Input type="number" min="1" max="720" value={maxAgeHours} onChange={setMax} /></Field>
            <Field label="Ancienneté minimale (minutes)" hint="Évite de concurrencer un webhook en vol"><Input type="number" min="0" max="1440" value={minAgeMinutes} onChange={setMin} /></Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function TransactionsPage() {
  const { hasRole } = useAuth();
  const { get, set, page, setPage } = useUrlState();
  const status = get('status'), type = get('type'), method = get('method'), merchantId = get('merchant_id'), openId = get('id');
  const [sel, setSel] = useState(null);
  const [reconcile, setReconcile] = useState(false);
  const list = useQuery(() => txnApi.list({ page, limit: LIMIT, status: status || undefined, type: type || undefined, method: method || undefined, merchant_id: merchantId || undefined }).then((r) => r.data), [page, status, type, method, merchantId]);
  useEffect(() => { if (openId) setSel({ transaction_id: openId }); }, [openId]);

  const cols = [
    { key: 'initiated_at', label: 'Date', render: (t) => <span className="cell-date">{fmtDateTime(t.initiated_at)}</span>, sortValue: (t) => t.initiated_at },
    { key: 'business_name', label: 'Marchand', render: (t) => <div><div className="cell-primary"><MerchantLink id={t.merchant_id} name={t.business_name} /></div><div className="cell-sub">{countryName(t.country)}</div></div> },
    { key: 'type', label: 'Type', render: (t) => <Badge tone={t.type === 'collect' ? 'success' : 'info'}>{t.type === 'collect' ? 'Encaissement' : t.type === 'payout' ? 'Retrait' : t.type}</Badge> },
    { key: 'payment_method', label: 'Méthode', render: (t) => <>{methodLabel(t.payment_method)}<div className="cell-sub">{t.detected_operator || t.detected_network || t.gateway_name || ''}</div></> },
    { key: 'amount', label: 'Montant', align: 'right', render: (t) => <span className="amount">{fmtMoney(t.amount, t.currency)}</span>, sortValue: (t) => Number(t.amount) },
    { key: 'fee_amount', label: 'Frais', align: 'right', hidden: true, render: (t) => <span className="num">{t.fee_amount ? fmtMoney(t.fee_amount, t.currency) : '—'}</span> },
    { key: 'net_amount', label: 'Net', align: 'right', render: (t) => <span className="num">{t.net_amount ? fmtMoney(t.net_amount, t.currency) : '—'}</span>, sortValue: (t) => Number(t.net_amount) },
    { key: 'status', label: 'Statut', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'settlement_status', label: 'Règlement', render: (t) => <StatusBadge status={t.settlement_status || 'non_regle'} /> },
    { key: 'auth_code', label: 'Autorisation', hidden: true, render: (t) => <span className="mono small">{t.auth_code || '—'}</span> },
  ];
  const hasActive = !!(status || type || method || merchantId);

  return (
    <div className="page">
      <PageHeader title="Transactions" badge={list.data?.total !== undefined && <Badge>{fmtNumber(list.data.total)}</Badge>} subtitle="Toutes les transactions de la plateforme. Cliquez sur une ligne pour le détail."
        actions={hasRole(PERMS.ops) && <Button variant="primary" icon="refresh" onClick={() => setReconcile(true)}>Réconcilier les transactions en attente</Button>} />
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <FiltersBar hasActive={hasActive} onReset={() => set({ status: '', type: '', method: '', merchant_id: '', page: '' })}>
            <Select value={status} onChange={(v) => set({ status: v, page: '' })} placeholder="Tous statuts" options={[{ value: 'authorized', label: 'Autorisées' }, { value: 'pending', label: 'En attente' }, { value: 'failed', label: 'Échouées' }, { value: 'reversed', label: 'Annulées' }]} aria-label="Statut" />
            <Select value={type} onChange={(v) => set({ type: v, page: '' })} placeholder="Tous types" options={[{ value: 'collect', label: 'Encaissement' }, { value: 'payout', label: 'Retrait' }]} aria-label="Type" />
            <Select value={method} onChange={(v) => set({ method: v, page: '' })} placeholder="Toutes méthodes" options={[{ value: 'mobile_money', label: 'Mobile Money' }, { value: 'card_nfc', label: 'Carte NFC' }, { value: 'card', label: 'Carte' }, { value: 'qr', label: 'QR code' }, { value: 'pay_link', label: 'Lien de paiement' }]} aria-label="Méthode" />
            {merchantId && <Button size="sm" icon="x" onClick={() => set({ merchant_id: '', page: '' })}>Marchand : {merchantId.slice(0, 8)}…</Button>}
            <div className="grow" />
            <Button size="sm" variant="ghost" icon="refresh" onClick={list.refresh} aria-label="Actualiser" />
          </FiltersBar>
        </div>
        <DataTable columns={cols} rows={list.data?.data || []} keyField="transaction_id" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} total={list.data?.total} onPage={setPage} onRowClick={setSel} columnTools storageKey="txns" empty="Aucune transaction pour ces critères" emptyIcon="swap" />
      </Card>
      {sel && <TransactionDrawer id={sel.transaction_id} initial={sel.amount !== undefined ? sel : null} onClose={() => { setSel(null); if (openId) set({ id: '' }); }} />}
      {reconcile && <ReconcileModal onClose={() => setReconcile(false)} onDone={list.refresh} />}
    </div>
  );
}
