import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { QRCodeSVG } from 'qrcode.react';
import { cashApi, isFeatureUnavailable, isCapabilityBlocked } from '../../services/api';
import { useFinancialIntent } from '../../hooks/useFinancialIntent';
import { useAuth } from '../../hooks/useAuth';
import { useCashSummary } from '../../hooks/useCashSummary';
import { useCapabilities } from '../../hooks/useCapabilities';
import { Button, Card, PageHeader, Input, AmountInput, Segmented, Notice, KV, Icon, Skeleton } from '../../components';
import { fmtMoney, fmtDateTime, fmtPhone, phoneDigits } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { opLabel, countryName, CARD_ACCEPTANCE, statusLabel } from '../../utils/labels';
import { copyText, shareOrCopy, printDoc } from '../../utils/actions';
import { devParams } from '../../utils/dev';
import { usePhoneDetection, phonePlaceholder, phoneHint, suggestReference } from './shared';

const POLL_EVERY_MS = 3000, POLL_MAX_MS = 90000;

// Encaisser : Mobile Money (détection de l'opérateur, push, interrogation du
// statut 3 s / 90 s) ou carte (lien de paiement hébergé + QR).
export const Encaisser = () => {
  const { user } = useAuth();
  const intent = useFinancialIntent(user, 'collect');
  const { summary, state: sumState } = useCashSummary();
  const currency = summary?.currency || user?.currency || 'XAF';
  const cardAcceptance = summary?.profile?.cardAcceptance;
  // Capacités réelles du pays (registre serveur) : méthode / opérateur non actifs désactivés, message explicite.
  const cap = useCapabilities(user?.country);
  const mmOpen = cap.isOpen('collect', 'mobile_money');
  const cardOpen = cap.isOpen('collect', 'card');
  const dev = devParams();
  const devDefaults = useRef({ amount: dev?.get('amount') || '', method: dev?.get('method') || 'mobile_money', customerPhone: dev?.get('phone') || '' });
  const [method, setMethod] = useState(dev?.get('method') || 'mobile_money');
  const [amount, setAmount] = useState(dev?.get('amount') || '');
  const [phone, setPhone] = useState(dev?.get('phone') || '');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState(() => suggestReference('ENC'));
  const [operator, setOperator] = useState(''); // '' = opérateur détecté, sinon alternative forcée
  const [phase, setPhase] = useState('form'); // form | pending | success | failed | timeout | card | card_unavailable
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(POLL_MAX_MS / 1000);
  const [errors, setErrors] = useState({});
  const restore = useCallback((payload) => {
    setMethod(payload?.method || 'mobile_money'); setAmount(payload ? String(payload.amount) : '');
    setPhone(payload?.customerPhone || ''); setDescription(payload?.description || '');
    setReference(payload?.reference || suggestReference('ENC')); setOperator(payload?.operator || '');
  }, []);
  useEffect(() => { restore(intent.restored || devDefaults.current); setResult(null); setPhase('form'); }, [intent.restored, user?.merchantId, user?.userId, restore]);
  const pollRef = useRef(null);
  const country = user?.country || null;
  const { detect, detecting } = usePhoneDetection(phone, method === 'mobile_money', country);
  useEffect(() => { if (!intent.pending) setOperator(''); }, [detect, intent.pending]);

  // Avertissement avant de quitter la page pendant une attente de paiement.
  useEffect(() => {
    if (phase !== 'pending') return undefined;
    const bu = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', bu);
    return () => window.removeEventListener('beforeunload', bu);
  }, [phase]);
  useEffect(() => () => clearInterval(pollRef.current), []);

  // Interrogation du statut : toutes les 3 s pendant 90 s.
  useEffect(() => {
    if (phase !== 'pending' || !result?.txnId) return undefined;
    const started = Date.now();
    setCountdown(POLL_MAX_MS / 1000);
    let stopped = false;
    const stop = (next, data) => { if (stopped) return; stopped = true; clearInterval(pollRef.current); setResult(r => ({ ...r, ...(data || {}) })); setPhase(next); };
    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - started;
      setCountdown(Math.max(0, Math.round((POLL_MAX_MS - elapsed) / 1000)));
      try {
        const { data } = await cashApi.collectStatus(result.txnId);
        if (data.status === 'authorized' || data.status === 'completed') { stop('success', data); toast.success('Paiement confirmé'); return; }
        if (data.status === 'failed' || data.status === 'expired') { stop('failed', data); toast.error(data.status === 'expired' ? 'Paiement expiré' : 'Paiement refusé'); return; }
      } catch (e) { /* on continue jusqu'au délai */ }
      if (Date.now() - started >= POLL_MAX_MS) stop('timeout');
    }, POLL_EVERY_MS);
    return () => clearInterval(pollRef.current);
  }, [phase, result?.txnId]);

  const amt = Number(amount);
  const detectedOk = detect?.success;
  const altList = detect?.alternatives || [];
  const currencyMismatch = detectedOk && detect.currency && detect.currency !== currency;
  const phoneOk = phoneDigits(phone).length >= 8;
  // Opérateur effectivement utilisé (détecté ou alternative choisie) : doit être actif dans le pays
  const effectiveOperator = operator ? operator.toUpperCase() : detect?.operator;
  const operatorClosed = method === 'mobile_money' && detectedOk && !!effectiveOperator && !cap.isOpen('collect', 'mobile_money', effectiveOperator);
  const methodClosed = method === 'mobile_money' ? !mmOpen : !cardOpen;
  const canSubmit = amt > 0 && !loading && (intent.pending || (!methodClosed && !operatorClosed && (method === 'card' || (phoneOk && !currencyMismatch && !detecting))));

  const submit = async (e) => {
    e?.preventDefault();
    const er = {};
    if (!(amt > 0)) er.amount = 'Saisissez un montant.';
    if (method === 'mobile_money' && !phoneOk) er.phone = 'Numéro Mobile Money requis.';
    setErrors(er); if (Object.keys(er).length || !canSubmit) return;
    setLoading(true);
    const body = { amount: amt, currency, method, description: description || undefined, reference: reference || undefined };
    if (method === 'mobile_money') { body.customerPhone = (detect?.phone || phone).trim(); if (operator) body.operator = operator; }
    try {
      const { data } = await intent.execute(body, cashApi.collect);
      if (method === 'card') { setResult(data); setPhase('card'); }
      else { setResult({ ...data, customerPhone: body.customerPhone }); setPhase('pending'); }
    } catch (err) {
      if (method === 'card' && (isFeatureUnavailable(err) || isCapabilityBlocked(err))) setPhase('card_unavailable');
      else toast.error(errorMessage(err, { currency }));
    } finally { setLoading(false); }
  };
  const reset = () => { try { intent.startNew(); setPhase('form'); setResult(null); restore(null); setErrors({}); } catch (err) { toast.error(err.message); } };
  const receiptRows = (r) => [['Référence', r.reference || r.txnId], ['Date', fmtDateTime(r.finalizedAt || r.createdAt || new Date())], ['Montant', fmtMoney(r.amount, r.currency || currency)], ['Frais', fmtMoney(r.fee, r.currency || currency)], ['Net', fmtMoney(r.net, r.currency || currency)], ['Opérateur', opLabel(r.operator, r.operatorLabel)], ['Client', r.customerPhone ? fmtPhone(r.customerPhone) : null], ['Statut', statusLabel(r.status)]];
  const cur = result?.currency || currency;

  const detectBox = () => {
    if (method !== 'mobile_money' || !phoneOk) return null;
    if (detecting && !detect) return <div className="row small muted mb-4"><span className="spinner" style={{ width: 14, height: 14 }} />Détection de l’opérateur…</div>;
    if (!detect) return null;
    if (!detect.success) return <Notice tone="warn" className="mb-4">{detect.error || 'Numéro non reconnu'}{detect.countryName ? ` — ${detect.countryName}` : ''}</Notice>;
    return (
      <div className="mb-4">
        <Notice tone={currencyMismatch || operatorClosed ? 'error' : 'success'} icon="smartphone">
          <div><strong>{opLabel(detect.operator, detect.brand)}</strong> · {detect.countryName || countryName(detect.country)} · {detect.currency}</div>
          {currencyMismatch && <div className="mt-2">Ce numéro est en {detect.currency}, votre caisse est en {currency} : encaissement impossible.</div>}
          {!currencyMismatch && operatorClosed && <div className="mt-2">{opLabel(effectiveOperator)} : {cap.message.toLowerCase()} (intégration en cours).</div>}
        </Notice>
        {altList.length > 0 && !currencyMismatch && (
          <div className="mt-3">
            <p className="field-label mb-2">Service choisi par le client</p>
            <Segmented compact value={operator} onChange={setOperator} ariaLabel="Service Mobile Money" options={[{ value: '', label: opLabel(detect.operator, detect.brand), sub: 'détecté' }, ...altList.map(a => ({ value: String(a.operator || '').toLowerCase(), label: a.brand || opLabel(a.operator) }))]} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="narrow">
      <PageHeader title="Encaisser" subtitle="Encaissez une vente par Mobile Money ou par carte. Le client confirme sur son téléphone." actions={<Button size="sm" variant="ghost" to="/compte/tarifs" icon="tag">Voir les frais</Button>} />
      {(intent.pending || intent.error) && <Notice tone={intent.error ? 'error' : 'info'} className="mb-4">
        {intent.error || 'Opération enregistrée dans cet onglet. Réessayez avec les mêmes paramètres pour retrouver son résultat.'}
        {intent.pending && <Button size="sm" onClick={() => { restore(intent.payload); setPhase('form'); }}>Reprendre les paramètres</Button>}
        {intent.canStartNew && <Button size="sm" onClick={reset}>Nouvelle opération</Button>}
      </Notice>}
      {sumState === 'unavailable' && <Notice tone="warn" className="mb-4">Résumé de caisse indisponible (en cours d’intégration). L’encaissement reste possible.</Notice>}

      {phase === 'form' && (
        <Card>
          <form onSubmit={submit} noValidate>
            <AmountInput label="Montant à encaisser" value={amount} onChange={v => { setAmount(v); setErrors(e => ({ ...e, amount: undefined })); }} currency={currency} autoFocus error={errors.amount} />
            <Segmented value={method} onChange={setMethod} ariaLabel="Moyen de paiement" options={[
              { value: 'mobile_money', icon: 'smartphone', label: 'Mobile Money', sub: !mmOpen ? 'non disponible' : cap.isPilot('collect', 'mobile_money') ? 'pilote' : undefined, disabled: !mmOpen && method !== 'mobile_money' },
              { value: 'card', icon: 'card', label: 'Carte', sub: !cardOpen ? 'non disponible' : sumState === 'loading' ? undefined : cardAcceptance === 'unavailable' ? 'indisponible' : 'lien de paiement', disabled: !cardOpen && method !== 'card' },
            ]} />
            {methodClosed && <Notice tone="neutral" className="mb-4" icon="clock"><strong>{cap.message}.</strong> {method === 'card' ? 'Aucune passerelle carte n’est active dans votre pays (intégration en cours).' : 'Les opérateurs Mobile Money de votre pays sont en cours d’intégration.'}{cap.countryInfo ? ` Pays du compte : ${cap.countryInfo.name}.` : ''}</Notice>}
            {method === 'mobile_money' && (<>
              <Input label="Numéro Mobile Money du client" type="tel" inputMode="tel" value={phone} onChange={v => { setPhone(v); setErrors(e => ({ ...e, phone: undefined })); }} placeholder={phonePlaceholder(country)} hint={!errors.phone && !detect ? phoneHint(country) : undefined} autoComplete="off" error={errors.phone} required />
              {detectBox()}
            </>)}
            {method === 'card' && (
              <Notice tone={CARD_ACCEPTANCE[cardAcceptance]?.tone || 'info'} icon="card" className="mb-4">
                {sumState === 'loading' ? <Skeleton height={14} /> : (CARD_ACCEPTANCE[cardAcceptance]?.text || 'Un lien de paiement sécurisé sera généré : le client paie par carte depuis son téléphone (QR ou lien).')}
              </Notice>
            )}
            <div className="form-grid">
              <Input label="Référence (générée automatiquement, modifiable)" value={reference} onChange={setReference} placeholder="ENC-261101-XXXXX" hint="Remplacez-la par votre numéro de facture ou de ticket si vous en avez un." />
              <Input label="Description (facultatif)" value={description} onChange={setDescription} placeholder="Vente comptoir" />
            </div>
            <Button type="submit" variant="primary" size="lg" block loading={loading} disabled={!canSubmit}>
              {method === 'card' ? 'Générer le lien carte' : 'Demander le paiement'}{amt > 0 ? ` · ${fmtMoney(amt, currency)}` : ''}
            </Button>
          </form>
        </Card>
      )}

      {phase === 'pending' && result && (
        <Card>
          <div className="big-status warn" aria-live="polite">
            <span className="ic"><Icon name="smartphone" size={30} /></span>
            <h2>En attente de validation du client</h2>
            <p className="small text-2">Le client <strong>{fmtPhone(result.customerPhone)}</strong> doit confirmer le paiement de <strong>{fmtMoney(result.amount, cur)}</strong> sur son téléphone ({opLabel(result.operator, result.operatorLabel)}).</p>
            <div className="countdown mt-4">{countdown} s</div>
            <p className="xs muted mono mt-2">Réf. {result.txnId}</p>
          </div>
        </Card>
      )}

      {phase === 'success' && result && (
        <Card>
          <div className="big-status success">
            <span className="ic"><Icon name="check" size={30} /></span>
            <h2>Paiement confirmé</h2>
            <div className="amount">{fmtMoney(result.amount, cur)}</div>
          </div>
          <div className="kv-box mb-4">
            <KV label="Frais" value={fmtMoney(result.fee, cur)} />
            <KV label="Net crédité" value={fmtMoney(result.net, cur)} tone="success" />
            <KV label="Opérateur" value={opLabel(result.operator, result.operatorLabel)} />
            <KV label="Client" value={fmtPhone(result.customerPhone)} />
            <KV label="Référence" value={result.reference || result.txnId} mono />
          </div>
          <div className="form-actions"><Button icon="print" onClick={() => printDoc('Reçu', receiptRows(result))}>Imprimer le reçu</Button><Button variant="primary" icon="plus" onClick={reset}>Nouvel encaissement</Button></div>
          {result.receiptUrl && <p className="center small mt-3"><a href={result.receiptUrl} target="_blank" rel="noreferrer">Reçu en ligne</a></p>}
        </Card>
      )}

      {phase === 'failed' && result && (
        <Card>
          <div className="big-status error">
            <span className="ic"><Icon name="close" size={30} /></span>
            <h2>{result.status === 'expired' ? 'Paiement expiré' : 'Paiement refusé'}</h2>
            <p className="small text-2">{result.message || 'Le client n’a pas validé le paiement. Vous pouvez réessayer.'}</p>
            <p className="xs muted mono mt-2">Réf. {result.txnId}</p>
          </div>
          <Button variant="primary" size="lg" block onClick={reset}>Nouvel encaissement</Button>
        </Card>
      )}

      {phase === 'timeout' && result && (
        <Card>
          <div className="big-status warn">
            <span className="ic"><Icon name="clock" size={30} /></span>
            <h2>En attente de confirmation</h2>
            <p className="small text-2">Le client n’a pas encore validé. Le paiement sera comptabilisé automatiquement dès confirmation de l’opérateur : suivez-le dans le journal.</p>
            <p className="xs muted mono mt-2">Réf. {result.txnId}</p>
          </div>
          <div className="form-actions"><Button to="/activite/journal" icon="book">Voir le journal</Button><Button variant="primary" icon="plus" onClick={reset}>Nouvel encaissement</Button></div>
        </Card>
      )}

      {phase === 'card' && result && (
        <Card>
          <div className="center">
            <h2>Lien de paiement par carte</h2>
            <div className="amount" style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700, margin: 'var(--s2) 0 var(--s4)' }}>{fmtMoney(result.amount || amt, cur)}</div>
            {result.payLink?.shortUrl ? (<>
              <div className="qr-box mb-3"><QRCodeSVG value={result.payLink.shortUrl} size={200} level="M" /></div>
              <p className="small mono mb-4" style={{ wordBreak: 'break-all' }}><a href={result.payLink.shortUrl} target="_blank" rel="noreferrer">{result.payLink.shortUrl}</a></p>
              <div className="form-actions"><Button icon="copy" onClick={() => copyText(result.payLink.shortUrl, 'Lien copié')}>Copier</Button><Button variant="brand" icon="share" onClick={() => shareOrCopy({ title: 'Paiement C-Pay', text: `Payer ${fmtMoney(result.amount || amt, cur)}`, url: result.payLink.shortUrl })}>Partager</Button></div>
              {result.payLink.expiresAt && <p className="xs muted mt-3">Expire le {fmtDateTime(result.payLink.expiresAt)}</p>}
              <p className="small muted mt-2">Le paiement apparaîtra dans le journal une fois réglé par le client.</p>
            </>) : <Notice tone="warn">Lien créé mais adresse absente de la réponse. Consultez <Link to="/ventes/liens">vos liens de paiement</Link>.</Notice>}
            <Button variant="primary" size="lg" block className="mt-4" icon="plus" onClick={reset}>Nouvel encaissement</Button>
          </div>
        </Card>
      )}

      {phase === 'card_unavailable' && (
        <Card>
          <Notice tone="neutral" className="mb-4"><strong>Paiement par carte non disponible dans votre pays pour le moment.</strong><br />Aucune passerelle carte n’est encore configurée pour votre pays (Tap-to-Phone : bientôt, après certification). Encaissez par Mobile Money.</Notice>
          <Button variant="primary" size="lg" block onClick={() => { setPhase('form'); if (!intent.pending) setMethod('mobile_money'); }}>Revenir au formulaire</Button>
        </Card>
      )}
    </div>
  );
};
export default Encaisser;
