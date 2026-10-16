import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { useAsync } from '../../hooks/useAsync';
import { Card, Button, Badge, ConfirmDialog, Alert, SkeletonList, ErrorState, EmptyState, Icon } from '../../components';
import * as cardsApi from '../../services/cards';
import { expiry } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { FEATURES } from '../../utils/features';

export default function ExternalCardsTab() {
  const enrolled = useAsync(cardsApi.listEnrolled, []);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  const setDefault = async (c) => {
    try { await cardsApi.setDefaultEnrolled(c.enrollmentId); toast.success('Carte par défaut mise à jour'); enrolled.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
  };
  const remove = async () => {
    setBusy(true);
    try { await cardsApi.removeEnrolled(removing.enrollmentId); toast.success('Carte retirée'); setRemoving(null); enrolled.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ gap: 24 }}>
      {!FEATURES.externalCardPayment ? (
        <Alert tone="info" title="Paiement par carte bancaire externe : en cours d’intégration">
          L’enregistrement de nouvelles cartes bancaires et le paiement avec ces cartes seront ouverts dès la mise en service de notre partenaire de paiement. Les cartes déjà enregistrées restent visibles ci-dessous.
        </Alert>
      ) : null}
      <Card flush title="Cartes bancaires enregistrées">
        {enrolled.loading ? <SkeletonList rows={2} />
          : enrolled.error ? <ErrorState error={enrolled.error} onRetry={enrolled.reload} />
            : !enrolled.data?.length ? <EmptyState icon="credit-card" title="Aucune carte externe">Aucune carte bancaire tierce n’est rattachée à votre compte.</EmptyState>
              : enrolled.data.map((c) => (
                <div className="list-item" key={c.enrollmentId}>
                  <span className="li-icon icon-neutral"><Icon name="credit-card" size={18} /></span>
                  <span className="li-main">
                    <span className="li-title mono">{c.cardMasked} <span style={{ textTransform: 'uppercase', fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-3)' }}>{c.network}</span></span>
                    <span className="li-sub">{c.cardholderName} · exp. {expiry(c.expiryMonth, c.expiryYear)} {c.isDefault ? <Badge tone="badge-info">Par défaut</Badge> : null}</span>
                  </span>
                  <span className="li-end row">
                    {!c.isDefault ? <Button size="sm" variant="ghost" onClick={() => setDefault(c)}>Par défaut</Button> : null}
                    <Button size="sm" variant="ghost" icon="trash" aria-label="Retirer cette carte" onClick={() => setRemoving(c)} />
                  </span>
                </div>
              ))}
      </Card>
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} loading={busy} danger title="Retirer cette carte ?" confirmLabel="Retirer"
        message={`La carte ${removing?.cardMasked || ''} ne sera plus associée à votre compte C-Pay.`} />
    </div>
  );
}
