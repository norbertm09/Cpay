=== C-Pay Payment Gateway ===
Contributors: calculusplus
Tags: woocommerce, payment, mobile money, airtel money, mtn momo, cemac, congo, cameroun
Requires at least: 5.8
Tested up to: 6.5
Requires PHP: 7.4
Stable tag: 2.7.0
License: GPL-2.0+
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Acceptez les paiements Mobile Money et carte bancaire via C-Pay (Calculus Plus) sur votre boutique WooCommerce. Zone CEMAC.

== Description ==
C-Pay Payment Gateway intègre la plateforme de paiement C-Pay, éditée par Calculus Plus SAS, à WooCommerce.

**Méthodes de paiement supportées :**
* 🔴 Airtel Money (Congo, Gabon, Tchad)
* 🟡 MTN MoMo (Cameroun, Congo)
* 💳 Carte bancaire Visa/Mastercard (via CyberSource/MIGS)

**Fonctionnalités :**
* Intégration native WooCommerce
* Confirmation automatique via Webhook signé (HMAC-SHA256)
* Remboursements depuis WooCommerce
* Mode Sandbox pour les tests
* Support Zone CEMAC (XAF)

**Prérequis :**
* Compte marchand C-Pay actif (merchant.c-pay.global)
* Clé API générée dans le portail marchand
* WooCommerce 6.0+

== Installation ==
1. Téléchargez et installez le plugin depuis WP Admin → Extensions → Ajouter
2. Activez le plugin
3. Allez dans WooCommerce → Réglages → Paiements → C-Pay
4. Entrez votre API Key et API Secret (disponibles dans merchant.c-pay.global → Clés API)
5. Déclarez l'URL Webhook dans votre portail marchand

== Configuration ==
URL Webhook à déclarer dans le portail marchand :
https://votresite.com/wc-api/cpay_webhook

L'ancienne URL https://votresite.com/wc-api/cplus_webhook reste acceptée.
Les webhooks sont vérifiés avec l'en-tête X-CPay-Signature (l'ancien en-tête
X-CPlus-Signature est accepté en repli).

API : https://api.c-pay.global/api/v1

== Mise à jour depuis 2.6.0 ==
Le slug du plugin (cplus-payment-gateway), l'identifiant de passerelle et vos
réglages sont conservés : aucune reconfiguration n'est nécessaire. Les
classes WC_CPlus_Gateway, CPlus_API et CPlus_Webhook restent disponibles
comme alias de WC_CPay_Gateway, CPay_API et CPay_Webhook.

== Support ==
* Documentation : https://c-pay.global/developers
* Email : support@c-pay.global

== Changelog ==
= 2.7.0 =
* Marque C-Pay (nom, libellés, logo)
* Webhook : en-tête X-CPay-Signature (repli X-CPlus-Signature), nouvelle URL /wc-api/cpay_webhook
* Refus des webhooks non signés dès qu'un secret est configuré
* Alias de compatibilité pour les anciens noms de classes

= 2.6.0 =
* Version initiale
* Support Airtel Money, MTN MoMo, Carte bancaire
* Webhook automatique
* Interface multilingue FR/EN
