// Traduction des erreurs API en messages porteurs (vouvoiement).
export const FEATURE_DISABLED_MESSAGE = 'Cette fonctionnalité est en cours d’intégration avec nos partenaires. Elle sera disponible prochainement.';

const errorCode = (err) => err?.response?.data?.code || null;
const errorStatus = (err) => err?.response?.status || null;

/** 410 FEATURE_DISABLED, ou service cartes non configure (503 GTP_NOT_CONFIGURED). */
export const isFeatureDisabled = (err) => {
  const st = errorStatus(err);
  const code = errorCode(err);
  return st === 410 || code === 'FEATURE_DISABLED' || code === 'GTP_NOT_CONFIGURED';
};

const BY_CODE = {
  FEATURE_DISABLED: FEATURE_DISABLED_MESSAGE,
  GTP_NOT_CONFIGURED: 'Le service cartes est en cours d’activation. Merci de réessayer plus tard.',
  GTP_TIMEOUT: 'Le service cartes ne répond pas pour le moment. Merci de réessayer dans quelques instants.',
  GTP_NETWORK_ERROR: 'Le service cartes est momentanément inaccessible.',
  RATE_LIMITED: 'Trop de tentatives. Merci de patienter avant de réessayer.',
  DUPLICATE: 'Cet e-mail ou ce numéro de téléphone est déjà utilisé.',
  INVALID_TOKEN: 'Ce lien est invalide ou a déjà été utilisé.',
  INVALID_TOTP: 'Code de vérification invalide.',
  WRONG_PASSWORD: 'Mot de passe actuel incorrect.',
  INVALID_REFRESH: 'Votre session a expiré. Merci de vous reconnecter.',
  LINK_NOT_FOUND: 'Ce lien de paiement est introuvable ou a expiré.',
  NO_GTP_CARD: 'Aucune carte C-Pay réseau n’est rattachée à votre compte.',
};

const BY_STATUS = {
  401: 'Identifiants incorrects.',
  403: 'Accès refusé.',
  404: 'Élément introuvable.',
  409: 'Conflit : cette information existe déjà.',
  422: 'Données invalides. Merci de vérifier le formulaire.',
  423: 'Compte temporairement verrouillé après plusieurs tentatives. Réessayez dans 15 minutes.',
  429: 'Trop de tentatives. Merci de patienter avant de réessayer.',
  500: 'Une erreur est survenue de notre côté. Merci de réessayer.',
  502: 'Service partenaire indisponible. Merci de réessayer plus tard.',
  503: 'Service momentanément indisponible.',
  504: 'Le service ne répond pas. Merci de réessayer.',
};

export const errorMessage = (err, fallback = 'Une erreur est survenue. Merci de réessayer.') => {
  if (!err) return fallback;
  if (!err.response) {
    if (err.code === 'ERR_NETWORK' || err.message === 'Network Error') return 'Connexion impossible. Vérifiez votre accès à Internet.';
    return err.message || fallback;
  }
  const { status, data } = err.response;
  if (data?.code && BY_CODE[data.code]) return BY_CODE[data.code];
  if (status === 410) return FEATURE_DISABLED_MESSAGE;
  if (status === 401 && typeof data?.attemptsLeft === 'number') {
    return data.attemptsLeft > 0
      ? `Identifiants incorrects. ${data.attemptsLeft} tentative${data.attemptsLeft > 1 ? 's' : ''} restante${data.attemptsLeft > 1 ? 's' : ''}.`
      : 'Identifiants incorrects. Compte verrouillé 15 minutes.';
  }
  if (typeof data?.error === 'string' && data.error.trim()) return data.error;
  return BY_STATUS[status] || fallback;
};
