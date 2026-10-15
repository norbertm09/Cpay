=== CPlus Payment Gateway ===
Contributors: calculusplus
Tags: woocommerce, payment, mobile money, airtel money, mtn momo, cemac, congo, cameroun
Requires at least: 5.8
Tested up to: 6.5
Requires PHP: 7.4
Stable tag: 2.6.0
License: GPL-2.0+
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Acceptez les paiements Mobile Money et carte bancaire via CPlus sur votre boutique WooCommerce. Zone CEMAC.

== Description ==
CPlus Payment Gateway intègre la plateforme de paiement CPlus à WooCommerce.

**Méthodes de paiement supportées :**
* 🔴 Airtel Money (Congo, Gabon, Tchad)
* 🟡 MTN MoMo (Cameroun, Congo)
* 💳 Carte bancaire Visa/Mastercard (via CyberSource/MIGS)

**Fonctionnalités :**
* Intégration native WooCommerce
* Confirmation automatique via Webhook
* Remboursements depuis WooCommerce
* Mode Sandbox pour les tests
* Support Zone CEMAC (XAF)

**Prérequis :**
* Compte Merchant CPlus actif (merchant.c-pay.global)
* Clé API générée dans le Merchant Portal
* WooCommerce 6.0+

== Installation ==
1. Téléchargez et installez le plugin depuis WP Admin → Extensions → Ajouter
2. Activez le plugin
3. Allez dans WooCommerce → Réglages → Paiements → CPlus
4. Entrez votre API Key et API Secret (disponibles dans merchant.c-pay.global → API Keys)
5. Configurez l'URL Webhook dans votre Merchant Portal

== Configuration ==
URL Webhook à configurer dans Merchant Portal :
https://votresite.com/wc-api/cplus_webhook

== Support ==
* Documentation : https://c-pay.global/developers
* Email : support@c-pay.global

== Changelog ==
= 2.6.0 =
* Version initiale
* Support Airtel Money, MTN MoMo, Carte bancaire
* Webhook automatique
* Interface multilingue FR/EN

