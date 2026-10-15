<?php
/**
 * Plugin Name: CPlus Payment Gateway
 * Plugin URI:  https://c-pay.global/developers
 * Description: Acceptez les paiements Mobile Money (Airtel Money, MTN MoMo) et carte bancaire via CPlus sur votre boutique WooCommerce. Zone CEMAC (Congo, Cameroun, Gabon, Tchad).
 * Version:     2.6.0
 * Author:      Calculus Plus SAS
 * Author URI:  https://c-pay.global
 * License:     GPL-2.0+
 * Text Domain: cplus-payment-gateway
 * Domain Path: /languages
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * WC requires at least: 6.0
 * WC tested up to: 8.5
 */

defined('ABSPATH') || exit;

define('CPLUS_VERSION', '2.6.0');
define('CPLUS_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('CPLUS_PLUGIN_URL', plugin_dir_url(__FILE__));
define('CPLUS_API_BASE',   'https://api.c-pay.global/api/v1');

// ── Vérifier WooCommerce actif ─────────────────────────────────────
add_action('plugins_loaded', 'cplus_init_gateway', 11);
function cplus_init_gateway() {
    if (!class_exists('WC_Payment_Gateway')) {
        add_action('admin_notices', function() {
            echo '<div class="error"><p><strong>CPlus Payment Gateway</strong> nécessite WooCommerce actif.</p></div>';
        });
        return;
    }
    require_once CPLUS_PLUGIN_DIR . 'includes/class-cplus-gateway.php';
    require_once CPLUS_PLUGIN_DIR . 'includes/class-cplus-webhook.php';
    require_once CPLUS_PLUGIN_DIR . 'includes/class-cplus-api.php';

    add_filter('woocommerce_payment_gateways', 'cplus_add_gateway');
    function cplus_add_gateway($gateways) {
        $gateways[] = 'WC_CPlus_Gateway';
        return $gateways;
    }
}

// ── Webhook endpoint ───────────────────────────────────────────────
add_action('woocommerce_api_cplus_webhook', ['CPlus_Webhook', 'handle']);

// ── Lien réglages dans liste plugins ──────────────────────────────
add_filter('plugin_action_links_' . plugin_basename(__FILE__), function($links) {
    $url = admin_url('admin.php?page=wc-settings&tab=checkout&section=cplus');
    array_unshift($links, "<a href='$url'>⚙️ Réglages</a>");
    return $links;
});
