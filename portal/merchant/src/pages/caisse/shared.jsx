import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { cashApi, accountApi, authApi, detectApi } from '../../services/api';
import { useStepUp } from '../../hooks/useStepUp';
import { Button, Input, Select, Card, Notice, CopyRow, KV, StepUpModal } from '../../components';
import { fmtMoney, fmtDateTime, fmtPhone, phoneDigits } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { OPERATOR_LABELS, WALLET_OPERATORS, opLabel, countryName } from '../../utils/labels';
import { printDoc } from '../../utils/actions';

// Saisie d'un numéro LOCAL (sans indicatif) : exemple et aide selon le pays du marchand.
export const PHONE_PLACEHOLDERS = { CG: '06 XXX XX XX', CM: '6XX XXX XXX', CI: '07 XX XX XX XX', SN: '77 XXX XX XX', CD: '08X XXX XXXX', GA: '07 XX XX XX', TD: '6X XX XX XX', CF: '7X XX XX XX', GQ: '222 XXX XXX' };
export const phonePlaceholder = (country) => PHONE_PLACEHOLDERS[String(country || '').toUpperCase()] || '+XXX XX XXX XX XX';
const CALLING_CODES = { CG: '242', CM: '237', CI: '225', SN: '221', CD: '243', GA: '241', TD: '235', CF: '236', GQ: '240' };
export const phoneHint = (country) => country ? `Numéro local du client, sans indicatif (+${CALLING_CODES[String(country).toUpperCase()] || '…'} ajouté automatiquement). L'opérateur est reconnu d'après le préfixe.` : 'Numéro au format international (+242 …).';
// Référence d'encaissement proposée par défaut (le serveur en génère une si le champ est vide) : ENC-AAMMJJ-XXXXX
export const suggestReference = (prefix = 'ENC') => {
  const d = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let x = '';
  const buf = new Uint8Array(5); (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(buf) : buf.forEach((_, i) => { buf[i] = Math.floor(Math.random() * 256); });
  for (let i = 0; i < 5; i++) x += A[buf[i] % A.length];
  return `${prefix}-${d}-${x}`;
};

// Détection d'opérateur en direct (debounce 400 ms, annulation des appels précédents).
export const usePhoneDetection = (phone, enabled = true, country = undefined) => {
  const [detect, setDetect] = useState(null);
  const [detecting, setDetecting] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    if (phoneDigits(phone).length < 8) { setDetect(null); setDetecting(false); return undefined; }
    const ctrl = new AbortController();
    const h = setTimeout(() => {
      setDetecting(true);
      detectApi.phone(phone.trim(), ctrl.signal, country)
        .then(r => setDetect(r.data))
        .catch(err => { if (!ctrl.signal.aborted) setDetect(err.response?.data || { success: false, error: 'Détection indisponible' }); })
        .finally(() => { if (!ctrl.signal.aborted) setDetecting(false); });
    }, 400);
    return () => { clearTimeout(h); ctrl.abort(); };
  }, [phone, enabled, country]);
  return { detect, detecting };
};

// Aperçu des frais depuis le résumé (fees.{withdraw|transfer} ou limits.*Fee*).
export const previewFee = (summary, amount, kind = 'withdraw') => {
  const l = summary?.limits || {}; const f = summary?.fees?.[kind] || {};
  const pct = f.percent ?? l[`${kind}FeePercent`]; const fixed = f.fixed ?? l[`${kind}FeeFixed`]; const min = f.min ?? l[`${kind}FeeMin`];
  if (pct == null && fixed == null) return null;
  let fee = (amount * (Number(pct) || 0)) / 100 + (Number(fixed) || 0);
  if (min != null) fee = Math.max(fee, Number(min));
  return Math.round(fee);
};

// Wallet Mobile Money du marchand (destination des retraits, PUT /cash/wallet, step-up).
export const WalletForm = ({ user, initial, onSaved, onCancel }) => {
  const stepUp = useStepUp(user);
  const [operator, setOperator] = useState(initial?.operator || '');
  const [phone, setPhone] = useState(initial?.phone || '');
  const [error, setError] = useState(null);
  const { detect } = usePhoneDetection(phone, true, user?.country);
  useEffect(() => {
    const op = String(detect?.operator || '').toLowerCase();
    if (detect?.success && WALLET_OPERATORS.includes(op)) setOperator(o => o || op);
  }, [detect]);
  const save = (e) => {
    e?.preventDefault();
    if (phoneDigits(phone).length < 8) { setError('Numéro invalide.'); return; }
    if (!operator) { setError('Choisissez l’opérateur.'); return; }
    setError(null);
    stepUp.request(async (confirm) => {
      const { data } = await cashApi.putWallet({ operator, phone: (detect?.phone || phone).trim(), confirm });
      toast.success('Wallet enregistré');
      onSaved(data || { operator, phone });
    });
  };
  return (
    <form onSubmit={save} noValidate>
      <p className="small text-2 mb-4">Vos retraits seront envoyés sur ce numéro. Il sera marqué vérifié après le premier retrait réussi. La modification exige une confirmation forte.</p>
      <Input label="Numéro Mobile Money" type="tel" inputMode="tel" value={phone} onChange={setPhone} placeholder="+237 6XX XXX XXX" autoComplete="off" error={error && phoneDigits(phone).length < 8 ? error : undefined}
        hint={detect?.success ? `${countryName(detect.country)} · ${opLabel(detect.operator, detect.brand)} détecté` : detect && !detect.success ? detect.error : undefined} required />
      <Select label="Opérateur" value={operator} onChange={setOperator} placeholder="— Choisir —" options={WALLET_OPERATORS.map(o => ({ value: o, label: OPERATOR_LABELS[o] }))} error={error && !operator ? error : undefined} required />
      <div className="form-actions">{onCancel && <Button onClick={onCancel}>Annuler</Button>}<Button type="submit" variant="primary">Enregistrer</Button></div>
      {stepUp.state && <StepUpModal {...stepUp.state} title="Confirmer le wallet" onConfirm={stepUp.confirm} onClose={stepUp.close} summary={<KV label="Wallet" value={`${OPERATOR_LABELS[operator] || operator} · ${fmtPhone(phone)}`} />} />}
    </form>
  );
};

// Ajout d'un compte bancaire (POST /bank-accounts).
export const BankAccountForm = ({ user, onSaved, onCancel }) => {
  const stepUp = useStepUp(user);
  const owner = user?.role === 'owner';
  const [institutions, setInstitutions] = useState(null);
  const [form, setForm] = useState({ institutionId: '', accountNumber: '', accountName: '', iban: '' });
  const [errors, setErrors] = useState({});
  const [confirmationAccount, setConfirmationAccount] = useState(null);
  useEffect(() => {
    authApi.institutions(user?.country || 'CG')
      .then(r => setInstitutions((r.data.institutions || []).filter(i => ['bank', 'microfinance', 'cooperative'].includes(i.type))))
      .catch(() => setInstitutions([]));
  }, [user?.country]);
  const f = k => v => { setForm(p => ({ ...p, [k]: v })); setErrors(e => ({ ...e, [k]: undefined })); };
  const save = async (e) => {
    e?.preventDefault();
    if (!owner) return;
    const er = {};
    if (!form.institutionId) er.institutionId = 'Choisissez la banque.';
    if (form.accountName.trim().length < 2) er.accountName = 'Titulaire requis.';
    if (form.accountNumber.replace(/\s/g, '').length < 8) er.accountNumber = 'Numéro de compte invalide.';
    setErrors(er); if (Object.keys(er).length) return;
    setConfirmationAccount({ ...form });
    stepUp.request(async (confirm) => {
      const { data } = await accountApi.addBankAccount({ institutionId: form.institutionId, accountNumber: form.accountNumber.trim(), accountName: form.accountName.trim(), iban: form.iban.trim() || undefined, confirm });
      toast.success('Compte bancaire ajouté — en attente de vérification Cpay'); onSaved(data);
    });
  };
  return (
    <>
    <form onSubmit={save} noValidate>
      <Select label="Banque" value={form.institutionId} onChange={f('institutionId')} placeholder={institutions === null ? 'Chargement…' : '— Choisir —'} error={errors.institutionId} required
        options={(institutions || []).map(i => ({ value: i.institution_id, label: `${i.name}${i.type !== 'bank' ? ` (${i.type})` : ''}` }))}
        hint={institutions && institutions.length === 0 ? 'Aucune institution référencée pour votre pays : contactez le support.' : undefined} />
      <Input label="Titulaire du compte" value={form.accountName} onChange={f('accountName')} placeholder="NOM DE L’ENTREPRISE" error={errors.accountName} required />
      <Input label="Numéro de compte" value={form.accountNumber} onChange={f('accountNumber')} inputMode="numeric" placeholder="30011 00012 12345678901 23" error={errors.accountNumber} mono required />
      <Input label="IBAN (facultatif)" value={form.iban} onChange={v => f('iban')(String(v).toUpperCase())} placeholder="CG39 ..." mono />
      <div className="form-actions">{onCancel && <Button onClick={onCancel}>Annuler</Button>}<Button type="submit" variant="primary" disabled={!owner || !!stepUp.state}>Ajouter</Button></div>
    </form>
      {stepUp.state && <StepUpModal {...stepUp.state} title="Confirmer l’ajout du compte bancaire" onConfirm={stepUp.confirm} onClose={stepUp.close} summary={<KV label="Compte" value={`${confirmationAccount?.accountName} · ${confirmationAccount?.accountNumber}`} />} />}
    </>
  );
};

// Bordereau d'approvisionnement (bank_to_wallet, status awaiting_funds).
export const FundingInstructions = ({ transfer, currency }) => {
  const ins = transfer?.instructions || {};
  const ref = ins.reference || transfer?.reference;
  const cur = transfer.currency || currency;
  const rows = [['Montant à virer', fmtMoney(transfer.amount, cur)], ['Référence à indiquer', ref], ['Banque', ins.bankName], ['Titulaire', ins.accountName], ['Numéro de compte', ins.accountNumber], ['IBAN', ins.iban], ['SWIFT / BIC', ins.swift], ['Valable jusqu’au', ins.expiresAt ? fmtDateTime(ins.expiresAt) : null]];
  return (
    <div>
      <Notice tone="info" icon="bank" className="mb-3">Effectuez un virement de <strong>{fmtMoney(transfer.amount, cur)}</strong> sur le compte ci-dessous en indiquant <strong>impérativement la référence</strong> : votre solde sera crédité dès confirmation de la réception par nos opérations.</Notice>
      <div className="kv-box mb-3">
        <CopyRow label="Référence à indiquer dans le virement" value={ref} highlight />
        <CopyRow label="Montant" value={String(transfer.amount ?? '')} />
        <CopyRow label="Banque" value={ins.bankName} />
        <CopyRow label="Titulaire du compte" value={ins.accountName} />
        <CopyRow label="Numéro de compte" value={ins.accountNumber} />
        {ins.iban && <CopyRow label="IBAN" value={ins.iban} />}
        {ins.swift && <CopyRow label="SWIFT / BIC" value={ins.swift} />}
        {ins.expiresAt && <KV label="Ordre valable jusqu’au" value={fmtDateTime(ins.expiresAt)} />}
      </div>
      <Button block icon="print" onClick={() => printDoc('Ordre d’approvisionnement', rows, 'Indiquez la référence dans le libellé du virement.')}>Imprimer le bordereau</Button>
    </div>
  );
};

export const CaisseCard = ({ children, className = '' }) => <Card className={`narrow ${className}`}>{children}</Card>;
