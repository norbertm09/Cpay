import React from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ForbiddenState } from '../components/ui';
import { roleLabel } from '../utils/roles';

export const AuthSplash = () => (
  <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--text-3)' }}>
    <div className="row"><span className="spinner" /> Chargement de la session…</div>
  </div>
);

// Session requise ; renvoie vers /login en conservant la destination.
export const RequireAuth = ({ children }) => {
  const { isAuth, loading } = useAuth();
  const location = useLocation();
  if (loading) return <AuthSplash />;
  return isAuth ? children : <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
};

// Page réservée à certains rôles (aligné sur requireRole côté API).
export const RequireRole = ({ roles, children }) => {
  const { hasRole } = useAuth();
  if (!hasRole(roles)) return <div className="card"><ForbiddenState roles={roles.map(roleLabel)} /></div>;
  return children;
};

// Redirection d'une ancienne route vers la nouvelle, paramètres et query conservés.
export const Legacy = ({ to }) => {
  const params = useParams();
  const location = useLocation();
  let target = to;
  Object.entries(params).forEach(([k, v]) => { target = target.replace(`:${k}`, v); });
  if (location.search) target += (target.includes('?') ? '&' : '?') + location.search.slice(1);
  return <Navigate to={target} replace />;
};
