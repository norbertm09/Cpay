<?php
/**
 * Plugin Name: C-Pay Payment Gateway
 * Plugin URI:  https://c-pay.global/developers
 * Description: Acceptez les paiements Mobile Money (Airtel Money, MTN MoMo) et carte bancaire via C-Pay (Calculus Plus) sur votre boutique WooCommerce. Zone CEMAC (Congo, Cameroun, Gabon, Tchad).
 * Version:     2.7.0
 * Author:      Calculus Plus SAS
 * Author URI:  https://c-pay.global
 * License:     GPL-2.0+
 * Text Domain: cplus-payment-gateway
 * Domain Path: /languages
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * WC requires at least: 6.0
 * WC tested up to: 8.5
 *
 * Compatibilite : le slug du plugin (cplus-payment-gateway), le fichier
 * principal, le text-domain, l'identifiant de passerelle `cplus` (cle
 * d'options woocommerce_cplus_settings) et les meta de commande `_cplus_*`
 * sont conserves pour que les installations existantes se mettent a jour sans
 * reconfiguration. Les anciens noms de classes (WC_CPlus_Gateway, CPlus_API,
 * CPlus_Webhook) restent disponibles comme alias.
 */

defined('ABSPATH') || exit;

define('CPAY_VERSION',    '2.7.0');
define('CPAY_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('CPAY_PLUGIN_URL', plugin_dir_url(__FILE__));
define('CPAY_API_BASE',   'https://api.c-pay.global/api/v1');

// Constantes historiques (2.6.x) conservees pour les extensions tierces.
define('CPLUS_VERSION',    CPAY_VERSION);
define('CPLUS_PLUGIN_DIR', CPAY_PLUGIN_DIR);
define('CPLUS_PLUGIN_URL', CPAY_PLUGIN_URL);
define('CPLUS_API_BASE',   CPAY_API_BASE);

// ── Vérifier WooCommerce actif ─────────────────────────────────────
add_action('plugins_loaded', 'cpay_init_gateway', 11);
function cpay_init_gateway() {
    if (!class_exists('WC_Payment_Gateway')) {
        add_action('admin_notices', function() {
            echo '<div class="error"><p><strong>C-Pay Payment Gateway</strong> nécessite WooCommerce actif.</p></div>';
        });
        return;
    }
    require_once CPAY_PLUGIN_DIR . 'includes/class-cpay-api.php';
    require_once CPAY_PLUGIN_DIR . 'includes/class-cpay-gateway.php';
    require_once CPAY_PLUGIN_DIR . 'includes/class-cpay-webhook.php';

    add_filter('woocommerce_payment_gateways', 'cpay_add_gateway');
}
function cpay_add_gateway($gateways) {
    $gateways[] = 'WC_CPay_Gateway';
    return $gateways;
}
// Alias historique de la fonction d'init (hooks tiers eventuels)
if (!function_exists('cplus_init_gateway')) { function cplus_init_gateway() { cpay_init_gateway(); } }

// ── Webhook endpoint ───────────────────────────────────────────────
// Nouvelle URL : /wc-api/cpay_webhook — l'ancienne /wc-api/cplus_webhook reste
// servie pour les URLs deja declarees dans le portail marchand.
add_action('woocommerce_api_cpay_webhook',  ['CPay_Webhook', 'handle']);
add_action('woocommerce_api_cplus_webhook', ['CPay_Webhook', 'handle']);

// ── Lien réglages dans liste plugins ──────────────────────────────
add_filter('plugin_action_links_' . plugin_basename(__FILE__), function($links) {
    $url = admin_url('admin.php?page=wc-settings&tab=checkout&section=cplus');
    array_unshift($links, "<a href='$url'>⚙️ Réglages</a>");
    return $links;
});
