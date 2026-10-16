// C-Pay 2.7.0 — Espace marchand : routeur.
//
// Une entrée par capacité (voir layout/nav.js) ; les anciennes adresses
// (/dashboard, /operations, /transactions…) redirigent vers les nouvelles.
import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, Guard } from './hooks/useAuth';
import { Toast } from './components';
import { AppShell } from './layout/AppShell';
import { LEGACY_REDIRECTS } from './layout/nav';
import { Login } from './pages/auth/Login';
import { Register } from './pages/auth/Register';
import { ForgotPassword } from './pages/auth/ForgotPassword';
import { ResetPassword } from './pages/auth/ResetPassword';
import { Accept } from './pages/auth/Accept';
import { Accueil } from './pages/accueil/Accueil';
import { Encaisser } from './pages/caisse/Encaisser';
import { Retirer } from './pages/caisse/Retirer';
import { Transferer } from './pages/caisse/Transferer';
import { Journal } from './pages/activite/Journal';
import { Reglements } from './pages/activite/Reglements';
import { Liens } from './pages/ventes/Liens';
import { Terminaux } from './pages/ventes/Terminaux';
import { TapToPhone } from './pages/ventes/TapToPhone';
import { ClesApi } from './pages/integrations/ClesApi';
import { Webhooks } from './pages/integrations/Webhooks';
import { Plugins } from './pages/integrations/Plugins';
import { Connecteurs } from './pages/integrations/Connecteurs';
import { Profil } from './pages/compte/Profil';
import { Comptes } from './pages/compte/Comptes';
import { Tarifs } from './pages/compte/Tarifs';
import { Securite } from './pages/compte/Securite';
import { Support } from './pages/compte/Support';
import { NotFound } from './pages/NotFound';

// Purge unique des jetons hérités de l'ancien stockage localStorage.
try { localStorage.removeItem('merchant_token'); localStorage.removeItem('merchant_refresh'); localStorage.removeItem('merchant_user'); } catch (e) { /* navigation privée */ }

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toast />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/accept" element={<Guard><Accept /></Guard>} />
          <Route path="/*" element={
            <Guard>
              <AppShell>
                <Routes>
                  <Route index element={<Accueil />} />
                  <Route path="caisse/encaisser" element={<Encaisser />} />
                  <Route path="caisse/retirer" element={<Retirer />} />
                  <Route path="caisse/transferer" element={<Transferer />} />
                  <Route path="activite/journal" element={<Journal />} />
                  <Route path="activite/reglements" element={<Reglements />} />
                  <Route path="ventes/liens" element={<Liens />} />
                  <Route path="ventes/terminaux" element={<Terminaux />} />
                  <Route path="ventes/tap-to-phone" element={<TapToPhone />} />
                  <Route path="integrations/cles-api" element={<ClesApi />} />
                  <Route path="integrations/webhooks" element={<Webhooks />} />
                  <Route path="integrations/plugins" element={<Plugins />} />
                  <Route path="integrations/connecteurs" element={<Connecteurs />} />
                  <Route path="compte/profil" element={<Profil />} />
                  <Route path="compte/comptes" element={<Comptes />} />
                  <Route path="compte/tarifs" element={<Tarifs />} />
                  <Route path="compte/securite" element={<Securite />} />
                  <Route path="compte/support" element={<Support />} />
                  {Object.entries(LEGACY_REDIRECTS).map(([from, to]) => <Route key={from} path={from.slice(1)} element={<Navigate to={to} replace />} />)}
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </AppShell>
            </Guard>
          } />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
