import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { cashApi } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { usePagination } from '../../hooks/usePagination';
import { Button, Card, PageHeader, Input, Select, Stat, Table, StatusBadge, Pagination, FeatureUnavailable, Icon } from '../../components';
import { fmtMoney, fmtDateTime, fmtRelative, isoDay, daysAgo } from '../../utils/format';
import { CASH_TYPES, CASH_IN_TYPES, typeLabel, methodLabel, statusLabel } from '../../utils/labels';
import { downloadBlob } from '../../utils/actions';
import { errorMessage } from '../../utils/errors';
import { TransactionDrawer } from './TransactionDrawer';

const PAGE = 25;
const PRESETS = [['7 jours', 6], ['30 jours', 29], ['Ce mois', 'month'], ['90 jours', 89]];

// Journal unifié : encaissements, retraits et transferts (GET /cash/history), export CSV.
export const Journal = () => {
  const { user } = useAuth();
  const currency = user?.currency || 'XAF';
  const [from, setFrom] = useState(isoDay(daysAgo(29)));
  const [to, setTo] = useState(isoDay());
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [exporting, setExporting] = useState(false);
  const [detail, setDetail] = useState(null);
  const pager = usePagination(PAGE);
  const params = { limit: PAGE, offset: pager.offset, ...(from && { from }), ...(to && { to }), ...(type && { type }) };
  const hist = useAsync(() => cashApi.history(params).then(r => { pager.setTotal(r.data?.total || 0); return r; }), [from, to, type, pager.offset]);
  const setFilter = (fn) => (v) => { fn(v); pager.reset(); };
  const preset = (p) => { if (p === 'month') { const d = new Date(); setFrom(isoDay(new Date(d.getFullYear(), d.getMonth(), 1))); } else setFrom(isoDay(daysAgo(p))); setTo(isoDay()); pager.reset(); };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await cashApi.exportHistoryCsv({ ...(from && { from }), ...(to && { to }), ...(type && { type }) });
      downloadBlob(r.data instanceof Blob ? r.data : new Blob([r.data], { type: 'text/csv;charset=utf-8' }), `journal-caisse-${from || 'debut'}_${to || 'fin'}.csv`);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setExporting(false); }
  };

  const all = hist.data?.data || [];
  const rows = all.filter(r => (!status || r.status === status) && (!q || `${r.reference || ''} ${r.counterparty || ''} ${r.description || ''}`.toLowerCase().includes(q.toLowerCase())));
  const totals = hist.data?.totals || {};
  const inn = (r) => CASH_IN_TYPES.includes(r.type);
  const columns = [
    { key: 'op', label: 'Opération', mobile: 'title', render: r => <div className="row"><span className={`op-ic ${inn(r) ? 'op-in' : 'op-out'}`} style={{ width: 30, height: 30, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: inn(r) ? 'var(--success-50)' : 'var(--warn-50)', color: inn(r) ? 'var(--success)' : 'var(--warn)' }}><Icon name={inn(r) ? 'arrowDown' : 'arrowUp'} size={16} /></span><div><div className="strong">{typeLabel(r.type)}</div><div className="xs muted">{r.counterparty || methodLabel(r.method)}</div></div></div> },
    { key: 'date', label: 'Date', render: r => <><div>{fmtDateTime(r.createdAt)}</div><div className="xs muted">{fmtRelative(r.createdAt)}</div></> },
    { key: 'ref', label: 'Référence', className: 'mono', render: r => <span className="xs">{r.reference || '—'}</span> },
    { key: 'amount', label: 'Montant', num: true, mobile: 'right', render: r => <><div className={`strong ${inn(r) ? 'success' : ''}`}>{inn(r) ? '+' : '−'} {fmtMoney(r.amount, r.currency || currency)}</div>{Number(r.fee) > 0 && <div className="xs muted">frais {fmtMoney(r.fee, r.currency || currency)}</div>}</> },
    { key: 'status', label: 'Statut', render: r => <StatusBadge status={r.status} /> },
  ];
  if (hist.state === 'unavailable') return <div><PageHeader title="Journal" /><FeatureUnavailable title="Journal de caisse" /></div>;
  const statuses = Array.from(new Set(all.map(r => r.status)));

  return (
    <div className="stack-lg">
      <PageHeader title="Journal" subtitle="Encaissements, retraits et transferts, en un seul endroit. Les totaux portent sur la période filtrée."
        actions={<Button icon="download" onClick={exportCsv} loading={exporting} disabled={hist.state !== 'ok'}>Exporter en CSV</Button>} />
      <Card>
        <div className="chips mb-4" role="group" aria-label="Périodes rapides">{PRESETS.map(([l, p]) => <button key={l} type="button" className="chip" onClick={() => preset(p)}>{l}</button>)}</div>
        <div className="filters">
          <Input label="Du" type="date" value={from} onChange={setFilter(setFrom)} max={to || undefined} />
          <Input label="Au" type="date" value={to} onChange={setFilter(setTo)} min={from || undefined} />
          <Select label="Type" value={type} onChange={setFilter(setType)} options={[{ value: '', label: 'Tous les types' }, ...Object.entries(CASH_TYPES).map(([v, l]) => ({ value: v, label: l }))]} />
          <Select label="Statut (page)" value={status} onChange={setStatus} options={[{ value: '', label: 'Tous' }, ...statuses.map(s => ({ value: s, label: statusLabel(s) }))]} />
          <Input label="Recherche (page)" type="search" value={q} onChange={setQ} placeholder="Référence, contrepartie…" />
        </div>
      </Card>
      <div className="stat-row">
        <Card><Stat label="Entrées" value={fmtMoney(totals.in, currency)} tone="success" hint="encaissements et approvisionnements" /></Card>
        <Card><Stat label="Sorties" value={fmtMoney(totals.out, currency)} tone="warn" hint="retraits et transferts" /></Card>
        <Card><Stat label="Solde de la période" value={fmtMoney((Number(totals.in) || 0) - (Number(totals.out) || 0), currency)} tone="primary" hint={`${hist.data?.total || 0} opération(s)`} /></Card>
      </div>
      <Card flush>
        <Table columns={columns} rows={rows} rowKey={r => r.id} state={hist.state} error={hist.error} onRetry={hist.reload} onRowClick={setDetail} skeletonRows={8}
          empty={{ title: 'Aucune opération sur la période', message: 'Modifiez les filtres ou encaissez votre première vente.' }} emptyIcon="book"
          footer={<Pagination pager={pager} unit="opération" />} />
      </Card>
      {detail && <TransactionDrawer row={detail} currency={currency} onClose={() => setDetail(null)} />}
    </div>
  );
};
export default Journal;
