import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Button, PasswordInput, Alert } from '../../components';
import * as authApi from '../../services/auth';
import { errorMessage } from '../../utils/errors';
import { passwordIssues } from '../../utils/validation';

export default function ResetPasswordPage() {
  useDocumentTitle('Nouveau mot de passe');
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();
  const [pwd, setPwd] = useState({ next: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const er = {};
    const issues = passwordIssues(pwd.next);
    if (issues.length) er.next = `Le mot de passe doit contenir : ${issues.join(', ')}.`;
    if (pwd.next !== pwd.confirm) er.confirm = 'Les deux mots de passe ne correspondent pas';
    setErrors(er);
    if (Object.keys(er).length) return;
    setLoading(true); setFormError('');
    try {
      await authApi.resetPassword(token, pwd.next);
      toast.success('Mot de passe réinitialisé. Vous pouvez vous connecter.');
      navigate('/connexion', { replace: true });
    } catch (err) { setFormError(errorMessage(err)); }
    finally { setLoading(false); }
  };

  if (!token) {
    return (
      <>
        <h1>Lien invalide</h1>
        <p className="ab-sub">Ce lien de réinitialisation est incomplet. Demandez un nouveau lien depuis la page « Mot de passe oublié ».</p>
        <Button variant="primary" block to="/mot-de-passe-oublie">Demander un nouveau lien</Button>
      </>
    );
  }
  return (
    <>
      <h1>Choisir un nouveau mot de passe</h1>
      <p className="ab-sub">Pour votre sécurité, toutes vos sessions actives seront déconnectées.</p>
      <form onSubmit={submit} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <PasswordInput label="Nouveau mot de passe" required value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} error={errors.next} hint="8 caractères minimum, avec majuscule, minuscule et chiffre" autoComplete="new-password" autoFocus />
        <PasswordInput label="Confirmer le mot de passe" required value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} error={errors.confirm} autoComplete="new-password" />
        <Button type="submit" variant="primary" size="lg" block loading={loading}>Enregistrer</Button>
      </form>
      <div className="ab-links"><Link to="/connexion">Retour à la connexion</Link></div>
    </>
  );
}
