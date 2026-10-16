import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { useAsync } from '../../hooks/useAsync';
import { Card, Button, Badge, Drawer, Modal, Input, AmountInput, ConfirmDialog, VirtualCard, Alert, Skeleton, ErrorState, EmptyState, FeatureDisabled, Icon } from '../../components';
import PinModal from './PinModal';
import { gtp } from '../../services/cards';
import { formatMoney, formatDate } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { cardStatus } from '../../utils/txn';
import { FEATURES } from '../../utils/features';
import { amountIssue, parseAmount } from '../../utils/validation';

const GtpTransactions = ({ id }) => {
  const txns = useAsync(() => gtp.transactions(id, { limit: 20 }), [id]);
  if (txns.loading) return <div className="stack-sm"><Skeleton /><Skeleton w="80%" /><Skeleton w="60%" /></div>;
  if (txns.error) return <ErrorState error={txns.error} onRetry={txns.reload} title="Historique indisponible" />;
  if (!txns.data?.length) return <p className="small muted">Aucune opération sur les 90 derniers jours.</p>;
  return (
    <div className="list">
      {txns.data.map((t) => (
        <div className="list-item" key={t.transactionId} style={{ paddingLeft: 0, paddingRight: 0 }}>
          <span className="li-main">
            <span className="li-title truncate" style={{ display: 'block' }}>{t.description || 'Opération'}</span>
            <span className="li-sub">{formatDate(t.date)}{t.time ? ` · ${t.time}` : ''}</span>
          </span>
          <span className="li-end">
            <span className="li-amount" style={{ display: 'block' }}>{formatMoney(t.amount, 'XAF')}</span>
            {t.fee ? <span className="xs muted">frais {formatMoney(t.fee, 'XAF')}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
};

const TransferModal = ({ open, onClose, card, onDone }) => {
  const [f, setF] = useState({ toCustomerId: '', toLast4: '', amount: '', description: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setErrors({ ...errors, [k]: undefined }); };
  const submit = async () => {
    const er = {};
    if (!/^\d{3,}$/.test(f.toCustomerId.trim())) er.toCustomerId = 'Identifiant du bénéficiaire invalide';
    if (f.toLast4 && !/^\d{4}$/.test(f.toLast4)) er.toLast4 = '4 chiffres attendus';
    const ai = amountIssue(f.amount, { min: 100, max: Number(card.balance) });
    if (ai) er.amount = ai;
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true); setFormError('');
    try {
      await gtp.payment(card.gtp_card_id, { toCustomerId: f.toCustomerId.trim(), toLast4: f.toLast4 || undefined, amount: parseAmount(f.amount), description: f.description || undefined });
      toast.success('Transfert effectué');
      setF({ toCustomerId: '', toLast4: '', amount: '', description: '' });
      onDone();
    } catch (err) { setFormError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return (
    <Modal open={open} title="Envoyer vers une autre carte C-Pay" onClose={busy ? undefined : onClose}
      footer={<><Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button><Button variant="primary" onClick={submit} loading={busy}>Envoyer</Button></>}>
      <div className="stack">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Input label="Identifiant client du bénéficiaire" required value={f.toCustomerId} onChange={set('toCustomerId')} error={errors.toCustomerId} inputMode="numeric" hint="Communiqué par le bénéficiaire (visible dans sa carte réseau)." />
        <Input label="4 derniers chiffres de sa carte" value={f.toLast4} onChange={set('toLast4')} error={errors.toLast4} inputMode="numeric" maxLength={4} />
        <AmountInput value={f.amount} onChange={set('amount')} error={errors.amount} hint={`Solde disponible : ${formatMoney(card?.balance, card?.currency)}`} />
        <Input label="Motif (facultatif)" value={f.description} onChange={set('description')} maxLength={60} />
      </div>
    </Modal>
  );
};

export default function GtpCardsTab() {
  const status = useAsync(gtp.status, []);
  const cards = useAsync(gtp.list, [status.data?.configured], { enabled: !!status.data?.configured });
  const [selectedId, setSelectedId] = useState(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issueError, setIssueError] = useState('');

  const list = cards.data || [];
  const selected = list.find((c) => c.gtp_card_id === selectedId) || null;
  const st = cardStatus(selected?.status);
  const frozen = ['frozen', 'blocked', 'inactive'].includes(String(selected?.status || '').toLowerCase());

  if (status.loading) return <Skeleton h={160} style={{ borderRadius: 16 }} />;
  if (status.error) return <ErrorState error={status.error} onRetry={status.reload} />;
  if (!status.data?.configured) {
    return (
      <Card>
        <FeatureDisabled icon="layers" title="Cartes réseau en cours d’activation"
          message="Les cartes prépayées réseau (acceptées chez tous les commerçants Visa) arrivent bientôt. Votre carte virtuelle C-Pay reste disponible pour vos paiements marchands." />
      </Card>
    );
  }

  const toggleFreeze = async () => {
    setBusy(true);
    try {
      if (frozen) await gtp.unfreeze(selected.gtp_card_id); else await gtp.freeze(selected.gtp_card_id);
      toast.success(frozen ? 'Carte réactivée' : 'Carte gelée');
      setFreezeOpen(false); cards.reload();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const issue = async () => {
    setBusy(true); setIssueError('');
    try { await gtp.issue({}); toast.success('Votre carte réseau est émise'); setIssueOpen(false); cards.reload(); status.reload(); }
    catch (err) { setIssueError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ gap: 24 }}>
      <Alert tone="info" title="Carte prépayée réseau">
        Émise par notre partenaire, elle est acceptée chez les commerçants du réseau. Les rechargements et retraits Mobile Money sont {FEATURES.gtpTopup ? 'disponibles' : 'en cours d’intégration'}.
      </Alert>

      {cards.loading ? <div className="cards-grid"><Skeleton h={220} style={{ borderRadius: 18 }} /></div>
        : cards.error ? <ErrorState error={cards.error} onRetry={cards.reload} />
          : !list.length ? (
            <Card>
              <EmptyState icon="credit-card" title="Aucune carte réseau" action={<Button variant="primary" icon="plus" onClick={() => setIssueOpen(true)}>Obtenir ma carte réseau</Button>}>
                Émettez votre carte prépayée en quelques secondes. Elle sera rattachée à votre compte C-Pay.
              </EmptyState>
            </Card>
          ) : (
            <div className="cards-grid">
              {list.map((c) => {
                const cs = cardStatus(c.status);
                return (
                  <div className="card-tile" key={c.gtp_card_id}>
                    <VirtualCard card={{ ...c, network: 'visa' }} as="button" type="button" onClick={() => setSelectedId(c.gtp_card_id)} label="Réseau" aria-label={`Carte réseau ${c.last4}`} />
                    <div className="ct-meta">
                      <span className="ct-balance">{formatMoney(c.balance, c.currency)}</span>
                      <Badge tone={cs.tone} dot>{cs.label}</Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

      <Drawer open={!!selected} onClose={() => setSelectedId(null)} title="Carte réseau">
        {selected ? (
          <div className="stack" style={{ gap: 20 }}>
            <VirtualCard card={{ ...selected, network: 'visa' }} label="Réseau" style={{ maxWidth: 'none' }} />
            <div className="balance-hero">
              <span className="bh-label">Solde</span>
              <span className="bh-value" style={{ fontSize: 28 }}>{formatMoney(selected.balance, selected.currency)}</span>
              <span><Badge tone={st.tone} dot>{st.label}</Badge></span>
            </div>
            <dl className="kv">
              <dt>Identifiant client</dt><dd className="mono">{selected.gtp_card_id}</dd>
              <dt>Numéro</dt><dd className="mono">{selected.cardMasked}</dd>
              <dt>Titulaire</dt><dd>{selected.cardholderName || '—'}</dd>
            </dl>
            <div>
              <h3 style={{ marginBottom: 8 }}>Actions</h3>
              <div className="action-grid">
                <button type="button" className="action-btn" onClick={() => setTransferOpen(true)} disabled={frozen}><span className="ab-icon"><Icon name="send" size={20} /></span>Envoyer vers une carte</button>
                <button type="button" className="action-btn" onClick={() => setPinOpen(true)}><span className="ab-icon"><Icon name="key" size={20} /></span>Code PIN</button>
                <button type="button" className="action-btn" onClick={() => setFreezeOpen(true)}><span className="ab-icon"><Icon name={frozen ? 'unlock' : 'snowflake'} size={20} /></span>{frozen ? 'Réactiver' : 'Geler'}</button>
                <button type="button" className="action-btn" disabled title="En cours d’intégration"><span className="ab-icon"><Icon name="arrow-down-left" size={20} /></span>Recharger (bientôt)</button>
              </div>
              {!FEATURES.gtpTopup ? <p className="xs muted" style={{ marginTop: 8 }}>Rechargement et retrait Mobile Money : en cours d’intégration avec les opérateurs.</p> : null}
            </div>
            <div>
              <h3 style={{ marginBottom: 8 }}>Dernières opérations</h3>
              <GtpTransactions id={selected.gtp_card_id} />
            </div>
          </div>
        ) : null}
      </Drawer>

      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} askCurrent={false} title="Code PIN de la carte réseau" onSubmit={async ({ newPin }) => { const r = await gtp.setPin(selected.gtp_card_id, newPin); if (r && r.success === false) throw new Error('Le changement de PIN a été refusé par le réseau.'); }} />
      <ConfirmDialog open={freezeOpen} onClose={() => setFreezeOpen(false)} onConfirm={toggleFreeze} loading={busy} danger={!frozen}
        title={frozen ? 'Réactiver la carte ?' : 'Geler la carte ?'} confirmLabel={frozen ? 'Réactiver' : 'Geler'}
        message={frozen ? 'Les paiements seront de nouveau autorisés.' : 'Tous les paiements seront refusés jusqu’à la réactivation.'} />
      {selected ? <TransferModal open={transferOpen} onClose={() => setTransferOpen(false)} card={selected} onDone={() => { setTransferOpen(false); cards.reload(); }} /> : null}
      <Modal open={issueOpen} title="Obtenir ma carte réseau" onClose={busy ? undefined : () => setIssueOpen(false)}
        footer={<><Button variant="outline" onClick={() => setIssueOpen(false)} disabled={busy}>Annuler</Button><Button variant="primary" onClick={issue} loading={busy}>Émettre la carte</Button></>}>
        <div className="stack">
          {issueError ? <Alert tone="error">{issueError}</Alert> : null}
          <p className="small text-2">La carte sera émise au nom figurant sur votre profil et rattachée à votre numéro de téléphone. Vous définirez ensuite son code PIN.</p>
        </div>
      </Modal>
    </div>
  );
}
