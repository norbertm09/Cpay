import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Button, Input, PasswordInput, Select, Checkbox, Alert, Steps, Icon } from '../../components';
import * as authApi from '../../services/auth';
import { setToken } from '../../services/api';
import { errorMessage } from '../../utils/errors';
import { isEmail, isPhone, passwordIssues, passwordScore } from '../../utils/validation';
import { LEGAL_CGU_URL, LEGAL_PRIVACY_URL } from '../../utils/features';

const COUNTRIES = [
  { value: 'CM', label: 'Cameroun' }, { value: 'CG', label: 'Congo' }, { value: 'GA', label: 'Gabon' },
  { value: 'TD', label: 'Tchad' }, { value: 'CF', label: 'Centrafrique' }, { value: 'GQ', label: 'Guinée équatoriale' },
  { value: 'CD', label: 'RD Congo' }, { value: 'CI', label: 'Côte d’Ivoire' }, { value: 'SN', label: 'Sénégal' },
];
const ID_TYPES = [
  { value: 'national_id', label: 'Carte nationale d’identité' },
  { value: 'passport', label: 'Passeport' },
  { value: 'driver_license', label: 'Permis de conduire' },
  { value: 'residence_permit', label: 'Carte de séjour' },
];
const STEPS = ['Identité', 'Sécurité', 'Confirmation'];

const Strength = ({ pwd }) => {
  const s = passwordScore(pwd);
  return <div className="strength" aria-hidden="true">{[1, 2, 3].map((i) => <span key={i} className={s >= i ? `on-${s}` : ''} />)}</div>;
};

export default function RegisterPage() {
  useDocumentTitle('Créer un compte');
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ firstName: '', lastName: '', phone: '', email: '', dateOfBirth: '', country: 'CM', idType: 'national_id', idNumber: '', password: '', confirm: '', cgu: false });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [done, setDone] = useState(null);
  const set = (k) => (e) => { const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value; setF((p) => ({ ...p, [k]: v })); setErrors((er) => ({ ...er, [k]: undefined })); };

  const validateStep = () => {
    const er = {};
    if (step === 0) {
      if (!f.firstName.trim()) er.firstName = 'Prénom requis';
      if (!f.lastName.trim()) er.lastName = 'Nom requis';
      if (!isPhone(f.phone)) er.phone = 'Numéro de téléphone invalide (indicatif inclus, ex. +237…)';
      if (!isEmail(f.email)) er.email = 'Adresse e-mail invalide';
      if (f.dateOfBirth) {
        const age = (Date.now() - new Date(f.dateOfBirth).getTime()) / (365.25 * 86400000);
        if (!(age >= 18)) er.dateOfBirth = 'Vous devez être majeur pour ouvrir un compte';
      }
    }
    if (step === 1) {
      const issues = passwordIssues(f.password);
      if (issues.length) er.password = `Le mot de passe doit contenir : ${issues.join(', ')}.`;
      if (f.password !== f.confirm) er.confirm = 'Les deux mots de passe ne correspondent pas';
      if (!f.cgu) er.cgu = 'Vous devez accepter les conditions pour continuer';
    }
    setErrors(er);
    return Object.keys(er).length === 0;
  };

  const next = (e) => { e.preventDefault(); if (validateStep()) setStep((s) => s + 1); };

  const submit = async (e) => {
    e.preventDefault();
    if (!validateStep()) return;
    setLoading(true); setFormError('');
    try {
      const { confirm, cgu, ...payload } = f;
      const data = await authApi.register({ ...payload, email: payload.email.trim().toLowerCase(), phone: payload.phone.replace(/\s/g, ''), dateOfBirth: payload.dateOfBirth || undefined, idNumber: payload.idNumber || undefined });
      if (data.access_token) setToken(data.access_token);
      setDone(data);
      setStep(2);
      toast.success('Compte créé');
    } catch (err) { setFormError(errorMessage(err)); }
    finally { setLoading(false); }
  };

  if (step === 2 && done) {
    return (
      <>
        <div className="success-ring"><Icon name="check" size={34} /></div>
        <h1 className="center">Votre compte est créé</h1>
        <p className="ab-sub center">Un e-mail d’activation a été envoyé à <strong>{done.cardholder?.email || f.email}</strong>. Cliquez sur le lien reçu pour confirmer votre adresse (valable 48 h).</p>
        {done.card ? (
          <Alert tone="success" title="Votre carte virtuelle est prête">
            {done.card.cardMasked} · solde initial {Number(done.card.balance || 0).toLocaleString('fr-FR')} {done.card.currency}
          </Alert>
        ) : null}
        <div className="stack" style={{ marginTop: 24 }}>
          <Button variant="primary" size="lg" block onClick={() => navigate('/', { replace: true })}>Accéder à mon espace</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Créer un compte</h1>
      <p className="ab-sub">Quelques informations suffisent pour obtenir votre carte virtuelle C-Pay.</p>
      <Steps steps={STEPS} current={step} />
      {step === 0 ? (
        <form onSubmit={next} noValidate>
          <div className="grid-2">
            <Input label="Prénom" required value={f.firstName} onChange={set('firstName')} error={errors.firstName} autoComplete="given-name" autoFocus />
            <Input label="Nom" required value={f.lastName} onChange={set('lastName')} error={errors.lastName} autoComplete="family-name" />
          </div>
          <Input label="Téléphone mobile" required type="tel" value={f.phone} onChange={set('phone')} error={errors.phone} autoComplete="tel" inputMode="tel" placeholder="+237 6 70 00 00 00" prefixIcon="smartphone" hint="Ce numéro servira à vous identifier et pour Mobile Money." />
          <Input label="Adresse e-mail" required type="email" value={f.email} onChange={set('email')} error={errors.email} autoComplete="email" inputMode="email" prefixIcon="mail" />
          <div className="grid-2">
            <Input label="Date de naissance" type="date" value={f.dateOfBirth} onChange={set('dateOfBirth')} error={errors.dateOfBirth} autoComplete="bday" />
            <Select label="Pays" value={f.country} onChange={set('country')} options={COUNTRIES} />
          </div>
          <div className="grid-2">
            <Select label="Pièce d’identité" value={f.idType} onChange={set('idType')} options={ID_TYPES} />
            <Input label="Numéro de pièce" value={f.idNumber} onChange={set('idNumber')} hint="Facultatif à cette étape" />
          </div>
          <Button type="submit" variant="primary" size="lg" block iconRight="arrow-right">Continuer</Button>
        </form>
      ) : (
        <form onSubmit={submit} noValidate>
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <div className="field">
            <PasswordInput label="Mot de passe" required value={f.password} onChange={set('password')} error={errors.password} autoComplete="new-password" hint="8 caractères minimum, avec majuscule, minuscule et chiffre" autoFocus />
            <Strength pwd={f.password} />
          </div>
          <PasswordInput label="Confirmer le mot de passe" required value={f.confirm} onChange={set('confirm')} error={errors.confirm} autoComplete="new-password" />
          <Checkbox checked={f.cgu} onChange={set('cgu')} error={errors.cgu}>
            J’accepte les <a href={LEGAL_CGU_URL} target="_blank" rel="noreferrer">Conditions Générales d’Utilisation</a> et la <a href={LEGAL_PRIVACY_URL} target="_blank" rel="noreferrer">Politique de confidentialité</a> de C-Pay.
          </Checkbox>
          <div className="row">
            <Button variant="outline" icon="arrow-left" onClick={() => setStep(0)}>Retour</Button>
            <Button type="submit" variant="primary" size="lg" className="grow" loading={loading}>Créer mon compte</Button>
          </div>
        </form>
      )}
      <div className="ab-links"><span>Déjà inscrit ? <Link to="/connexion" className="strong">Se connecter</Link></span></div>
    </>
  );
}
