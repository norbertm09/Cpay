<?php
defined('ABSPATH') || exit;

class CPlus_Webhook {
    public static function handle() {
        $gateway = new WC_CPlus_Gateway();
        $secret  = $gateway->webhook_secret;
        $payload = file_get_contents('php://input');
        $sig     = $_SERVER['HTTP_X_CPLUS_SIGNATURE'] ?? '';

        // Vérifier la signature HMAC
        if ($secret && $sig) {
            $expected = 'sha256=' . hash_hmac('sha256', $payload, $secret);
            if (!hash_equals($expected, $sig)) {
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
                    'Paiement CPlus confirmé — Réf: %s — Montant: %s XAF — Méthode: %s',
                    $txn['reference'] ?? '—',
                    number_format($txn['amount'] ?? 0, 0, ',', ' '),
                    $txn['method'] ?? '—'
                ));
                break;

            case 'transaction.failed':
                $order->update_status('failed', 'Paiement CPlus échoué: ' . ($txn['reason'] ?? 'Erreur inconnue'));
                break;

            case 'transaction.refunded':
                $order->update_status('refunded', 'Remboursement CPlus effectué.');
                break;
        }

        http_response_code(200);
        echo json_encode(['received' => true, 'orderId' => $order_id]);
        exit;
    }
}
