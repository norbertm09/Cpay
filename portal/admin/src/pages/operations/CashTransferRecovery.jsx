import React from 'react';
import { Badge, Callout } from '../../components/ui';
import { fmtDateTime } from '../../utils/format';

export const hasUncertainOutcome = (transfer) => ['unknown', 'processing'].includes(transfer.status);

// Provider status checks describe evidence; they never authorize another payout.
export default function CashTransferRecovery({ transfer, compact = false }) {
  const uncertain = hasUncertainOutcome(transfer);
  if (!uncertain && !transfer.needsReview && !transfer.unknownSince && !transfer.lastStatusCheckAt) return null;
  return <div className={compact ? 'small mt-2' : 'stack'}>
    {uncertain && (compact ? <div className="strong">Fonds réservés · paiement non confirmé.</div> : <Callout tone="warn">Fonds réservés : paiement non confirmé. Attendez la confirmation de la banque ou de l’opérateur avant de considérer les fonds comme versés. Aucun nouveau paiement ne doit être émis pour remplacer cette opération.</Callout>)}
    {transfer.needsReview && <Badge tone="warn">Examen requis</Badge>}
    {transfer.unknownSince && <div className="xs muted">Issue inconnue depuis : {fmtDateTime(transfer.unknownSince)}</div>}
    {(uncertain || transfer.lastStatusCheckAt) && <div className="xs muted">Dernier contrôle du statut : {transfer.lastStatusCheckAt ? fmtDateTime(transfer.lastStatusCheckAt) : 'Pas encore contrôlé'}</div>}
  </div>;
}
