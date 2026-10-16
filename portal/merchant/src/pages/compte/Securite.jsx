import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { authApi, setAccessToken } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, PageHeader, PasswordInput, OtpInput, Notice, Badge, Modal, SkeletonCard, CopyRow } from '../../components';
import { errorMessage } from '../../utils/errors';

// Sécurité : mot de passe (toutes les sessions sont révoquées), 2FA TOTP (activation avec QR, désactivation par code).
export const Securite = () => {
  const { user, logout } = useAuth();
  const status = useAsync(() => authApi.twoFaStatus(), []);
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' });
  const [pwdErr, setPwdErr] = useState({});
  const [saving, setSaving] = useState(false);
  const [setup, setSetup] = useState(null); // { qrCode, secret, code, step }
  const [disable, setDisable] = useState(null); // { code }
  const [busy, setBusy] = useState(false);
  const mfa = status.data?.mfaEnabled ?? user?.mfaEnabled;

  const changePassword = async (e) => {
    e.preventDefault();
    const er = {};
    if (!pwd.current) er.current = 'Mot de passe actuel requis.';
    if (pwd.next.length < 8) er.next = '8 caractères minimum.';
    if (pwd.next !== pwd.confirm) er.confirm = 'Les deux mots de passe ne correspondent pas.';
    setPwdErr(er); if (Object.keys(er).length) return;
    setSaving(true);
    try {
      await authApi.changePassword({ currentPassword: pwd.current, newPassword: pwd.next });
      toast.success('Mot de passe modifié. Reconnectez-vous.');
      setAccessToken(null); window.location.href = '/login';
    } catch (err) { setPwdErr({ current: err.response?.status === 401 ? 'Mot de passe actuel incorrect.' : errorMessage(err) }); }
    finally { setSaving(false); }
  };
  const startSetup = async () => {
    setBusy(true);
    try { const { data } = await authApi.twoFaSetup(); setSetup({ qrCode: data.qrCode, secret: data.secret, code: '', step: 'scan' }); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    if (setup.code.length !== 6) return;
    setBusy(true);
    try { await authApi.twoFaVerify(setup.code); toast.success('Double authentification activée'); setSetup(null); status.reload(); }
    catch (err) { setSetup(s => ({ ...s, error: errorMessage(err) === 'Une erreur est survenue.' ? 'Code invalide.' : errorMessage(err) })); }
    finally { setBusy(false); }
  };
  const doDisable = async () => {
    if (disable.code.length !== 6) return;
    setBusy(true);
    try { await authApi.twoFaDisable(disable.code); toast.success('Double authentification désactivée'); setDisable(null); status.reload(); }
    catch (err) { setDisable(d => ({ ...d, error: errorMessage(err) === 'Une erreur est survenue.' ? 'Code invalide.' : errorMessage(err) })); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Sécurité" subtitle="Mot de passe, double authentification et sessions de votre compte." />
      {user?.mustChangePassword && <Notice tone="warn">Vous utilisez un mot de passe temporaire : définissez-en un nouveau dès maintenant.</Notice>}
      <div className="grid-2">
        {status.state === 'loading' ? <SkeletonCard lines={4} /> : (
          <Card title="Double authentification (2FA)" actions={<Badge tone={mfa ? 'success' : 'warn'} dot>{mfa ? 'Activée' : 'Désactivée'}</Badge>}>
            <p className="small text-2 mb-4">Un code à 6 chiffres généré par une application d’authentification (Google Authenticator, Authy, Microsoft Authenticator) est demandé à chaque connexion et pour confirmer les retraits et transferts.</p>
            {status.data && !mfa && (status.data.required ? <Notice tone="error" className="mb-4">La 2FA est obligatoire sur votre compte : activez-la maintenant.</Notice> : status.data.daysLeft != null && <Notice tone="warn" className="mb-4">Activation requise sous {status.data.daysLeft} jour(s).</Notice>)}
            {mfa ? <Button variant="danger" onClick={() => setDisable({ code: '' })}>Désactiver la 2FA</Button> : <Button variant="primary" icon="shield" onClick={startSetup} loading={busy}>Activer la 2FA</Button>}
          </Card>
        )}
        <Card title="Mot de passe">
          <form onSubmit={changePassword} noValidate>
            <PasswordInput label="Mot de passe actuel" value={pwd.current} onChange={v => setPwd(p => ({ ...p, current: v }))} autoComplete="current-password" error={pwdErr.current} required />
            <PasswordInput label="Nouveau mot de passe" value={pwd.next} onChange={v => setPwd(p => ({ ...p, next: v }))} autoComplete="new-password" error={pwdErr.next} hint="8 caractères minimum ; majuscule, minuscule et chiffre recommandés." required />
            <PasswordInput label="Confirmer" value={pwd.confirm} onChange={v => setPwd(p => ({ ...p, confirm: v }))} autoComplete="new-password" error={pwdErr.confirm} required />
            <Button type="submit" variant="primary" loading={saving}>Changer le mot de passe</Button>
            <p className="xs muted mt-3">Le changement déconnecte tous vos appareils ; vous devrez vous reconnecter.</p>
          </form>
        </Card>
      </div>
      <Card title="Sessions et appareils">
        <p className="small text-2 mb-3">La liste détaillée des appareils connectés n’est pas encore disponible. Pour fermer toutes les sessions ouvertes sur vos autres appareils, changez votre mot de passe (toutes les sessions sont alors révoquées) ou déconnectez-vous ici.</p>
        <Button icon="logout" onClick={logout}>Se déconnecter de cet appareil</Button>
      </Card>
      {setup && (
        <Modal title="Activer la double authentification" onClose={() => setSetup(null)} locked={busy}
          footer={setup.step === 'scan' ? <Button variant="primary" block onClick={() => setSetup(s => ({ ...s, step: 'verify' }))}>J’ai scanné le code</Button> : <><Button onClick={() => setSetup(s => ({ ...s, step: 'scan', error: null }))}>Retour</Button><Button variant="primary" onClick={verify} disabled={setup.code.length !== 6} loading={busy}>Activer</Button></>}>
          {setup.step === 'scan' ? (<>
            <p className="small text-2 mb-3">1. Scannez ce QR code avec votre application d’authentification.</p>
            {setup.qrCode && <div className="center mb-3"><img src={setup.qrCode} alt="QR code d’enrôlement 2FA" style={{ width: 200, height: 200, borderRadius: 8, border: '1px solid var(--border)' }} /></div>}
            <p className="xs muted mb-2">Ou saisissez cette clé manuellement :</p>
            <div className="kv-box"><CopyRow label="Clé secrète" value={setup.secret} /></div>
          </>) : (<>
            <p className="small text-2 mb-3">2. Saisissez le code à 6 chiffres affiché dans l’application.</p>
            <OtpInput value={setup.code} onChange={v => setSetup(s => ({ ...s, code: v, error: null }))} error={setup.error} autoFocus />
          </>)}
        </Modal>
      )}
      {disable && (
        <Modal title="Désactiver la double authentification" onClose={() => setDisable(null)} locked={busy}
          footer={<><Button onClick={() => setDisable(null)}>Annuler</Button><Button variant="danger-solid" onClick={doDisable} disabled={disable.code.length !== 6} loading={busy}>Désactiver</Button></>}>
          <Notice tone="warn" className="mb-4">Sans 2FA, les retraits et transferts seront confirmés par votre mot de passe seul. Saisissez un code valide pour confirmer.</Notice>
          <OtpInput value={disable.code} onChange={v => setDisable(d => ({ ...d, code: v, error: null }))} error={disable.error} autoFocus />
        </Modal>
      )}
    </div>
  );
};
export default Securite;
