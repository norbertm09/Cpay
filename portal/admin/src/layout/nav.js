import { PERMS } from '../utils/roles';

// Architecture de l'information du back-office. `roles` absent = tous les
// rôles admin. Les droits d'écriture sont contrôlés dans chaque page.
export const NAV = [
  { label: 'Pilotage', items: [
    { to: '/', label: 'Tableau de bord', icon: 'dashboard', end: true },
  ] },
  { label: 'Clients', items: [
    { to: '/marchands', label: 'Marchands', icon: 'store' },
    { to: '/porteurs', label: 'Porteurs', icon: 'idcard' },
  ] },
  { label: 'Opérations', items: [
    { to: '/operations/transactions', label: 'Transactions', icon: 'swap' },
    { to: '/operations/caisse', label: 'Caisse', icon: 'banknote', roles: PERMS.ops, countKey: 'cash' },
    { to: '/operations/reglements', label: 'Règlements', icon: 'receipt', roles: PERMS.finance, countKey: 'payouts' },
    { to: '/operations/fraude', label: 'Fraude & alertes', icon: 'shield' },
    { to: '/operations/rails', label: 'Rails', icon: 'network', roles: PERMS.ops },
  ] },
  { label: 'Support & CRM', items: [
    { to: '/support/tickets', label: 'Tickets', icon: 'lifebuoy', countKey: 'tickets' },
    { to: '/support/reclamations', label: 'Réclamations', icon: 'flag', roles: PERMS.crm, countKey: 'claims' },
    { to: '/support/leads', label: 'Leads', icon: 'target', roles: PERMS.crm, countKey: 'leads' },
    { to: '/support/conversations', label: 'Conversations', icon: 'chat', roles: PERMS.crm },
  ] },
  { label: 'Partenaires & distribution', roles: PERMS.ops, items: [
    { to: '/partenaires/banques', label: 'Banques', icon: 'bank', roles: PERMS.ops },
    { to: '/partenaires/agences', label: 'Agences', icon: 'pin', roles: PERMS.ops },
    { to: '/partenaires/agents', label: 'Agents', icon: 'users', roles: PERMS.ops },
    { to: '/partenaires/tenants', label: 'Tenants', icon: 'globe', roles: PERMS.ops },
  ] },
  { label: 'Configuration', items: [
    { to: '/configuration/connecteurs', label: 'Connecteurs opérateurs', icon: 'plug', roles: PERMS.ops },
    { to: '/configuration/notifications', label: 'Notifications', icon: 'bell', roles: PERMS.ops },
    { to: '/configuration/terminaux', label: 'Terminaux', icon: 'phone' },
    { to: '/configuration/fonctionnalites', label: 'Fonctionnalités & pilote', icon: 'toggle', roles: PERMS.ops },
    { to: '/configuration/administrateurs', label: 'Administrateurs', icon: 'usershield', roles: PERMS.superOnly },
    { to: '/configuration/audit', label: 'Journal d’audit', icon: 'list', roles: PERMS.superOnly },
    { to: '/configuration/monitoring', label: 'Monitoring', icon: 'activity' },
  ] },
];

// Anciennes routes → nouvelles (redirections conservées pour les favoris).
export const LEGACY_REDIRECTS = [
  ['/merchants', '/marchands'], ['/merchants/:id', '/marchands/:id'], ['/users', '/marchands/utilisateurs'],
  ['/cardholders', '/porteurs'], ['/cardholders/:id', '/porteurs'],
  ['/transactions', '/operations/transactions'], ['/finance', '/operations/reglements'],
  ['/fraud', '/operations/fraude'], ['/alerts', '/operations/fraude?tab=alertes'],
  ['/monitoring', '/configuration/monitoring'], ['/audit', '/configuration/audit'],
  ['/tickets', '/support/tickets'], ['/crm/leads', '/support/leads'], ['/crm/complaints', '/support/reclamations'], ['/crm/conversations', '/support/conversations'],
  ['/cash', '/operations/caisse'], ['/cash/transfers', '/operations/caisse?tab=transferts'], ['/cash/platform-accounts', '/operations/caisse?tab=comptes'],
  ['/banks', '/partenaires/banques'], ['/banks/:id', '/partenaires/banques/:id'], ['/partners-agencies', '/partenaires/agences'], ['/partners-agents', '/partenaires/agents'], ['/tenants', '/partenaires/tenants'],
  ['/api-configs', '/configuration/connecteurs'], ['/terminals', '/configuration/terminaux'], ['/admin-users', '/configuration/administrateurs'],
];
