<?php
/**
 * Alias de compatibilite SDK 1.0.x : \CPlusSDK\CPlusException -> \CPay\CPayException.
 */
namespace CPlusSDK;

\class_alias(\CPay\CPayException::class, __NAMESPACE__ . '\\CPlusException');
