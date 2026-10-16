// Architecture de l'information : une entrée par capacité, aucun doublon.
export const NAV = [
  { key: 'accueil', label: 'Accueil', icon: 'home', to: '/' },
  { key: 'caisse', label: 'Caisse', icon: 'cash', to: '/caisse/encaisser', children: [
    { label: 'Encaisser', to: '/caisse/encaisser', icon: 'arrowDown' },
    { label: 'Retirer', to: '/caisse/retirer', icon: 'arrowUp' },
    { label: 'Transférer', to: '/caisse/transferer', icon: 'swap' },
  ] },
  { key: 'activite', label: 'Activité', icon: 'activity', to: '/activite/journal', children: [
    { label: 'Journal', to: '/activite/journal', icon: 'book' },
    { label: 'Règlements', to: '/activite/reglements', icon: 'bank' },
  ] },
  { key: 'ventes', label: 'Outils de vente', short: 'Ventes', icon: 'tag', to: '/ventes/liens', children: [
    { label: 'Liens & QR', to: '/ventes/liens', icon: 'link' },
    { label: 'Terminaux', to: '/ventes/terminaux', icon: 'smartphone' },
    { label: 'Tap-to-Phone', to: '/ventes/tap-to-phone', icon: 'contactless' },
  ] },
  { key: 'integrations', label: 'Intégrations', icon: 'plug', to: '/integrations/cles-api', children: [
    { label: 'Clés API', to: '/integrations/cles-api', icon: 'key' },
    { label: 'Webhooks', to: '/integrations/webhooks', icon: 'webhook' },
    { label: 'Plugins & SDK', to: '/integrations/plugins', icon: 'box' },
    { label: 'Connecteurs', to: '/integrations/connecteurs', icon: 'grid' },
  ] },
  { key: 'compte', label: 'Compte', icon: 'user', to: '/compte/profil', children: [
    { label: 'Profil & KYB', to: '/compte/profil', icon: 'file' },
    { label: 'Comptes & wallet', to: '/compte/comptes', icon: 'wallet' },
    { label: 'Tarifs & frais', to: '/compte/tarifs', icon: 'tag' },
    { label: 'Sécurité', to: '/compte/securite', icon: 'shield' },
    { label: 'Support', to: '/compte/support', icon: 'lifebuoy' },
  ] },
];

export const areaFor = (pathname) => NAV.find(a => a.to === '/' ? pathname === '/' : pathname.startsWith('/' + a.key)) || NAV[0];

// Redirections des anciennes routes (favoris, liens dans des e-mails).
export const LEGACY_REDIRECTS = {
  '/dashboard': '/', '/caisse': '/', '/operations': '/caisse/encaisser', '/withdraw': '/caisse/retirer',
  '/transactions': '/activite/journal', '/caisse/journal': '/activite/journal', '/settlements': '/activite/reglements',
  '/pay-links': '/ventes/liens', '/terminals': '/ventes/terminaux', '/tap-to-phone': '/ventes/tap-to-phone',
  '/api-keys': '/integrations/cles-api', '/integrations': '/integrations/cles-api',
  '/support': '/compte/support', '/account': '/compte/profil',
};
