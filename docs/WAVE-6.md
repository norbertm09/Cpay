# Vague 6 — réponse à l'audit du 17 octobre 2026 (branche `wave-6`)

Audit : `docs/AUDIT-2026-10-17.md`. Détails : `docs/WAVE-6-LOT1.md` (intégrité financière), `docs/WAVE-6-LOT2.md`
(registre des capacités, TLS). Backend : **28 suites / 655 tests verts** (`npm test`). Lot 3 à venir.

## Lot 1 — intégrité financière (P1 n° 1, 2, 3 et P2 n° 5)
- **Résultat opérateur incertain** : classification explicite des réponses des rails. Refus confirmé → `failed`
  (fonds libérés) ; délai, erreur réseau, 5xx, réponse illisible → nouveau statut **`unknown`**, réservation
  conservée, référence et requête stockées, interrogation du fournisseur par la réconciliation, `needs_review`
  et alerte opérations après `CASH_UNKNOWN_ALERT_HOURS` (2 h). Côté encaissement, une exception passerelle laisse
  la transaction `pending` (`pending_unknown`) pour que webhook ou réconciliation la finalisent.
- **Idempotence durable** : sur les routes monétaires, une erreur 5xx conserve la clé ; la nouvelle tentative
  renvoie l'opération d'origine (`200 IDEMPOTENCY_REPLAY`) ou `409 IDEMPOTENCY_RETRY_AFTER_ERROR`. Plus de double ordre.
- **Finalisation atomique** : confirmation, file de règlement et clôture du lien dans une seule transaction ;
  contrainte d'unicité sur la file ; tâche de réparation `sweepAuthorizedWithoutQueue` (script et route admin).
- **Bénéficiaires** : rôle propriétaire + confirmation forte pour le wallet et les comptes bancaires ; nouveaux
  comptes `pending_verification`, vérifiés par l'admin (`POST /admin/cash/bank-accounts/:id/verify`) ; historique
  `beneficiary_events`, audit, e-mail au propriétaire.
- **Antifraude dégradée** : `FRAUD_DEGRADED_MODE` = `allow_limited` (défaut, plafond `FRAUD_DEGRADED_MAX_AMOUNT`),
  `review` ou `block` ; alerte limitée à une par 10 min.
- Migration `011_wave6_integrity.sql` (idempotente).

## Lot 2 — couverture réelle et durcissements (P1 n° 4, P2 n° 6)
- **Registre des capacités** pays × devise × moyen × opération, statut **calculé** (`active` seulement si le code et
  la configuration existent, `pilot`, `planned`, `unavailable`). Garde serveur sur la caisse, les routes historiques,
  l'inscription et la page carte : `403 CAPABILITY_NOT_ACTIVE`, `422 COUNTRY_NOT_OPEN`.
- **Interrupteur `CAPABILITY_ENFORCE`** : `enforce` (défaut), `report` (laisse passer, journalise les refus évités,
  visibles dans l'admin), `off`. Procédure : déployer en `report`, observer 48 h, passer en `enforce`.
- Détection étendue à CF, GA, GQ, TD (opérateurs `planned`, préfixes à confirmer) ; GIMAC → `GATEWAY_NOT_ACTIVATED`.
- `GET /api/v1/public/capabilities` alimente la vitrine (badges Disponible / Pilote / En cours d'intégration), le
  portail marchand (moyens désactivés par pays) et une page admin « Capacités pays ».
- **TLS PostgreSQL** : `DB_SSL=true` vérifie désormais le certificat ; `DB_SSL_CA_FILE` pour la CA OVH ;
  `DB_SSL_REJECT_UNAUTHORIZED=false` conserve l'ancien mode avec avertissement.

## Déploiement (automatique après fusion) — à préparer AVANT de fusionner
1. Dans `backend/.env` du serveur : `CAPABILITY_ENFORCE=report` (observation d'abord). Sans cette ligne le mode
   `enforce` s'applique et un statut mal calculé pourrait bloquer un marchand.
2. TLS base : le serveur a aujourd'hui `NODE_TLS_REJECT_UNAUTHORIZED=0`, qui désactive toute vérification au niveau
   Node et neutralise le durcissement. Pour l'activer plus tard : télécharger la CA de la Cloud DB dans l'espace
   client OVH, la déposer sur le serveur, renseigner `DB_SSL_CA_FILE`, retirer `NODE_TLS_REJECT_UNAUTHORIZED`,
   redémarrer l'API et vérifier `/health`.
3. Après déploiement : `docker compose run --rm --no-deps api node scripts/reconcile-pending.js --json`, puis
   contrôler Admin → Configuration → Capacités (refus évités) et Opérations → Caisse (`unknown`, `needs_review`).

## Points ouverts (lot 3)
- Portails : afficher `unknown`/`needs_review`, `pending_verification`, l'historique des bénéficiaires et l'écran de
  vérification admin ; intentions de paiement persistantes côté app porteur ; tableau de rapprochement admin
  (opérations inconnues, callbacks manquants, encaissements sans file, lots en échec) ; observabilité.
- MTN Congo : référence générée dans le client du rail, donc un délai avant réponse laisse l'ordre `unknown` sans
  référence interrogeable (proposition : générer la référence dans `cash.service`).
- Procédure Finance pour clôturer manuellement un ordre `unknown`.
- Confirmer les plans de numérotation CF/GA/GQ/TD et les contrats GIMAC avant tout code.
