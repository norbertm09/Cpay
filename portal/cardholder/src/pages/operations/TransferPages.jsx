import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Card, Button, Input, Select, AmountInput, PinInput, Alert, PageHeader, FeatureDisabled, Icon } from '../../components';
import * as ops from '../../services/operations';
import { formatMoney, formatPhone } from '../../utils/format';
import { errorMessage, isFeatureDisabled } from '../../utils/errors';
import { amountIssue, parseAmount, isPhone, isPin } from '../../utils/validation';
import { FEATURES } from '../../utils/features';
import { OPERATORS } from '../../utils/txn';

/**
 * Rechargement (Mobile Money -> carte) et retrait (carte -> Mobile Money).
 * Les deux sont desactives cote backend (410 FEATURE_DISABLED) : l'ecran
 * presente l'etat « en cours d'integration » tant que le drapeau n'est pas leve,
 * et retombe sur ce meme etat si l'API repond 410.
 */
const TransferForm = ({ kind }) => {
  const isTopup = kind === 'topup';
  const { user, patchCard } = useAuth();
  const navigate = useNavigate();
  const card = user?.card;
  const [f, setF] = useState({ amount: '', operator: 'mtn', phone: user?.phone || '', pin: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [formError, setFormError] = useState('');
  const [done, setDone] = useState(null);
  const rate = isTopup ? 0.01 : 0.015;
  const n = parseAmount(f.amount);
  const fee = Number.isFinite(n) ? Math.round(n * rate) : 0;

  if (disabled) return <Card><FeatureDisabled backTo="/operations" /></Card>;

  const submit = async (e) => {
    e.preventDefault();
    const er = {};
    const ai = amountIssue(f.amount, { min: 500, max: isTopup ? undefined : Number(card?.balance) });
    if (ai) er.amount = ai;
    if (!isPhone(f.phone)) er.phone = 'Numéro Mobile Money invalide';
    if (!isTopup && !isPin(f.pin)) er.pin = 'Code PIN à 4 chiffres requis';
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true); setFormError('');
    try {
      const payload = { amount: n, operator: f.operator, phone: f.phone.replace(/\s/g, ''), ...(isTopup ? {} : { pin: f.pin }) };
      const data = isTopup ? await ops.topup(payload) : await ops.unload(payload);
      if (typeof data.newBalance === 'number') patchCard({ balance: data.newBalance });
      setDone(data);
      toast.success(isTopup ? 'Carte rechargée' : 'Transfert effectué');
    } catch (err) {
      if (isFeatureDisabled(err)) { setDisabled(true); return; }
      setFormError(errorMessage(err));
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <Card>
        <div className="center">
          <div className="success-ring"><Icon name="check" size={34} /></div>
          <h2>{isTopup ? 'Rechargement effectué' : 'Transfert effectué'}</h2>
        </div>
        <div className="receipt" style={{ marginTop: 20 }}>
          <dl className="kv">
            <dt>Montant</dt><dd>{formatMoney(n, card?.currency)}</dd>
            <dt>Frais</dt><dd>{formatMoney(done.fee ?? fee, card?.currency)}</dd>
            <dt>{isTopup ? 'Net crédité' : 'Net envoyé'}</dt><dd className="strong">{formatMoney(isTopup ? done.credited : done.sent, card?.currency)}</dd>
            <dt>Référence</dt><dd className="mono">{done.mmReference || '—'}</dd>
            <dt>Nouveau solde</dt><dd className="strong">{formatMoney(done.newBalance, card?.currency)}</dd>
          </dl>
        </div>
        <div className="row wrap" style={{ marginTop: 20 }}>
          <Button variant="primary" onClick={() => navigate('/operations')}>Voir mes opérations</Button>
          <Button variant="outline" onClick={() => { setDone(null); setF({ ...f, amount: '', pin: '' }); }}>Nouvelle opération</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={submit} noValidate className="stack">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <AmountInput value={f.amount} onChange={(e) => { setF({ ...f, amount: e.target.value }); setErrors({ ...errors, amount: undefined }); }} error={errors.amount} currency={card?.currency || 'XAF'}
          hint={`Minimum 500 XAF · frais ${(rate * 100).toLocaleString('fr-FR')} % (${formatMoney(fee, card?.currency)})${isTopup ? '' : ` · solde ${formatMoney(card?.balance, card?.currency)}`}`} autoFocus />
        <Select label="Opérateur Mobile Money" value={f.operator} onChange={(e) => setF({ ...f, operator: e.target.value })} options={OPERATORS} />
        <Input label="Numéro Mobile Money" type="tel" inputMode="tel" value={f.phone} onChange={(e) => { setF({ ...f, phone: e.target.value }); setErrors({ ...errors, phone: undefined }); }} error={errors.phone} hint={user?.phone ? `Votre numéro de compte : ${formatPhone(user.phone)}` : undefined} prefixIcon="smartphone" />
        {!isTopup ? (
          <div className="field">
            <span className="field-label center">Code PIN</span>
            <PinInput value={f.pin} onChange={(v) => { setF({ ...f, pin: v }); setErrors({ ...errors, pin: undefined }); }} />
            {errors.pin ? <div className="field-error center" role="alert">{errors.pin}</div> : null}
          </div>
        ) : null}
        <Button type="submit" variant="primary" size="lg" block loading={busy}>{isTopup ? 'Recharger ma carte' : 'Transférer vers Mobile Money'}</Button>
      </form>
    </Card>
  );
};

export function TopupPage() {
  useDocumentTitle('Recharger');
  return (
    <div className="pay-layout stack" style={{ gap: 20 }}>
      <PageHeader title="Recharger ma carte" subtitle="Depuis votre compte Mobile Money vers votre carte C-Pay." back={{ to: '/operations', label: 'Opérations' }} />
      {FEATURES.topup ? <TransferForm kind="topup" /> : (
        <Card>
          <FeatureDisabled icon="arrow-down-left" title="Rechargement en cours d’intégration" backTo="/operations"
            message="Le rechargement de votre carte par Mobile Money (MTN, Orange, Airtel…) est en cours de raccordement avec les opérateurs. Nous vous préviendrons dès son ouverture." />
        </Card>
      )}
    </div>
  );
}

export function UnloadPage() {
  useDocumentTitle('Retirer');
  return (
    <div className="pay-layout stack" style={{ gap: 20 }}>
      <PageHeader title="Retirer vers Mobile Money" subtitle="Transférez le solde de votre carte vers votre compte Mobile Money." back={{ to: '/operations', label: 'Opérations' }} />
      {FEATURES.unload ? <TransferForm kind="unload" /> : (
        <Card>
          <FeatureDisabled icon="arrow-up-right" title="Retrait en cours d’intégration" backTo="/operations"
            message="Le transfert de votre carte vers Mobile Money est en cours de raccordement avec les opérateurs. Votre solde reste disponible pour vos paiements marchands." />
        </Card>
      )}
    </div>
  );
}
