import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { authApi } from '../../services/api';
import { Button, PasswordInput, Notice } from '../../components';
import { errorMessage } from '../../utils/errors';
import AuthLayout from '../../layout/AuthLayout';

const RULES = [
  ['8 caractères minimum', (p) => p.length >= 8],
  ['Une majuscule', (p) => /[A-Z]/.test(p)],
  ['Une minuscule', (p) => /[a-z]/.test(p)],
  ['Un chiffre', (p) => /[0-9]/.test(p)],
];

export const ResetPassword = () => {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [pwd, setPwd] = useState({ a: '', b: '' });
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const ok = RULES.every(([, f]) => f(pwd.a));
  const submit = async (e) => {
    e.preventDefault();
    if (!ok) { setError('Le mot de passe ne respecte pas les règles ci-dessous.'); return; }
    if (pwd.a !== pwd.b) { setError('Les deux mots de passe ne correspondent pas.'); return; }
    setLoading(true); setError(null);
    try { await authApi.resetPassword({ token, newPassword: pwd.a }); setDone(true); }
    catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  };
  if (!token) return <AuthLayout title="Lien invalide" lead="Ce lien de réinitialisation est incomplet." footer={<div className="links"><Link to="/forgot-password">Demander un nouveau lien</Link></div>} />;
  return (
    <AuthLayout title="Nouveau mot de passe" lead="Choisissez un nouveau mot de passe. Toutes vos sessions ouvertes seront déconnectées."
      footer={<div className="links"><Link to="/login">Retour à la connexion</Link></div>}>
      {done ? <Notice tone="success">Mot de passe réinitialisé. <Link to="/login">Connectez-vous</Link> avec votre nouveau mot de passe.</Notice> : (
        <form onSubmit={submit} noValidate>
          {error && <Notice tone="error" className="mb-4">{error}</Notice>}
          <PasswordInput label="Nouveau mot de passe" value={pwd.a} onChange={v => setPwd(p => ({ ...p, a: v }))} autoComplete="new-password" required autoFocus />
          <ul className="small" style={{ margin: '0 0 var(--s4)', paddingLeft: 18 }}>{RULES.map(([l, f]) => <li key={l} className={f(pwd.a) ? 'success' : 'muted'}>{l}</li>)}</ul>
          <PasswordInput label="Confirmer le mot de passe" value={pwd.b} onChange={v => setPwd(p => ({ ...p, b: v }))} autoComplete="new-password" required />
          <Button type="submit" variant="primary" size="lg" block loading={loading}>Réinitialiser</Button>
        </form>
      )}
    </AuthLayout>
  );
};
export default ResetPassword;
