// C-Pay — Portail porteur. Routeur fin : les ecrans vivent dans src/pages.
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './hooks/useAuth';
import AppShell from './layout/AppShell';
import AuthLayout from './layout/AuthLayout';
import LoginPage from './pages/auth/LoginPage';
import RegisterPage from './pages/auth/RegisterPage';
import ForgotPasswordPage from './pages/auth/ForgotPasswordPage';
import ResetPasswordPage from './pages/auth/ResetPasswordPage';
import VerifyEmailPage from './pages/auth/VerifyEmailPage';
import HomePage from './pages/home/HomePage';
import CardsPage from './pages/cards/CardsPage';
import PayPage from './pages/pay/PayPage';
import OperationsPage from './pages/operations/OperationsPage';
import { TopupPage, UnloadPage } from './pages/operations/TransferPages';
import HelpPage from './pages/help/HelpPage';
import ProfilePage from './pages/profile/ProfilePage';

const Splash = () => (
  <div className="splash" role="status" aria-live="polite">
    <img src="/logo-calculus.png" alt="C-Pay" />
    <span>Chargement de votre espace…</span>
  </div>
);

const RequireAuth = ({ children }) => {
  const { isAuth, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Splash />;
  return isAuth ? children : <Navigate to="/connexion" replace state={{ from: location.pathname + location.search }} />;
};

const PublicOnly = ({ children }) => {
  const { isAuth, loading } = useAuth();
  if (loading) return <Splash />;
  return isAuth ? <Navigate to="/" replace /> : children;
};

/** Redirection en conservant la chaine de requete (liens e-mail : ?token=…). */
const RedirectKeepQuery = ({ to }) => {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
};
const LegacyResetRedirect = () => {
  const { search } = useLocation();
  const hasToken = new URLSearchParams(search).has('token');
  return <Navigate to={hasToken ? `/reinitialiser-mot-de-passe${search}` : '/mot-de-passe-oublie'} replace />;
};

// Anciennes routes (portail 2.7.0) -> nouvelle architecture.
const LEGACY = {
  '/cards': '/cartes', '/gtp-card': '/cartes/gtp', '/payment': '/payer', '/transactions': '/operations',
  '/topup': '/operations/recharger', '/unload': '/operations/retirer', '/incidents': '/aide', '/profile': '/profil',
};

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toaster position="top-center" toastOptions={{ duration: 4000, style: { fontFamily: 'var(--font-sans)', fontSize: 14, borderRadius: 10 } }} />
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/connexion" element={<PublicOnly><LoginPage /></PublicOnly>} />
            <Route path="/inscription" element={<PublicOnly><RegisterPage /></PublicOnly>} />
            <Route path="/mot-de-passe-oublie" element={<ForgotPasswordPage />} />
            <Route path="/reinitialiser-mot-de-passe" element={<ResetPasswordPage />} />
            <Route path="/verifier-email" element={<VerifyEmailPage />} />
          </Route>

          <Route path="/login" element={<Navigate to="/connexion" replace />} />
          <Route path="/register" element={<Navigate to="/inscription" replace />} />
          <Route path="/reset-password" element={<LegacyResetRedirect />} />
          <Route path="/verify-email" element={<RedirectKeepQuery to="/verifier-email" />} />
          {Object.entries(LEGACY).map(([from, to]) => <Route key={from} path={`${from}/*`} element={<RedirectKeepQuery to={to} />} />)}

          <Route element={<RequireAuth><AppShell /></RequireAuth>}>
            <Route index element={<HomePage />} />
            <Route path="/cartes/*" element={<CardsPage />} />
            <Route path="/payer" element={<PayPage />} />
            <Route path="/operations" element={<OperationsPage />} />
            <Route path="/operations/recharger" element={<TopupPage />} />
            <Route path="/operations/retirer" element={<UnloadPage />} />
            <Route path="/aide/*" element={<HelpPage />} />
            <Route path="/profil/*" element={<ProfilePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
