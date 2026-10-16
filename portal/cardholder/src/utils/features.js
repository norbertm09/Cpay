// Fonctions monetaires desactivees cote backend (410 FEATURE_DISABLED) tant
// qu'aucun operateur n'est branche. Chaque drapeau peut etre leve par une
// variable d'environnement de build (REACT_APP_FEATURE_<NOM>=true) ; l'ecran
// correspondant garde de toute facon le repli « en cours d'integration »
// si l'API repond 410.
const flag = (name) => process.env[`REACT_APP_FEATURE_${name}`] === 'true';

export const FEATURES = Object.freeze({
  topup: flag('TOPUP'),
  unload: flag('UNLOAD'),
  gtpTopup: flag('GTP_TOPUP'),
  gtpUnload: flag('GTP_UNLOAD'),
  externalCardPayment: flag('EXTERNAL_CARD_PAYMENT'),
});

export const SUPPORT_EMAIL = 'support@c-pay.global';
export const LEGAL_CGU_URL = 'https://c-pay.global/legal/cgu.html';
export const LEGAL_PRIVACY_URL = 'https://c-pay.global/legal/confidentialite.html';
export const PAY_LINK_HOSTS = ['pay.c-pay.global', 'c-pay.global', 'www.c-pay.global'];
