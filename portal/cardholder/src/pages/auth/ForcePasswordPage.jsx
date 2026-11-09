import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Button, PasswordInput, Alert } from '../../components';
import * as authApi from '../../services/auth';
import { logoutLocal } from '../../services/api';
import { errorMessage } from '../../utils/errors';
import { passwordIssues } from '../../utils/validation';

// Lot 2 (audit 2026-11-02 portails P1-1) : mot de passe TEMPORAIRE (mustChangePassword) → cet écran remplace tout
// l'espace porteur, y compris après rechargement ; l'API refuse les autres opérations (403 PASSWORD_CHANGE_REQUIRED).
// POST /profile/change-password révoque toutes les sessions : reconnexion avec le nouveau mot de passe.
export default function ForcePasswordPage() {
  useDocumentTitle('Nouveau mot de passe requis');
  const { user, signOut } = useAuth();
  const [cur, setCur] = useState('');
  const [pwd, setPwd] = useState({ next: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!cur) errs.cur = 'Saisissez le mot de passe temporaire reçu.';
    const issues = passwordIssues(pwd.next);
    if (issues.length) errs.next = `Le mot de passe doit contenir : ${issues.join(', ')}.`;
    if (pwd.next && pwd.next === cur) errs.next = 'Le nouveau mot de passe doit différer du mot de passe temporaire.';
    if (pwd.next !== pwd.confirm) errs.confirm = 'Les deux mots de passe ne correspondent pas.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setLoading(true); setFormError('');
    try {
      await authApi.changePassword(cur, pwd.next);
      toast.success('Mot de passe modifié. Reconnectez-vous avec votre nouveau mot de passe.');
      logoutLocal();
    } catch (err) { setFormError(errorMessage(err)); setLoading(false); }
  };

  return (
    <div className="auth-page">
      <h1>Nouveau mot de passe requis</h1>
      <p className="lead">Votre mot de passe est temporaire{user?.email ? ` (${user.email})` : ''}. Choisissez-en un nouveau pour accéder à votre espace : aucune opération n’est possible avant.</p>
      <form onSubmit={submit} noValidate>
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <PasswordInput label="Mot de passe temporaire reçu" required value={cur} onChange={(e) => setCur(e.target.value)} error={errors.cur} autoComplete="current-password" autoFocus />
        <PasswordInput label="Nouveau mot de passe" required value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} error={errors.next} hint="8 caractères minimum, avec majuscule, minuscule et chiffre" autoComplete="new-password" />
        <PasswordInput label="Confirmer le mot de passe" required value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} error={errors.confirm} autoComplete="new-password" />
        <Button type="submit" variant="primary" block loading={loading}>Enregistrer et se reconnecter</Button>
        <Button type="button" variant="ghost" block onClick={signOut}>Se déconnecter</Button>
      </form>
    </div>
  );
}
