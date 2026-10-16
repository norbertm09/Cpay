// Carte statut → { label, tone } pour les Badge. Une seule source de vérité.
const S = (label, tone) => ({ label, tone });

export const STATUS = {
  // Transactions
  authorized: S('Autorisée', 'success'), approved: S('Approuvée', 'success'), completed: S('Terminé', 'success'),
  failed: S('Échouée', 'error'), pending: S('En attente', 'warn'), processing: S('En cours', 'info'),
  reversed: S('Annulée', 'neutral'), cancelled: S('Annulé', 'neutral'), rejected: S('Rejeté', 'error'), expired: S('Expiré', 'neutral'),
  // Caisse
  awaiting_funds: S('Fonds attendus', 'warn'), pending_manual: S('À exécuter', 'warn'), pending_settlement: S('À virer', 'warn'),
  // Règlement d'une transaction
  regle: S('Réglé', 'success'), en_cours: S('En cours', 'warn'), echec: S('Échec', 'error'), non_regle: S('Non réglé', 'neutral'),
  // Lots de règlement
  submitted: S('Soumis', 'info'),
  // Marchands, terminaux, utilisateurs
  active: S('Actif', 'success'), inactive: S('Inactif', 'neutral'), suspended: S('Suspendu', 'error'), closed: S('Fermé', 'neutral'), blocked: S('Bloqué', 'error'),
  // KYB / KYC
  not_started: S('Non démarré', 'neutral'), in_progress: S('En cours', 'warn'), verified: S('Vérifié', 'success'),
  // Tickets
  open: S('Ouvert', 'error'), pending_admin: S('En cours', 'warn'), pending_merchant: S('Attente marchand', 'info'), resolved: S('Résolu', 'success'),
  // CRM
  new: S('Nouveau', 'info'), contacted: S('Contacté', 'warn'), qualified: S('Qualifié', 'cyan'), converted: S('Converti', 'success'), lost: S('Perdu', 'neutral'),
  // Fraude
  allow: S('Autorisé', 'success'), review: S('À revoir', 'warn'), block: S('Bloqué', 'error'),
  false_positive: S('Faux positif', 'success'), confirmed_fraud: S('Fraude confirmée', 'error'),
  // Connecteurs
  testing: S('Test', 'info'), error: S('Erreur', 'error'),
  // Divers
  approved_doc: S('Approuvé', 'success'), done: S('Fait', 'success'),
  sandbox: S('Sandbox', 'info'), production: S('Production', 'success'), staging: S('Staging', 'info'),
};

export const statusOf = (s) => STATUS[s] || { label: s || '—', tone: 'neutral' };

export const PRIORITY = { low: S('Faible', 'neutral'), normal: S('Normale', 'info'), high: S('Haute', 'warn'), urgent: S('Urgente', 'error') };
export const priorityOf = (p) => PRIORITY[p] || { label: p || '—', tone: 'neutral' };

export const SEVERITY = { 1: S('Faible', 'neutral'), 2: S('Moyenne', 'warn'), 3: S('Élevée', 'accent'), 4: S('Critique', 'error') };
export const severityOf = (n) => SEVERITY[n] || { label: String(n ?? '—'), tone: 'neutral' };

export const KYB_LEVELS = [
  { v: 0, label: 'Niveau 0 — compte créé', limit: '500 000 / jour' },
  { v: 1, label: 'Niveau 1 — KYB validé', limit: '5 000 000 / jour' },
  { v: 2, label: 'Niveau 2 — contrat signé', limit: 'Illimité' },
];
export const kybTone = (lvl) => ['neutral', 'warn', 'success'][Number(lvl)] || 'neutral';

export const TRANSFER_DIRECTIONS = {
  wallet_to_bank: S('Wallet → banque', 'info'), bank_to_wallet: S('Banque → wallet', 'cyan'), withdraw: S('Retrait wallet', 'success'),
};
export const directionOf = (t) => {
  const d = t?.direction || t?.type;
  if (TRANSFER_DIRECTIONS[d]) return TRANSFER_DIRECTIONS[d];
  if (d === 'funding') return TRANSFER_DIRECTIONS.bank_to_wallet;
  if (d === 'payout') return t?.wallet ? TRANSFER_DIRECTIONS.withdraw : TRANSFER_DIRECTIONS.wallet_to_bank;
  return { label: d || '—', tone: 'neutral' };
};
