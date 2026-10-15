<?php
defined('ABSPATH') || exit;

class WC_CPay_Gateway extends WC_Payment_Gateway {

    public function __construct() {
        // L'identifiant `cplus` est conserve : il nomme la cle d'options
        // (woocommerce_cplus_settings) et la section de reglages des boutiques
        // deja configurees.
        $this->id                 = 'cplus';
        $this->icon               = CPAY_PLUGIN_URL . 'assets/logo-cpay.png';
        $this->has_fields         = true;
        $this->method_title       = 'C-Pay — Mobile Money & Carte';
        $this->method_description = 'Acceptez les paiements Mobile Money (Airtel Money, MTN MoMo) et carte bancaire via C-Pay (Calculus Plus). Zone CEMAC.';
        $this->supports           = ['products', 'refunds'];

        $this->init_form_fields();
        $this->init_settings();

        $this->title       = $this->get_option('title');
        $this->description = $this->get_option('description');
        $this->api_key     = $this->get_option('api_key');
        $this->api_secret  = $this->get_option('api_secret');
        $this->environment = $this->get_option('environment', 'sandbox');
        $this->webhook_secret = $this->get_option('webhook_secret');

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
    }

    public function init_form_fields() {
        $this->form_fields = [
            'enabled' => [
                'title'   => 'Activer/Désactiver',
                'type'    => 'checkbox',
                'label'   => 'Activer C-Pay Payment Gateway',
                'default' => 'yes',
            ],
            'title' => [
                'title'       => 'Titre',
                'type'        => 'text',
                'description' => 'Titre affiché au client lors du paiement.',
                'default'     => '📱 C-Pay — Mobile Money & Carte',
                'desc_tip'    => true,
            ],
            'description' => [
                'title'       => 'Description',
                'type'        => 'textarea',
                'description' => 'Description affichée au client.',
                'default'     => 'Payez avec Airtel Money, MTN MoMo ou votre carte bancaire via C-Pay.',
            ],
            'environment' => [
                'title'       => 'Environnement',
                'type'        => 'select',
                'description' => 'Choisissez Sandbox pour les tests, Production pour les vrais paiements.',
                'default'     => 'sandbox',
                'options'     => [
                    'sandbox'    => '🔵 Sandbox (Tests)',
                    'production' => '🟢 Production',
                ],
            ],
            'api_key' => [
                'title'       => 'API Key (sk_live_xxx)',
                'type'        => 'text',
                'description' => 'Votre clé API C-Pay. Disponible dans le portail marchand (merchant.c-pay.global) → Clés API.',
                'default'     => '',
                'desc_tip'    => true,
            ],
            'api_secret' => [
                'title'       => 'API Secret',
                'type'        => 'password',
                'description' => 'Votre secret API C-Pay.',
                'default'     => '',
                'desc_tip'    => true,
            ],
            'webhook_secret' => [
                'title'       => 'Webhook Secret',
                'type'        => 'password',
                'description' => 'Secret pour valider les webhooks C-Pay (en-tête X-CPay-Signature). URL webhook à déclarer dans le portail marchand : '
                                 . home_url('/wc-api/cpay_webhook') . ' (l\'ancienne URL /wc-api/cplus_webhook reste acceptée).',
                'default'     => '',
                'desc_tip'    => true,
            ],
            'payment_methods' => [
                'title'       => 'Méthodes de paiement',
                'type'        => 'multiselect',
                'description' => 'Méthodes proposées au client.',
                'default'     => ['airtel_money', 'mtn_momo'],
                'options'     => [
                    'airtel_money' => '🔴 Airtel Money',
                    'mtn_momo'     => '🟡 MTN MoMo',
                    'card'         => '💳 Carte bancaire',
                ],
            ],
        ];
    }

    public function payment_fields() {
        $methods = $this->get_option('payment_methods', ['airtel_money', 'mtn_momo']);
        ?>
        <div id="cplus-payment-fields" style="padding:12px 0">
            <p style="margin-bottom:12px;color:#5a6677;font-size:13px">
                <?php echo esc_html($this->description); ?>
            </p>
            <div style="margin-bottom:12px">
                <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">
                    Mode de paiement *
                </label>
                <select name="cplus_method" id="cplus_method" style="width:100%;padding:10px;border:1px solid #dce3ed;border-radius:8px;font-size:14px">
                    <?php if (in_array('airtel_money', $methods)): ?>
                    <option value="airtel_money">🔴 Airtel Money</option>
                    <?php endif; ?>
                    <?php if (in_array('mtn_momo', $methods)): ?>
                    <option value="mtn_momo">🟡 MTN MoMo</option>
                    <?php endif; ?>
                    <?php if (in_array('card', $methods)): ?>
                    <option value="card">💳 Carte bancaire</option>
                    <?php endif; ?>
                </select>
            </div>
            <div id="cplus-phone-field">
                <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">
                    Numéro Mobile Money *
                </label>
                <input type="tel" name="cplus_phone" id="cplus_phone"
                    placeholder="+242060000001"
                    style="width:100%;padding:10px 12px;border:1px solid #dce3ed;border-radius:8px;font-size:14px;box-sizing:border-box" />
                <p style="font-size:11px;color:#5a6677;margin-top:4px">
                    Format international — ex: +242060000001 (Congo), +237670000001 (Cameroun)
                </p>
            </div>
        </div>
        <script>
        document.getElementById('cplus_method').addEventListener('change', function() {
            var phoneField = document.getElementById('cplus-phone-field');
            phoneField.style.display = this.value === 'card' ? 'none' : 'block';
        });
        </script>
        <?php
    }

    public function validate_fields() {
        $method = sanitize_text_field($_POST['cplus_method'] ?? '');
        $phone  = sanitize_text_field($_POST['cplus_phone'] ?? '');
        if (empty($method)) {
            wc_add_notice('Veuillez choisir un mode de paiement.', 'error');
            return false;
        }
        if ($method !== 'card' && empty($phone)) {
            wc_add_notice('Veuillez entrer votre numéro Mobile Money.', 'error');
            return false;
        }
        return true;
    }

    public function process_payment($order_id) {
        $order  = wc_get_order($order_id);
        $method = sanitize_text_field($_POST['cplus_method'] ?? 'airtel_money');
        $phone  = sanitize_text_field($_POST['cplus_phone'] ?? '');
        $amount = $order->get_total();

        // Appel API C-Pay
        $api      = new CPay_API($this->api_key, $this->api_secret, $this->environment);
        $response = $api->create_pay_link([
            'amount'      => $amount,
            'currency'    => 'XAF',
            'method'      => $method,
            'phone'       => $phone,
            'reference'   => 'WC-' . $order_id,
            'description' => 'Commande #' . $order_id . ' — ' . get_bloginfo('name'),
            'returnUrl'   => $this->get_return_url($order),
            'webhookUrl'  => home_url('/wc-api/cpay_webhook'),
        ]);

        if (is_wp_error($response)) {
            wc_add_notice('Erreur C-Pay: ' . $response->get_error_message(), 'error');
            return ['result' => 'fail'];
        }

        // Sauvegarder l'ID de transaction C-Pay (meta `_cplus_*` conservees
        // pour les commandes existantes)
        $order->update_meta_data('_cplus_txn_id',  $response['txnId'] ?? '');
        $order->update_meta_data('_cplus_method',   $method);
        $order->update_meta_data('_cplus_ref',      $response['reference'] ?? '');
        $order->update_status('pending', 'En attente de confirmation C-Pay.');
        $order->save();

        // Redirection selon le mode
        if ($method === 'card' && !empty($response['payUrl'])) {
            return ['result' => 'success', 'redirect' => $response['payUrl']];
        }

        // Mobile Money — attendre webhook
        wc_reduce_stock_levels($order_id);
        return [
            'result'   => 'success',
            'redirect' => $this->get_return_url($order),
        ];
    }

    public function process_refund($order_id, $amount = null, $reason = '') {
        $order  = wc_get_order($order_id);
        $txn_id = $order->get_meta('_cplus_txn_id');
        if (!$txn_id) return new WP_Error('no_txn', 'Transaction C-Pay introuvable');
        $api    = new CPay_API($this->api_key, $this->api_secret, $this->environment);
        $result = $api->refund($txn_id, $amount, $reason);
        if (is_wp_error($result)) return $result;
        $order->add_order_note('Remboursement C-Pay effectué — ' . $amount . ' XAF');
        return true;
    }
}

// Alias historique (2.6.x)
if (!class_exists('WC_CPlus_Gateway', false)) { class_alias('WC_CPay_Gateway', 'WC_CPlus_Gateway'); }
