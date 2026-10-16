import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import Icon from '../components/Icon';
import { Button, Popover } from '../components/ui';
import CommandPalette from '../components/CommandPalette';
import NotificationBell from './NotificationBell';
import { NAV } from './nav';
import { useAuth } from '../hooks/useAuth';
import { useQuery } from '../hooks/useQuery';
import { cashApi, crmApi, financeApi, supportApi, monitorApi } from '../services/api';
import { roleLabel, hasRole, PERMS } from '../utils/roles';
import { initials } from '../utils/format';

const envLabel = () => {
  const h = window.location.hostname;
  if (h === 'admin.c-pay.global') return { label: 'Production', cls: 'prod' };
  if (h === 'localhost' || h === '127.0.0.1') return { label: 'Local', cls: 'dev' };
  return { label: h.includes('staging') || h.includes('preprod') ? 'Préprod' : 'Hors prod', cls: 'dev' };
};

// Compteurs de files d'attente affichés dans la navigation (lecture discrète : 403 ignoré)
const useNavCounts = (admin) => {
  const ops = hasRole(admin, PERMS.ops), crm = hasRole(admin, PERMS.crm), fin = hasRole(admin, PERMS.finance);
  const { data } = useQuery(async () => {
    const [cash, crmStats, payouts, tickets] = await Promise.all([
      ops ? cashApi.stats().then((r) => r.data).catch(() => null) : null,
      crm ? crmApi.stats().then((r) => r.data).catch(() => null) : null,
      fin ? financeApi.payoutsSummary().then((r) => r.data).catch(() => null) : null,
      supportApi.tickets({ status: 'open', limit: 1 }).then((r) => r.data.total).catch(() => null),
    ]);
    return {
      cash: cash ? (cash.queues?.pendingManual?.count || 0) + (cash.queues?.awaitingFunds?.count || 0) : null,
      claims: crmStats?.claims?.open ?? null, leads: crmStats?.leads?.new ?? null,
      payouts: payouts?.pending ?? null, tickets: tickets ?? null,
    };
  }, [admin?.role], { enabled: !!admin, interval: 60000 });
  return data || {};
};

export default function AppShell({ children }) {
  const { admin, logout } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('admin_sidebar') === '1' || window.innerWidth < 1100; } catch (e) { return false; } });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const counts = useNavCounts(admin);
  const env = envLabel();
  const { data: health } = useQuery(() => monitorApi.health().then((r) => r.data).catch(() => ({ status: 'unreachable' })), [], { interval: 60000 });

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  useEffect(() => {
    const h = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => { try { localStorage.setItem('admin_sidebar', c ? '0' : '1'); } catch (e) { /* ignore */ } return !c; }), []);

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((it) => hasRole(admin, it.roles)) })).filter((g) => g.items.length && hasRole(admin, g.roles));

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />
      <aside className="sidebar" aria-label="Navigation principale">
        <div className="sidebar-brand">
          <img src="/logo-calculus.png" alt="Calculus Plus" />
          <div className="brand-text"><b>C-Pay Admin</b><span>Back-office</span></div>
        </div>
        <nav className="sidebar-nav">
          {groups.map((g) => (
            <div className="nav-group" key={g.label}>
              <div className="nav-group-label">{g.label}</div>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} title={collapsed ? it.label : undefined}>
                  <Icon name={it.icon} size={18} /><span>{it.label}</span>
                  {it.countKey && counts[it.countKey] > 0 && <span className="nav-count" aria-label={`${counts[it.countKey]} en attente`}>{counts[it.countKey] > 99 ? '99+' : counts[it.countKey]}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <Button variant="ghost" size="sm" icon={collapsed ? 'chevronRight' : 'chevronLeft'} onClick={toggleCollapsed} aria-label={collapsed ? 'Déplier le menu' : 'Replier le menu'} />
          <span className="sidebar-version">v{process.env.REACT_APP_VERSION || require('../../package.json').version} · {health?.status === 'ok' ? 'API opérationnelle' : health?.status === 'degraded' ? 'API dégradée' : 'API injoignable'}</span>
        </div>
      </aside>

      <header className="topbar">
        <Button variant="ghost" className="hamburger" icon="menu" aria-label="Ouvrir le menu" onClick={() => setMobileOpen(true)} />
        <div className="topbar-search">
          <button type="button" onClick={() => setPalette(true)} aria-label="Recherche globale (Ctrl+K)">
            <Icon name="search" size={16} /><span>Rechercher un marchand, une référence, une page…</span><span className="kbd">Ctrl K</span>
          </button>
        </div>
        <div className="topbar-right">
          <span className={`env-badge ${env.cls}`} title="Environnement">{env.label}</span>
          <NotificationBell />
          <Popover button={({ toggle, open }) => (
            <button type="button" className="user-menu-btn" onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
              <span className="avatar">{initials(admin?.firstName, admin?.lastName, admin?.email)}</span>
              <span className="who"><b>{admin?.firstName ? `${admin.firstName} ${admin.lastName || ''}` : admin?.email}</b><span>{roleLabel(admin?.role)}</span></span>
              <Icon name="chevronDown" size={14} className="muted" />
            </button>
          )}>
            <div style={{ padding: '6px 10px' }} className="small muted truncate">{admin?.email}</div>
            <div className="sep" />
            <Link to="/compte"><Icon name="usercircle" size={16} /> Mon compte</Link>
            <Link to="/compte?tab=securite"><Icon name="lock" size={16} /> Sécurité &amp; 2FA</Link>
            <div className="sep" />
            <button type="button" onClick={logout}><Icon name="logout" size={16} /> Se déconnecter</button>
          </Popover>
        </div>
      </header>

      <main className="main"><div className="main-inner">{children}</div></main>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
