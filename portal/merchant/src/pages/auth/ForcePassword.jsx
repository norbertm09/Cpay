import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { authApi, setAccessToken } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { Button, PasswordInput, Notice } from '../../components';
import { errorMessage } from '../../utils/errors';
import AuthLayout from '../../layout/AuthLayout';

// Lot 2 (audit 2026-11-02 portails P1-1) : tant que le compte porte un mot de passe TEMPORAIRE
// (user.mustChangePassword, lu dans /auth/me), cet écran remplace tout l'espace marchand — y compris après un
// rechargement de page (le refresh silencieux ré-ouvre la session). Côté API, le jeton porte `pwdTemp` et
// merchantAuth refuse toute autre opération (403 PASSWORD_CHANGE_REQUIRED). POST /auth/change-password
// révoque toutes les sessions : on repart d'une connexion propre.
export const ForcePassword = () => {
  const { user, logout } = useAuth();
  const [cur, setCur] = useState('');
  const [pwd, setPwd] = useState({ newPassword: '', confirm: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (loading) return;
    if (!cur) { setError('Saisissez le mot de passe temporaire reçu.'); return; }
    if (pwd.newPassword.length < 8) { setError('8 caractères minimum.'); return; }
    if (pwd.newPassword === cur) { setError('Le nouveau mot de passe doit différer du mot de passe temporaire.'); return; }
    if (pwd.newPassword !== pwd.confirm) { setError('Les deux mots de passe ne correspondent pas.'); return; }
    setLoading(true); setError(null);
    try {
      await authApi.changePassword({ currentPassword: cur, newPassword: pwd.newPassword });
      toast.success('Mot de passe modifié. Reconnectez-vous avec votre nouveau mot de passe.');
      setAccessToken(null);
      window.location.href = '/login';
    } catch (err) { setError(errorMessage(err)); setLoading(false); }
  };

  return (
    <AuthLayout title="Nouveau mot de passe requis" lead={`Votre mot de passe est temporaire${user?.email ? ` (${user.email})` : ''}. Choisissez-en un nouveau pour accéder à votre espace.`}>
      <form onSubmit={submit} noValidate>
        <Notice tone="warn" className="mb-4">Aucune opération (encaissement, retrait, paramètres) n’est possible avant ce changement.</Notice>
        {error && <Notice tone="error" className="mb-4">{error}</Notice>}
        <PasswordInput id="current-password" label="Mot de passe temporaire reçu" value={cur} onChange={setCur} autoComplete="current-password" required autoFocus />
        <PasswordInput id="new-password" label="Nouveau mot de passe" value={pwd.newPassword} onChange={v => setPwd(p => ({ ...p, newPassword: v }))} autoComplete="new-password" hint="8 caractères minimum, avec majuscule, minuscule et chiffre recommandés." required />
        <PasswordInput id="confirm-password" label="Confirmer le mot de passe" value={pwd.confirm} onChange={v => setPwd(p => ({ ...p, confirm: v }))} autoComplete="new-password" required />
        <Button type="submit" variant="primary" size="lg" block loading={loading}>Enregistrer et se reconnecter</Button>
        <Button variant="ghost" block className="mt-3" onClick={logout}>Se déconnecter</Button>
      </form>
    </AuthLayout>
  );
};
export default ForcePassword;
