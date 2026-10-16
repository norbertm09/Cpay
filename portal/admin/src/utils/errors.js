// Traduction des erreurs axios / API en message lisible.
const CODES = {
  INSUFFICIENT_ROLE: 'Vos droits ne permettent pas cette action.',
  INVALID_REFRESH: 'Session expirée, veuillez vous reconnecter.',
  INVALID_TOTP: 'Code de vérification invalide.',
  WEAK_PASSWORD: 'Mot de passe trop faible (10 caractères minimum).',
  SELF_RESET: 'Utilisez la page Compte pour votre propre mot de passe.',
  REFUND_NOT_IMPLEMENTED: 'Le remboursement automatique n’est pas disponible : procédez auprès de l’opérateur.',
  TRANSFER_NOT_FOUND: 'Transfert introuvable.',
  INVALID_STATUS: 'Le statut actuel ne permet pas cette action.',
  NOT_FUNDING_ORDER: 'Ce transfert n’est pas un ordre d’approvisionnement.',
  VALIDATION_ERROR: 'Données invalides.',
  RAW_PAN_NOT_ALLOWED: 'Données carte brutes interdites : utilisez un token réseau.',
  COUNTRY_REQUIRED: 'Pays requis ou numéro de téléphone non reconnu.',
  UNSUPPORTED_COUNTRY: 'Pays non pris en charge.',
};

export const errorMessage = (err, fallback = 'Une erreur est survenue') => {
  if (!err) return fallback;
  const data = err.response?.data;
  const status = err.response?.status;
  if (data?.error && typeof data.error === 'string') return data.error;
  if (data?.code && CODES[data.code]) return CODES[data.code];
  if (status === 403) return CODES.INSUFFICIENT_ROLE;
  if (status === 404) return 'Ressource introuvable.';
  if (status === 409) return 'Conflit : l’opération a déjà été réalisée ou l’état a changé.';
  if (status === 422) return CODES.VALIDATION_ERROR;
  if (status === 429) return 'Trop de tentatives, réessayez dans quelques minutes.';
  if (status >= 500) return 'Le serveur a rencontré une erreur. Réessayez.';
  if (err.code === 'ERR_NETWORK' || !err.response) return 'Serveur injoignable. Vérifiez votre connexion.';
  return err.message || fallback;
};

export const isForbidden = (err) => err?.response?.status === 403;
export const isNotFound = (err) => err?.response?.status === 404;
