import React from 'react';
import { Link } from 'react-router-dom';
import { Drawer, KeyValue, StatusBadge, Skeleton, ErrorState, CopyButton, Badge } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { txnApi } from '../../services/api';
import { fmtMoney, fmtDateTime, methodLabel, countryName } from '../../utils/format';

// Détail d'une transaction : GET /transactions/:id (ligne SQL + business_name).
export default function TransactionDrawer({ id, initial, onClose }) {
  const { data, loading, error, reload } = useQuery(() => txnApi.get(id).then((r) => r.data), [id]);
  const t = data || initial;
  return (
    <Drawer title={t ? `${fmtMoney(t.amount, t.currency)} · ${t.type === 'collect' ? 'Encaissement' : t.type === 'payout' ? 'Retrait' : t.type || 'Transaction'}` : 'Transaction'}
      sub={t ? <span className="mono">{t.transaction_id}</span> : null} onClose={onClose}>
      {!t && loading ? <Skeleton lines={8} /> : !t ? <ErrorState error={error} onRetry={reload} /> : (
        <div className="stack-lg">
          <div className="row-wrap">
            <StatusBadge status={t.status} />
            {t.settlement_status && <StatusBadge status={t.settlement_status} />}
            {t.payment_method && <Badge tone="info">{methodLabel(t.payment_method)}</Badge>}
            <CopyButton value={t.transaction_id} label="Copier l’identifiant" />
          </div>
          <KeyValue rows={[
            ['Marchand', t.merchant_id ? <Link to={`/marchands/${t.merchant_id}`}>{t.business_name || t.merchant_id}</Link> : t.business_name],
            ['Montant', fmtMoney(t.amount, t.currency)],
            ['Frais', t.fee_amount ? fmtMoney(t.fee_amount, t.currency) : '—'],
            ['Net marchand', t.net_amount ? fmtMoney(t.net_amount, t.currency) : '—'],
            ['Opérateur / réseau', [t.detected_operator, t.detected_network].filter(Boolean).join(' · ') || '—'],
            ['Passerelle', t.gateway_name],
            ['Pays détecté', countryName(t.detected_country || t.country)],
            ['Référence opérateur', t.gateway_reference || t.operator_reference || t.external_reference],
            ['Code d’autorisation', t.auth_code ? <span className="mono">{t.auth_code}</span> : '—'],
            ['Terminal', t.device_id || t.terminal_id],
            ['Description', t.description],
            ['Initiée le', fmtDateTime(t.initiated_at)],
            ['Terminée le', fmtDateTime(t.completed_at)],
            ['Réglée le', fmtDateTime(t.settled_at)],
            t.error_message || t.failure_reason ? ['Erreur', <span className="error">{t.error_message || t.failure_reason}</span>] : null,
          ]} />
          <div className="callout callout-info"><span>Le remboursement automatique n’est pas disponible sur la plateforme : un remboursement se fait auprès de l’opérateur, puis se trace dans un ticket de support.</span></div>
        </div>
      )}
    </Drawer>
  );
}
