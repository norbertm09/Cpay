import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Button, Input, Alert, Icon } from '../../components';
import * as authApi from '../../services/auth';
import { errorMessage } from '../../utils/errors';
import { isEmail } from '../../utils/validation';

export default function ForgotPasswordPage() {
  useDocumentTitle('Mot de passe oublié');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!isEmail(email)) { setError('Adresse e-mail invalide'); return; }
    setLoading(true); setError('');
    try { await authApi.forgotPassword(email.trim().toLowerCase()); setSent(true); }
    catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  };

  if (sent) {
    return (
      <>
        <div className="success-ring"><Icon name="mail" size={30} /></div>
        <h1 className="center">Vérifiez votre boîte mail</h1>
        <p className="ab-sub center">Si un compte existe pour <strong>{email}</strong>, un lien de réinitialisation vient de vous être envoyé. Il est valable une heure.</p>
        <div className="ab-links"><Link to="/connexion" className="strong">Retour à la connexion</Link></div>
      </>
    );
  }
  return (
    <>
      <h1>Mot de passe oublié</h1>
      <p className="ab-sub">Indiquez l’adresse e-mail de votre compte, nous vous enverrons un lien pour choisir un nouveau mot de passe.</p>
      <form onSubmit={submit} noValidate>
        <Input label="Adresse e-mail" required type="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(''); }} error={error} autoComplete="email" inputMode="email" prefixIcon="mail" autoFocus />
        <Button type="submit" variant="primary" size="lg" block loading={loading}>Envoyer le lien</Button>
      </form>
      <div className="ab-links"><Link to="/connexion">Retour à la connexion</Link></div>
    </>
  );
}
