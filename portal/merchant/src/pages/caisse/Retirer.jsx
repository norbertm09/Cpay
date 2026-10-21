import React, { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { cashApi, isFeatureUnavailable, isStepUp } from '../../services/api';
import { useFinancialIntent } from '../../hooks/useFinancialIntent';
import { useAuth } from '../../hooks/useAuth';
import { useCashSummary } from '../../hooks/useCashSummary';
import { useCapabilities } from '../../hooks/useCapabilities';
import { useStepUp } from '../../hooks/useStepUp';
import { Button, Card, PageHeader, Input, AmountInput, Notice, KV, Icon, StatusBadge, StepUpModal, FeatureUnavailable, SkeletonCard, Modal } from '../../components';
import { fmtMoney, fmtDateTime, fmtPhone } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { opLabel, statusLabel } from '../../utils/labels';
import { printDoc } from '../../utils/actions';
import { devParams } from '../../utils/dev';
import { TransferRecovery, transferNetValue } from './TransferRecovery';
import { WalletForm, previewFee } from './shared';

// Retirer : solde disponible -> wallet Mobile Money enregistré (step-up, limite journalière).
export const Retirer = () => {
  const { user } = useAuth();
  const intent = useFinancialIntent(user, 'withdraw');
  const { summary, state: sumState, reload } = useCashSummary();
  const stepUp = useStepUp(user);
  const currency = summary?.currency || user?.currency || 'XAF';
  const cap = useCapabilities(user?.country);
  const dev = devParams();
  const devDefaults = useRef({ amount: dev?.get('amount') || '' });
  const [wallet, setWallet] = useState(null);
  const [walletState, setWalletState] = useState('loading');
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(dev?.get('amount') || '');
  const [description, setDescription] = useState('');
  const [result, setResult] = useState(null);
  const [blocked, setBlocked] = useState(null);
  const restore = useCallback((payload) => { setAmount(payload ? String(payload.amount) : ''); setDescription(payload?.description || ''); }, []);
  useEffect(() => { restore(intent.restored || devDefaults.current); setResult(null); }, [intent.restored, user?.merchantId, user?.userId, restore]);
  const newOperation = () => { try { intent.startNew(); setResult(null); restore(null); } catch (err) { toast.error(err.message); } };

  const loadWallet = useCallback(() => {
    setWalletState('loading');
    cashApi.getWallet()
      .then(r => { setWallet(r.status === 204 || !r.data?.phone ? null : r.data); setWalletState('ok'); })
      .catch(err => { if (isFeatureUnavailable(err)) setWalletState('unavailable'); else { setWallet(null); setWalletState('ok'); } });
  }, []);
  useEffect(() => { loadWallet(); }, [loadWallet]);

  const amt = Number(amount);
  const available = summary?.balance?.available;
  const remaining = summary?.limits?.withdrawDailyRemaining;
  const minT = summary?.limits?.transferMin;
  const fee = amt > 0 ? previewFee(summary, amt) : null;
  const overBalance = available != null && amt > Number(available);
  const overLimit = remaining != null && amt > Number(remaining);
  const belowMin = minT != null && amt > 0 && amt < Number(minT);
  const amountError = overBalance ? 'Montant supérieur au solde disponible.' : overLimit ? 'Montant supérieur à votre limite journalière restante.' : belowMin ? `Montant minimum ${fmtMoney(minT, currency)}.` : null;
  // Retrait Mobile Money actif dans le pays ? (registre serveur ; l'opérateur du wallet doit l'être aussi)
  const withdrawClosed = !cap.isOpen('withdraw', 'mobile_money') || (wallet?.operator ? !cap.isOpen('withdraw', 'mobile_money', String(wallet.operator).toUpperCase()) : false);
  // A saved order may already have debited the balance. Let its existing key
  // retrieve the result; execute still rejects any changed business payload.
  const canSubmit = amt > 0 && (intent.pending || (!!wallet && !amountError && !withdrawClosed));

  const run = useCallback((confirm) => intent.execute({ amount: amt, description: description || undefined, confirm }, cashApi.withdraw)
    .then(({ data }) => { setResult(data); reload(); if (['unknown', 'processing'].includes(data.status)) toast('Retrait enregistré — en cours de confirmation'); else toast.success('Retrait lancé'); })
    .catch(err => {
      if (isStepUp(err)) throw err;
      const code = err.response?.data?.code;
      if (code === 'WALLET_MISSING') { setWallet(null); setEditing(true); }
      if (isFeatureUnavailable(err)) setBlocked('Retrait indisponible : aucun rail de paiement sortant n’est encore configuré pour l’opérateur de votre wallet. Fonctionnalité en cours d’intégration.');
      else if (code === 'DAILY_LIMIT_EXCEEDED' || code === 'INSUFFICIENT_BALANCE') reload();
      toast.error(errorMessage(err, { currency }));
    }), [amt, description, currency, reload, intent.execute]);
  const submit = (e) => { e?.preventDefault(); if (!canSubmit) return; setBlocked(null); stepUp.request(run); };

  // Outil de développement : ?stepup=1 ouvre la fenêtre de confirmation (captures d'écran).
  useEffect(() => { if (dev?.get('stepup') === '1' && wallet && amt > 0 && !stepUp.state) stepUp.request(run); }, [wallet]);

  if (walletState === 'unavailable' || sumState === 'unavailable') return <div className="narrow"><PageHeader title="Retirer" /><FeatureUnavailable title="Retrait vers mon wallet" /></div>;
  const quick = available != null && amt === 0 ? [0.25, 0.5, 1].map(p => { const cap = Math.min(Number(available), remaining != null ? Number(remaining) : Infinity); return [p, Math.floor(cap * p)]; }).filter(x => x[1] > 0) : [];

  return (
    <div className="narrow">
      <PageHeader title="Retirer" subtitle="Transférez votre solde disponible vers votre wallet Mobile Money. Chaque retrait exige une confirmation forte." actions={<Button size="sm" variant="ghost" to="/compte/tarifs" icon="tag">Voir les frais</Button>} />
      {(intent.pending || intent.error) && <Notice tone={intent.error ? 'error' : 'info'} className="mb-4">
        {intent.error || 'Opération enregistrée dans cet onglet. Réessayez avec les mêmes paramètres pour retrouver son résultat.'}
        {intent.pending && <Button size="sm" onClick={() => restore(intent.payload)}>Reprendre les paramètres</Button>}
        {intent.canStartNew && <Button size="sm" onClick={newOperation}>Nouvelle opération</Button>}
      </Notice>}

      {result && (
        <Card className="mb-4">
          <div className={`big-status ${result.status === 'completed' ? 'success' : 'info'}`}>
            <span className="ic"><Icon name={result.status === 'completed' ? 'check' : 'send'} size={30} /></span>
            <h2>Retrait {statusLabel(result.status).toLowerCase()}</h2>
            <div className="amount">{fmtMoney(result.amount, currency)}</div>
          </div>
          <TransferRecovery transfer={result} onUpdated={fresh => { setResult(fresh); reload(); }} />
          <div className="kv-box mb-4">
            <KV label="Référence" value={result.reference} mono />
            <KV label="Statut" value={<StatusBadge status={result.status} />} />
            <KV label="Frais" value={fmtMoney(result.fee, currency)} />
            <KV label={result.status === 'completed' ? 'Net envoyé' : 'Net'} value={transferNetValue(result, currency)} tone={result.status === 'completed' ? 'success' : undefined} />
            <KV label="Wallet" value={`${opLabel(result.wallet?.operator, result.wallet?.operatorLabel)} ${fmtPhone(result.wallet?.phone)}`} />
          </div>
          <div className="form-actions">
            <Button icon="print" onClick={() => printDoc('Retrait', [['Référence', result.reference], ['Date', fmtDateTime(new Date())], ['Montant', fmtMoney(result.amount, currency)], ['Frais', fmtMoney(result.fee, currency)], ['Net', transferNetValue(result, currency)], ['Wallet', `${opLabel(result.wallet?.operator)} ${result.wallet?.phone || ''}`], ['Statut', statusLabel(result.status)]])}>Imprimer</Button>
            <Button variant="primary" icon="plus" onClick={newOperation}>Nouveau retrait</Button>
          </div>
        </Card>
      )}

      {walletState === 'loading' && <SkeletonCard lines={4} />}
      {walletState === 'ok' && wallet === null && (
        <Card title="Enregistrer mon wallet Mobile Money">
          <Notice tone="warn" className="mb-4">Aucun wallet enregistré. Indiquez le numéro Mobile Money qui recevra vos retraits.</Notice>
          <WalletForm user={user} onSaved={(w) => { setWallet(w); reload(); }} />
        </Card>
      )}
      {editing && wallet && <Modal title="Modifier mon wallet" onClose={() => setEditing(false)}><WalletForm user={user} initial={wallet} onSaved={(w) => { setWallet(w); setEditing(false); reload(); }} onCancel={() => setEditing(false)} /></Modal>}

      {walletState === 'ok' && wallet && !result && (
        <Card>
          {withdrawClosed && <Notice tone="neutral" className="mb-4" icon="clock"><strong>{cap.message}.</strong> Le retrait vers {opLabel(wallet.operator, wallet.operatorLabel)} n’est pas encore activé dans votre pays (intégration en cours).</Notice>}
          <form onSubmit={submit} noValidate>
            <div className="row-between kv-box mb-4" style={{ padding: 'var(--s3) var(--s4)' }}>
              <div style={{ minWidth: 0 }}>
                <div className="xs muted">Wallet de réception</div>
                <div className="strong">{opLabel(wallet.operator, wallet.operatorLabel)} · {fmtPhone(wallet.phone)}</div>
                <div className={`xs ${wallet.verifiedAt ? 'success' : 'warn'}`}>{wallet.verifiedAt ? 'Vérifié' : 'Vérification au premier retrait réussi'}</div>
              </div>
              <Button size="sm" icon="edit" onClick={() => setEditing(true)}>Modifier</Button>
            </div>
            {sumState === 'ok' && (
              <div className="grid-2 keep mb-4">
                <div className="kv-box" style={{ padding: 'var(--s3)' }}><div className="xs muted">Disponible</div><div className="strong success">{fmtMoney(available, currency)}</div></div>
                <div className="kv-box" style={{ padding: 'var(--s3)' }}><div className="xs muted">Reste aujourd’hui</div><div className="strong warn">{remaining != null ? fmtMoney(remaining, currency) : '—'}</div></div>
              </div>
            )}
            <AmountInput label="Montant à retirer" value={amount} onChange={setAmount} currency={currency} error={amountError}
              hint={amt > 0 ? (fee != null ? `Frais ≈ ${fmtMoney(fee, currency)} · net ≈ ${fmtMoney(amt - fee, currency)}` : 'Frais affichés à la confirmation') : (minT != null ? `Minimum ${fmtMoney(minT, currency)}` : undefined)} />
            {quick.length > 0 && <div className="chips mb-4">{quick.map(([p, v]) => <button type="button" key={p} className="chip" onClick={() => setAmount(String(v))}>{p === 1 ? 'Tout' : `${p * 100} %`} · {fmtMoney(v, currency)}</button>)}</div>}
            <Input label="Libellé (facultatif)" value={description} onChange={setDescription} placeholder="Caisse du soir" />
            {blocked && <Notice tone="warn" className="mb-4">{blocked}</Notice>}
            <Button type="submit" variant="primary" size="lg" block disabled={!canSubmit}>{amt > 0 ? `Retirer ${fmtMoney(amt, currency)}` : 'Retirer'}</Button>
          </form>
        </Card>
      )}

      {stepUp.state && <StepUpModal {...stepUp.state} title="Confirmer le retrait" onConfirm={stepUp.confirm} onClose={stepUp.close}
        summary={<><KV label="Montant" value={fmtMoney(amt, currency)} /><KV label="Vers" value={`${opLabel(wallet?.operator)} ${fmtPhone(wallet?.phone)}`} />{fee != null && <KV label="Frais estimés" value={fmtMoney(fee, currency)} />}</>} />}
    </div>
  );
};
export default Retirer;
