'use strict';
/**
 * Base de connaissances de l'assistant C-Pay (vitrine).
 * Contenu factuel uniquement : tout ce qui est écrit ici peut être répété au public.
 * À maintenir par l'équipe produit ; aucune promesse de certification ni de tarif non validé.
 */
module.exports = `
# C-Pay — fiche produit
C-Pay est la plateforme de paiement panafricaine éditée par Calculus Plus SAS. Elle permet aux marchands
d'encaisser et de reverser de l'argent par Mobile Money, QR code et lien de paiement, depuis une application
Android et un portail web. Principe : le marchand saisit un montant et le numéro du client ; C-Pay détecte
automatiquement le pays, la devise et l'opérateur, puis route le paiement.

## Pays et opérateurs (détection par numéro)
- Sénégal (+221, XOF) : Orange Money (77/78), Free Money (76). Alternative choisie par le client : Wave.
- Côte d'Ivoire (+225, XOF, numéros à 10 chiffres) : Orange Money (07), MTN MoMo (05), Moov Money (01). Alternative : Wave.
- Cameroun (+237, XAF) : MTN MoMo (67, 68, 650-654), Orange Money (69, 655-659). Alternative : Express Union Mobile.
- Congo-Brazzaville (+242, XAF) : MTN MoMo (06), Airtel Money (05).
- RDC (+243, CDF) : Vodacom M-Pesa (81/82), Airtel Money (97-99), Orange Money (84/85/89), Africell Money (90/91).
Les devises XOF, XAF et CDF n'ont pas de décimales. Aucune conversion de change : la devise du client doit être celle du marchand.

## Produits
- Encaissement Mobile Money (push de paiement sur le téléphone du client, confirmation par PIN côté client).
- Retrait / décaissement vers un numéro Mobile Money (réservé au propriétaire du compte marchand).
- QR code et lien de paiement (pay.c-pay.global), partageables par WhatsApp et SMS, valables 24 h (QR) ou 7 jours (lien).
- Portail marchand (merchant.c-pay.global) : tableau de bord, transactions, règlements, terminaux, clés API, webhooks.
- API REST et SDK (JavaScript, PHP, Android) et extension WooCommerce, documentés sur c-pay.global/developers.html ; environnement de test sur demande.
- Paiement par carte sans contact (Tap-to-Phone) : en préparation, conditionné à un SDK certifié ; pas encore disponible.

## Tarifs
- Les tarifs ne sont pas publiés sur le site : chaque marchand consulte sa grille (commission par encaissement
  selon son niveau KYB, frais de retrait et de transfert) dans son portail marchand, rubrique « Tarifs & frais ».
- Les frais de chaque opération sont affichés avant confirmation ; ce montant fait foi.
- Aucun abonnement ni frais d'installation. Les frais prélevés par l'opérateur côté payeur ne dépendent pas de C-Pay.
- Si un visiteur demande un pourcentage : expliquer qu'il dépend du niveau du compte et l'inviter à ouvrir un compte
  ou à contacter sales@c-pay.global ; ne jamais citer de chiffre.

## Caisse (encaisser, retirer, transférer — portail marchand et apps)
- Encaisser : par Mobile Money, le marchand saisit le montant et le numéro du client ; l'opérateur est détecté
  automatiquement (Wave et Express Union se choisissent explicitement) ; la devise du numéro doit être celle du
  marchand. Par carte, C-Pay crée un lien de paiement hébergé (pay.c-pay.global) lorsqu'une passerelle carte est
  configurée pour le pays du marchand ; sinon la fonction est indiquée « en cours d'intégration ».
- Retirer : paiement du solde disponible vers le wallet Mobile Money du marchand (enregistré dans le portail,
  marqué vérifié après le premier retrait abouti), dans la limite journalière du niveau KYB
  (100 000 / 500 000 / 2 000 000 en devise locale pour les niveaux 0 / 1 / 2) ; les frais sont affichés avant confirmation.
- Transférer wallet → banque : vers un compte bancaire vérifié du marchand ; exécuté par les opérations C-Pay
  à J+1 ouvré (le marchand voit le statut « en attente d'exécution » puis « exécuté » avec la référence du virement).
- Transférer banque → wallet (approvisionnement) : C-Pay remet un ordre avec une référence FND-XXXXXX et les
  coordonnées du compte de collecte de la devise ; le marchand effectue le virement (valable 7 jours) et le solde
  est crédité à la confirmation de réception par les opérations.
- Retraits, transferts sortants et changement de wallet exigent une confirmation forte : code 2FA si activé,
  sinon mot de passe du compte. Un journal unique regroupe encaissements, retraits et transferts (export CSV).

## Règlement (reversement au marchand)
- Les encaissements validés sont reversés à J+1 par lot, sur le compte Mobile Money ou bancaire renseigné dans le portail.
- Le virement bancaire est traité manuellement par l'équipe finance ; le Mobile Money est automatique.

## Ouverture de compte
1. Inscription sur merchant.c-pay.global (nom commercial, pays, téléphone, e-mail).
2. Compte créé au niveau 0 (plafond réduit) ; envoi des documents KYB (RCCM, NIF, pièce d'identité du gérant) depuis le portail.
3. Validation par l'équipe C-Pay, passage au niveau 1 puis contrat pour le niveau 2.

## Sécurité (faits)
- Connexion avec mot de passe fort et double authentification (code TOTP) disponible.
- C-Pay ne stocke aucun numéro de carte complet ; les données sont chiffrées en transit (TLS) ; hébergement en Europe (OVH).
- C-Pay ne demande jamais de PIN Mobile Money, de code OTP ni de mot de passe par chat, e-mail ou téléphone.
- Aucune certification PCI DSS n'est revendiquée à ce jour.

## Support et réclamations
- Réclamation : via l'assistant ou le formulaire du site ; une référence REC-XXXXXX est remise et traitée par l'équipe support.
- Délai indicatif de première réponse : 1 jour ouvré. Les litiges de paiement nécessitent la date, le montant, le numéro client et si possible l'identifiant de transaction.
- Contact : support@c-pay.global (support), sales@c-pay.global (commercial), developers@c-pay.global (intégration), security@c-pay.global (sécurité).
`;
