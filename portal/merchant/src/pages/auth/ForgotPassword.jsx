import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../../services/api';
import { Button, Input, Notice } from '../../components';
import { errorMessage } from '../../utils/errors';
import AuthLayout from '../../layout/AuthLayout';

export const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError('Adresse e-mail invalide.'); return; }
    setLoading(true); setError(null);
    try { await authApi.forgotPassword(email.trim()); setSent(true); }
    catch (err) { if (err.response?.status === 429) setError(errorMessage(err)); else setSent(true); }
    finally { setLoading(false); }
  };
  return (
    <AuthLayout title="Mot de passe oublié" lead="Indiquez l’adresse e-mail de votre compte : vous recevrez un lien de réinitialisation valable une heure."
      footer={<div className="links"><Link to="/login">Retour à la connexion</Link></div>}>
      {sent ? (
        <Notice tone="success">Si cette adresse correspond à un compte, un e-mail de réinitialisation vient d’être envoyé. Pensez à vérifier vos courriers indésirables.</Notice>
      ) : (
        <form onSubmit={submit} noValidate>
          <Input label="Adresse e-mail" type="email" value={email} onChange={setEmail} autoComplete="email" inputMode="email" placeholder="vous@entreprise.com" error={error} required autoFocus />
          <Button type="submit" variant="primary" size="lg" block loading={loading}>Envoyer le lien</Button>
        </form>
      )}
    </AuthLayout>
  );
};
export default ForgotPassword;
