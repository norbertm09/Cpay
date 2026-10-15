<?php
namespace CPay;

/**
 * C-Pay SDK — PHP
 * @version 1.1.0
 * @author  Calculus Plus SAS <dev@c-pay.global>
 * @link    https://c-pay.global/developers
 *
 * Compatibilite : \CPlusSDK\CPlusClient et \CPlusSDK\CPlusException (SDK 1.0.x)
 * restent disponibles comme alias (voir src/compat/).
 */
class CPayClient
{
    const VERSION  = '1.1.0';
    const BASE_URL = 'https://api.c-pay.global/api/v1';

    /** En-tetes de signature des webhooks, par ordre de preference. */
    const SIGNATURE_HEADERS = ['X-CPay-Signature', 'X-CPlus-Signature'];

    private string $apiKey;
    private string $baseUrl;
    private int    $timeout;
    private string $currency;
    public  bool   $sandbox;

    /**
     * @param string $apiKey   Clé API (sk_live_xxx ou sk_test_xxx)
     * @param array  $options  ['baseUrl', 'timeout', 'currency']
     */
    public function __construct(string $apiKey, array $options = [])
    {
        if (empty($apiKey)) throw new CPayException('apiKey est requis', 'MISSING_API_KEY');
        $this->apiKey   = $apiKey;
        $this->baseUrl  = $options['baseUrl']  ?? self::BASE_URL;
        $this->timeout  = $options['timeout']  ?? 30;
        $this->currency = $options['currency'] ?? 'XAF';
        $this->sandbox  = strncmp($apiKey, 'sk_test_', 8) === 0;
    }

    // ─── COLLECTION ───────────────────────────────────────────

    /**
     * Encaissement Mobile Money
     *
     * @param float  $amount        Montant en XAF (min 100)
     * @param string $phone         Numéro du client (+242XXXXXXXXX)
     * @param string $method        'airtel_money' | 'mtn_momo'
     * @param array  $options       ['description', 'reference', 'currency']
     *
     * @example
     * $txn = $cpay->collectMomo(5000, '+242060000001', 'airtel_money', [
     *   'reference' => 'CMD-001',
     *   'description' => 'Commande #001'
     * ]);
     */
    public function collectMomo(float $amount, string $phone, string $method, array $options = []): array
    {
        if ($amount < 100) throw new CPayException('Montant minimum 100 XAF', 'INVALID_AMOUNT');
        if (empty($phone)) throw new CPayException('phone est requis', 'MISSING_PHONE');
        if (!in_array($method, ['airtel_money', 'mtn_momo'])) throw new CPayException('method invalide', 'INVALID_METHOD');

        return $this->request('POST', '/merchant/public/collect', array_merge([
            'amount'        => $amount,
            'currency'      => $options['currency'] ?? $this->currency,
            'customerPhone' => $phone,
            'method'        => $method,
        ], array_filter([
            'description' => $options['description'] ?? null,
            'reference'   => $options['reference']   ?? null,
        ])));
    }

    /**
     * Créer un lien de paiement carte
     *
     * @param float  $amount
     * @param array  $options  ['description', 'psp', 'currency', 'recipientPhone']
     */
    public function createPayLink(float $amount, array $options = []): array
    {
        if ($amount < 100) throw new CPayException('Montant minimum 100 XAF', 'INVALID_AMOUNT');

        return $this->request('POST', '/merchant/public/pay-links', array_filter([
            'amount'        => $amount,
            'currency'      => $options['currency'] ?? $this->currency,
            'description'   => $options['description'] ?? null,
            'psp'           => $options['psp'] ?? 'cybersource',
            'paymentMethod' => 'card',
            'recipientPhone'=> $options['recipientPhone'] ?? null,
        ]));
    }

    // ─── DISBURSEMENT ─────────────────────────────────────────

    /**
     * Décaissement Mobile Money
     *
     * @param float  $amount    Montant en XAF (min 500)
     * @param string $phone     Numéro du bénéficiaire (+242XXXXXXXXX)
     * @param string $operator  'airtel_money' | 'mtn_momo'
     * @param array  $options   ['description', 'reference', 'currency']
     *
     * @example
     * $disb = $cpay->disburse(10000, '+242055000001', 'mtn_momo', [
     *   'description' => 'Remboursement commande #42'
     * ]);
     */
    public function disburse(float $amount, string $phone, string $operator, array $options = []): array
    {
        if ($amount < 500) throw new CPayException('Montant minimum 500 XAF', 'INVALID_AMOUNT');
        if (empty($phone)) throw new CPayException('phone est requis', 'MISSING_PHONE');
        if (!in_array($operator, ['airtel_money', 'mtn_momo'])) throw new CPayException('operator invalide', 'INVALID_OPERATOR');

        return $this->request('POST', '/merchant/disburse', array_merge([
            'amount'         => $amount,
            'currency'       => $options['currency'] ?? $this->currency,
            'recipientPhone' => $phone,
            'operator'       => $operator,
        ], array_filter([
            'description' => $options['description'] ?? null,
            'reference'   => $options['reference']   ?? null,
        ])));
    }

    // ─── TRANSACTIONS ─────────────────────────────────────────

    /**
     * Lister les transactions
     * @param array $params  ['page', 'limit', 'status', 'type']
     */
    public function listTransactions(array $params = []): array
    {
        $qs = http_build_query(array_filter([
            'page'   => $params['page']   ?? 1,
            'limit'  => $params['limit']  ?? 20,
            'status' => $params['status'] ?? null,
            'type'   => $params['type']   ?? null,
        ]));
        return $this->request('GET', '/merchant/public/transactions?' . $qs);
    }

    /**
     * Obtenir une transaction par ID
     */
    public function getTransaction(string $txnId): array
    {
        if (empty($txnId)) throw new CPayException('txnId requis', 'MISSING_TXN_ID');
        return $this->request('GET', '/merchant/transactions/' . $txnId);
    }

    // ─── WEBHOOKS ─────────────────────────────────────────────

    /**
     * Extraire la signature d'un webhook depuis les en-tetes recus.
     * X-CPay-Signature est lu en premier, puis X-CPlus-Signature (ancien nom,
     * encore envoye pendant la transition). Accepte $_SERVER (HTTP_X_...),
     * getallheaders() ou tout tableau nom => valeur, sans sensibilite a la casse.
     */
    public static function signatureFromHeaders(array $headers): string
    {
        $norm = [];
        foreach ($headers as $k => $v) {
            $key = strtolower(str_replace('_', '-', (string)$k));
            if (strncmp($key, 'http-', 5) === 0) $key = substr($key, 5);
            $norm[$key] = is_array($v) ? reset($v) : $v;
        }
        foreach (self::SIGNATURE_HEADERS as $name) {
            $key = strtolower($name);
            if (!empty($norm[$key])) return (string)$norm[$key];
        }
        return '';
    }

    /**
     * Vérifier la signature d'un webhook C-Pay (HMAC-SHA256, sha256=<hex>).
     *
     * @param string       $payload    Corps brut de la requete (php://input)
     * @param string|array $signature  Valeur de l'en-tete, ou tableau d'en-tetes
     *                                 ($_SERVER / getallheaders()) : le bon en-tete est choisi
     * @param string       $secret     Votre secret webhook
     *
     * @example
     * $payload = file_get_contents('php://input');
     * $valid   = CPayClient::verifyWebhook($payload, $_SERVER, $_ENV['CPAY_WEBHOOK_SECRET']);
     * if (!$valid) { http_response_code(401); exit; }
     */
    public static function verifyWebhook(string $payload, $signature, string $secret): bool
    {
        if ($secret === '') return false;
        if (is_array($signature)) $signature = self::signatureFromHeaders($signature);
        if (!is_string($signature) || $signature === '') return false;
        $expected = 'sha256=' . hash_hmac('sha256', $payload, $secret);
        return hash_equals($expected, $signature);
    }

    // ─── HTTP ─────────────────────────────────────────────────

    private function request(string $method, string $path, array $body = []): array
    {
        $url  = $this->baseUrl . $path;
        $json = !empty($body) ? json_encode($body) : null;

        $headers = [
            'X-API-Key: '    . $this->apiKey,
            'Content-Type: application/json',
            'Accept: application/json',
            'User-Agent: cpay-sdk-php/' . self::VERSION,
        ];
        if ($json) $headers[] = 'Content-Length: ' . strlen($json);

        $ch = curl_init();
        curl_setopt_array($ch, [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeout,
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_HTTPHEADER     => $headers,
        ]);
        if ($json) curl_setopt($ch, CURLOPT_POSTFIELDS, $json);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error    = curl_error($ch);
        curl_close($ch);

        if ($error) throw new CPayException('Erreur réseau: ' . $error, 'NETWORK_ERROR');

        $data = json_decode((string)$response, true);
        if (!is_array($data)) throw new CPayException('Réponse invalide du serveur', 'INVALID_RESPONSE', $httpCode);

        if ($httpCode >= 400) {
            throw new CPayException(
                $data['error'] ?? 'Erreur API',
                $data['code']  ?? 'API_ERROR',
                $httpCode
            );
        }
        return $data;
    }
}
