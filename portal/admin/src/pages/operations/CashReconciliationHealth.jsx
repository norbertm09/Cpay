import React from 'react';
import { Button, Callout } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { cashApi } from '../../services/api';
import { fmtDateTime } from '../../utils/format';

export default function CashReconciliationHealth() {
  const health = useQuery(() => cashApi.reconciliationStatus().then(r => r.data), [], { interval: 60000 });
  const state = health.data;
  const unavailable = !!health.error || (!health.loading && typeof state?.enabled !== 'boolean');
  const failed = state?.consecutiveFailures > 0;
  return <Callout tone={unavailable || failed || state?.enabled === false ? 'warn' : 'info'}>
    {health.loading && !state ? 'Chargement du suivi du rapprochement…' : unavailable ? <div>Suivi du rapprochement indisponible. Les opérations restent consultables. <Button size="sm" onClick={health.reload}>Réessayer le suivi</Button></div> : <div>
      {!state.enabled ? <div>Rapprochement automatique désactivé.</div> : !state.scheduled ? <div>Rapprochement automatique non planifié.</div> : state.running ? <div>Rapprochement automatique en cours.</div> : <div>Rapprochement automatique planifié.</div>}
      {failed && <div>Dernier rapprochement incomplet ou en échec.</div>}
      <div className="small">{state.lastSuccessfulAt ? `Dernier rapprochement réussi : ${fmtDateTime(state.lastSuccessfulAt)}` : 'Aucun rapprochement réussi enregistré depuis le démarrage.'}</div>
    </div>}
  </Callout>;
}
