import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { authApi, setAccessToken } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { Button, Input, PasswordInput, OtpInput, Notice } from '../../components';
import { errorMessage } from '../../utils/errors';
import AuthLayout from '../../layout/AuthLayout';

// Connexion en trois étapes possibles :
//   identifiants -> { mfaRequired, mfaToken } -> code TOTP (/auth/2fa/validate)
//   -> { mustChangePassword } -> nouveau mot de passe forcé (/auth/change-password)
export const Login = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuth } = useAuth();
  const [creds, setCreds] = useState({ emailOrPhone: '', password: '' });
  const [step, setStep] = useState('creds'); // creds | mfa | password
  const [mfaToken, setMfaToken] = useState(null);
  const [code, setCode] = useState('');
  const [pwd, setPwd] = useState({ newPassword: '', confirm: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const dest = location.state?.from && location.state.from !== '/login' ? location.state.from : '/';

  useEffect(() => { if (isAuth && step !== 'password') navigate(dest, { replace: true }); }, [isAuth, step, navigate, dest]);

  const finish = (data) => {
    if (data.mfaRequired && data.mfaToken) { setMfaToken(data.mfaToken); setStep('mfa'); return; }
    // Le refresh token arrive en cookie HttpOnly ; l'access token reste en mémoire.
    if (data.mustChangePassword) { setStep('password'); setAccessToken(data.access_token); return; }
    setAccessToken(data.access_token);
    navigate(dest, { replace: true });
  };

  const submitCreds = async () => {
    if (!creds.emailOrPhone.trim() || !creds.password) { setError('Identifiant et mot de passe requis.'); return; }
    setLoading(true); setError(null);
    try { const { data } = await authApi.login({ emailOrPhone: creds.emailOrPhone.trim(), password: creds.password }); finish(data); }
    catch (err) {
      const d = err.response?.data || {};
      setError(err.response?.status === 401 ? `Identifiants incorrects${d.attemptsLeft != null ? ` (${d.attemptsLeft} tentative(s) restante(s))` : ''}.` : errorMessage(err));
    } finally { setLoading(false); }
  };
  const submitMfa = async () => {
    if (code.length !== 6) { setError('Saisissez le code à 6 chiffres.'); return; }
    setLoading(true); setError(null);
    try { const { data } = await authApi.validate2fa({ mfaToken, code }); finish({ ...data, mfaRequired: false }); }
    catch (err) { setError(err.response?.status === 401 && err.response?.data?.code !== 'INVALID_TOTP' ? 'Session de vérification expirée, reconnectez-vous.' : errorMessage(err)); }
    finally { setLoading(false); }
  };
  const submitPassword = async () => {
    if (pwd.newPassword.length < 8) { setError('8 caractères minimum.'); return; }
    if (pwd.newPassword !== pwd.confirm) { setError('Les deux mots de passe ne correspondent pas.'); return; }
    setLoading(true); setError(null);
    try {
      await authApi.changePassword({ currentPassword: creds.password, newPassword: pwd.newPassword });
      toast.success('Mot de passe modifié. Reconnectez-vous avec votre nouveau mot de passe.');
      // Le backend révoque toutes les sessions : on repart d'une connexion propre.
      setAccessToken(null); setStep('creds'); setCreds({ emailOrPhone: creds.emailOrPhone, password: '' }); setPwd({ newPassword: '', confirm: '' });
    } catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  };
  const onSubmit = (e) => { e.preventDefault(); if (loading) return; if (step === 'password') submitPassword(); else if (step === 'mfa') submitMfa(); else submitCreds(); };

  const titles = { creds: ['Connexion', 'Accédez à votre espace marchand.'], mfa: ['Vérification en deux étapes', 'Saisissez le code à 6 chiffres de votre application d’authentification.'], password: ['Nouveau mot de passe requis', 'Pour continuer, définissez un nouveau mot de passe (8 caractères minimum).'] };
  return (
    <AuthLayout title={titles[step][0]} lead={titles[step][1]}
      footer={step === 'creds' && <div className="links"><Link to="/forgot-password">Mot de passe oublié ?</Link><span>Pas encore de compte ? <Link to="/register">Créer un compte</Link></span></div>}>
      <form onSubmit={onSubmit} noValidate>
        {error && <Notice tone="error" className="mb-4">{error}</Notice>}
        {step === 'creds' && (<>
          <Input id="identifier" name="identifier" label="E-mail ou téléphone" value={creds.emailOrPhone} onChange={v => setCreds(c => ({ ...c, emailOrPhone: v }))} autoComplete="username" inputMode="email" placeholder="vous@entreprise.com" required autoFocus />
          <PasswordInput id="password" name="password" label="Mot de passe" value={creds.password} onChange={v => setCreds(c => ({ ...c, password: v }))} autoComplete="current-password" required />
          <Button type="submit" variant="primary" size="lg" block loading={loading}>Se connecter</Button>
        </>)}
        {step === 'mfa' && (<>
          <OtpInput id="otp" value={code} onChange={setCode} autoFocus />
          <Button type="submit" variant="primary" size="lg" block loading={loading} disabled={code.length !== 6}>Valider</Button>
          <Button variant="ghost" block className="mt-3" onClick={() => { setStep('creds'); setCode(''); setError(null); }}>Retour</Button>
        </>)}
        {step === 'password' && (<>
          <PasswordInput id="new-password" label="Nouveau mot de passe" value={pwd.newPassword} onChange={v => setPwd(p => ({ ...p, newPassword: v }))} autoComplete="new-password" hint="8 caractères minimum, avec majuscule, minuscule et chiffre recommandés." required autoFocus />
          <PasswordInput id="confirm-password" label="Confirmer le mot de passe" value={pwd.confirm} onChange={v => setPwd(p => ({ ...p, confirm: v }))} autoComplete="new-password" required />
          <Button type="submit" variant="primary" size="lg" block loading={loading}>Enregistrer</Button>
        </>)}
      </form>
    </AuthLayout>
  );
};
export default Login;
