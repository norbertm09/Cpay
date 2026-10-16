// Libellés métier : statuts, types d'opérations, opérateurs.
export const OPERATOR_LABELS = {
  mtn_momo: 'MTN MoMo', orange_money: 'Orange Money', airtel_money: 'Airtel Money', wave: 'Wave',
  moov_money: 'Moov Money', free_money: 'Free Money', vodacom_mpesa: 'M-Pesa', africell_money: 'Africell Money',
  express_union: 'Express Union Mobile',
};
export const WALLET_OPERATORS = Object.keys(OPERATOR_LABELS);
export const opLabel = (op, explicit) => explicit || OPERATOR_LABELS[String(op || '').toLowerCase()] || (op ? String(op).replace(/_/g, ' ') : '—');

export const STATUS = {
  authorized: ['Confirmé', 'success'], completed: ['Terminé', 'success'], paid: ['Payé', 'success'], active: ['Actif', 'success'], verified: ['Vérifié', 'success'], approved: ['Approuvé', 'success'], regle: ['Réglé', 'success'], resolved: ['Résolu', 'success'],
  pending: ['En attente', 'warn'], processing: ['En cours', 'warn'], pending_manual: ['En attente d’exécution', 'warn'], pending_settlement: ['En attente d’exécution', 'warn'], awaiting_funds: ['En attente de votre virement', 'info'], in_progress: ['En cours', 'warn'], open: ['Ouvert', 'info'], pending_merchant: ['Réponse attendue', 'warn'], submitted: ['Soumis', 'warn'], en_cours: ['En cours', 'warn'],
  failed: ['Échoué', 'error'], cancelled: ['Annulé', 'neutral'], rejected: ['Rejeté', 'error'], expired: ['Expiré', 'neutral'], refunded: ['Remboursé', 'neutral'], reversed: ['Annulé', 'neutral'], inactive: ['Désactivé', 'neutral'], blocked: ['Bloqué', 'error'], closed: ['Fermé', 'neutral'], echec: ['Échec', 'error'], non_regle: ['Non réglé', 'neutral'], removed: ['Supprimé', 'neutral'],
};
export const statusLabel = (s) => (STATUS[s] || [s || '—'])[0];
export const statusTone = (s) => (STATUS[s] || [null, 'neutral'])[1];

export const CASH_TYPES = { collect: 'Encaissement', withdraw: 'Retrait', transfer_out: 'Transfert vers banque', transfer_in: 'Approvisionnement' };
export const CASH_IN_TYPES = ['collect', 'transfer_in'];
export const TXN_TYPES = { collect: 'Encaissement', payout: 'Décaissement', refund: 'Remboursement', transfer: 'Transfert' };
export const typeLabel = (t) => CASH_TYPES[t] || TXN_TYPES[t] || t || '—';

export const METHOD_LABELS = { mobile_money: 'Mobile Money', card: 'Carte', card_nfc: 'Carte (sans contact)', pay_link: 'Lien de paiement', bank_transfer: 'Virement bancaire', qr: 'QR code' };
export const methodLabel = (m) => METHOD_LABELS[m] || m || '—';

export const TRANSFER_STATUS_HELP = {
  processing: 'En cours d’exécution par le rail de paiement (opérateur ou banque).',
  pending_manual: 'Exécuté par nos opérations sous 1 jour ouvré.',
  pending_settlement: 'Exécuté par nos opérations sous 1 jour ouvré.',
  awaiting_funds: 'Effectuez le virement avec la référence indiquée ; votre solde sera crédité à réception.',
  pending: 'Transfert enregistré, traitement imminent.',
  completed: 'Transfert terminé.',
  failed: 'Le transfert a échoué, les fonds ont été libérés.',
  rejected: 'Transfert rejeté par nos opérations, les fonds ont été libérés.',
  cancelled: 'Transfert annulé.',
};
export const dirLabel = (d) => (d === 'bank_to_wallet' || d === 'funding' || d === 'transfer_in') ? 'Banque → Wallet' : d === 'withdraw' ? 'Retrait vers wallet' : 'Wallet → Banque';

export const CARD_ACCEPTANCE = {
  link: { tone: 'success', text: 'Paiement par carte disponible via lien de paiement (page sécurisée pay.c-pay.global).' },
  tap_to_phone_pending: { tone: 'warn', text: 'Tap-to-Phone : bientôt, après certification. En attendant, la carte est acceptée via lien de paiement.' },
  unavailable: { tone: 'neutral', text: 'Paiement par carte non disponible dans votre pays pour le moment. Encaissez par Mobile Money.' },
};

export const COUNTRIES = [
  ['CG', 'Congo-Brazzaville', 'XAF'], ['CM', 'Cameroun', 'XAF'], ['GA', 'Gabon', 'XAF'], ['GQ', 'Guinée équatoriale', 'XAF'],
  ['TD', 'Tchad', 'XAF'], ['CF', 'Centrafrique', 'XAF'], ['CD', 'RD Congo', 'CDF'], ['CI', 'Côte d’Ivoire', 'XOF'], ['SN', 'Sénégal', 'XOF'],
];
export const countryName = (iso) => (COUNTRIES.find(c => c[0] === iso) || [])[1] || iso || '—';
