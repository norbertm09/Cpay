import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Card, Button, Input, AmountInput, PinInput, Alert, Steps, Icon, Badge } from '../../components';
import QrScanner from './QrScanner';
import * as ops from '../../services/operations';
import { formatMoney, formatDateTime } from '../../utils/format';
import { errorMessage, isFeatureDisabled } from '../../utils/errors';
import { amountIssue, parseAmount, isPin } from '../../utils/validation';
import { PAY_LINK_HOSTS } from '../../utils/features';

const FEE_RATE = 0.005; // frais paiement marchand 0,5 % (backend)
const STEPS = ['Commerçant', 'Montant', 'Confirmation'];
const QUICK = [1000, 2000, 5000, 10000];

/** Interprete le contenu d'un QR ou d'une saisie : marchand, lien de paiement ou JSON C-Pay. */
const parseTarget = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (j && (j.merchantId || j.merchant_id)) return { kind: 'merchant', merchantId: j.merchantId || j.merchant_id, amount: j.amount ? String(j.amount) : '', description: j.description || '', name: j.merchantName || j.name || '' };
  } catch (e) { /* pas du JSON */ }
  try {
    const u = new URL(text.includes('://') ? text : `https://${text}`);
    if (PAY_LINK_HOSTS.includes(u.hostname)) {
      const seg = u.pathname.split('/').filter(Boolean);
      const shortId = (seg[seg.length - 1] || '').toUpperCase();
      if (/^[A-Z0-9]{6,10}$/.test(shortId)) return { kind: 'paylink', shortId };
    }
    const m = u.searchParams.get('merchantId') || u.searchParams.get('m');
    if (m) return { kind: 'merchant', merchantId: m, amount: u.searchParams.get('amount') || '', description: u.searchParams.get('description') || '' };
  } catch (e) { /* pas une URL */ }
  if (/^[A-Z0-9]{6,10}$/.test(text) && !/^[0-9a-f-]{36}$/i.test(text) && !text.includes('-')) return { kind: 'paylink', shortId: text.toUpperCase() };
  return { kind: 'merchant', merchantId: text, amount: '', description: '' };
};

export default function PayPage() {
  useDocumentTitle('Payer');
  const { user, patchCard } = useAuth();
  const navigate = useNavigate();
  const card = user?.card;
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState('scan'); // scan | manual
  const [scanSupported, setScanSupported] = useState(true);
  const [manual, setManual] = useState('');
  const [target, setTarget] = useState(null);
  const [payLink, setPayLink] = useState(null);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [pin, setPin] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState(null);

  const amountNum = parseAmount(amount);
  const fee = Number.isFinite(amountNum) ? Math.round(amountNum * FEE_RATE) : 0;
  const total = Number.isFinite(amountNum) ? amountNum + fee : 0;
  const balance = Number(card?.balance ?? 0);
  const cardBlocked = card && card.status !== 'active';

  const applyTarget = useCallback(async (raw) => {
    const t = parseTarget(raw);
    if (!t) { setErrors({ manual: 'Saisissez un code commerçant ou un lien de paiement.' }); return; }
    setErrors({}); setFormError('');
    if (t.kind === 'paylink') {
      setBusy(true);
      try { const st = await ops.payLinkStatus(t.shortId); setPayLink({ ...st, shortId: t.shortId }); setTarget(t); }
      catch (err) { setFormError(errorMessage(err, 'Ce lien de paiement est introuvable ou a expiré.')); }
      finally { setBusy(false); }
      return;
    }
    setTarget(t);
    if (t.amount) setAmount(String(t.amount));
    if (t.description) setDescription(t.description);
    setStep(1);
  }, []);

  const onScan = useCallback((text) => { applyTarget(text); }, [applyTarget]);
  const onUnsupported = useCallback(() => { setScanSupported(false); setMode('manual'); }, []);

  const goConfirm = () => {
    const ai = amountIssue(amount, { min: 100 });
    if (ai) { setErrors({ amount: ai }); return; }
    if (total > balance) { setErrors({ amount: `Solde insuffisant (frais inclus : ${formatMoney(total, card?.currency)}).` }); return; }
    setErrors({}); setStep(2);
  };

  const confirm = async () => {
    if (!isPin(pin)) { setErrors({ pin: 'Saisissez votre code PIN à 4 chiffres.' }); return; }
    setBusy(true); setFormError(''); setErrors({});
    try {
      const data = await ops.pay({ merchantId: target.merchantId, amount: amountNum, description: description || undefined, pin });
      setResult(data);
      if (typeof data.newBalance === 'number') patchCard({ balance: data.newBalance });
      setPin('');
    } catch (err) {
      setFormError(isFeatureDisabled(err) ? errorMessage(err) : errorMessage(err, 'Paiement refusé.'));
      setPin('');
    } finally { setBusy(false); }
  };

  const reset = () => { setStep(0); setTarget(null); setPayLink(null); setAmount(''); setDescription(''); setPin(''); setErrors({}); setFormError(''); setResult(null); setManual(''); };

  const merchantLabel = useMemo(() => target?.name || (target?.merchantId ? `Commerçant ${String(target.merchantId).slice(0, 8)}…` : ''), [target]);

  if (result) {
    const txn = result.txn || {};
    return (
      <div className="pay-layout stack" style={{ gap: 20 }}>
        <Card>
          <div className="center">
            <div className="success-ring"><Icon name="check" size={34} /></div>
            <h1 style={{ fontSize: 22 }}>Paiement effectué</h1>
            <p className="muted small">Merci. Votre reçu est disponible ci-dessous.</p>
          </div>
          <div className="receipt" style={{ marginTop: 20 }}>
            <div className="center rc-amount">{formatMoney(txn.amount ?? amountNum, txn.currency || card?.currency)}</div>
            <div className="center small muted" style={{ marginBottom: 16 }}>{txn.merchant_name || merchantLabel}</div>
            <dl className="kv">
              <dt>Date</dt><dd>{formatDateTime(txn.completed_at || Date.now())}</dd>
              <dt>Frais</dt><dd>{formatMoney(txn.fee ?? fee, txn.currency || card?.currency)}</dd>
              <dt>Total débité</dt><dd className="strong">{formatMoney(Number(txn.amount ?? amountNum) + Number(txn.fee ?? fee), txn.currency || card?.currency)}</dd>
              <dt>Code d’autorisation</dt><dd className="mono">{result.authCode || txn.auth_code || '—'}</dd>
              <dt>Référence</dt><dd className="mono xs">{txn.txn_id || '—'}</dd>
              <dt>Nouveau solde</dt><dd className="strong">{formatMoney(result.newBalance, card?.currency)}</dd>
              {description ? <><dt>Description</dt><dd>{description}</dd></> : null}
            </dl>
          </div>
          <div className="row wrap no-print" style={{ marginTop: 20 }}>
            <Button variant="primary" icon="send" onClick={reset}>Nouveau paiement</Button>
            <Button variant="outline" icon="printer" onClick={() => window.print()}>Imprimer le reçu</Button>
            <Button variant="ghost" onClick={() => navigate('/operations')}>Voir mes opérations</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="pay-layout stack" style={{ gap: 20 }}>
      <div>
        <h1>Payer un commerçant</h1>
        <p className="muted small">Scannez le QR code du commerçant ou saisissez son code, puis confirmez avec votre PIN.</p>
      </div>
      {cardBlocked ? (
        <Alert tone="warn" title="Carte non active" action={<Button size="sm" variant="outline" to="/cartes">Gérer ma carte</Button>}>
          Votre carte est {card.status === 'frozen' ? 'gelée' : 'inactive'} : les paiements sont bloqués.
        </Alert>
      ) : null}
      <Card>
        <Steps steps={STEPS} current={step} />
        {formError ? <Alert tone={formError.includes('intégration') ? 'warn' : 'error'}>{formError}</Alert> : null}

        {step === 0 ? (
          <div className="stack">
            {scanSupported ? (
              <div className="seg" role="tablist" aria-label="Mode de saisie">
                <button type="button" role="tab" aria-pressed={mode === 'scan'} onClick={() => setMode('scan')}><Icon name="camera" size={16} /> Scanner</button>
                <button type="button" role="tab" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}><Icon name="keyboard" size={16} /> Saisir un code</button>
              </div>
            ) : <p className="small muted">La lecture de QR code n’est pas disponible sur ce navigateur : saisissez le code du commerçant.</p>}

            {mode === 'scan' && scanSupported ? <QrScanner active={mode === 'scan' && !payLink} onResult={onScan} onUnsupported={onUnsupported} /> : null}

            {payLink ? (
              <Alert tone="info" title={`Lien de paiement ${payLink.shortId}`}>
                <div className="stack-sm">
                  <span>Montant : <strong>{formatMoney(payLink.amount, payLink.currency)}</strong> · statut : <Badge tone={payLink.status === 'pending' ? 'badge-warn' : payLink.status === 'paid' ? 'badge-success' : ''}>{payLink.status}</Badge></span>
                  <span>Le règlement d’un lien de paiement avec le solde de votre carte C-Pay est en cours d’intégration. Vous pouvez régler ce lien par Mobile Money sur sa page sécurisée.</span>
                  <div className="row wrap">
                    <Button size="sm" variant="secondary" href={`https://pay.c-pay.global/${payLink.shortId}`} target="_blank" rel="noreferrer" iconRight="external-link">Ouvrir le lien</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setPayLink(null); setTarget(null); }}>Autre commerçant</Button>
                  </div>
                </div>
              </Alert>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); applyTarget(manual); }} noValidate className="stack">
                <Input label="Code commerçant ou lien de paiement" value={manual} onChange={(e) => { setManual(e.target.value); setErrors({}); }} error={errors.manual} placeholder="Identifiant du commerçant ou pay.c-pay.global/XXXXXX" prefixIcon="hash" autoComplete="off" />
                <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={cardBlocked} iconRight="arrow-right">Continuer</Button>
              </form>
            )}
          </div>
        ) : null}

        {step === 1 ? (
          <form onSubmit={(e) => { e.preventDefault(); goConfirm(); }} noValidate className="stack">
            <div className="pay-merchant">
              <span className="pm-icon"><Icon name="shopping-bag" size={20} /></span>
              <div className="grow">
                <div className="strong small">{merchantLabel}</div>
                <div className="xs muted mono truncate">{target?.merchantId}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setStep(0)}>Modifier</Button>
            </div>
            <AmountInput value={amount} onChange={(e) => { setAmount(e.target.value); setErrors({}); }} error={errors.amount} currency={card?.currency || 'XAF'} autoFocus
              hint={`Solde disponible : ${formatMoney(balance, card?.currency)} · frais ${(FEE_RATE * 100).toLocaleString('fr-FR')} %`} />
            <div className="chips" aria-label="Montants rapides">
              {QUICK.map((q) => <button key={q} type="button" className="chip" aria-pressed={amountNum === q} onClick={() => { setAmount(String(q)); setErrors({}); }}>{formatMoney(q, card?.currency)}</button>)}
            </div>
            <Input label="Description (facultatif)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={80} placeholder="Ex. courses du marché" />
            <Button type="submit" variant="primary" size="lg" block disabled={cardBlocked} iconRight="arrow-right">Continuer</Button>
          </form>
        ) : null}

        {step === 2 ? (
          <form onSubmit={(e) => { e.preventDefault(); confirm(); }} noValidate className="stack">
            <div className="pay-summary">
              <div className="ps-row"><span className="muted">Commerçant</span><span className="strong">{merchantLabel}</span></div>
              <div className="ps-row"><span className="muted">Montant</span><span>{formatMoney(amountNum, card?.currency)}</span></div>
              <div className="ps-row"><span className="muted">Frais ({(FEE_RATE * 100).toLocaleString('fr-FR')} %)</span><span>{formatMoney(fee, card?.currency)}</span></div>
              {description ? <div className="ps-row"><span className="muted">Description</span><span>{description}</span></div> : null}
              <div className="ps-row ps-total"><span>Total débité</span><span>{formatMoney(total, card?.currency)}</span></div>
              <div className="ps-row xs"><span className="muted">Solde après paiement</span><span>{formatMoney(balance - total, card?.currency)}</span></div>
            </div>
            <div className="field">
              <span className="field-label center">Confirmez avec votre code PIN</span>
              <PinInput value={pin} onChange={(v) => { setPin(v); setErrors({}); }} autoFocus />
              {errors.pin ? <div className="field-error center" role="alert">{errors.pin}</div> : null}
            </div>
            <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={cardBlocked} icon="lock">Payer {formatMoney(total, card?.currency)}</Button>
            <Button variant="ghost" onClick={() => setStep(1)} disabled={busy}>Modifier le montant</Button>
          </form>
        ) : null}
      </Card>
      <p className="xs muted center">Les paiements sont protégés par votre code PIN. En cas de doute sur une opération, déposez une réclamation depuis l’aide.</p>
    </div>
  );
}
