<?php
defined('ABSPATH') || exit;

class CPay_API {
    private $api_key;
    private $api_secret;
    private $base_url;

    public function __construct($api_key, $api_secret, $environment = 'sandbox') {
        $this->api_key    = $api_key;
        $this->api_secret = $api_secret;
        $this->base_url   = defined('CPAY_API_BASE') ? CPAY_API_BASE : 'https://api.c-pay.global/api/v1';
    }

    private function request($method, $endpoint, $data = []) {
        $url  = $this->base_url . $endpoint;
        $args = [
            'method'  => strtoupper($method),
            'headers' => [
                'Content-Type'  => 'application/json',
                'X-API-Key'     => $this->api_key,
                'X-API-Secret'  => $this->api_secret,
                'User-Agent'    => 'CPay-WooCommerce/' . CPAY_VERSION,
            ],
            'timeout' => 30,
        ];
        if (!empty($data)) $args['body'] = json_encode($data);
        $response = wp_remote_request($url, $args);
        if (is_wp_error($response)) return $response;
        $body = json_decode(wp_remote_retrieve_body($response), true);
        $code = wp_remote_retrieve_response_code($response);
        if ($code >= 400) {
            return new WP_Error('cpay_api_error', $body['error'] ?? 'Erreur API C-Pay (' . $code . ')');
        }
        return $body;
    }

    public function create_pay_link($params) {
        return $this->request('POST', '/merchant/public/pay-links', $params);
    }

    public function get_transaction($txn_id) {
        return $this->request('GET', '/merchant/public/transactions/' . $txn_id);
    }

    public function refund($txn_id, $amount, $reason = '') {
        return $this->request('POST', '/merchant/public/refunds', [
            'txnId'  => $txn_id,
            'amount' => $amount,
            'reason' => $reason,
        ]);
    }
}

// Alias historique (2.6.x)
if (!class_exists('CPlus_API', false)) { class_alias('CPay_API', 'CPlus_API'); }
