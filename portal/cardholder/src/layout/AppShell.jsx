import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../hooks/useAuth';
import { Icon, Button, Modal, Checkbox } from '../components';
import { formatMoney, greeting, initials } from '../utils/format';
import { consent as consentApi } from '../services/auth';
import { LEGAL_CGU_URL, LEGAL_PRIVACY_URL } from '../utils/features';
import { errorMessage } from '../utils/errors';

const NAV = [
  { to: '/', label: 'Accueil', icon: 'home', end: true },
  { to: '/cartes', label: 'Mes cartes', icon: 'credit-card' },
  { to: '/payer', label: 'Payer', icon: 'send', accent: true },
  { to: '/operations', label: 'Opérations', icon: 'list' },
  { to: '/profil', label: 'Profil', icon: 'user' },
];

const UserMenu = ({ user, onLogout }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="topbar-user" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Menu du compte">
        <span className="avatar">{initials(user?.firstName, user?.lastName)}</span>
        <span className="tu-name truncate">{user?.firstName || 'Mon compte'}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div className="menu" role="menu">
          <div style={{ padding: '8px 12px' }}>
            <div className="strong small truncate">{[user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Porteur C-Pay'}</div>
            <div className="xs muted truncate">{user?.email}</div>
          </div>
          <div className="menu-sep" />
          <Link to="/profil" className="menu-item" role="menuitem" onClick={() => setOpen(false)}><Icon name="user" size={18} />Mon profil</Link>
          <Link to="/profil/securite" className="menu-item" role="menuitem" onClick={() => setOpen(false)}><Icon name="shield" size={18} />Sécurité</Link>
          <Link to="/aide" className="menu-item" role="menuitem" onClick={() => setOpen(false)}><Icon name="life-buoy" size={18} />Aide et réclamations</Link>
          <div className="menu-sep" />
          <button type="button" className="menu-item danger" role="menuitem" onClick={onLogout}><Icon name="log-out" size={18} />Se déconnecter</button>
        </div>
      ) : null}
    </div>
  );
};

const ConsentGate = ({ userId }) => {
  const [show, setShow] = useState(false);
  const [cgu, setCgu] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    consentApi.check().then((d) => { if (!cancelled && d && d.hasConsented === false) setShow(true); }).catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);
  const accept = async () => {
    setSaving(true);
    try { await consentApi.accept(); setShow(false); toast.success('Merci, vos consentements sont enregistrés'); }
    catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };
  return (
    <Modal open={show} title="Conditions d’utilisation" closable={false}
      footer={<Button variant="primary" block onClick={accept} disabled={!cgu || !privacy} loading={saving}>Accepter et continuer</Button>}>
      <p className="text-2 small" style={{ marginBottom: 16 }}>Avant de continuer, merci de lire et d’accepter les conditions d’utilisation du service C-Pay édité par Calculus Plus SAS.</p>
      <div className="stack-sm" style={{ marginBottom: 16 }}>
        <div className="card card-pad" style={{ padding: 14 }}>
          <div className="strong small">Conditions Générales d’Utilisation</div>
          <ul className="small text-2" style={{ marginTop: 6, paddingLeft: 16, listStyle: 'disc' }}>
            <li>Service réservé aux personnes majeures</li>
            <li>Usage strictement personnel et non frauduleux</li>
            <li>Droit applicable : zone CEMAC</li>
          </ul>
          <a className="xs" href={LEGAL_CGU_URL} target="_blank" rel="noreferrer">Lire les CGU complètes</a>
        </div>
        <div className="card card-pad" style={{ padding: 14 }}>
          <div className="strong small">Politique de confidentialité</div>
          <ul className="small text-2" style={{ marginTop: 6, paddingLeft: 16, listStyle: 'disc' }}>
            <li>Données collectées pour exécuter vos opérations</li>
            <li>Aucune vente de données à des tiers</li>
          </ul>
          <a className="xs" href={LEGAL_PRIVACY_URL} target="_blank" rel="noreferrer">Lire la politique complète</a>
        </div>
      </div>
      <div className="stack-sm">
        <Checkbox checked={cgu} onChange={(e) => setCgu(e.target.checked)} label="J’accepte les Conditions Générales d’Utilisation de C-Pay" />
        <Checkbox checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} label="J’accepte la Politique de confidentialité et le traitement de mes données" />
      </div>
    </Modal>
  );
};

export default function AppShell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const card = user?.card;

  useEffect(() => { window.scrollTo({ top: 0 }); }, [pathname]);

  const logout = async () => { await signOut(); navigate('/connexion', { replace: true }); };

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="topbar-brand" aria-label="C-Pay, accueil"><img src="/logo-calculus.png" alt="" /><span>C-Pay</span></Link>
        <div className="topbar-greet">
          <span className="tg-hello">{greeting()},</span>
          <span className="tg-name">{user?.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : 'bienvenue'}</span>
        </div>
        <div className="topbar-spacer" />
        {card ? (
          <Link to="/cartes" className="topbar-balance" aria-label={`Solde disponible ${formatMoney(card.balance, card.currency)}`}>
            <Icon name="wallet" size={16} /><span className="tb-label">Solde</span><span className="num">{formatMoney(card.balance, card.currency)}</span>
          </Link>
        ) : null}
        <Link to="/aide" className="btn btn-ghost btn-icon no-print topbar-help" aria-label="Aide"><Icon name="help-circle" /></Link>
        <UserMenu user={user} onLogout={logout} />
      </header>

      <div className="shell-body">
        <nav className="sidebar" aria-label="Navigation principale">
          <div className="sidebar-section">Menu</div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${n.accent ? 'nav-accent' : ''} ${isActive ? 'active' : ''}`}>
              <Icon name={n.icon} size={20} />{n.label}
            </NavLink>
          ))}
          <NavLink to="/aide" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}><Icon name="life-buoy" size={20} />Aide</NavLink>
          {card ? (
            <div className="sidebar-card">
              <div className="sc-label">Solde disponible</div>
              <div className="sc-value">{formatMoney(card.balance, card.currency)}</div>
              <div className="sc-label" style={{ marginTop: 2 }}>{card.cardMasked}</div>
            </div>
          ) : null}
          <div className="sidebar-foot">C-Pay est un produit de Calculus Plus SAS.<br />Support : support@c-pay.global</div>
        </nav>

        <main className="main" id="contenu">
          <div className="main-inner"><Outlet /></div>
        </main>
      </div>

      <nav className="tabbar no-print" aria-label="Navigation">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            {n.accent ? <span className="tb-pay"><Icon name={n.icon} size={22} /></span> : <Icon name={n.icon} size={22} />}
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      {user?.userId ? <ConsentGate userId={user.userId} /> : null}
    </div>
  );
}
