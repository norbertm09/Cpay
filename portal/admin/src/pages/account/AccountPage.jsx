import React, { useState } from 'react';
import { Button, Card, PageHeader, Tabs, Field, Input, PasswordInput, KeyValue, Badge, Callout, Modal } from '../../components/ui';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { useQuery } from '../../hooks/useQuery';
import { authApi, clearToken } from '../../services/api';
import { roleLabel, roleTone } from '../../utils/roles';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';

function PasswordForm() {
  const [cur, setCur] = useState(''); const [pwd, setPwd] = useState(''); const [confirm, setConfirm] = useState(''); const [busy, setBusy] = useState(false);
  const valid = cur && pwd.length >= 10 && pwd === confirm;
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await authApi.changePassword({ currentPassword: cur, newPassword: pwd }); toast.success('Mot de passe modifié : reconnectez-vous.'); clearToken(); window.location.href = '/login'; }
    catch (err) { toast.error(errorMessage(err)); setBusy(false); }
  };
  return (
    <Card title="Changer le mot de passe" sub="Toutes vos sessions seront révoquées ; vous devrez vous reconnecter.">
      <form onSubmit={submit} className="stack" style={{ maxWidth: 420 }}>
        <Field label="Mot de passe actuel" required><PasswordInput value={cur} onChange={setCur} autoComplete="current-password" /></Field>
        <Field label="Nouveau mot de passe" required hint="10 caractères minimum."><PasswordInput value={pwd} onChange={setPwd} autoComplete="new-password" /></Field>
        <Field label="Confirmation" required error={confirm && confirm !== pwd ? 'Les mots de passe diffèrent.' : null}><PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" /></Field>
        <div><Button type="submit" variant="primary" loading={busy} disabled={!valid}>Mettre à jour</Button></div>
      </form>
    </Card>
  );
}

function TwoFactor() {
  const { reloadUser } = useAuth();
  const status = useQuery(() => authApi.mfaStatus().then((r) => r.data), []);
  const [enroll, setEnroll] = useState(null); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [disable, setDisable] = useState(false);
  const enabled = !!status.data?.mfaEnabled;
  const start = async () => {
    setBusy(true);
    try { const { data } = await authApi.mfaSetup(); setEnroll(data); setCode(''); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true);
    try { await authApi.mfaVerify(code); toast.success('Vérification en deux étapes activée'); setEnroll(null); status.refresh(); reloadUser(); }
    catch (e) { toast.error(errorMessage(e, 'Code invalide')); } finally { setBusy(false); }
  };
  const doDisable = async () => {
    setBusy(true);
    try { await authApi.mfaDisable(code); toast.success('Vérification en deux étapes désactivée'); setDisable(false); setCode(''); status.refresh(); reloadUser(); }
    catch (e) { toast.error(errorMessage(e, 'Code invalide')); } finally { setBusy(false); }
  };
  return (
    <Card title="Vérification en deux étapes (TOTP)" sub="Code à 6 chiffres généré par une application d’authentification à chaque connexion." actions={<Badge tone={enabled ? 'success' : 'warn'} dot>{enabled ? 'Activée' : 'Désactivée'}</Badge>}>
      {!enabled ? (
        <div className="stack">
          <Callout tone="warn">Recommandé pour tous les administrateurs : sans 2FA, un mot de passe compromis suffit à accéder au back-office.</Callout>
          <div><Button variant="primary" icon="lock" loading={busy} onClick={start}>Activer la 2FA</Button></div>
        </div>
      ) : (
        <div className="stack">
          <Callout tone="success">Votre compte est protégé par la vérification en deux étapes.</Callout>
          <div><Button variant="danger-outline" onClick={() => { setDisable(true); setCode(''); }}>Désactiver</Button></div>
        </div>
      )}
      {enroll && (
        <Modal title="Activer la vérification en deux étapes" onClose={() => !busy && setEnroll(null)} size="sm" footer={<><Button onClick={() => setEnroll(null)} disabled={busy}>Annuler</Button><Button variant="primary" loading={busy} disabled={code.length !== 6} onClick={verify}>Vérifier et activer</Button></>}>
          <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
            <div className="small text-2">Scannez ce QR code avec Google Authenticator, Authy ou équivalent, puis saisissez le code affiché.</div>
            {enroll.qrCode ? <img src={enroll.qrCode} alt="QR code 2FA" width={180} height={180} style={{ border: '1px solid var(--border)', borderRadius: 8 }} /> : null}
            <div className="small">Clé manuelle : <code className="mono">{enroll.secret}</code></div>
            <Field label="Code à 6 chiffres"><Input value={code} onChange={(v) => setCode(String(v).replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" style={{ textAlign: 'center', letterSpacing: 6, fontSize: 20 }} /></Field>
          </div>
        </Modal>
      )}
      {disable && (
        <Modal title="Désactiver la 2FA" onClose={() => !busy && setDisable(false)} size="sm" footer={<><Button onClick={() => setDisable(false)} disabled={busy}>Annuler</Button><Button variant="danger" loading={busy} disabled={code.length !== 6} onClick={doDisable}>Désactiver</Button></>}>
          <div className="stack">
            <Callout tone="error">Votre compte ne sera plus protégé que par votre mot de passe.</Callout>
            <Field label="Code actuel de votre application"><Input value={code} onChange={(v) => setCode(String(v).replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" /></Field>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export default function AccountPage() {
  const { admin, logout } = useAuth();
  const { get, set } = useUrlState({ tab: 'profil' });
  const tab = get('tab');
  return (
    <div className="page">
      <PageHeader title="Mon compte" subtitle="Profil, mot de passe et vérification en deux étapes." actions={<Button icon="logout" onClick={logout}>Se déconnecter</Button>} />
      <Tabs value={tab} onChange={(v) => set({ tab: v })} items={[{ value: 'profil', label: 'Profil', icon: 'usercircle' }, { value: 'securite', label: 'Sécurité', icon: 'lock' }]} />
      {tab === 'profil' ? (
        <Card title="Profil">
          <KeyValue rows={[['Nom', `${admin?.firstName || ''} ${admin?.lastName || ''}`.trim() || '—'], ['E-mail', admin?.email], ['Rôle', <Badge tone={roleTone(admin?.role)}>{roleLabel(admin?.role)}</Badge>], ['2FA', admin?.mfaEnabled ? <Badge tone="success">activée</Badge> : <Badge tone="warn">désactivée</Badge>], ['Identifiant', <span className="mono small">{admin?.adminId}</span>]]} />
          <div className="xs muted mt-3">La modification du nom et du rôle se fait par un super administrateur (Configuration → Administrateurs).</div>
        </Card>
      ) : (
        <div className="grid grid-2"><PasswordForm /><TwoFactor /></div>
      )}
    </div>
  );
}
