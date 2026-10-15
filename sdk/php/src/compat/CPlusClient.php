<?php
/**
 * Alias de compatibilite SDK 1.0.x : \CPlusSDK\CPlusClient -> \CPay\CPayClient.
 * Charge par l'autoload PSR-4 ("CPlusSDK\\" => src/compat/).
 */
namespace CPlusSDK;

if (!class_exists(__NAMESPACE__ . '\\CPlusException', false)) {
    require_once __DIR__ . '/CPlusException.php';
}
\class_alias(\CPay\CPayClient::class, __NAMESPACE__ . '\\CPlusClient');
