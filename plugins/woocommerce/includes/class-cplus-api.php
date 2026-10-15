<?php
defined('ABSPATH') || exit;

class CPlus_API {
    private $api_key;
    private $api_secret;
    private $base_url;

    public function __construct($api_key, $api_secret, $environment = 'sandbox') {
        $this->api_key    = $api_key;
        $this->api_secret = $api_secret;
        $this->base_url   = 'https://api.c-pay.global/api/v1';
    }

    private function request($method, $endpoint, $data = []) {
        $url  = $this->base_url . $endpoint;
        $args = [
            'method'  => strtoupper($method),
            'headers' => [
                'Content-Type'  => 'application/json',
                'X-API-Key'     => $this->api_key,
                'X-API-Secret'  => $this->api_secret,
                'User-Agent'    => 'CPlus-WooCommerce/' . CPLUS_VERSION,
            ],
            'timeout' => 30,
        ];
        if (!empty($data)) $args['body'] = json_encode($data);
        $response = wp_remote_request($url, $args);
        if (is_wp_error($response)) return $response;
        $body = json_decode(wp_remote_retrieve_body($response), true);
        $code = wp_remote_retrieve_response_code($response);
        if ($code >= 400) {
            return new WP_Error('cplus_api_error', $body['error'] ?? 'Erreur API CPlus (' . $code . ')');
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
