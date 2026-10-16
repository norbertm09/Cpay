import React, { useState, useEffect, useRef } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useAsync } from '../hooks/useAsync';
import { cashApi, authApi, consentApi } from '../services/api';
import { Icon, Button, Notice } from '../components';
import { fmtMoney } from '../utils/format';
import { NAV, areaFor } from './nav';
import Brand from './Brand';

const initials = (u) => {
  const s = [u?.firstName, u?.lastName].filter(Boolean).join(' ') || u?.businessName || u?.email || '?';
  return s.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
};

// Vérification du consentement CGU : renvoie vers /accept tant qu'il manque.
// En cas d'erreur réseau on laisse passer (ne jamais bloquer le marchand).
const ConsentGate = ({ children }) => {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    consentApi.check().then(r => { if (cancelled) return; if (r.data && r.data.hasConsented === false) navigate('/accept', { replace: true }); else setReady(true); })
      .catch(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [navigate]);
  return ready ? children : null;
};

export const AppShell = ({ children }) => {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const area = areaFor(pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('cpay_sidebar') === 'collapsed'; } catch (e) { return false; } });
  const [openGroups, setOpenGroups] = useState({ [area.key]: true });
  const userMenuRef = useRef(null);
  const { data: summary } = useAsync(() => cashApi.summary(), [pathname.split('/')[1]]);
  const { data: twoFa } = useAsync(() => authApi.twoFaStatus(), []);

  useEffect(() => { setMenuOpen(false); setUserMenu(false); setOpenGroups(g => ({ ...g, [area.key]: true })); }, [pathname, area.key]);
  useEffect(() => {
    const onDoc = (e) => { if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenu(false); };
    document.addEventListener('mousedown', onDoc); return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const toggleCollapse = () => setCollapsed(c => { try { localStorage.setItem('cpay_sidebar', c ? 'open' : 'collapsed'); } catch (e) { /* stockage indisponible */ } return !c; });

  const currency = summary?.currency || user?.currency;
  const mfaBanner = twoFa && !twoFa.mfaEnabled && pathname !== '/compte/securite';
  const cls = ['shell', collapsed ? 'collapsed' : '', menuOpen ? 'menu-open' : ''].filter(Boolean).join(' ');

  return (
    <div className={cls}>
      <header className="topbar">
        <Button variant="ghost" className="hamburger" onClick={() => setMenuOpen(o => !o)} aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'} aria-expanded={menuOpen}><Icon name={menuOpen ? 'close' : 'menu'} /></Button>
        <Brand />
        <span className="tb-spacer" />
        {summary?.balance && (
          <Link to="/" className="tb-balance" aria-label={`Solde disponible ${fmtMoney(summary.balance.available, currency)}`}>
            <span className="lbl">Solde disponible</span>
            <span className="val">{fmtMoney(summary.balance.available, currency)}</span>
          </Link>
        )}
        <div ref={userMenuRef} style={{ position: 'relative' }}>
          <button className="tb-user" onClick={() => setUserMenu(o => !o)} aria-haspopup="menu" aria-expanded={userMenu} aria-label="Menu utilisateur">
            <span className="avatar">{initials(user)}</span>
            <span className="name truncate">{user?.businessName || 'Mon compte'}</span>
            <Icon name="chevronDown" size={16} className="name" />
          </button>
          {userMenu && (
            <div className="menu" role="menu">
              <div className="m-head"><div className="n truncate">{user?.businessName}</div><div className="e">{user?.email || [user?.firstName, user?.lastName].filter(Boolean).join(' ')}</div></div>
              <Link to="/compte/profil" role="menuitem"><Icon name="user" size={16} />Profil & KYB</Link>
              <Link to="/compte/securite" role="menuitem"><Icon name="shield" size={16} />Sécurité</Link>
              <Link to="/compte/support" role="menuitem"><Icon name="lifebuoy" size={16} />Support</Link>
              <button className="danger" role="menuitem" onClick={logout}><Icon name="logout" size={16} />Se déconnecter</button>
            </div>
          )}
        </div>
      </header>

      <div className="sidebar-overlay" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <nav className="sidebar" aria-label="Navigation principale">
        {NAV.map(a => {
          const active = a.key === area.key;
          const open = openGroups[a.key] || active;
          return (
            <div className="group" key={a.key}>
              {a.children ? (
                <button className={`group-head${active ? ' active' : ''}${open ? ' open' : ''}`} onClick={() => setOpenGroups(g => ({ ...g, [a.key]: !open }))} aria-expanded={open} title={a.label}>
                  <Icon name={a.icon} size={20} /><span>{a.label}</span><Icon name="chevronRight" size={16} className="chev" />
                </button>
              ) : (
                <NavLink to={a.to} end className={({ isActive }) => `group-head${isActive ? ' active' : ''}`} title={a.label}><Icon name={a.icon} size={20} /><span>{a.label}</span></NavLink>
              )}
              {a.children && open && (
                <div className="sub">{a.children.map(c => <NavLink key={c.to} to={c.to} className={({ isActive }) => (isActive ? 'active' : '')}>{c.label}</NavLink>)}</div>
              )}
            </div>
          );
        })}
        <div className="sb-foot">C-Pay 2.7.0 · Calculus Plus SAS</div>
        <Button variant="ghost" size="sm" className="collapse-btn" onClick={toggleCollapse} aria-label={collapsed ? 'Déployer le menu' : 'Réduire le menu'} icon={collapsed ? 'chevronRight' : 'chevronLeft'}>{collapsed ? '' : 'Réduire'}</Button>
      </nav>

      <main className="main" id="main">
        <div className="content">
          {area.children && (
            <div className="subnav" aria-label={`Sections ${area.label}`}>
              {area.children.map(c => <NavLink key={c.to} to={c.to} className={({ isActive }) => (isActive ? 'active' : '')}>{c.label}</NavLink>)}
            </div>
          )}
          {user?.mustChangePassword && (
            <Notice tone="warn" className="mb-4" action={<Button size="sm" to="/compte/securite">Changer maintenant</Button>}>Vous utilisez un mot de passe temporaire. Définissez un nouveau mot de passe pour sécuriser votre compte.</Notice>
          )}
          {mfaBanner && (
            <Notice tone={twoFa.required ? 'error' : 'warn'} className="mb-4" action={<Button size="sm" to="/compte/securite">Activer la 2FA</Button>}>
              {twoFa.required ? 'La double authentification est désormais obligatoire sur votre compte.' : `Activez la double authentification pour protéger vos fonds${twoFa.daysLeft != null ? ` — ${twoFa.daysLeft} jour(s) restant(s)` : ''}.`}
            </Notice>
          )}
          <ConsentGate>{children}</ConsentGate>
        </div>
      </main>

      <nav className="tabbar" aria-label="Navigation rapide">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}><Icon name="home" />Accueil</NavLink>
        <NavLink to="/activite/journal" className={() => (area.key === 'activite' ? 'active' : '')}><Icon name="activity" />Activité</NavLink>
        <NavLink to="/caisse/encaisser" className={() => `tb-main${area.key === 'caisse' ? ' active' : ''}`}><span className="ring"><Icon name="cash" /></span>Caisse</NavLink>
        <NavLink to="/ventes/liens" className={() => (area.key === 'ventes' ? 'active' : '')}><Icon name="tag" />Ventes</NavLink>
        <button onClick={() => setMenuOpen(o => !o)} aria-label="Plus" className={area.key === 'compte' || area.key === 'integrations' ? 'active' : ''}><Icon name="more" />Plus</button>
      </nav>
    </div>
  );
};
export default AppShell;
