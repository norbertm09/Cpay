import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { cashApi, accountApi, authApi, detectApi } from '../../services/api';
import { useStepUp } from '../../hooks/useStepUp';
import { Button, Input, Select, Card, Notice, CopyRow, KV, StepUpModal } from '../../components';
import { fmtMoney, fmtDateTime, fmtPhone, phoneDigits } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { OPERATOR_LABELS, WALLET_OPERATORS, opLabel, countryName } from '../../utils/labels';
import { printDoc } from '../../utils/actions';

// Détection d'opérateur en direct (debounce 400 ms, annulation des appels précédents).
export const usePhoneDetection = (phone, enabled = true) => {
  const [detect, setDetect] = useState(null);
  const [detecting, setDetecting] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    if (phoneDigits(phone).length < 8) { setDetect(null); setDetecting(false); return undefined; }
    const ctrl = new AbortController();
    const h = setTimeout(() => {
      setDetecting(true);
      detectApi.phone(phone.trim(), ctrl.signal)
        .then(r => setDetect(r.data))
        .catch(err => { if (!ctrl.signal.aborted) setDetect(err.response?.data || { success: false, error: 'Détection indisponible' }); })
        .finally(() => { if (!ctrl.signal.aborted) setDetecting(false); });
    }, 400);
    return () => { clearTimeout(h); ctrl.abort(); };
  }, [phone, enabled]);
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
  const { detect } = usePhoneDetection(phone);
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
  const [institutions, setInstitutions] = useState(null);
  const [form, setForm] = useState({ institutionId: '', accountNumber: '', accountName: '', iban: '' });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    authApi.institutions(user?.country || 'CG')
      .then(r => setInstitutions((r.data.institutions || []).filter(i => ['bank', 'microfinance', 'cooperative'].includes(i.type))))
      .catch(() => setInstitutions([]));
  }, [user?.country]);
  const f = k => v => { setForm(p => ({ ...p, [k]: v })); setErrors(e => ({ ...e, [k]: undefined })); };
  const save = async (e) => {
    e?.preventDefault();
    const er = {};
    if (!form.institutionId) er.institutionId = 'Choisissez la banque.';
    if (form.accountName.trim().length < 2) er.accountName = 'Titulaire requis.';
    if (form.accountNumber.replace(/\s/g, '').length < 8) er.accountNumber = 'Numéro de compte invalide.';
    setErrors(er); if (Object.keys(er).length) return;
    setSaving(true);
    try {
      const { data } = await accountApi.addBankAccount({ institutionId: form.institutionId, accountNumber: form.accountNumber.trim(), accountName: form.accountName.trim(), iban: form.iban.trim() || undefined });
      toast.success('Compte bancaire ajouté'); onSaved(data);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSaving(false); }
  };
  return (
    <form onSubmit={save} noValidate>
      <Select label="Banque" value={form.institutionId} onChange={f('institutionId')} placeholder={institutions === null ? 'Chargement…' : '— Choisir —'} error={errors.institutionId} required
        options={(institutions || []).map(i => ({ value: i.institution_id, label: `${i.name}${i.type !== 'bank' ? ` (${i.type})` : ''}` }))}
        hint={institutions && institutions.length === 0 ? 'Aucune institution référencée pour votre pays : contactez le support.' : undefined} />
      <Input label="Titulaire du compte" value={form.accountName} onChange={f('accountName')} placeholder="NOM DE L’ENTREPRISE" error={errors.accountName} required />
      <Input label="Numéro de compte" value={form.accountNumber} onChange={f('accountNumber')} inputMode="numeric" placeholder="30011 00012 12345678901 23" error={errors.accountNumber} mono required />
      <Input label="IBAN (facultatif)" value={form.iban} onChange={v => f('iban')(String(v).toUpperCase())} placeholder="CG39 ..." mono />
      <div className="form-actions">{onCancel && <Button onClick={onCancel}>Annuler</Button>}<Button type="submit" variant="primary" loading={saving}>Ajouter</Button></div>
    </form>
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
