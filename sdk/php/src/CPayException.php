<?php
namespace CPay;

class CPayException extends \Exception
{
    /** Code d'erreur C-Pay (INVALID_AMOUNT, API_ERROR, NETWORK_ERROR...) */
    public string $cpayCode;
    /** @deprecated utiliser $cpayCode */
    public string $cplusCode;
    public int    $statusCode;

    public function __construct(string $message, string $code = '', int $statusCode = 0)
    {
        parent::__construct($message);
        $this->cpayCode   = $code;
        $this->cplusCode  = $code;
        $this->statusCode = $statusCode;
    }
}
