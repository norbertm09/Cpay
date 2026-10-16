import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { authApi, setAccessToken } from '../../services/api';
import { Button, Input, PasswordInput, Select, Notice } from '../../components';
import { errorMessage } from '../../utils/errors';
import { COUNTRIES } from '../../utils/labels';
import AuthLayout from '../../layout/AuthLayout';

// Inscription en trois étapes : entreprise, accès, compte de règlement.
const STEPS = ['Entreprise', 'Accès', 'Règlement'];
const cleanDigits = (v) => String(v).replace(/[^0-9]/g, '').slice(0, 12);

export const Register = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ country: 'CG', businessName: '', rccm: '', nif: '', email: '', phone: '', password: '', confirmPassword: '', walletMtn: '', walletAirtel: '', bankAccount: '', institutionId: '', bankName: '', iban: '' });
  const [institutions, setInstitutions] = useState([]);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  const f = (k) => (v) => { setForm(p => ({ ...p, [k]: v })); setErrors(e => ({ ...e, [k]: undefined })); };

  useEffect(() => {
    authApi.institutions(form.country).then(r => setInstitutions((r.data.institutions || []).filter(i => ['bank', 'microfinance', 'cooperative'].includes(i.type)))).catch(() => setInstitutions([]));
  }, [form.country]);

  const validate = () => {
    const e = {};
    if (step === 0) {
      if (form.businessName.trim().length < 2) e.businessName = 'Nom de l’entreprise requis.';
      if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) e.email = 'Adresse e-mail invalide.';
      if (!/^\+?[0-9 ]{8,16}$/.test(form.phone.trim())) e.phone = 'Numéro invalide (format international, ex. +242 06 123 45 67).';
    }
    if (step === 1) {
      if (form.password.length < 10) e.password = '10 caractères minimum.';
      if (form.password !== form.confirmPassword) e.confirmPassword = 'Les deux mots de passe ne correspondent pas.';
    }
    if (step === 2 && !form.walletMtn && !form.walletAirtel && !form.bankAccount) e.walletMtn = 'Renseignez au moins un wallet ou un compte bancaire.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };
  const next = () => { if (validate()) setStep(s => s + 1); };
  const submit = async () => {
    if (!validate()) return;
    setLoading(true); setApiError(null);
    try {
      const body = { ...form, phone: form.phone.replace(/\s/g, ''), iban: form.iban || undefined, rccm: form.rccm || undefined, nif: form.nif || undefined, bankName: form.bankName || undefined };
      delete body.confirmPassword; delete body.institutionId; delete body.country;
      const { data } = await authApi.register(body);
      setAccessToken(data.access_token);
      toast.success('Compte créé. Bienvenue sur C-Pay.');
      navigate('/accept', { replace: true });
    } catch (err) { setApiError(errorMessage(err)); }
    finally { setLoading(false); }
  };
  const onSubmit = (e) => { e.preventDefault(); if (step < 2) next(); else submit(); };
  const currency = (COUNTRIES.find(c => c[0] === form.country) || [])[2] || 'XAF';

  return (
    <AuthLayout title="Créer un compte marchand" lead={`Étape ${step + 1} sur 3 — ${STEPS[step]}`}
      footer={<div className="links"><span>Déjà un compte ? <Link to="/login">Se connecter</Link></span></div>}>
      <div className="steps" aria-hidden="true">{STEPS.map((s, i) => <span key={s} className={i <= step ? 'on' : ''} />)}</div>
      <form onSubmit={onSubmit} noValidate>
        {apiError && <Notice tone="error" className="mb-4">{apiError}</Notice>}
        {step === 0 && (<>
          <Select label="Pays" value={form.country} onChange={v => { setForm(p => ({ ...p, country: v, institutionId: '', bankName: '' })); }} options={COUNTRIES.map(c => ({ value: c[0], label: `${c[1]} (${c[2]})` }))} required />
          <Input label="Nom de l’entreprise" value={form.businessName} onChange={f('businessName')} placeholder="Ma Boutique SARL" error={errors.businessName} required autoFocus />
          <Input label="Adresse e-mail" type="email" value={form.email} onChange={f('email')} placeholder="contact@entreprise.com" autoComplete="email" error={errors.email} required />
          <Input label="Téléphone (Mobile Money)" type="tel" value={form.phone} onChange={f('phone')} placeholder="+242 06 123 45 67" autoComplete="tel" error={errors.phone} hint="Ce numéro détermine votre pays et votre devise de règlement." required />
          <div className="form-grid">
            <Input label="RCCM" value={form.rccm} onChange={f('rccm')} placeholder="CG-BZV-01-2024-B12-00123" hint="Facultatif, demandé pour le KYB." />
            <Input label="NIF" value={form.nif} onChange={f('nif')} placeholder="P0123456789" hint="Facultatif." />
          </div>
          <Button type="submit" variant="primary" size="lg" block iconRight="chevronRight">Continuer</Button>
        </>)}
        {step === 1 && (<>
          <PasswordInput label="Mot de passe" value={form.password} onChange={f('password')} autoComplete="new-password" error={errors.password} hint="10 caractères minimum." required autoFocus />
          <PasswordInput label="Confirmer le mot de passe" value={form.confirmPassword} onChange={f('confirmPassword')} autoComplete="new-password" error={errors.confirmPassword} required />
          <div className="form-actions"><Button size="lg" icon="chevronLeft" onClick={() => setStep(0)}>Retour</Button><Button type="submit" variant="primary" size="lg" iconRight="chevronRight">Continuer</Button></div>
        </>)}
        {step === 2 && (<>
          <Notice tone="info" className="mb-4">C’est ici que vous recevrez vos encaissements, nets de commission (devise {currency}). Au moins un wallet ou un compte bancaire est requis ; vous pourrez en ajouter d’autres plus tard.</Notice>
          <Input label="Wallet MTN MoMo" type="tel" inputMode="numeric" value={form.walletMtn} onChange={v => f('walletMtn')(cleanDigits(v))} placeholder="061234567" error={errors.walletMtn} />
          <Input label="Wallet Airtel Money" type="tel" inputMode="numeric" value={form.walletAirtel} onChange={v => f('walletAirtel')(cleanDigits(v))} placeholder="051234567" />
          <p className="field-label mb-2">Coordonnées bancaires (facultatif)</p>
          <Select label="Institution" value={form.institutionId} placeholder="— Choisir une institution —" onChange={v => { const inst = institutions.find(i => i.institution_id === v); setForm(p => ({ ...p, institutionId: v, bankName: inst ? inst.name : '' })); }}
            options={institutions.map(i => ({ value: i.institution_id, label: `${i.name}${i.type !== 'bank' ? ` (${i.type})` : ''}` }))} />
          <Input label="Numéro de compte (RIB)" value={form.bankAccount} onChange={v => f('bankAccount')(String(v).replace(/[^0-9A-Za-z ]/g, '').toUpperCase())} placeholder="30011 00012 12345678901 23" mono />
          <Input label="IBAN" value={form.iban} onChange={v => f('iban')(String(v).toUpperCase())} placeholder="CG39 3001 1000 1212 3456 7890 123" mono />
          <div className="form-actions"><Button size="lg" icon="chevronLeft" onClick={() => setStep(1)}>Retour</Button><Button type="submit" variant="primary" size="lg" loading={loading}>Créer mon compte</Button></div>
        </>)}
      </form>
    </AuthLayout>
  );
};
export default Register;
