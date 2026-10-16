// Libelles et conventions d'affichage des operations (table card_transactions).
const TXN_TYPES = {
  payment: { label: 'Paiement', dir: -1, icon: 'shopping-bag', tone: 'icon-pay' },
  topup: { label: 'Rechargement', dir: 1, icon: 'arrow-down-left', tone: 'icon-in' },
  unload: { label: 'Retrait vers Mobile Money', dir: -1, icon: 'arrow-up-right', tone: 'icon-out' },
  fee: { label: 'Frais', dir: -1, icon: 'percent', tone: 'icon-neutral' },
  refund: { label: 'Remboursement', dir: 1, icon: 'rotate-ccw', tone: 'icon-in' },
  card2momo: { label: 'Carte vers Mobile Money', dir: -1, icon: 'smartphone', tone: 'icon-out' },
  card2momo_leg1: { label: 'Carte vers Mobile Money', dir: -1, icon: 'smartphone', tone: 'icon-out' },
  momo2card: { label: 'Mobile Money vers carte', dir: 1, icon: 'arrow-down-left', tone: 'icon-in' },
  momo2momo: { label: 'Transfert Mobile Money', dir: -1, icon: 'smartphone', tone: 'icon-neutral' },
};
export const txnMeta = (type) => TXN_TYPES[type] || { label: type || 'Opération', dir: -1, icon: 'credit-card', tone: 'icon-neutral' };

export const TXN_STATUS = {
  completed: { label: 'Effectuée', tone: 'badge-success' },
  authorized: { label: 'Autorisée', tone: 'badge-info' },
  pending: { label: 'En attente', tone: 'badge-warn' },
  failed: { label: 'Échouée', tone: 'badge-error' },
  declined: { label: 'Refusée', tone: 'badge-error' },
  refunded: { label: 'Remboursée', tone: 'badge-info' },
  needs_refund: { label: 'Remboursement en cours', tone: 'badge-warn' },
  cancelled: { label: 'Annulée', tone: '' },
};
export const txnStatus = (s) => TXN_STATUS[s] || { label: s || '—', tone: '' };

export const txnTitle = (t) => t.merchant_name || t.description || txnMeta(t.type).label;
export const txnFee = (t) => Number(t.fee ?? t.fee_amount ?? 0) || 0;

export const CARD_STATUS = {
  active: { label: 'Active', tone: 'badge-success' },
  frozen: { label: 'Gelée', tone: 'badge-warn' },
  inactive: { label: 'Inactive', tone: '' },
  blocked: { label: 'Bloquée', tone: 'badge-error' },
  cancelled: { label: 'Annulée', tone: 'badge-error' },
  pending: { label: 'En attente', tone: 'badge-warn' },
};
export const cardStatus = (s) => CARD_STATUS[String(s || '').toLowerCase()] || { label: s || '—', tone: '' };

export const OPERATORS = [
  { value: 'mtn', label: 'MTN Mobile Money' },
  { value: 'orange', label: 'Orange Money' },
  { value: 'airtel', label: 'Airtel Money' },
  { value: 'vodacom', label: 'M-Pesa (Vodacom)' },
];

/** Export CSV (page courante) — donnees reelles, separateur point-virgule (Excel FR). */
export const toCsv = (rows) => {
  const head = ['Date', 'Type', 'Libellé', 'Montant', 'Frais', 'Devise', 'Statut', 'Référence'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((t) => [
    new Date(t.initiated_at).toLocaleString('fr-FR'), txnMeta(t.type).label, txnTitle(t),
    Number(t.amount) * txnMeta(t.type).dir, txnFee(t), t.currency || 'XAF', txnStatus(t.status).label, t.auth_code || t.mm_reference || t.txn_id,
  ].map(esc).join(';'));
  return `﻿${head.map(esc).join(';')}\n${lines.join('\n')}`;
};
