import React, { useState } from 'react';
import { Button, Card, Field, PasswordInput, Callout } from '../../components/ui';
import { authApi, clearToken } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';

// mustChangePassword (mot de passe temporaire) : changement obligatoire avant
// d'entrer. POST /auth/change-password révoque toutes les sessions → reconnexion.
export default function ForcePasswordPage() {
  const { admin, logout } = useAuth();
  const [cur, setCur] = useState('');
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const valid = pwd.length >= 10 && pwd === confirm && cur;

  const submit = async (e) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true); setError(null);
    try {
      await authApi.changePassword({ currentPassword: cur, newPassword: pwd });
      toast.success('Mot de passe modifié. Reconnectez-vous avec votre nouveau mot de passe.');
      clearToken();
      window.location.href = '/login';
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };

  return (
    <div className="auth-main" style={{ minHeight: '100vh' }}>
      <div className="auth-card">
        <div className="auth-logo"><img src="/logo-calculus.png" alt="" /><div><h1 style={{ fontSize: 22 }}>Nouveau mot de passe requis</h1><div className="small muted">{admin?.email}</div></div></div>
        <Card>
          <form onSubmit={submit} className="stack" noValidate>
            <Callout tone="warn">Votre mot de passe est temporaire. Choisissez-en un nouveau (10 caractères minimum) pour accéder au back-office.</Callout>
            {error && <Callout tone="error">{error}</Callout>}
            <Field label="Mot de passe temporaire reçu" required><PasswordInput value={cur} onChange={setCur} autoComplete="current-password" /></Field>
            <Field label="Nouveau mot de passe" required hint="10 caractères minimum, évitez les mots du dictionnaire."><PasswordInput value={pwd} onChange={setPwd} autoComplete="new-password" /></Field>
            <Field label="Confirmation" required error={confirm && confirm !== pwd ? 'Les deux mots de passe diffèrent.' : null}><PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" /></Field>
            <Button type="submit" variant="primary" block loading={busy} disabled={!valid}>Enregistrer et se reconnecter</Button>
            <Button variant="ghost" block onClick={logout}>Se déconnecter</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
