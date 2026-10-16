import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAsync } from '../../hooks/useAsync';
import { useIsMobile } from '../../hooks/useMediaQuery';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Card, Button, Badge, Drawer, Select, Input, PageHeader, ListTable, SkeletonList, ErrorState, EmptyState, Icon } from '../../components';
import { TxnRowContent } from '../../components/TxnList';
import * as ops from '../../services/operations';
import { formatMoney, formatDateTime } from '../../utils/format';
import { txnMeta, txnStatus, txnTitle, txnFee, toCsv, OPERATORS } from '../../utils/txn';
import { FEATURES } from '../../utils/features';

const PAGE_SIZE = 20;
const TYPE_OPTIONS = [
  { value: '', label: 'Tous les types' }, { value: 'payment', label: 'Paiements' }, { value: 'topup', label: 'Rechargements' },
  { value: 'unload', label: 'Retraits' }, { value: 'refund', label: 'Remboursements' }, { value: 'fee', label: 'Frais' },
];
const STATUS_OPTIONS = [
  { value: '', label: 'Tous les statuts' }, { value: 'completed', label: 'Effectuées' }, { value: 'pending', label: 'En attente' },
  { value: 'failed', label: 'Échouées' }, { value: 'refunded', label: 'Remboursées' },
];

const download = (name, content, type = 'text/csv;charset=utf-8') => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export default function OperationsPage() {
  useDocumentTitle('Opérations');
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') || '';
  const status = params.get('status') || '';
  const page = Math.max(1, parseInt(params.get('page'), 10) || 1);
  const selectedId = params.get('op');
  const [search, setSearch] = useState('');

  const list = useAsync(() => ops.listTransactions({ page, limit: PAGE_SIZE, type: type || undefined, status: status || undefined }), [page, type, status]);
  const rows = list.data?.data || [];
  const total = list.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((t) => [txnTitle(t), t.description, t.auth_code, t.mm_reference, t.txn_id, String(t.amount)].some((v) => String(v || '').toLowerCase().includes(q)));
  }, [rows, search]);

  const selected = rows.find((t) => t.txn_id === selectedId) || null;
  const setParam = (k, v) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k !== 'page' && k !== 'op') p.delete('page'); setParams(p, { replace: true }); };

  useEffect(() => { if (selectedId && !list.loading && !selected && rows.length) setParam('op', ''); }, [selectedId, list.loading, selected, rows.length]);

  const columns = [
    { key: 'initiated_at', label: 'Date', render: (t) => <span className="nowrap">{formatDateTime(t.initiated_at)}</span> },
    { key: 'title', label: 'Libellé', render: (t) => (
      <span className="row">
        <span className={`li-icon ${txnMeta(t.type).tone}`} style={{ width: 32, height: 32, borderRadius: 10 }}><Icon name={txnMeta(t.type).icon} size={16} /></span>
        <span><span className="strong" style={{ display: 'block' }}>{txnTitle(t)}</span><span className="xs muted">{txnMeta(t.type).label}</span></span>
      </span>
    ) },
    { key: 'status', label: 'Statut', render: (t) => <Badge tone={txnStatus(t.status).tone}>{txnStatus(t.status).label}</Badge> },
    { key: 'amount', label: 'Montant', align: 'right', render: (t) => <span style={{ color: txnMeta(t.type).dir > 0 ? 'var(--success)' : undefined }}>{formatMoney(Number(t.amount) * txnMeta(t.type).dir, t.currency, { sign: true })}</span> },
  ];

  const meta = selected ? txnMeta(selected.type) : null;
  const st = selected ? txnStatus(selected.status) : null;
  const operatorLabel = (op) => OPERATORS.find((o) => o.value === op)?.label || op;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader title="Opérations" subtitle="Historique complet de vos paiements, rechargements et retraits."
        actions={(
          <>
            <Button variant="outline" icon="arrow-down-left" to="/operations/recharger" aria-label={FEATURES.topup ? 'Recharger' : 'Recharger (en cours d’intégration)'}>Recharger</Button>
            <Button variant="outline" icon="arrow-up-right" to="/operations/retirer" aria-label={FEATURES.unload ? 'Retirer' : 'Retirer (en cours d’intégration)'}>Retirer</Button>
            <Button variant="ghost" icon="download" onClick={() => download(`operations-cpay-page${page}.csv`, toCsv(filtered))} disabled={!filtered.length}>Exporter</Button>
          </>
        )} />

      <Card flush>
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <div className="filters grow">
            <Select aria-label="Type" value={type} onChange={(e) => setParam('type', e.target.value)} options={TYPE_OPTIONS} />
            <Select aria-label="Statut" value={status} onChange={(e) => setParam('status', e.target.value)} options={STATUS_OPTIONS} />
            <Input aria-label="Rechercher" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher sur cette page" prefixIcon="search" />
          </div>
          <span className="small muted nowrap">{total} opération{total > 1 ? 's' : ''}</span>
        </div>
        {list.loading ? <SkeletonList rows={6} />
          : list.error ? <ErrorState error={list.error} onRetry={list.reload} />
            : !filtered.length ? <EmptyState icon="receipt" title={rows.length ? 'Aucun résultat' : 'Aucune opération'}>{rows.length ? 'Modifiez votre recherche ou vos filtres.' : 'Vos opérations apparaîtront ici dès votre premier paiement.'}</EmptyState>
              : <ListTable columns={columns} rows={filtered} keyField="txn_id" isMobile={isMobile} onRowClick={(t) => setParam('op', t.txn_id)} mobileRender={(t) => <TxnRowContent txn={t} />} />}
        {pages > 1 ? (
          <div className="pager">
            <Button size="sm" variant="outline" icon="chevron-left" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>Précédent</Button>
            <span>Page {page} / {pages}</span>
            <Button size="sm" variant="outline" iconRight="chevron-right" disabled={page >= pages} onClick={() => setParam('page', String(page + 1))}>Suivant</Button>
          </div>
        ) : null}
      </Card>

      <Drawer open={!!selected} onClose={() => setParam('op', '')} title="Détail de l’opération"
        footer={selected ? (
          <>
            <Button variant="outline" icon="printer" onClick={() => window.print()}>Reçu</Button>
            <Button variant="ghost" icon="life-buoy" onClick={() => navigate(`/aide/reclamations?txn=${selected.txn_id}&amount=${selected.amount}&date=${encodeURIComponent(selected.initiated_at)}`)}>Signaler un problème</Button>
          </>
        ) : null}>
        {selected ? (
          <div className="stack" style={{ gap: 20 }}>
            <div className="center">
              <span className={`li-icon ${meta.tone}`} style={{ width: 56, height: 56, borderRadius: 18, margin: '0 auto 10px' }}><Icon name={meta.icon} size={26} /></span>
              <div className="rc-amount" style={{ fontSize: 28, fontWeight: 800 }}>{formatMoney(Number(selected.amount) * meta.dir, selected.currency, { sign: true })}</div>
              <div className="small text-2">{txnTitle(selected)}</div>
              <div style={{ marginTop: 6 }}><Badge tone={st.tone} dot>{st.label}</Badge></div>
            </div>
            <dl className="kv">
              <dt>Type</dt><dd>{meta.label}</dd>
              <dt>Date</dt><dd>{formatDateTime(selected.initiated_at)}</dd>
              {selected.completed_at ? <><dt>Finalisée le</dt><dd>{formatDateTime(selected.completed_at)}</dd></> : null}
              <dt>Montant</dt><dd>{formatMoney(selected.amount, selected.currency)}</dd>
              <dt>Frais</dt><dd>{formatMoney(txnFee(selected), selected.currency)}</dd>
              {selected.net_amount != null ? <><dt>Net</dt><dd>{formatMoney(selected.net_amount, selected.currency)}</dd></> : null}
              {selected.balance_after != null && Number(selected.balance_after) !== 0 ? <><dt>Solde après</dt><dd>{formatMoney(selected.balance_after, selected.currency)}</dd></> : null}
              {selected.merchant_name ? <><dt>Commerçant</dt><dd>{selected.merchant_name}</dd></> : null}
              {selected.mobile_money_op ? <><dt>Opérateur</dt><dd>{operatorLabel(selected.mobile_money_op)} {selected.mobile_money_phone ? `· ${selected.mobile_money_phone}` : ''}</dd></> : null}
              {selected.description ? <><dt>Description</dt><dd>{selected.description}</dd></> : null}
              {selected.auth_code ? <><dt>Autorisation</dt><dd className="mono">{selected.auth_code}</dd></> : null}
              {selected.mm_reference ? <><dt>Référence opérateur</dt><dd className="mono">{selected.mm_reference}</dd></> : null}
              {selected.failure_reason ? <><dt>Motif</dt><dd>{selected.failure_reason}</dd></> : null}
              <dt>Référence</dt><dd className="mono xs">{selected.txn_id}</dd>
            </dl>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
