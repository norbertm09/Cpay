# Audit de la version de production C-Pay / CPlus 2.6.0 — synthèse

Date : 15 octobre 2026. Source : instantané de `/opt/cplus` sur le VPS OVH (`VERSION = 2.6.0-production-ovh`),
poussé puis nettoyé dans la branche `ovh-prod-clean`. Quatre rapports détaillés accompagnent cette synthèse :

1. [`01-backend-core-securite.md`](01-backend-core-securite.md) — serveur, middleware, ~340 routes, SQL, scripts, tests
2. [`02-backend-services-rails.md`](02-backend-services-rails.md) — flux d'argent, providers, gateways, rails Visa/Mastercard/GTP, règlement
3. [`03-portails-landing.md`](03-portails-landing.md) — 7 portails React + site vitrine
4. [`04-android-mobile-sdk-infra.md`](04-android-mobile-sdk-infra.md) — Android natif, Expo, SDK, WooCommerce, Docker/Nginx/scripts/monitoring

## Contexte : deux versions désynchronisées

| | GitHub `main` (juin 2026) | Serveur OVH (2.6.0) |
|---|---|---|
| Fichiers | 65 | 391 (+ `node_modules`, certificats, `.env` exclus) |
| Backend | 3 300 lignes, 2 migrations | 20 000 lignes, 6 migrations, 12 fichiers de routes |
| Front | 2 portails | 7 portails + landing + app Expo |
| Mobile | app Compose (non compilable) | app native réécrite (`global.cpay.app`) + SDK Android/JS/PHP + plugin WooCommerce |
| Infra | compose invalide | compose + nginx + scripts + monitoring (partiellement inopérants) |

Le dépôt GitHub n'a jamais reçu le travail fait sur le serveur. La branche `refonte-2026` (audit et refonte du 15 octobre) a été construite sur la version GitHub et doit être réconciliée avec la production (voir plan ci-dessous).

## Verdict

La version 2.6.0 est fonctionnellement riche mais **n'est pas sûre pour des transactions réelles**. Les constats P0 ci-dessous permettent, chacun, soit de créer ou détourner de l'argent, soit de compromettre la plateforme. Ils sont tous vérifiés dans le code (fichier et ligne dans les rapports détaillés), plusieurs reproduits par exécution.

## Les 15 constats P0 (toutes couches confondues)

| # | Constat | Où |
|---|---|---|
| 1 | **Mot de passe de la base de production en clair** dans `backend/reset-creds.js`, poussé sur GitHub public | 01 §2.1, 04 §4.4 |
| 2 | **Webhook MTN sans aucune authentification** : un POST forgé crédite une carte virtuelle ; le porteur reçoit lui-même la référence à confirmer | 01 §2.3, 02 §4 |
| 3 | **Cartes virtuelles orphelines (IDOR)** : `cardholder_id` jamais renseigné → tout porteur peut payer, créditer ou changer le PIN de la carte d'un autre ; idem cartes GTP | 01 §2.4-2.5 |
| 4 | **Monnaie créée sans mouvement réel** : `/cardholder/topup`, `/unload`, `/payment/tokenized`, `/merchant/withdraw` (retraits illimités), `/partners/collect|disburse`, `/merchant/public/collect` (succès fictif) | 01 §2.6 |
| 5 | **Retrait par carte = débit du client** (`/payout` avec `emvPayload` appelle `authorizeCard`) | 02 §2 |
| 6 | **Airtel et Vodacom marqués payés avant confirmation** ; **MTN timeout = `failed`** alors que le client peut encore valider → client débité, transaction en échec, re-tentative = double paiement | 02 §2 |
| 7 | **Callbacks Orange, Wave, Africell, Express Union, Free Money inexistants** → transactions `pending` à vie ; réconciliation ne couvre pas l'orchestrateur | 02 §2 |
| 8 | **Double règlement possible par trois voies** (trois moteurs concurrents, claim non atomique, pas de verrou) ; **retraits reversés au marchand** ; virement bancaire = no-op marqué `submitted` | 02 §6 |
| 9 | **Escalade de privilèges** : un `support_agent` peut se nommer `super_admin` (`PATCH /admin-users/:id`) | 01 §2.8 |
| 10 | **2FA factice** partout : partners accepte n'importe quel code, aucun login ne vérifie `mfa_enabled` ; secret TOTP partenaires envoyé à `api.qrserver.com` | 01 §2.11, 03 §2 |
| 11 | **XSS stocké sur la page de paiement publique** `pay.c-pay.global` (nom marchand non échappé) + formulaire carte qui envoie PAN/CVV au serveur | 01 §2.10 |
| 12 | **Middleware « PCI » cosmétique** (six no-op) ; PAN en clair dans `virtual_cards.card_number` ; Visa Direct accepte des PAN bruts de tout marchand ; TLS désactivé vers MTN | 01 §2.2, 02 §4 |
| 13 | **APK debug publié** (debuggable, logs HTTP complets, pointe sur la prod) ; SDK Android embarque `sk_live_` ; plugin WooCommerce accepte des webhooks non signés et ne confirme jamais de commande | 04 §1.6, §3 |
| 14 | **Infra non reproductible** : nginx réel hors dépôt, `deploy-ovh.sh` échoue à l'étape 1, **aucune sauvegarde de la base** (cron pointe sur un conteneur inexistant), renouvellement TLS ne recharge pas le bon proxy, alertes vers une route inexistante | 04 §4 |
| 15 | **Schéma non reconstructible** : 45 tables utilisées absentes des migrations ; `/live`, `/ready`, `/metrics` renvoient 404 ; `axios` et `bcrypt` manquants ; 42 vulnérabilités npm | 01 §1.2, §3 |

Les 90 autres constats P1/P2 sont dans les rapports détaillés.

## Ce qui est à mettre au crédit de la 2.6.0

Idempotence et refresh tokens pour le marchand (partiels), runner de migrations, inscription, pilotage par feature flags avec runbook, ticketing, intégrations sortantes signées, client GTP réel, client Visa Direct mTLS, image API non-root, nginx avec TLS 1.2/1.3 et OCSP, 71 tests verts. L'ambition fonctionnelle est là ; c'est la rigueur financière et sécuritaire qui manque.

## Plan de réconciliation recommandé

**Principe : la production devient la base de référence du dépôt, et les correctifs de `refonte-2026` y sont portés.** Réécrire la 2.6.0 à partir de `refonte-2026` (3 300 lignes contre 20 000) n'est pas réaliste.

1. **Immédiat (vous)** : changer le mot de passe Cloud DB ; supprimer la branche `ovh-prod-snapshot` sur GitHub ; passer le dépôt en privé ; retirer l'APK debug du serveur ; révoquer le jeton GitHub exposé.
2. **Base de référence** : faire de `ovh-prod-clean` la nouvelle `main` (fusion avec historique conservé). À valider par vous : cela remplace le contenu actuel de `main`.
3. **Vague 1 — arrêter l'hémorragie (1 à 2 semaines)** : signatures webhooks obligatoires et re-query opérateur ; IDOR cartes ; désactivation (410) des endpoints qui créent de la valeur sans mouvement ; payout carte refusé ; Airtel/Vodacom/MTN → `pending` jusqu'à confirmation ; rôles admin ; un seul moteur de règlement avec claim atomique et exclusion des payouts ; échappement des pages pay-link ; `/live` `/ready` `/metrics` avant `/:shortId` ; `asyncHandler` partout ; sauvegardes DB réelles. Ce sont des correctifs ciblés dans le code 2.6.0, sans refonte.
4. **Vague 2 — porter `refonte-2026` (2 à 4 semaines)** : moteur de détection corrigé (plans de numérotation, AID), chiffrement des secrets en base, routes webhooks signées (Wave, Orange, Stripe…), validation zod, auth unifiée (un seul middleware, cookies, rotation, révocation), settlement J+1 par devise, routes publiques pay-link, Express 5, dépendances à jour, export du DDL réel comme migration de référence, Docker/Nginx versionnés et scripts de déploiement qui fonctionnent.
5. **Vague 3 — structurel** : fusion des 7 portails en une base Vite commune, un seul client mobile officiel (retirer l'app Expo ou la native), SDK/plugin alignés sur l'API réelle avec clés hachées, 2FA réelle, monitoring déployé, tests d'intégration sur DB jetable, SDK Tap-to-Phone certifié avant toute activation carte.
