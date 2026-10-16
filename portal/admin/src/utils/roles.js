// Rôles admin tels que définis par backend/src/routes/admin.routes.js (validRoles)
// et les requireRole(...) des routes. support_admin apparaît dans deux
// requireRole mais n'est pas un rôle créable : il n'est pas listé ici.
export const ROLES = {
  super_admin: { label: 'Super administrateur', tone: 'navy' },
  ops_admin: { label: 'Administrateur opérations', tone: 'info' },
  finance_admin: { label: 'Finance', tone: 'success' },
  support_agent: { label: 'Support client', tone: 'accent' },
};
export const ROLE_LIST = Object.keys(ROLES);
export const roleLabel = (r) => ROLES[r]?.label || r || '—';
export const roleTone = (r) => ROLES[r]?.tone || 'neutral';

// Groupes de droits utilisés par l'IA du portail (alignés sur requireRole côté API)
export const PERMS = {
  ops: ['super_admin', 'ops_admin'],                       // marchands (écriture), caisse, fraude, rails, connecteurs
  finance: ['super_admin', 'finance_admin'],               // règlements, virements en attente
  crm: ['super_admin', 'ops_admin', 'support_agent'],      // leads, réclamations, conversations
  superOnly: ['super_admin'],                              // administrateurs, audit, tenants, banques (création)
  all: ['super_admin', 'ops_admin', 'finance_admin', 'support_agent'],
};

export const hasRole = (admin, roles) => !roles || roles.includes(admin?.role);
export const can = (admin, perm) => hasRole(admin, PERMS[perm] || PERMS.all);
