import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { Card, Button, Badge, Drawer, Modal, Input, ConfirmDialog, VirtualCard, Alert, Skeleton, ErrorState, EmptyState, Icon } from '../../components';
import PinModal from './PinModal';
import * as cardsApi from '../../services/cards';
import { formatMoney, expiry } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { cardStatus } from '../../utils/txn';

const ActionButton = ({ icon, label, onClick, disabled, danger, hint }) => (
  <button type="button" className={`action-btn ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled} title={hint}>
    <span className="ab-icon"><Icon name={icon} size={20} /></span>{label}
  </button>
);

export default function VirtualCardsTab() {
  const { user, reloadUser } = useAuth();
  const navigate = useNavigate();
  const created = useAsync(cardsApi.listCreated, []);
  const [selectedId, setSelectedId] = useState(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [createMsg, setCreateMsg] = useState('');

  const mainCard = user?.card;
  const list = created.data?.data?.length ? created.data.data : (mainCard ? [{ ...mainCard, label: 'Carte principale' }] : []);
  const max = created.data?.max || 3;
  const selected = list.find((c) => c.cardId === selectedId) || null;
  const isMain = selected && mainCard && selected.cardId === mainCard.cardId;
  const selStatus = cardStatus(selected?.status);

  const toggleFreeze = async () => {
    setBusy(true);
    try {
      const action = selected.status === 'frozen' ? 'unfreeze' : 'freeze';
      await cardsApi.setCardStatus(action);
      toast.success(action === 'freeze' ? 'Carte gelée : les paiements sont bloqués' : 'Carte réactivée');
      setFreezeOpen(false);
      await Promise.all([created.reload(), reloadUser()]);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try { await cardsApi.deleteCreated(selected.cardId); toast.success('Carte supprimée'); setDeleteOpen(false); setSelectedId(null); created.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setCreateMsg('');
    try { await cardsApi.createCard(label.trim() || undefined); toast.success('Nouvelle carte créée'); setCreateOpen(false); setLabel(''); created.reload(); }
    catch (err) { setCreateMsg(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row-between wrap">
        <p className="small text-2">{list.length} carte{list.length > 1 ? 's' : ''} sur {max} possibles. Touchez une carte pour voir le détail et les actions.</p>
        <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)} disabled={list.length >= max}>Nouvelle carte</Button>
      </div>

      {created.loading && !list.length ? <div className="cards-grid"><Skeleton h={220} style={{ borderRadius: 18 }} /><Skeleton h={220} style={{ borderRadius: 18 }} /></div>
        : created.error && !list.length ? <ErrorState error={created.error} onRetry={created.reload} />
          : !list.length ? <EmptyState icon="credit-card" title="Aucune carte">Créez votre première carte virtuelle C-Pay.</EmptyState>
            : (
              <div className="cards-grid">
                {list.map((c) => {
                  const st = cardStatus(c.status);
                  return (
                    <div className="card-tile" key={c.cardId}>
                      <VirtualCard card={c} as="button" type="button" onClick={() => setSelectedId(c.cardId)} aria-label={`Détail de la carte ${c.label || ''} ${String(c.cardMasked || '').slice(-4)}`} label={c.label && c.label !== 'Carte' ? c.label : undefined} />
                      <div className="ct-meta">
                        <span className="ct-balance">{formatMoney(c.balance, c.currency)}</span>
                        <Badge tone={st.tone} dot>{st.label}</Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

      <Drawer open={!!selected} onClose={() => setSelectedId(null)} title={selected?.label && selected.label !== 'Carte' ? selected.label : 'Carte virtuelle'}>
        {selected ? (
          <div className="stack" style={{ gap: 20 }}>
            <VirtualCard card={selected} style={{ maxWidth: 'none' }} />
            <div className="balance-hero">
              <span className="bh-label">Solde disponible</span>
              <span className="bh-value" style={{ fontSize: 28 }}>{formatMoney(selected.balance, selected.currency)}</span>
              <span><Badge tone={selStatus.tone} dot>{selStatus.label}</Badge></span>
            </div>
            <dl className="kv">
              <dt>Numéro</dt><dd className="mono">{selected.cardMasked}</dd>
              <dt>Titulaire</dt><dd>{selected.cardholderName || '—'}</dd>
              <dt>Expiration</dt><dd>{expiry(selected.expiryMonth, selected.expiryYear)}</dd>
              <dt>Réseau</dt><dd style={{ textTransform: 'capitalize' }}>{selected.network || 'visa'}</dd>
            </dl>
            <div>
              <h3 style={{ marginBottom: 8 }}>Plafonds</h3>
              <div className="limits">
                <div className="limit"><div className="lm-label">Par jour</div><div className="lm-value">{selected.dailyLimit ? formatMoney(selected.dailyLimit, selected.currency) : '—'}</div></div>
                <div className="limit"><div className="lm-label">Par mois</div><div className="lm-value">{selected.monthlyLimit ? formatMoney(selected.monthlyLimit, selected.currency) : '—'}</div></div>
              </div>
            </div>
            <div>
              <h3 style={{ marginBottom: 8 }}>Actions</h3>
              <div className="action-grid">
                <ActionButton icon="send" label="Payer avec cette carte" onClick={() => navigate('/payer')} disabled={selected.status !== 'active'} />
                <ActionButton icon="key" label="Code PIN" onClick={() => setPinOpen(true)} disabled={selected.status === 'cancelled'} />
                <ActionButton icon={selected.status === 'frozen' ? 'unlock' : 'snowflake'} label={selected.status === 'frozen' ? 'Réactiver la carte' : 'Geler la carte'} onClick={() => setFreezeOpen(true)}
                  disabled={!isMain || selected.status === 'cancelled'} hint={!isMain ? 'Disponible pour la carte principale' : undefined} />
                <ActionButton icon="trash" label="Supprimer la carte" danger onClick={() => setDeleteOpen(true)} disabled={isMain || Number(selected.balance) > 0 || selected.status === 'cancelled'}
                  hint={isMain ? 'La carte principale ne peut pas être supprimée' : Number(selected.balance) > 0 ? 'Le solde doit être nul' : undefined} />
              </div>
              {!isMain ? <p className="xs muted" style={{ marginTop: 8 }}>Le gel ne s’applique qu’à la carte principale pour le moment.</p> : null}
              {isMain && Number(selected.balance) > 0 ? <p className="xs muted" style={{ marginTop: 8 }}>La suppression nécessite un solde nul.</p> : null}
            </div>
          </div>
        ) : null}
      </Drawer>

      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} askCurrent onSubmit={({ currentPin, newPin }) => cardsApi.setPin({ currentPin, newPin, cardId: selected?.cardId })} />

      <ConfirmDialog open={freezeOpen} onClose={() => setFreezeOpen(false)} onConfirm={toggleFreeze} loading={busy} danger={selected?.status !== 'frozen'}
        title={selected?.status === 'frozen' ? 'Réactiver la carte ?' : 'Geler la carte ?'} confirmLabel={selected?.status === 'frozen' ? 'Réactiver' : 'Geler'}
        message={selected?.status === 'frozen' ? 'Les paiements seront de nouveau autorisés.' : 'Tous les paiements seront refusés jusqu’à la réactivation. Vous pourrez la réactiver à tout moment.'} />

      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={remove} loading={busy} danger title="Supprimer cette carte ?" confirmLabel="Supprimer"
        message="La carte sera annulée définitivement. Cette action est irréversible." />

      <Modal open={createOpen} title="Nouvelle carte virtuelle" onClose={busy ? undefined : () => { setCreateOpen(false); setCreateMsg(''); }}
        footer={<><Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>Annuler</Button><Button variant="primary" onClick={create} loading={busy}>Créer la carte</Button></>}>
        <div className="stack">
          <p className="small text-2">Donnez un nom à votre carte pour la retrouver facilement (par exemple « Achats en ligne »).</p>
          {createMsg ? <Alert tone="warn" title="Indisponible pour le moment">{createMsg}</Alert> : null}
          <Input label="Nom de la carte" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="Ma carte" autoFocus />
        </div>
      </Modal>
    </div>
  );
}
