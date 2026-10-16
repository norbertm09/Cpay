import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Button, Icon, Alert } from '../../components';
import * as authApi from '../../services/auth';
import { errorMessage } from '../../utils/errors';

export default function VerifyEmailPage() {
  useDocumentTitle('Vérification de l’e-mail');
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState(token ? 'loading' : 'missing');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    authApi.verifyEmail(token)
      .then((d) => { if (!cancelled) { setState('ok'); setMessage(d.email || ''); } })
      .catch((err) => { if (!cancelled) { setState('error'); setMessage(errorMessage(err, 'Ce lien est invalide ou a déjà été utilisé.')); } });
    return () => { cancelled = true; };
  }, [token]);

  if (state === 'loading') {
    return <div className="stack center" style={{ alignItems: 'center' }}><Icon name="loader" size={28} className="spin" /><p className="muted">Vérification de votre adresse e-mail…</p></div>;
  }
  if (state === 'ok') {
    return (
      <>
        <div className="success-ring"><Icon name="check" size={34} /></div>
        <h1 className="center">Adresse confirmée</h1>
        <p className="ab-sub center">{message ? <>L’adresse <strong>{message}</strong> est vérifiée. </> : null}Votre compte est pleinement activé.</p>
        <Button variant="primary" size="lg" block to="/connexion">Se connecter</Button>
      </>
    );
  }
  return (
    <>
      <h1>Lien de vérification</h1>
      <Alert tone={state === 'missing' ? 'warn' : 'error'} title={state === 'missing' ? 'Lien incomplet' : 'Vérification impossible'}>
        {state === 'missing' ? 'Ce lien ne contient pas de jeton de vérification.' : message}
      </Alert>
      <p className="ab-sub" style={{ marginTop: 16 }}>Connectez-vous puis demandez un nouveau lien depuis votre profil (section Sécurité).</p>
      <Button variant="primary" block to="/connexion">Aller à la connexion</Button>
    </>
  );
}
