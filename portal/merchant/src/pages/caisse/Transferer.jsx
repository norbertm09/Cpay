import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { cashApi, accountApi, isFeatureUnavailable, isStepUp } from '../../services/api';
import { useFinancialIntent } from '../../hooks/useFinancialIntent';
import { useAuth } from '../../hooks/useAuth';
import { useCashSummary } from '../../hooks/useCashSummary';
import { useCapabilities } from '../../hooks/useCapabilities';
import { useStepUp } from '../../hooks/useStepUp';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, PageHeader, Input, Select, AmountInput, Segmented, Notice, KV, KVList, StatusBadge, StepUpModal, FeatureUnavailable, Table, Modal, ConfirmDialog, Drawer } from '../../components';
import { fmtMoney, fmtDateTime, fmtRelative } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { dirLabel } from '../../utils/labels';
import { TransferRecovery, transferNetValue } from './TransferRecovery';
import { BankAccountForm, FundingInstructions, previewFee } from './shared';

const CANCELLABLE = ['awaiting_funds', 'pending_manual'];

// Transférer : wallet -> banque (step-up, compte vérifié) ou banque -> wallet
// (ordre d'approvisionnement référencé, aucune confirmation forte).
export const Transferer = () => {
  const { user } = useAuth();
  const intent = useFinancialIntent(user, 'transfer');
  const { summary, state: sumState, reload } = useCashSummary();
  const stepUp = useStepUp(user);
  const currency = summary?.currency || user?.currency || 'XAF';
  const cap = useCapabilities(user?.country);
  const [direction, setDirection] = useState('wallet_to_bank');
  const [accountId, setAccountId] = useState('');
  const [addingAccount, setAddingAccount] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [fundingUnavailable, setFundingUnavailable] = useState(false);
  const [detail, setDetail] = useState(null);
  const [toCancel, setToCancel] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const restore = useCallback((payload) => {
    setDirection(payload?.direction || 'wallet_to_bank'); setAmount(payload ? String(payload.amount) : '');
    setDescription(payload?.description || ''); setAccountId(payload?.accountId || '');
  }, []);
  useEffect(() => { restore(intent.restored); setResult(null); }, [intent.restored, user?.merchantId, user?.userId, restore]);
  const newOperation = () => { try { intent.startNew(); setResult(null); restore(null); } catch (err) { toast.error(err.message); } };
  const accounts = useAsync(() => accountApi.bankAccounts(), []);
  const transfers = useAsync(() => cashApi.listTransfers({ limit: 20, offset: 0 }), []);
  const verified = (accounts.data?.data || []).filter(a => a.status === 'verified');
  useEffect(() => { if (!accountId && verified.length) setAccountId((verified.find(a => a.isDefault) || verified[0]).accountId); }, [verified, accountId]);

  const amt = Number(amount);
  const minT = summary?.limits?.transferMin;
  const available = summary?.balance?.available;
  const account = verified.find(a => a.accountId === accountId);
  const belowMin = minT != null && amt > 0 && amt < Number(minT);
  const overBalance = direction === 'wallet_to_bank' && available != null && amt > Number(available);
  const amountError = belowMin ? `Montant minimum ${fmtMoney(minT, currency)}.` : overBalance ? 'Montant supérieur au solde disponible.' : null;
  const directionClosed = !cap.isOpen('transfer', direction);
  const canSubmit = amt > 0 && !loading && (intent.pending || (!amountError && !directionClosed && (direction === 'bank_to_wallet' || !!account)));
  const fee = direction === 'wallet_to_bank' && amt > 0 ? previewFee(summary, amt, 'transfer') : null;

  const doCreate = useCallback(async (confirm) => {
    const body = { direction, amount: amt, description: description || undefined };
    if (direction === 'wallet_to_bank') body.accountId = accountId;
    if (confirm) body.confirm = confirm;
    const { data } = await intent.execute(body, cashApi.createTransfer);
    setResult(data); setFundingUnavailable(false);
    reload(); transfers.reload();
    if (['unknown', 'processing'].includes(data.status)) toast('Transfert enregistré — en cours de confirmation');
    else toast.success(direction === 'bank_to_wallet' ? 'Ordre d’approvisionnement créé' : 'Transfert lancé');
  }, [direction, amt, description, accountId, reload, transfers, intent.execute]);

  const submit = async (e) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setFundingUnavailable(false);
    if (direction === 'wallet_to_bank') {
      stepUp.request(async (confirm) => { try { await doCreate(confirm); } catch (err) { if (isStepUp(err)) throw err; toast.error(errorMessage(err, { currency })); } });
      return;
    }
    setLoading(true);
    try { await doCreate(null); }
    catch (err) {
      if (isStepUp(err)) {
        stepUp.request(async (confirm) => { try { await doCreate(confirm); } catch (e2) { if (isStepUp(e2)) throw e2; if (e2.response?.data?.code === 'FUNDING_UNAVAILABLE') setFundingUnavailable(true); else toast.error(errorMessage(e2, { currency })); } }, err.response?.data?.methods);
      } else if (err.response?.data?.code === 'FUNDING_UNAVAILABLE') setFundingUnavailable(true);
      else toast.error(errorMessage(err, { currency }));
    } finally { setLoading(false); }
  };
  const cancel = async () => {
    setCancelling(true);
    try { await cashApi.cancelTransfer(toCancel.transferId || toCancel.id); toast.success('Transfert annulé'); setToCancel(null); setDetail(null); transfers.reload(); reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setCancelling(false); }
  };

  if (sumState === 'unavailable' && transfers.state === 'unavailable') return <div className="medium"><PageHeader title="Transférer" /><FeatureUnavailable title="Transferts wallet ↔ banque" /></div>;

  const columns = [
    { key: 'dir', label: 'Transfert', mobile: 'title', render: t => <><strong>{dirLabel(t.direction || t.type)}</strong><div className="xs muted mono">{t.reference}</div></> },
    { key: 'date', label: 'Date', render: t => <span title={fmtDateTime(t.createdAt)}>{fmtRelative(t.createdAt)}</span> },
    { key: 'dest', label: 'Destination', render: t => t.bankAccount ? `${t.bankAccount.bankName || 'Banque'} ${t.bankAccount.accountMasked || ''}` : t.instructions?.bankName || (t.wallet ? `${t.wallet.operator || ''} ${t.wallet.phone || ''}` : '—') },
    { key: 'amount', label: 'Montant', num: true, mobile: 'right', render: t => <strong>{fmtMoney(t.amount, t.currency || currency)}</strong> },
    { key: 'status', label: 'Statut', render: t => <StatusBadge status={t.status} /> },
  ];

  return (
    <div className="medium">
      <PageHeader title="Transférer" subtitle="Entre votre solde C-Pay et vos comptes bancaires : virement vers la banque ou approvisionnement de votre solde." />
      {(intent.pending || intent.error) && <Notice tone={intent.error ? 'error' : 'info'} className="mb-4">
        {intent.error || 'Opération enregistrée dans cet onglet. Réessayez avec les mêmes paramètres pour retrouver son résultat.'}
        {intent.pending && <Button size="sm" onClick={() => restore(intent.payload)}>Reprendre les paramètres</Button>}
        {intent.canStartNew && <Button size="sm" onClick={newOperation}>Nouvelle opération</Button>}
      </Notice>}

      {result && (
        <Card className="mb-4">
          <div className="row-between mb-3"><div><div className="xs muted">{dirLabel(result.direction)}</div><h2>Réf. <span className="mono">{result.reference}</span></h2></div><StatusBadge status={result.status} /></div>
          <TransferRecovery transfer={result} onUpdated={fresh => { setResult(fresh); reload(); transfers.reload(); }} />
          {result.status === 'awaiting_funds' ? <FundingInstructions transfer={result} currency={currency} /> : (
            <KVList boxed rows={[['Montant', fmtMoney(result.amount, currency)], result.fee != null && ['Frais', fmtMoney(result.fee, currency)], result.net != null && [result.status === 'completed' ? 'Net viré' : 'Net', transferNetValue(result, currency), { tone: result.status === 'completed' ? 'success' : undefined }], result.bankAccount && ['Compte', `${result.bankAccount.bankName || ''} ${result.bankAccount.accountMasked || ''}`]]} />
          )}
          <Button variant="primary" block className="mt-4" icon="plus" onClick={newOperation}>Nouveau transfert</Button>
        </Card>
      )}

      {!result && (
        <Card className="mb-4">
          <form onSubmit={submit} noValidate>
            <Segmented value={direction} onChange={d => { setDirection(d); setFundingUnavailable(false); }} ariaLabel="Sens du transfert" options={[
              { value: 'wallet_to_bank', icon: 'bank', label: 'Wallet → Banque', sub: cap.isOpen('transfer', 'wallet_to_bank') ? 'virer mon solde' : 'non disponible', disabled: !cap.isOpen('transfer', 'wallet_to_bank') && direction !== 'wallet_to_bank' },
              { value: 'bank_to_wallet', icon: 'arrowDown', label: 'Banque → Wallet', sub: cap.isOpen('transfer', 'bank_to_wallet') ? 'approvisionner' : 'non disponible', disabled: !cap.isOpen('transfer', 'bank_to_wallet') && direction !== 'bank_to_wallet' },
            ]} />
            {directionClosed && <Notice tone="neutral" className="mb-4" icon="clock"><strong>{cap.message}.</strong> {direction === 'bank_to_wallet' ? 'Aucun compte de collecte C-Pay n’est encore ouvert pour votre devise.' : 'Le virement vers la banque n’est pas encore activé dans votre pays.'}</Notice>}
            {direction === 'wallet_to_bank' && (<>
              {accounts.state === 'loading' ? <p className="small muted mb-4">Chargement des comptes…</p> : accounts.state === 'error' ? <Notice tone="error" className="mb-4" action={<Button size="sm" onClick={accounts.reload}>Réessayer</Button>}>Comptes bancaires indisponibles.</Notice> : (
                verified.length > 0
                  ? <Select label="Compte bancaire de destination (vérifié)" value={accountId} onChange={setAccountId} options={verified.map(a => ({ value: a.accountId, label: `${a.institution?.name || 'Banque'} · ${a.accountNumber} · ${a.accountName}` }))} required />
                  : <Notice tone="warn" className="mb-4">Aucun compte bancaire vérifié. Ajoutez-en un ci-dessous ou depuis <Link to="/compte/comptes">Comptes & wallet</Link>.</Notice>
              )}
              <Button variant="ghost" size="sm" icon="plus" className="mb-4" onClick={() => setAddingAccount(true)}>Ajouter un compte bancaire</Button>
              {sumState === 'ok' && <p className="small muted mb-3">Solde disponible : <strong className="success">{fmtMoney(available, currency)}</strong></p>}
            </>)}
            {direction === 'bank_to_wallet' && <Notice tone="info" className="mb-4">Vous recevrez les coordonnées du compte de collecte C-Pay et une <strong>référence</strong> à indiquer dans votre virement. Le solde est crédité à réception des fonds. Aucune confirmation forte n’est requise.</Notice>}
            <AmountInput label={direction === 'wallet_to_bank' ? 'Montant à virer vers la banque' : 'Montant à approvisionner'} value={amount} onChange={setAmount} currency={currency} error={amountError}
              hint={fee != null && amt > 0 ? `Frais ≈ ${fmtMoney(fee, currency)} · net ≈ ${fmtMoney(amt - fee, currency)}` : minT != null ? `Minimum ${fmtMoney(minT, currency)}` : (direction === 'wallet_to_bank' && amt > 0 ? 'Frais affichés à la confirmation' : undefined)} />
            <Input label="Libellé (facultatif)" value={description} onChange={setDescription} placeholder={direction === 'wallet_to_bank' ? 'Virement hebdomadaire' : 'Approvisionnement caisse'} />
            {fundingUnavailable && <Notice tone="warn" className="mb-4">Approvisionnement par virement indisponible pour votre devise ({currency}) pour le moment : aucun compte de collecte n’est configuré. Contactez le support.</Notice>}
            <Button type="submit" variant="primary" size="lg" block loading={loading} disabled={!canSubmit}>{direction === 'wallet_to_bank' ? `Virer${amt > 0 ? ' ' + fmtMoney(amt, currency) : ''} vers la banque` : `Créer l’ordre d’approvisionnement${amt > 0 ? ' · ' + fmtMoney(amt, currency) : ''}`}</Button>
          </form>
        </Card>
      )}

      <Card title="Mes transferts" flush actions={<Button size="sm" variant="ghost" icon="refresh" onClick={transfers.reload} aria-label="Actualiser" />}>
        <Table columns={columns} rows={transfers.data?.data || []} rowKey={t => t.transferId || t.id} state={transfers.state} error={transfers.error} onRetry={transfers.reload} onRowClick={setDetail}
          empty={{ title: 'Aucun transfert pour l’instant', message: 'Vos virements et approvisionnements apparaîtront ici.' }} emptyIcon="swap" />
      </Card>

      {addingAccount && <Modal title="Ajouter un compte bancaire" onClose={() => setAddingAccount(false)}><BankAccountForm user={user} onSaved={(a) => { setAddingAccount(false); setAccountId(a?.accountId || ''); accounts.reload(); reload(); }} onCancel={() => setAddingAccount(false)} /></Modal>}
      {detail && (
        <Drawer title={dirLabel(detail.direction || detail.type)} subtitle={`Réf. ${detail.reference}`} onClose={() => setDetail(null)}
          footer={CANCELLABLE.includes(detail.status) ? <Button variant="danger" onClick={() => setToCancel(detail)}>Annuler ce transfert</Button> : null}>
          <div className="row-between mb-3"><span className="strong">{fmtMoney(detail.amount, detail.currency || currency)}</span><StatusBadge status={detail.status} /></div>
          <TransferRecovery transfer={detail} onUpdated={fresh => { setDetail(fresh); reload(); transfers.reload(); }} />
          {detail.status === 'awaiting_funds' && detail.instructions ? <FundingInstructions transfer={detail} currency={currency} /> : (
            <KVList boxed rows={[['Date', fmtDateTime(detail.createdAt)], detail.fee != null && ['Frais', fmtMoney(detail.fee, currency)], detail.net != null && ['Net', transferNetValue(detail, currency)], detail.bankAccount && ['Compte', `${detail.bankAccount.bankName || ''} ${detail.bankAccount.accountMasked || ''}`], detail.wallet && ['Wallet', `${detail.wallet.operator || ''} ${detail.wallet.phone || ''}`], detail.description && ['Libellé', detail.description], detail.bankReference && ['Référence bancaire', detail.bankReference, { mono: true }], detail.completedAt && ['Terminé le', fmtDateTime(detail.completedAt)], detail.errorMessage && ['Motif', detail.errorMessage, { tone: 'error' }]]} />
          )}
        </Drawer>
      )}
      {toCancel && <ConfirmDialog title="Annuler le transfert" message={`Confirmez-vous l’annulation du transfert ${toCancel.reference || ''} de ${fmtMoney(toCancel.amount, currency)} ? Les fonds réservés seront libérés.`} confirmLabel="Annuler le transfert" busy={cancelling} onConfirm={cancel} onClose={() => setToCancel(null)} />}
      {stepUp.state && <StepUpModal {...stepUp.state} title="Confirmer le transfert" onConfirm={stepUp.confirm} onClose={stepUp.close}
        summary={<><KV label={dirLabel(direction)} value={fmtMoney(amt, currency)} />{direction === 'wallet_to_bank' && account && <KV label="Vers" value={`${account.institution?.name || 'Banque'} ${account.accountNumber}`} />}</>} />}
    </div>
  );
};
export default Transferer;
