import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cashApi } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { Button, KV, Notice } from '../../components';
import { fmtDateTime, fmtMoney } from '../../utils/format';
import { TRANSFER_STATUS_HELP } from '../../utils/labels';

export const transferNetValue = (transfer, currency) => transfer.status === 'completed'
  ? fmtMoney(transfer.net, currency)
  : ['failed', 'rejected', 'cancelled', 'expired'].includes(transfer.status) ? 'Non envoyé' : 'À confirmer';

// Refresh the existing resource, including when an idempotency replay returns
// an older creation response. This component never starts a payment.
export const TransferRecovery = ({ transfer, onUpdated }) => {
  const { user } = useAuth();
  const id = transfer.transferId || transfer.id || transfer.withdrawalId;
  const scope = JSON.stringify([id, user?.merchantId, user?.userId]);
  const generation = useRef(null);
  if (generation.current?.scope !== scope) generation.current = { scope, busy: false };
  const current = generation.current;
  const latest = useRef({ transfer, onUpdated });
  latest.current = { transfer, onUpdated };
  const [view, setView] = useState(null);
  const checking = view?.scope === scope && view.checking;
  const error = view?.scope === scope ? view.error : null;
  const refresh = useCallback(async () => {
    if (!id || current.busy || generation.current !== current) return;
    current.busy = true; setView({ scope: current.scope, checking: true, error: null });
    try {
      const { data } = await cashApi.getTransfer(id);
      if (generation.current !== current) return;
      latest.current.onUpdated({ ...latest.current.transfer, ...data });
    } catch (_) {
      if (generation.current === current) setView({ scope: current.scope, checking: false, error: 'Vérification indisponible. Réessayez pour actualiser ce même ordre.' });
    } finally {
      current.busy = false;
      if (generation.current === current) setView(previous => previous?.scope === current.scope ? { ...previous, checking: false } : previous);
    }
  }, [id, current]);
  useEffect(() => {
    generation.current = current;
    return () => { if (generation.current === current) generation.current = null; };
  }, [current]);
  useEffect(() => {
    if (['unknown', 'processing'].includes(transfer.status)) refresh();
  }, [current, refresh, transfer.status]);
  const uncertain = ['unknown', 'processing'].includes(transfer.status);
  return <div className="mb-4">
    {TRANSFER_STATUS_HELP[transfer.status] && <Notice tone={uncertain ? 'warn' : 'info'}>{TRANSFER_STATUS_HELP[transfer.status]}</Notice>}
    {uncertain && <Notice tone="warn">Créer une nouvelle opération déclenche un paiement distinct et peut créer un doublon. Actualisez cet ordre avant de recommencer.</Notice>}
    {uncertain && transfer.unknownSince && <KV label="Résultat incertain depuis" value={fmtDateTime(transfer.unknownSince)} />}
    {transfer.lastStatusCheckAt && <KV label="Dernière vérification" value={fmtDateTime(transfer.lastStatusCheckAt)} />}
    {uncertain && transfer.needsReview && <Notice tone="warn">Revue par les opérations Cpay nécessaire. Les fonds restent réservés jusqu’à confirmation du résultat.</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
    {id && <Button size="sm" icon="refresh" onClick={refresh} loading={checking}>Actualiser le statut</Button>}
  </div>;
};
