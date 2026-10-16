import React from 'react';
import Icon from './Icon';
import Badge from './Badge';
import { formatMoney, formatDateTime } from '../utils/format';
import { txnMeta, txnStatus, txnTitle } from '../utils/txn';

/** Contenu d'une ligne d'operation (icone, libelle, montant, statut). */
export function TxnRowContent({ txn }) {
  const meta = txnMeta(txn.type);
  const st = txnStatus(txn.status);
  const failed = ['failed', 'declined', 'cancelled'].includes(txn.status);
  return (
    <>
      <span className={`li-icon ${failed ? 'icon-error' : meta.tone}`}><Icon name={meta.icon} size={18} /></span>
      <span className="li-main">
        <span className="li-title truncate">{txnTitle(txn)}</span>
        <span className="li-sub">{formatDateTime(txn.initiated_at)} · {meta.label}</span>
      </span>
      <span className="li-end">
        <span className="li-amount" style={{ color: failed ? 'var(--text-3)' : meta.dir > 0 ? 'var(--success)' : 'var(--text)', textDecoration: failed ? 'line-through' : 'none' }}>
          {formatMoney(Number(txn.amount) * meta.dir, txn.currency, { sign: true })}
        </span>
        <Badge tone={st.tone}>{st.label}</Badge>
      </span>
    </>
  );
}

/** Ligne d'operation compacte (accueil, mobile). */
export function TxnRow({ txn, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return <Tag className="list-item" type={onClick ? 'button' : undefined} onClick={onClick}><TxnRowContent txn={txn} /></Tag>;
}

export default function TxnList({ txns, onSelect }) {
  return <div className="list">{txns.map((t) => <TxnRow key={t.txn_id} txn={t} onClick={onSelect ? () => onSelect(t) : undefined} />)}</div>;
}
