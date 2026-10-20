// Message lisible pour une erreur d'API (codes du contrat caisse et routes marchand).
import { isFeatureUnavailable, isCapabilityBlocked } from '../services/api';
import { fmtMoney } from './format';

export const FEATURE_UNAVAILABLE_MSG = 'Fonctionnalité en cours d’intégration';
export const CAPABILITY_BLOCKED_MSG = 'Non disponible dans votre pays pour le moment';

export const errorMessage = (err, ctx = {}) => {
  const d = err?.response?.data || {};
  const st = err?.response?.status;
  if (isFeatureUnavailable(err)) return FEATURE_UNAVAILABLE_MSG;
  if (isCapabilityBlocked(err)) return d.message ? `${CAPABILITY_BLOCKED_MSG} : ${d.message}` : `${CAPABILITY_BLOCKED_MSG}.`;
  const available = d.available ?? d.details?.available;
  switch (d.code) {
    case 'INSUFFICIENT_BALANCE': return `Solde insuffisant${available != null ? ` (disponible : ${fmtMoney(available, ctx.currency)})` : ''}.`;
    case 'DAILY_LIMIT_EXCEEDED': return 'Limite journalière de retrait atteinte. Réessayez demain ou relevez votre niveau KYB.';
    case 'WALLET_MISSING': return 'Aucun wallet enregistré : enregistrez d’abord votre numéro Mobile Money.';
    case 'STEP_UP_REQUIRED': return 'Confirmation requise.';
    case 'STEP_UP_LOCKED': return 'Trop d’échecs de confirmation : réessayez dans 15 minutes.';
    case 'CURRENCY_MISMATCH': return 'La devise de ce numéro ne correspond pas à celle de votre compte.';
    case 'MERCHANT_INACTIVE': return 'Compte marchand inactif : contactez le support.';
    case 'SUSPENDED': return 'Compte suspendu : contactez le support.';
    case 'FUNDING_UNAVAILABLE': return 'Approvisionnement par virement indisponible pour votre devise pour le moment.';
    case 'TRANSFER_NOT_CANCELLABLE': return 'Ce transfert ne peut plus être annulé.';
    case 'LIMIT_EXCEEDED': return d.error || 'Plafond atteint.';
    case 'PAYMENT_DECLINED': return d.error || 'Paiement refusé par l’opérateur.';
    case 'INVALID_TOTP': return 'Code de vérification invalide.';
    case 'INVALID_PHONE': return 'Numéro invalide : format international attendu (ex. +237 6XX XXX XXX).';
    case 'INVALID_TOKEN': return 'Lien invalide ou expiré.';
    case 'UNSAFE_WEBHOOK_URL': return d.error || 'URL de webhook refusée (https:// public obligatoire).';
    case 'VALIDATION_ERROR': return d.error || 'Données invalides.';
    case 'COUNTRY_NOT_OPEN': return d.error || 'Ce pays n’est pas encore ouvert à l’inscription.';
    default: break;
  }
  if (st === 423) return 'Compte temporairement verrouillé après plusieurs échecs. Réessayez dans 15 minutes.';
  if (st === 429) return 'Trop de tentatives, réessayez dans quelques minutes.';
  if (st === 409) return d.error || 'Conflit : cette donnée existe déjà.';
  if (!err?.response) return 'Réseau indisponible, vérifiez votre connexion.';
  if (st >= 500) return 'Erreur du serveur, réessayez dans un instant.';
  return d.error || 'Une erreur est survenue.';
};
