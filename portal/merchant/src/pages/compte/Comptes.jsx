import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { accountApi, cashApi, isFeatureUnavailable } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, PageHeader, Table, Badge, StatusBadge, Modal, ConfirmDialog, Notice, Skeleton, KVList, Icon } from '../../components';
import { fmtPhone, fmtDateTime } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { opLabel } from '../../utils/labels';
import { WalletForm, BankAccountForm } from '../caisse/shared';

// Comptes bancaires (transferts wallet → banque) et wallet Mobile Money (retraits).
export const Comptes = () => {
  const { user } = useAuth();
  const accounts = useAsync(() => accountApi.bankAccounts(), []);
  const wallet = useAsync(() => cashApi.getWallet().then(r => ({ data: r.status === 204 || !r.data?.phone ? null : r.data })), []);
  const [adding, setAdding] = useState(false);
  const [editWallet, setEditWallet] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const rows = accounts.data?.data || [];
  const remove = async () => {
    setBusy(true);
    try { await accountApi.deleteBankAccount(toDelete.accountId); toast.success('Compte retiré'); setToDelete(null); accounts.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const columns = [
    { key: 'bank', label: 'Banque', mobile: 'title', render: a => <><strong>{a.institution?.name || 'Banque'}</strong><div className="xs muted">{a.accountName}</div></> },
    { key: 'num', label: 'Numéro', className: 'mono', render: a => a.accountNumber },
    { key: 'status', label: 'Statut', mobile: 'right', render: a => <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}><StatusBadge status={a.status} />{a.isDefault && <Badge tone="info">Par défaut</Badge>}</span> },
    { key: 'act', label: '', mobile: 'actions', render: a => <Button size="sm" variant="danger" icon="trash" onClick={() => setToDelete(a)}>Retirer</Button> },
  ];
  const w = wallet.data;
  return (
    <div className="stack-lg">
      <PageHeader title="Comptes & wallet" subtitle="Les destinations de vos fonds : le wallet Mobile Money pour les retraits, vos comptes bancaires pour les transferts." />
      <Card title="Wallet Mobile Money de retrait" actions={w && <Button size="sm" icon="edit" onClick={() => setEditWallet(true)}>Modifier</Button>}>
        {wallet.state === 'loading' ? <div className="stack"><Skeleton /><Skeleton width="60%" /></div> : wallet.state === 'unavailable' ? <Notice tone="neutral">Wallet de retrait en cours d’intégration.</Notice> : w ? (
          <div className="row" style={{ gap: 'var(--s4)' }}>
            <span className="qa-ic" style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--primary-50)', color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="smartphone" /></span>
            <div><div className="strong">{opLabel(w.operator, w.operatorLabel)} · {fmtPhone(w.phone)}</div><div className={`small ${w.verifiedAt ? 'success' : 'warn'}`}>{w.verifiedAt ? `Vérifié le ${fmtDateTime(w.verifiedAt)}` : 'Sera vérifié au premier retrait réussi'}</div></div>
          </div>
        ) : (
          <><Notice tone="warn" className="mb-4">Aucun wallet enregistré : vos retraits ne sont pas encore possibles.</Notice><WalletForm user={user} onSaved={() => wallet.reload()} /></>
        )}
      </Card>
      <Card title="Comptes bancaires" subtitle="Destinations des transferts wallet → banque" flush actions={<Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>Ajouter</Button>}>
        <Table columns={columns} rows={rows} rowKey={a => a.accountId} state={accounts.state} error={accounts.error} onRetry={accounts.reload}
          empty={{ title: 'Aucun compte bancaire', message: 'Ajoutez un compte pour virer votre solde vers votre banque.' }} emptyIcon="bank"
          emptyAction={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Ajouter un compte</Button>} />
      </Card>
      <Card title="Compte de règlement historique" subtitle="Renseigné à l’inscription">
        <KVList rows={[['Type', user?.settlementType === 'bank' ? 'Virement bancaire' : 'Mobile Money'], ['Information', 'Les règlements quotidiens (J+1) utilisent ce compte ; pour le changer, contactez le support.']]} />
      </Card>
      {adding && <Modal title="Ajouter un compte bancaire" onClose={() => setAdding(false)}><BankAccountForm user={user} onSaved={() => { setAdding(false); accounts.reload(); }} onCancel={() => setAdding(false)} /></Modal>}
      {editWallet && <Modal title="Modifier le wallet de retrait" onClose={() => setEditWallet(false)}><WalletForm user={user} initial={w} onSaved={() => { setEditWallet(false); wallet.reload(); }} onCancel={() => setEditWallet(false)} /></Modal>}
      {toDelete && <ConfirmDialog title="Retirer le compte bancaire" message={`Le compte ${toDelete.institution?.name || ''} ${toDelete.accountNumber} ne pourra plus recevoir de transferts.`} confirmLabel="Retirer" busy={busy} onConfirm={remove} onClose={() => setToDelete(null)} />}
    </div>
  );
};
export default Comptes;
