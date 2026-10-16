import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { Card, Button, Badge, Modal, PasswordInput, PinInput, Alert, Icon, SkeletonList, ErrorState, EmptyState, CopyButton } from '../../components';
import * as authApi from '../../services/auth';
import { errorMessage } from '../../utils/errors';
import { passwordIssues } from '../../utils/validation';
import { formatDateTime } from '../../utils/format';

const EVENT_LABELS = {
  AUTH_SUCCESS: 'Connexion réussie', AUTH_FAILURE: 'Échec de connexion', AUTH_LOCKOUT: 'Compte verrouillé', AUTH_LOGOUT: 'Déconnexion',
  CARDHOLDER_REGISTERED: 'Création du compte', PIN_CHANGE: 'Changement de PIN', PASSWORD_CHANGE: 'Changement de mot de passe',
};

const PasswordModal = ({ open, onClose }) => {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    const er = {};
    if (!f.current) er.current = 'Mot de passe actuel requis';
    const issues = passwordIssues(f.next);
    if (issues.length) er.next = `Le mot de passe doit contenir : ${issues.join(', ')}.`;
    if (f.next !== f.confirm) er.confirm = 'Les deux mots de passe ne correspondent pas';
    if (f.current && f.next === f.current) er.next = 'Choisissez un mot de passe différent de l’actuel';
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true); setFormError('');
    try {
      await authApi.changePassword(f.current, f.next);
      toast.success('Mot de passe modifié. Reconnectez-vous.');
      await signOut();
      navigate('/connexion', { replace: true });
    } catch (err) { setFormError(errorMessage(err)); setBusy(false); }
  };
  return (
    <Modal open={open} title="Changer le mot de passe" onClose={busy ? undefined : onClose}
      footer={<><Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button><Button variant="primary" onClick={submit} loading={busy}>Modifier</Button></>}>
      <form onSubmit={submit} noValidate className="stack">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Alert tone="info">Pour votre sécurité, toutes vos sessions seront déconnectées après le changement.</Alert>
        <PasswordInput label="Mot de passe actuel" required value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} error={errors.current} autoComplete="current-password" autoFocus />
        <PasswordInput label="Nouveau mot de passe" required value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} error={errors.next} autoComplete="new-password" hint="8 caractères minimum, avec majuscule, minuscule et chiffre" />
        <PasswordInput label="Confirmer" required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} error={errors.confirm} autoComplete="new-password" />
        <button type="submit" className="sr-only">Modifier</button>
      </form>
    </Modal>
  );
};

const TwoFaModal = ({ open, mode, onClose, onDone }) => {
  // mode: 'setup' | 'disable'
  const [enroll, setEnroll] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadErr, setLoadErr] = useState(null);

  const start = React.useCallback(async () => {
    setLoadErr(null); setEnroll(null);
    try { setEnroll(await authApi.twoFa.setup()); } catch (err) { setLoadErr(err); }
  }, []);
  React.useEffect(() => { if (open && mode === 'setup') start(); if (!open) { setCode(''); setError(''); setEnroll(null); } }, [open, mode, start]);

  const submit = async () => {
    if (code.length !== 6) { setError('Saisissez le code à 6 chiffres.'); return; }
    setBusy(true); setError('');
    try {
      if (mode === 'setup') await authApi.twoFa.verify(code); else await authApi.twoFa.disable(code);
      toast.success(mode === 'setup' ? 'Double authentification activée' : 'Double authentification désactivée');
      onDone();
    } catch (err) { setError(errorMessage(err, 'Code invalide.')); setCode(''); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} title={mode === 'setup' ? 'Activer la double authentification' : 'Désactiver la double authentification'} onClose={busy ? undefined : onClose}
      footer={<><Button variant="outline" onClick={onClose} disabled={busy}>Annuler</Button><Button variant={mode === 'setup' ? 'primary' : 'danger'} onClick={submit} loading={busy} disabled={mode === 'setup' && !enroll}>{mode === 'setup' ? 'Activer' : 'Désactiver'}</Button></>}>
      <div className="stack">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {mode === 'setup' ? (
          loadErr ? <ErrorState error={loadErr} onRetry={start} title="Impossible de préparer la 2FA" />
            : !enroll ? <div className="stack center" style={{ alignItems: 'center' }}><div className="skeleton qr-img" /><p className="small muted">Génération du QR code…</p></div>
              : (
                <>
                  <p className="small text-2">1. Scannez ce QR code avec une application d’authentification (Google Authenticator, Microsoft Authenticator, Authy…).</p>
                  {enroll.qrCode ? <img className="qr-img" src={enroll.qrCode} alt="QR code d’enrôlement 2FA" /> : <Alert tone="warn">QR code indisponible : saisissez la clé manuellement dans votre application.</Alert>}
                  <div className="stack-sm">
                    <span className="xs muted center">Clé à saisir manuellement</span>
                    <div className="secret">{enroll.secret}</div>
                    <div className="center"><CopyButton value={enroll.secret} label="Copier la clé" /></div>
                  </div>
                  <p className="small text-2">2. Saisissez le code à 6 chiffres affiché par l’application.</p>
                </>
              )
        ) : <p className="small text-2">Saisissez un code valide de votre application d’authentification pour confirmer la désactivation. Votre compte sera moins protégé.</p>}
        <PinInput value={code} onChange={setCode} length={6} label="Code de vérification" secret={false} />
      </div>
    </Modal>
  );
};

export default function SecurityTab() {
  const { user, reloadUser, signOut } = useAuth();
  const navigate = useNavigate();
  const status = useAsync(authApi.twoFa.status, []);
  const events = useAsync(authApi.securityEvents, []);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [twoFa, setTwoFa] = useState(null); // 'setup' | 'disable'
  const [resend, setResend] = useState({ busy: false, msg: '' });

  const mfaOn = status.data ? !!status.data.mfaEnabled : !!user?.mfaEnabled;

  const resendVerification = async () => {
    setResend({ busy: true, msg: '' });
    try {
      const r = await authApi.resendVerification();
      setResend({ busy: false, msg: r.alreadyVerified ? 'Votre adresse e-mail est déjà vérifiée.' : `Un nouveau lien d’activation a été envoyé à ${user?.email}.` });
    } catch (err) { setResend({ busy: false, msg: '' }); toast.error(errorMessage(err)); }
  };

  const logout = async () => { await signOut(); navigate('/connexion', { replace: true }); };

  return (
    <div className="help-grid">
      <div className="stack">
        <Card title="Sécurité du compte">
          <div className="sec-row">
            <div className="sr-main">
              <div className="sr-title"><Icon name="shield-check" size={18} />Double authentification (2FA) <Badge tone={mfaOn ? 'badge-success' : 'badge-warn'} dot>{mfaOn ? 'Activée' : 'Désactivée'}</Badge></div>
              <div className="sr-sub">Un code à usage unique vous est demandé à chaque connexion.{status.data && !mfaOn && status.data.daysLeft != null ? ` Recommandée : ${status.data.required ? 'requise' : `${status.data.daysLeft} jours avant activation obligatoire`}.` : ''}</div>
            </div>
            <Button variant={mfaOn ? 'danger-outline' : 'primary'} size="sm" onClick={() => setTwoFa(mfaOn ? 'disable' : 'setup')}>{mfaOn ? 'Désactiver' : 'Activer'}</Button>
          </div>
          <div className="sec-row">
            <div className="sr-main">
              <div className="sr-title"><Icon name="key" size={18} />Mot de passe {user?.mustChangePassword ? <Badge tone="badge-error">Temporaire</Badge> : null}</div>
              <div className="sr-sub">Choisissez un mot de passe unique, non utilisé ailleurs.</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setPwdOpen(true)}>Modifier</Button>
          </div>
          <div className="sec-row">
            <div className="sr-main">
              <div className="sr-title"><Icon name="mail" size={18} />Vérification de l’e-mail</div>
              <div className="sr-sub">{resend.msg || `Vous n’avez pas reçu le lien d’activation envoyé à ${user?.email || 'votre adresse'} ?`}</div>
            </div>
            <Button variant="outline" size="sm" onClick={resendVerification} loading={resend.busy}>Renvoyer le lien</Button>
          </div>
          <div className="sec-row">
            <div className="sr-main">
              <div className="sr-title"><Icon name="log-out" size={18} />Session</div>
              <div className="sr-sub">Déconnectez-vous sur cet appareil. Le changement de mot de passe déconnecte tous les appareils.</div>
            </div>
            <Button variant="ghost" size="sm" onClick={logout}>Se déconnecter</Button>
          </div>
        </Card>
      </div>
      <Card flush title="Activité récente" actions={<Button size="sm" variant="ghost" icon="refresh-cw" onClick={events.reload} aria-label="Actualiser" />}>
        {events.loading ? <SkeletonList rows={4} />
          : events.error ? <ErrorState error={events.error} onRetry={events.reload} title="Journal indisponible" />
            : !events.data?.length ? <EmptyState icon="shield" title="Aucun événement">Les connexions et actions sensibles s’afficheront ici.</EmptyState>
              : events.data.slice(0, 15).map((e, i) => (
                <div className="list-item" key={`${e.created_at}-${i}`}>
                  <span className={`li-icon ${e.success === false ? 'icon-error' : 'icon-neutral'}`}><Icon name={e.success === false ? 'alert-circle' : 'check'} size={16} /></span>
                  <span className="li-main">
                    <span className="li-title">{EVENT_LABELS[e.event_type] || e.event_type}</span>
                    <span className="li-sub">{formatDateTime(e.created_at)}{e.ip_address ? ` · ${e.ip_address}` : ''}</span>
                  </span>
                </div>
              ))}
      </Card>
      <PasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
      <TwoFaModal open={!!twoFa} mode={twoFa || 'setup'} onClose={() => setTwoFa(null)} onDone={async () => { setTwoFa(null); await Promise.all([status.reload(), reloadUser()]); }} />
    </div>
  );
}
