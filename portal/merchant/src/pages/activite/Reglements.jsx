import React, { useState } from 'react';
import { activityApi } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { Card, PageHeader, Tabs, Table, Stat, StatusBadge, Drawer, KVList, Notice, Skeleton } from '../../components';
import { fmtMoney, fmtDate, fmtDayLong, fmtTime, fmtDateTime } from '../../utils/format';
import { methodLabel, opLabel } from '../../utils/labels';

// Règlements : par journée (transactions réglées) et par lot (settlement_batches).
export const Reglements = () => {
  const { user } = useAuth();
  const currency = user?.currency || 'XAF';
  const [tab, setTab] = useState('daily');
  const [day, setDay] = useState(null);
  const days = useAsync(() => activityApi.settlementsDaily(), []);
  const batches = useAsync(() => activityApi.settlements(), []);
  const dayDetail = useAsync(() => activityApi.settlementsDay(day), [day], { enabled: !!day });
  const list = batches.data?.data || [];
  const gross = list.reduce((a, s) => a + Number(s.total_gross || 0), 0);
  const fees = list.reduce((a, s) => a + Number(s.total_fees || 0), 0);
  const net = list.reduce((a, s) => a + Number(s.total_net || 0), 0);
  const pending = list.filter(s => ['pending', 'submitted', 'processing'].includes(s.status)).reduce((a, s) => a + Number(s.total_net || 0), 0);

  const dayCols = [
    { key: 'jour', label: 'Journée', mobile: 'title', render: d => <strong>{fmtDayLong(d.jour)}</strong> },
    { key: 'nb', label: 'Transactions', render: d => d.nb },
    { key: 'brut', label: 'Total brut', num: true, render: d => fmtMoney(d.total_brut, currency) },
    { key: 'net', label: 'Net versé', num: true, mobile: 'right', render: d => <strong className="success">{fmtMoney(d.total_net, currency)}</strong> },
  ];
  const batchCols = [
    { key: 'date', label: 'Date de règlement', mobile: 'title', render: s => <><strong>{fmtDate(s.batch_date)}</strong><div className="xs muted mono">{String(s.batch_id || '').slice(0, 8)}</div></> },
    { key: 'n', label: 'Transactions', render: s => s.txn_count },
    { key: 'type', label: 'Canal', render: s => s.settlement_type === 'bank' ? 'Virement bancaire' : s.settlement_type === 'mobile_money' ? 'Mobile Money' : (s.settlement_type || '—') },
    { key: 'gross', label: 'Volume encaissé', num: true, render: s => fmtMoney(s.total_gross, s.currency || currency) },
    { key: 'fees', label: 'Frais C-Pay', num: true, render: s => <span className="muted">− {fmtMoney(s.total_fees, s.currency || currency)}</span> },
    { key: 'net', label: 'Net versé', num: true, mobile: 'right', render: s => <strong className="success">{fmtMoney(s.total_net, s.currency || currency)}</strong> },
    { key: 'status', label: 'Statut', render: s => <StatusBadge status={s.status} /> },
  ];
  const txCols = [
    { key: 'h', label: 'Heure', mobile: 'title', render: t => <strong>{fmtTime(t.settled_at || t.initiated_at)}</strong> },
    { key: 'op', label: 'Moyen', render: t => t.detected_operator ? opLabel(t.detected_operator) : methodLabel(t.payment_method) },
    { key: 'a', label: 'Montant', num: true, render: t => fmtMoney(t.amount, currency) },
    { key: 'n', label: 'Net', num: true, mobile: 'right', render: t => <strong className="success">{fmtMoney(t.net_amount || t.amount, currency)}</strong> },
    { key: 'r', label: 'Réf. règlement', className: 'mono', render: t => <span className="xs">{t.settlement_ref || '—'}</span> },
  ];

  return (
    <div className="stack-lg">
      <PageHeader title="Règlements" subtitle="Reversement de vos encaissements validés, en règle générale à J+1 ouvré, sur le compte de règlement renseigné dans votre profil." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'daily', label: 'Par journée' }, { value: 'batch', label: 'Par lot' }]} />
      {tab === 'daily' && (
        <Card flush>
          <Table columns={dayCols} rows={days.data?.days || []} rowKey={d => d.jour} state={days.state} error={days.error} onRetry={days.reload} onRowClick={d => setDay(String(d.jour).slice(0, 10))}
            empty={{ title: 'Aucun règlement pour l’instant', message: 'Vos encaissements validés apparaîtront ici une fois reversés.' }} emptyIcon="bank" />
        </Card>
      )}
      {tab === 'batch' && (<>
        {batches.state === 'ok' && list.length > 0 && (
          <div className="stat-row">
            <Card><Stat label="Volume brut" value={fmtMoney(gross, currency)} /></Card>
            <Card><Stat label="Frais" value={fmtMoney(fees, currency)} hint={gross > 0 ? `${((fees / gross) * 100).toFixed(2).replace('.', ',')} % en moyenne` : undefined} /></Card>
            <Card><Stat label="Net reçu" value={fmtMoney(net, currency)} tone="success" /></Card>
            <Card><Stat label="En cours" value={fmtMoney(pending, currency)} tone="warn" /></Card>
          </div>
        )}
        <Card flush>
          <Table columns={batchCols} rows={list} rowKey={(s, i) => s.batch_id || i} state={batches.state} error={batches.error} onRetry={batches.reload}
            empty={{ title: 'Aucun lot de règlement', message: 'Les lots sont constitués chaque jour ouvré à partir des encaissements validés.' }} emptyIcon="bank" />
        </Card>
      </>)}
      {day && (
        <Drawer title={`Règlements du ${fmtDayLong(day)}`} onClose={() => setDay(null)} size="lg">
          {dayDetail.state === 'loading' ? <div className="stack"><Skeleton /><Skeleton /><Skeleton /></div> : dayDetail.state === 'ok' ? (<>
            <KVList boxed rows={[['Transactions', (dayDetail.data?.transactions || []).length], ['Total net', fmtMoney((dayDetail.data?.transactions || []).reduce((a, t) => a + Number(t.net_amount || t.amount || 0), 0), currency), { tone: 'success' }]]} />
            <div className="mt-4"><Table columns={txCols} rows={dayDetail.data?.transactions || []} rowKey={t => t.transaction_id} empty={{ title: 'Aucune transaction' }} /></div>
            {(dayDetail.data?.transactions || [])[0]?.settled_at && <p className="xs muted mt-3">Dernier règlement : {fmtDateTime(dayDetail.data.transactions[0].settled_at)}</p>}
          </>) : <Notice tone="error">Détail de la journée indisponible.</Notice>}
        </Drawer>
      )}
    </div>
  );
};
export default Reglements;
