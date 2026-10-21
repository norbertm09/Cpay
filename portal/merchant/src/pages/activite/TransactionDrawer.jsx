import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { activityApi, cashApi } from '../../services/api';
import { Drawer, Button, Input, KVList, StatusBadge, Skeleton, Notice } from '../../components';
import { fmtMoney, fmtDateTime, fmtRelative, fmtPhone, phoneDigits } from '../../utils/format';
import { typeLabel, methodLabel, statusLabel, opLabel, CASH_IN_TYPES } from '../../utils/labels';
import { printDoc } from '../../utils/actions';
import { errorMessage } from '../../utils/errors';
import { TransferRecovery, transferNetValue } from '../caisse/TransferRecovery';
import { FundingInstructions } from '../caisse/shared';

// Détail d'une ligne du journal : transaction (encaissement, décaissement) ou
// transfert (retrait, wallet ↔ banque). Reçu imprimable, envoi par SMS.
export const TransactionDrawer = ({ row, currency, onClose }) => {
  const [detail, setDetail] = useState(null);
  const [kind, setKind] = useState(null); // transaction | transfer
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [sending, setSending] = useState(false);
  const cur = row.currency || currency;
  const isTransferType = row.type !== 'collect' && !/^[0-9a-f-]{36}$/i.test(String(row.reference || '')) && /^(PAY|TRF|FND)-/.test(String(row.reference || ''));

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setDetail(null);
    const asTransfer = () => cashApi.getTransfer(row.id).then(r => ({ kind: 'transfer', data: r.data }));
    const asTxn = () => activityApi.transaction(row.id).then(r => ({ kind: 'transaction', data: r.data }));
    const first = row.type === 'collect' ? asTxn : isTransferType ? asTransfer : () => asTransfer().catch(asTxn);
    first().catch(() => (row.type === 'collect' ? asTransfer() : asTxn())).then(r => { if (!cancelled) { setDetail(r.data); setKind(r.kind); } })
      .catch(() => { if (!cancelled) { setDetail({}); setKind(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [row.id, row.type, isTransferType]);

  const inn = CASH_IN_TYPES.includes(row.type);
  const t = detail || {};
  const rows = kind === 'transaction' ? [
    ['Date', fmtDateTime(t.initiated_at || row.createdAt)], ['Type', typeLabel(row.type)], ['Moyen', methodLabel(t.payment_method || row.method)], t.detected_operator && ['Opérateur', opLabel(t.detected_operator)],
    ['Montant', fmtMoney(t.amount ?? row.amount, cur)], ['Frais', fmtMoney(t.fee_amount ?? row.fee, cur)], ['Net', fmtMoney(t.net_amount ?? row.net, cur), { tone: 'success' }],
    ['Statut', statusLabel(t.status || row.status)], t.settlement_status && ['Règlement', statusLabel(t.settlement_status)], t.settled_at && ['Réglé le', fmtDateTime(t.settled_at)],
    t.auth_code && ['Code d’autorisation', t.auth_code, { mono: true }], ['Identifiant', t.transaction_id || row.id, { mono: true }], t.gateway_payment_id && ['Réf. opérateur', t.gateway_payment_id, { mono: true }], (t.gateway_order_id || row.reference) && ['Référence', t.gateway_order_id || row.reference, { mono: true }],
    (t.description || row.description) && ['Description', t.description || row.description], t.device_id && ['Terminal', t.device_id, { mono: true }],
  ] : kind === 'transfer' ? [
    ['Date', fmtDateTime(t.createdAt || row.createdAt)], ['Type', typeLabel(row.type)], ['Référence', t.reference || row.reference, { mono: true }],
    ['Montant', fmtMoney(t.amount ?? row.amount, cur)], t.fee != null && ['Frais', fmtMoney(t.fee, cur)], t.net != null && ['Net', transferNetValue({ ...t, status: t.status || row.status }, cur)],
    ['Statut', statusLabel(t.status || row.status)], t.wallet && ['Wallet', `${opLabel(t.wallet.operator)} ${fmtPhone(t.wallet.phone)}`], t.bankAccount && ['Compte', `${t.bankAccount.bankName || ''} ${t.bankAccount.accountMasked || ''}`],
    t.bankReference && ['Référence bancaire', t.bankReference, { mono: true }], t.completedAt && ['Terminé le', fmtDateTime(t.completedAt)], t.description && ['Libellé', t.description], t.errorMessage && ['Motif', t.errorMessage, { tone: 'error' }],
  ] : [
    ['Date', fmtDateTime(row.createdAt)], ['Type', typeLabel(row.type)], ['Référence', row.reference, { mono: true }], ['Montant', fmtMoney(row.amount, cur)], ['Frais', fmtMoney(row.fee, cur)], ['Net', ['withdraw', 'transfer_out', 'payout'].includes(row.type) ? transferNetValue(row, cur) : fmtMoney(row.net, cur)], ['Statut', statusLabel(row.status)], row.counterparty && ['Contrepartie', row.counterparty], row.method && ['Moyen', methodLabel(row.method)],
  ];
  const printRows = rows.filter(Boolean).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]);
  const sendSms = async () => {
    if (phoneDigits(phone).length < 8) { toast.error('Numéro invalide'); return; }
    setSending(true);
    try {
      const { data } = await activityApi.receiptSms({ txnId: row.id, phone: phone.trim(), amount: row.amount, reference: row.reference, type: typeLabel(row.type) });
      toast.success(data?.sent === false ? 'Passerelle SMS indisponible : reçu non envoyé' : 'Reçu envoyé par SMS'); setPhone('');
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSending(false); }
  };

  return (
    <Drawer title={typeLabel(row.type)} subtitle={`${fmtRelative(row.createdAt)} · ${fmtDateTime(row.createdAt)}`} onClose={onClose}
      footer={<><Button icon="print" onClick={() => printDoc(typeLabel(row.type), printRows)}>Imprimer le reçu</Button></>}>
      <div className="row-between mb-4">
        <span style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700 }} className={inn ? 'success' : ''}>{inn ? '+' : '−'} {fmtMoney(row.amount, cur)}</span>
        <StatusBadge status={t.status || row.status} />
      </div>
      {kind === 'transfer' && <TransferRecovery transfer={{ ...t, transferId: t.transferId || row.id }} onUpdated={setDetail} />}
      {loading ? <div className="stack"><Skeleton /><Skeleton /><Skeleton /><Skeleton /></div> : (<>
        {kind === 'transfer' && t.status === 'awaiting_funds' && t.instructions && <div className="mb-4"><FundingInstructions transfer={t} currency={cur} /></div>}
        <KVList boxed rows={rows} />
        {kind === null && <Notice tone="neutral" className="mt-3">Détail complet indisponible : informations du journal affichées.</Notice>}
      </>)}
      {row.type === 'collect' && (
        <div className="mt-5">
          <p className="field-label mb-2">Envoyer le reçu par SMS</p>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}><Input type="tel" inputMode="tel" value={phone} onChange={setPhone} placeholder="+237 6XX XXX XXX" aria-label="Numéro du client" /></div>
            <Button variant="brand" icon="send" onClick={sendSms} loading={sending} aria-label="Envoyer le reçu" />
          </div>
        </div>
      )}
    </Drawer>
  );
};
export default TransactionDrawer;
