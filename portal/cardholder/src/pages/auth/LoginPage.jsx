import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Button, Input, PasswordInput, PinInput, Alert } from '../../components';
import * as authApi from '../../services/auth';
import { setToken } from '../../services/api';
import { errorMessage } from '../../utils/errors';
import { isEmailOrPhone, passwordIssues } from '../../utils/validation';

export default function LoginPage() {
  useDocumentTitle('Connexion');
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuth, reloadUser } = useAuth();
  const [step, setStep] = useState('creds'); // creds | mfa | password
  const [creds, setCreds] = useState({ emailOrPhone: '', password: '' });
  const [errors, setErrors] = useState({});
  const [mfaToken, setMfaToken] = useState(null);
  const [code, setCode] = useState('');
  const [pwd, setPwd] = useState({ next: '', confirm: '' });
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const dest = location.state?.from || '/';

  useEffect(() => { if (isAuth && step !== 'password') navigate(dest, { replace: true }); }, [isAuth, step, navigate, dest]);

  const finish = async (data) => {
    if (data.mfaRequired && data.mfaToken) { setMfaToken(data.mfaToken); setStep('mfa'); return; }
    if (data.access_token) setToken(data.access_token);
    if (data.mustChangePassword) { setStep('password'); return; }
    navigate(dest, { replace: true });
  };

  const submitCreds = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!isEmailOrPhone(creds.emailOrPhone)) errs.emailOrPhone = 'Saisissez un e-mail ou un numéro de téléphone valide';
    if (!creds.password) errs.password = 'Mot de passe requis';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setLoading(true); setFormError('');
    try { await finish(await authApi.login(creds.emailOrPhone.trim(), creds.password)); }
    catch (err) { setFormError(errorMessage(err, 'Identifiants incorrects.')); }
    finally { setLoading(false); }
  };

  const submitMfa = async (e) => {
    e.preventDefault();
    if (code.length !== 6) { setFormError('Saisissez le code à 6 chiffres de votre application d’authentification.'); return; }
    setLoading(true); setFormError('');
    try { await finish({ ...(await authApi.validate2fa(mfaToken, code)), mfaRequired: false }); }
    catch (err) { setFormError(errorMessage(err, 'Code invalide.')); setCode(''); }
    finally { setLoading(false); }
  };

  const submitPwd = async (e) => {
    e.preventDefault();
    const issues = passwordIssues(pwd.next);
    if (issues.length) { setErrors({ next: `Le mot de passe doit contenir : ${issues.join(', ')}.` }); return; }
    if (pwd.next !== pwd.confirm) { setErrors({ confirm: 'Les deux mots de passe ne correspondent pas.' }); return; }
    setErrors({}); setLoading(true); setFormError('');
    try {
      await authApi.changePassword(creds.password, pwd.next);
      // Le backend revoque toutes les sessions : on se reconnecte avec le nouveau mot de passe.
      const data = await authApi.login(creds.emailOrPhone.trim(), pwd.next);
      if (data.mfaRequired) { setMfaToken(data.mfaToken); setCode(''); setStep('mfa'); toast.success('Mot de passe modifié. Confirmez votre code 2FA.'); return; }
      if (data.access_token) setToken(data.access_token);
      await reloadUser();
      toast.success('Mot de passe modifié');
      navigate('/', { replace: true });
    } catch (err) { setFormError(errorMessage(err)); }
    finally { setLoading(false); }
  };

  if (step === 'mfa') {
    return (
      <>
        <h1>Vérification en deux étapes</h1>
        <p className="ab-sub">Saisissez le code à 6 chiffres généré par votre application d’authentification.</p>
        <form onSubmit={submitMfa} noValidate>
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <PinInput value={code} onChange={setCode} length={6} label="Code de vérification" secret={false} autoFocus />
          <Button type="submit" variant="primary" size="lg" block loading={loading}>Valider</Button>
          <Button variant="ghost" onClick={() => { setStep('creds'); setCode(''); setFormError(''); }}>Revenir à la connexion</Button>
        </form>
      </>
    );
  }

  if (step === 'password') {
    return (
      <>
        <h1>Nouveau mot de passe</h1>
        <p className="ab-sub">Votre mot de passe est temporaire. Choisissez-en un nouveau pour sécuriser votre compte.</p>
        <form onSubmit={submitPwd} noValidate>
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <PasswordInput label="Nouveau mot de passe" required value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} error={errors.next} hint="8 caractères minimum, avec majuscule, minuscule et chiffre" autoComplete="new-password" autoFocus />
          <PasswordInput label="Confirmer le mot de passe" required value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} error={errors.confirm} autoComplete="new-password" />
          <Button type="submit" variant="primary" size="lg" block loading={loading}>Enregistrer et continuer</Button>
        </form>
      </>
    );
  }

  return (
    <>
      <h1>Bienvenue</h1>
      <p className="ab-sub">Connectez-vous à votre espace C-Pay.</p>
      <form onSubmit={submitCreds} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Input label="E-mail ou téléphone" required name="emailOrPhone" value={creds.emailOrPhone} onChange={(e) => setCreds({ ...creds, emailOrPhone: e.target.value })} error={errors.emailOrPhone} autoComplete="username" inputMode="email" prefixIcon="user" autoFocus />
        <PasswordInput label="Mot de passe" required name="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} error={errors.password} autoComplete="current-password" />
        <Button type="submit" variant="primary" size="lg" block loading={loading}>Se connecter</Button>
      </form>
      <div className="ab-links">
        <Link to="/mot-de-passe-oublie">Mot de passe oublié ?</Link>
        <span>Pas encore de compte ? <Link to="/inscription" className="strong">Créer un compte</Link></span>
      </div>
    </>
  );
}
