import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Button, Card, Field, Input, PasswordInput, Callout } from '../../components/ui';
import { authApi } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { errorMessage } from '../../utils/errors';

// Étapes renvoyées par POST /auth/login :
//   { mfaRequired:true, mfaToken } → code TOTP via POST /auth/2fa/validate { mfaToken, code }
//   { access_token, mustChangePassword } → session ouverte ; le changement forcé est géré par le garde (ForcePasswordPage)
export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuth, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const from = location.state?.from && location.state.from !== '/login' ? location.state.from : '/';

  useEffect(() => { if (isAuth) navigate(from, { replace: true }); }, [isAuth, navigate, from]);

  const finish = (data) => {
    if (data.mfaRequired && data.mfaToken) { setMfa({ mfaToken: data.mfaToken }); return; }
    login(data);
  };
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (mfa) {
        if (code.length !== 6) { setError('Le code comporte 6 chiffres.'); return; }
        const { data } = await authApi.validate2fa({ mfaToken: mfa.mfaToken, code });
        finish({ ...data, mfaRequired: false });
      } else {
        const { data } = await authApi.login({ email: email.trim(), password });
        finish(data);
      }
    } catch (err) {
      const st = err.response?.status;
      if (st === 423) setError(`Compte temporairement verrouillé après plusieurs échecs. Réessayez plus tard.`);
      else if (st === 401 && err.response?.data?.attemptsLeft !== undefined) setError(`Identifiants incorrects (${err.response.data.attemptsLeft} essai(s) restant(s) avant verrouillage).`);
      else setError(errorMessage(err, 'Connexion impossible'));
    } finally { setBusy(false); }
  };

  return (
    <div className="auth">
      <aside className="auth-side">
        <div>
          <div className="row" style={{ gap: 12 }}>
            <img src="/logo-calculus.png" alt="Calculus Plus" style={{ width: 44, height: 44, background: '#fff', borderRadius: 10, padding: 4 }} />
            <div style={{ lineHeight: 1.1 }}><b style={{ fontSize: 18 }}>C-Pay Admin</b><div style={{ fontSize: 12, color: '#c9d6ee' }}>Back-office de la plateforme</div></div>
          </div>
          <h2>Pilotez la plateforme C-Pay en toute sécurité.</h2>
          <p>Marchands, opérations de caisse, règlements, fraude, support et configuration des opérateurs : chaque tâche à un ou deux clics.</p>
          <ul>
            <li><Icon name="check" size={16} /> Sessions courtes (15 min) renouvelées par cookie sécurisé</li>
            <li><Icon name="check" size={16} /> Vérification en deux étapes (TOTP)</li>
            <li><Icon name="check" size={16} /> Toute action sensible est tracée dans le journal d’audit</li>
          </ul>
        </div>
        <div style={{ fontSize: 12, color: '#9fb2d6' }}>C-Pay est un produit de Calculus Plus SAS · admin.c-pay.global</div>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-logo">
            <img src="/logo-calculus.png" alt="" />
            <div><h1 style={{ fontSize: 22 }}>{mfa ? 'Vérification en deux étapes' : 'Connexion'}</h1><div className="small muted">{mfa ? 'Saisissez le code de votre application d’authentification.' : 'Accès réservé aux administrateurs C-Pay.'}</div></div>
          </div>
          <Card>
            <form onSubmit={submit} className="stack" noValidate>
              {error && <Callout tone="error">{error}</Callout>}
              {mfa ? (
                <>
                  <Field label="Code à 6 chiffres" required>
                    <Input value={code} onChange={(v) => setCode(String(v).replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" autoFocus style={{ fontSize: 22, letterSpacing: 6, textAlign: 'center', height: 48 }} />
                  </Field>
                  <Button type="submit" variant="primary" block loading={busy} disabled={code.length !== 6}>Valider</Button>
                  <Button variant="ghost" block onClick={() => { setMfa(null); setCode(''); setError(null); }}>Retour</Button>
                </>
              ) : (
                <>
                  <Field label="Adresse e-mail" required>
                    <Input type="email" value={email} onChange={setEmail} autoComplete="username" placeholder="prenom.nom@c-pay.global" autoFocus required />
                  </Field>
                  <Field label="Mot de passe" required>
                    <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" placeholder="••••••••••" required />
                  </Field>
                  <Button type="submit" variant="primary" block loading={busy} disabled={!email || !password}>Se connecter</Button>
                </>
              )}
            </form>
          </Card>
          <div className="auth-foot">Mot de passe oublié ? Demandez une réinitialisation à un super administrateur.</div>
        </div>
      </main>
    </div>
  );
}
