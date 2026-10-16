import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { Card, Button, Input, Alert, Skeleton } from '../../components';
import * as cardsApi from '../../services/cards';
import { updateProfile } from '../../services/profile';
import { errorMessage } from '../../utils/errors';
import { isEmail, isPhone } from '../../utils/validation';
import { formatPhone } from '../../utils/format';

export default function InfoTab() {
  const { user, reloadUser } = useAuth();
  const card = useAsync(cardsApi.getCard, []);
  const [f, setF] = useState({ email: '', phone: '', address: '', city: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const ch = card.data?.cardholder;
    setF({ email: user?.email || ch?.email || '', phone: user?.phone || ch?.phone || '', address: ch?.address || '', city: ch?.city || '' });
  }, [user, card.data]);

  const base = { email: user?.email || card.data?.cardholder?.email || '', phone: user?.phone || card.data?.cardholder?.phone || '', address: card.data?.cardholder?.address || '', city: card.data?.cardholder?.city || '' };
  const dirty = Object.keys(f).some((k) => (f[k] || '') !== (base[k] || ''));

  const submit = async (e) => {
    e.preventDefault();
    const er = {};
    if (!isEmail(f.email)) er.email = 'Adresse e-mail invalide';
    if (!isPhone(f.phone)) er.phone = 'Numéro de téléphone invalide';
    setErrors(er);
    if (Object.keys(er).length) return;
    const changed = Object.fromEntries(Object.entries(f).filter(([k, v]) => (v || '') !== (base[k] || '')).map(([k, v]) => [k, k === 'phone' ? v.replace(/\s/g, '') : v.trim()]));
    if (!Object.keys(changed).length) return;
    setBusy(true); setFormError('');
    try {
      await updateProfile(changed);
      toast.success('Profil mis à jour');
      if (changed.email) toast('Un nouvel e-mail devra être vérifié depuis la section Sécurité.', { icon: null });
      await Promise.all([reloadUser(), card.reload()]);
    } catch (err) { setFormError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="help-grid">
      <Card title="Mes informations">
        {card.loading && !user ? <div className="stack"><Skeleton h={44} /><Skeleton h={44} /><Skeleton h={44} /></div> : (
          <form onSubmit={submit} noValidate className="stack">
            {formError ? <Alert tone="error">{formError}</Alert> : null}
            <div className="grid-2 collapse">
              <Input label="Prénom" value={user?.firstName || card.data?.cardholder?.firstName || ''} disabled hint="Modifiable sur justificatif via le support" />
              <Input label="Nom" value={user?.lastName || card.data?.cardholder?.lastName || ''} disabled />
            </div>
            <Input label="Adresse e-mail" type="email" required value={f.email} onChange={(e) => { setF({ ...f, email: e.target.value }); setErrors({}); }} error={errors.email} autoComplete="email" prefixIcon="mail" />
            <Input label="Téléphone mobile" type="tel" required value={f.phone} onChange={(e) => { setF({ ...f, phone: e.target.value }); setErrors({}); }} error={errors.phone} autoComplete="tel" prefixIcon="smartphone" hint={f.phone ? formatPhone(f.phone) : undefined} />
            <Input label="Adresse" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} autoComplete="street-address" maxLength={200} />
            <Input label="Ville" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} autoComplete="address-level2" maxLength={80} />
            <div className="row">
              <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>Enregistrer</Button>
              {dirty ? <Button variant="ghost" onClick={() => setF(base)} disabled={busy}>Annuler</Button> : null}
            </div>
          </form>
        )}
      </Card>
      <div className="stack">
        <Card title="Mon compte">
          <dl className="kv">
            <dt>Identifiant</dt><dd className="mono xs">{user?.cardholderId || '—'}</dd>
            <dt>Niveau KYC</dt><dd>{user?.kycLevel != null ? `Niveau ${user.kycLevel}` : '—'}</dd>
            <dt>Double authentification</dt><dd>{user?.mfaEnabled ? 'Activée' : 'Désactivée'}</dd>
            <dt>Carte principale</dt><dd className="mono">{user?.card?.cardMasked || '—'}</dd>
          </dl>
        </Card>
        <Alert tone="info" title="Vos données">
          Vos informations servent uniquement à l’exécution de vos opérations et aux obligations réglementaires. Contact : legal@c-pay.global.
        </Alert>
      </div>
    </div>
  );
}
