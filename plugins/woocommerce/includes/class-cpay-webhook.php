<?php
defined('ABSPATH') || exit;

class CPay_Webhook {
    /**
     * Signature du webhook : X-CPay-Signature d'abord, puis X-CPlus-Signature
     * (ancien nom, encore envoye par la plateforme pendant la transition).
     */
    public static function read_signature() {
        foreach (['HTTP_X_CPAY_SIGNATURE', 'HTTP_X_CPLUS_SIGNATURE'] as $key) {
            if (!empty($_SERVER[$key])) return trim((string)$_SERVER[$key]);
        }
        return '';
    }

    public static function handle() {
        $gateway = new WC_CPay_Gateway();
        $secret  = $gateway->webhook_secret;
        $payload = file_get_contents('php://input');
        $sig     = self::read_signature();

        // Vérifier la signature HMAC-SHA256 ("sha256=<hex>"). Des qu'un secret
        // est configure, une requete non signee ou mal signee est refusee.
        if ($secret) {
            $expected = 'sha256=' . hash_hmac('sha256', $payload, $secret);
            if (!$sig || !hash_equals($expected, $sig)) {
                http_response_code(401);
                echo json_encode(['error' => 'Signature invalide']);
                exit;
            }
        }

        $data   = json_decode($payload, true);
        $event  = $data['event'] ?? '';
        $txn    = $data['transaction'] ?? [];
        $ref    = $txn['reference'] ?? '';

        // Trouver la commande WooCommerce
        if (!preg_match('/^WC-(\d+)$/', $ref, $m)) {
            http_response_code(200);
            echo json_encode(['received' => true]);
            exit;
        }

        $order_id = (int)$m[1];
        $order    = wc_get_order($order_id);
        if (!$order) {
            http_response_code(404);
            exit;
        }

        switch ($event) {
            case 'transaction.completed':
                $order->payment_complete($txn['txnId'] ?? '');
                $order->add_order_note(sprintf(
                    'Paiement C-Pay confirmé — Réf: %s — Montant: %s XAF — Méthode: %s',
                    $txn['reference'] ?? '—',
                    number_format($txn['amount'] ?? 0, 0, ',', ' '),
                    $txn['method'] ?? '—'
                ));
                break;

            case 'transaction.failed':
                $order->update_status('failed', 'Paiement C-Pay échoué: ' . ($txn['reason'] ?? 'Erreur inconnue'));
                break;

            case 'transaction.refunded':
                $order->update_status('refunded', 'Remboursement C-Pay effectué.');
                break;
        }

        http_response_code(200);
        echo json_encode(['received' => true, 'orderId' => $order_id]);
        exit;
    }
}

// Alias historique (2.6.x)
if (!class_exists('CPlus_Webhook', false)) { class_alias('CPay_Webhook', 'CPlus_Webhook'); }
