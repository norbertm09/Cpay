import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { consentApi } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { Button, Checkbox, Notice } from '../../components';
import { errorMessage } from '../../utils/errors';
import AuthLayout from '../../layout/AuthLayout';

// Acceptation des CGU et de la politique de confidentialité (une fois par
// utilisateur et par portail, POST /api/v1/consent/accept).
export const Accept = () => {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [cgu, setCgu] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [saving, setSaving] = useState(false);
  const accept = async () => {
    setSaving(true);
    try { await consentApi.accept({ cguAccepted: true, privacyAccepted: true, contractAccepted: true }); navigate('/', { replace: true }); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setSaving(false); }
  };
  return (
    <AuthLayout title="Conditions d’utilisation" lead="Veuillez lire et accepter nos conditions avant d’accéder à votre espace marchand.">
      <div className="card mb-4" style={{ padding: 'var(--s4)' }}>
        <h3 className="mb-2">Conditions générales d’utilisation — l’essentiel</h3>
        <ul className="small text-2" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>La plateforme C-Pay est opérée par Calculus Plus SAS.</li>
          <li>Vous devez avoir 18 ans ou plus et utiliser la plateforme à des fins licites.</li>
          <li>Vos opérations sont soumises aux frais communiqués avant validation.</li>
          <li>Calculus Plus SAS peut suspendre un compte en cas d’utilisation abusive.</li>
          <li>Les litiges relèvent des juridictions de Brazzaville, République du Congo.</li>
        </ul>
        <a className="small" href="https://c-pay.global/legal/cgu.html" target="_blank" rel="noreferrer">Lire les CGU complètes</a>
      </div>
      <div className="card mb-4" style={{ padding: 'var(--s4)' }}>
        <h3 className="mb-2">Politique de confidentialité — l’essentiel</h3>
        <ul className="small text-2" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Vos données servent à exécuter les opérations et à vérifier votre identité (KYB).</li>
          <li>Elles sont conservées conformément aux obligations légales (5 à 10 ans) et jamais vendues.</li>
          <li>Vous disposez d’un droit d’accès, de rectification et de suppression : legal@c-pay.global.</li>
        </ul>
        <a className="small" href="https://c-pay.global/legal/confidentialite.html" target="_blank" rel="noreferrer">Lire la politique complète</a>
      </div>
      <div className="stack mb-4">
        <Checkbox checked={cgu} onChange={setCgu}>J’ai lu et j’accepte les Conditions générales d’utilisation de C-Pay.</Checkbox>
        <Checkbox checked={privacy} onChange={setPrivacy}>J’accepte la Politique de confidentialité et consens au traitement de mes données.</Checkbox>
      </div>
      {!(cgu && privacy) && <Notice tone="neutral" className="mb-4">Sans acceptation, l’accès à la plateforme n’est pas possible.</Notice>}
      <Button variant="primary" size="lg" block disabled={!cgu || !privacy} loading={saving} onClick={accept}>Accepter et continuer</Button>
      <Button variant="ghost" block className="mt-3" onClick={logout}>Se déconnecter</Button>
    </AuthLayout>
  );
};
export default Accept;
