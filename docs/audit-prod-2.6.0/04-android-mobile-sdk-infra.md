# Audit production 2.6.0 — apps mobiles, SDK, plugins, infrastructure

Snapshot OVH `/opt/cplus` (branche `ovh-prod-clean`), lecture seule. Les secrets rencontrés ne sont pas reproduits.

## 1. Android natif (`android/`, package `global.cpay.app`, 5 561 lignes Kotlin)

### Buildabilité / toolchain
- Root build présent (`android/build.gradle:1-5`) : AGP 8.2.0, Kotlin 1.9.22 ; `settings.gradle`, `gradle.properties` OK.
- **Pas de Gradle wrapper** → build non reproductible. `local.properties` commité (`sdk.dir=/opt/android-sdk`).
- Fichiers `.k19.bak` orphelins.
- `app/build.gradle:13-20` : compileSdk 34, minSdk 24, targetSdk 34, versionCode 1, versionName 2.6.0 → **non publiable sur Play Store** (targetSdk 35 exigé depuis août 2025).
- Dépendances 2023-2024 : Retrofit 2.9, OkHttp 4.12, Room 2.6.1, Material 1.11, CameraX 1.3.1, `security-crypto:1.1.0-alpha06` (**alpha en prod**), zxing-embedded 4.3 + mlkit barcode (doublon, seul zxing utilisé). Aucun test.
- `app/build.gradle:16-17,26,33` : `API_BASE_URL` identique en debug et release → **le build debug tape la prod**.
- **Bug Retrofit certain** : `common/ApiService.kt:342-344` combine `@Multipart` et `@Body` (`uploadKybDoc`) → `IllegalArgumentException` au premier appel → **l'upload KYB plante systématiquement** (`KybDocumentsFragment.kt:119`).
- Layouts morts : `activity_collect.xml`, `item_bank_account.xml`, `dialog_collect_waiting.xml`. `navigation-fragment-ktx` déclaré sans `res/navigation`.

### Architecture
- Activities + Fragments + ViewBinding + Retrofit/Gson + `lifecycleScope` ; pas de ViewModel/Repository (requêtes dans les Fragments, ex. `CollectFragment.kt:166-190`).
- Deux profils : marchand et porteur de carte.
- Stubs : `PaymentConfirmActivity.kt:6-11` (`finish()`), `DeepLinkActivity.kt:6-12` (TODO + `finish()`), `PayFragment.kt:26-28` « bientôt disponible », `CollectFragment.kt:240-242` NFC « bientôt disponible ».

### Sécurité
| Point | Constat |
|---|---|
| Stockage token | `EncryptedSharedPreferences` AES256 (`SessionManager.kt:22-31`) — bon. Mais `refresh_token` jamais stocké ni utilisé → déconnexion forcée à l'expiration (`ApiClient.kt:33-38,53-58`). |
| Cert pinning | **Aucun**. |
| Cleartext | Interdit (manifest + NSC) — bon. |
| Logging | `ApiClient.kt:21-24` : `Level.BODY` en debug (l'APK debug publié logge tokens et corps). `LoginActivity.kt:107` : `Log.d` du `errorBody` **en release** (pas de `-assumenosideeffects`). |
| FLAG_SECURE | **Absent** partout. |
| Root detection | `SecurityManager.isDeviceRooted()` existe (`:67-71`) mais **jamais appelé**. |
| 2FA/OTP | `TwoFAActivity` fait setup/verify TOTP et affiche le secret en clair (`:65`). Backend : login marchand (`merchant.routes.js:171-240`) et porteur (`cardholder.routes.js:36-84`) **ne consultent jamais `mfa_enabled`** ; l'app ignore `mfaRequired` → **2FA purement décoratif**. |
| Biométrie avant payout | `BiometricHelper` uniquement pour « se reconnecter » (`LoginActivity.kt:69-84`, `BIOMETRIC_WEAK`). **Aucune confirmation avant payout/disburse/withdraw/transfer/topup** ; backend `/transfer/payout` n'exige rien (`merchant.routes.js:793-940`). |
| QR scanning | `QRScanActivity.kt:48-56` scanne n'importe quel texte sans validation, puis `PaymentConfirmActivity` fait `finish()` → flux « payer par QR » inopérant. |
| Deep links | Intent-filter `https://pay.c-pay.global` avec `autoVerify` (`AndroidManifest.xml:62-69`) mais l'Activity ne fait rien → **l'app intercepte les liens de paiement et les ferme**. |
| Room | `TransactionEntity` stocke `customerPhone`, `authCode`, montants **non chiffrés** (`AppDatabase.kt:17-21`) ; jamais purgé à la déconnexion → données du compte précédent visibles. |
| Divers | `ANDROID_ID` envoyé pour l'appairage ; `appVersion` en dur `"2.6.0"` (`PairingActivity.kt:56`) ; `SecurityManager.normalizePhone` force `+242` par défaut (`:52`). |

### Idempotence & erreurs
- **Aucune `Idempotency-Key`** côté app. Le middleware backend `idempotency` n'est branché que sur les routes legacy `/api/v1/collect|payout|qr-code|pay-link` (`server.js:578,602,625,638`) ; les routes utilisées par l'app (`/merchant/collect`, `/disburse`, `/withdraw`, `/transfer/payout`) n'ont que `merchantAuth` (`merchant.routes.js:793,1406,1643,1828`) → timeout 30 s + retry = **double décaissement possible**.
- **402** non traité ; `errorBody()` brut affiché (`CollectFragment.kt:187`, `DisburseFragment.kt:121`).

### Chemins API vs backend
Les 100+ routes d'`ApiService.kt` existent toutes côté backend. Seules divergences : `uploadKybDoc` (bug Retrofit) et `appVersion` figé.

### APK publié
`portal/landing/downloads/cplus-v2.6.0-debug.apk` (30 Mo) : manifeste `debuggable`, `versionName 2.6.0-debug`, applicationId `global.cpay.app.debug`, pointe sur `https://api.c-pay.global/api/v1`. **Build debug de ce code, non minifié, logging HTTP BODY actif, téléchargeable par URL** (non lié depuis les pages HTML).

## 2. App Expo (`mobile/cplus-mobile`)
- `App.js` (864 lignes, un fichier) : login marchand/admin, inscription, collect/payout legacy, QR/pay-link, historique, rails Visa, tokens, CRM, pilot, support, **mode admin complet** (`/admin/*`).
- Base URL `EXPO_PUBLIC_API_BASE_URL || 'https://api.c-pay.global'` ; `.env.example` mentionné mais absent.
- **Tokens en `AsyncStorage` en clair** (`App.js:17,60-68,143-144`) y compris sessions super_admin ; `expo-secure-store` en dépendance mais jamais importé.
- `Idempotency-Key` régénérée à chaque appel (`App.js:44`) → inutile.
- Doublon de l'app native (autre identifiant `global.cpay.mobile`, routes legacy). **Pas production-ready** : `eas.json` minimal, `app.json` sans icône/splash/projectId, Expo SDK 51 (2024), aucun test.

## 3. SDK et plugin WooCommerce

### Auth par clé API (backend, référence)
`merchant.routes.js:2103-2127` : `apiKeyAuth` lit `X-API-Key`, compare la clé **en clair** en base, **ignore `X-API-Secret`**. 3 routes publiques seulement : `POST /merchant/public/collect`, `GET /merchant/public/transactions`, `POST /merchant/public/pay-links`.

### SDK Android (`sdk/android`)
- Embarque `sk_live_` côté client (clé serveur dans un APK = compromission).
- `disburse()` poste sur `/merchant/public/collect` (`CPlusAPI.kt:68`) → **un décaissement devient un encaissement** ; `getTransaction` appelle une route inexistante ; `scanQR` stub `"DEMO-MERCHANT-001"` ; SANDBOX = PRODUCTION (`Models.kt:14-17`).
- `debugMode` → logging BODY (clé API en logcat). Non compilable (manifest, proguard, wrapper absents) ; artefact Maven promis inexistant.

### SDK JavaScript
- Routes cassées : `disbursement.momo`, `transactions.get`, `payLinks.list/cancel`, `collection.contactless` → protégées par JWT → **401 systématique avec clé API**.
- `verifyWebhook` : comparaison non timing-safe (`index.js:248-255`), exemple basé sur `JSON.stringify(req.body)`.
- Accepte `http:` ; `build.js`/`test.js`/`dist/` référencés inexistants.

### SDK PHP
- `hash_equals` timing-safe — bon ; mêmes routes cassées ; `str_starts_with()` PHP 8 alors que `composer.json` déclare `>=7.4` → **fatal sur 7.4**.

### Plugin WooCommerce (livré dans `plugins/cplus-payment-gateway-v2.6.0.zip` et `developers.html:465`)
- **Signature webhook sautée si secret ou en-tête absents** (`class-cplus-webhook.php:12-19`) → n'importe qui peut marquer des commandes payées sur une boutique non configurée. Pas de contrôle montant/devise, pas d'anti-rejeu.
- **Format incompatible** : le plugin lit `$data['transaction']['reference']` alors que le backend envoie un payload plat (`webhook-handlers.js:282-292`) → **aucune commande n'est jamais confirmée**.
- `process_payment` envoie des champs que le backend ignore et lit `txnId`/`payUrl` absents → pas de redirection, référence `WC-<id>` jamais transmise ; **stock réduit** pour MoMo en attendant un webhook qui ne matchera jamais.
- `refund()` appelle `/merchant/public/refunds` **inexistant**. Sandbox ignoré.

## 4. Infrastructure

### docker-compose
- Services : api, admin/merchant/cardholder/partners portals, nginx (profil `standalone-nginx`, `restart: "no"`), certbot. **Pas de postgres** (OVH Cloud DB managée, Postgres 18.4), **pas de prometheus/grafana/loki/exporters/settlement-cron**.
- Tous les ports liés à `127.0.0.1:300x` et nginx désactivé → **le reverse proxy réel est hors dépôt** (nginx hôte non versionné) ; `docker/nginx.conf` (upstreams DNS Docker) ne peut pas être la conf de prod → dérive, non reproductible.
- `upstream cplus_cardholder { server 172.20.0.2:80; }` : IP de bridge figée, cassante.
- `RUN_MIGRATIONS: "true"` → migrations à chaque démarrage (idempotent avec checksum, sans verrou).
- `image: cplus-api:2.6.0` figé → rollback par tag impossible.

### nginx.conf
- TLS 1.2+1.3, ciphers modernes, OCSP, dhparam — bon (la doc dit « TLS 1.3 uniquement », faux).
- HSTS absent sur `app./card.c-pay.global` ; CSP/Referrer-Policy absents sur admin/merchant ; `X-XSS-Protection` obsolète.
- Zone rate-limit paiement ne couvre que `/api/v1/(collect|payout)` ; les routes réelles `/merchant/collect|disburse|withdraw|transfer/payout` tombent dans le général.
- **`/metrics` et `/internal/*` non bloqués** ; `metricsHandler` accepte `?token=` en query (token dans les logs) et **n'exige rien si `METRICS_TOKEN` est vide** ; `/internal/settlement/run` ouvert si `INTERNAL_TOKEN` absent (`server.js:725-726`).
- `try_files` dans une location `proxy_pass` : inopérant. Pas de `default_server`, apex `c-pay.global` non servi en 443. Certbot ne demande pas `app.`/`card.` → erreur TLS probable sur ces hôtes.
- KYB : 5 Mo base64 ≈ 6,7 Mo > `express.json 5mb` → **upload ≥ ~3,7 Mo rejeté 413**.

### Dockerfiles
- `Dockerfile.api` : multi-stage, non-root, tini, healthcheck — bon. **Node 20 EOL depuis avril 2026** → Node 22.
- `Dockerfile.portal` : `npm install` (pas `ci`), `CI=false` pour ignorer ESLint, `nginx:1.25-alpine` en root.

### Scripts
- `deploy-ovh.sh` : `set -a; . backend/.env` exporte tous les secrets ; `docker compose up -d postgres` puis `prometheus alertmanager grafana loki promtail node-exporter postgres-exporter settlement-cron` → **aucun n'existe dans le compose ⇒ le script échoue à l'étape 1**. `build --no-cache` écrase le tag → rollback (`:31-45`) inopérant (`CPLUS_TAG` jamais lu), `docker compose down` = coupure totale, pas de rollback DB.
- `deploy-prod.sh:19` : même erreur (`postgres`).
- `backup-db.sh` / `restore-db.sh` : `docker exec cplus-postgres` → **conteneur inexistant** ⇒ le cron quotidien installé par `init-ovh.sh:167` **échoue chaque nuit, aucun backup de la Cloud DB**.
- `init-ovh.sh` : `cplus` ajouté aux groupes `docker` **et `sudo`** ; `curl … your-org … | bash` (URL placeholder) en root sans checksum ; écrit `renew-tls.sh` avant le clone qui l'écrase.
- `renew-tls.sh` recharge le nginx Docker (sous profil, non lancé) → **le renouvellement Let's Encrypt ne recharge pas le vrai proxy** (risque d'expiration à 90 j).
- `OVH_DEPLOYMENT.md` et `deploy-ovh.sh:51` référencent `backend/.env.production.example` **absent**.
- `backend/reset-creds.js:4` : URL de connexion complète de la Cloud DB de production **avec mot de passe en clair** + mots de passe de comptes de démo en dur (retiré dans `ovh-prod-clean`).

### Monitoring
- `prometheus.yml` scrape `api:3000/metrics` avec `credentials_file` — bon ; cibles node-exporter/postgres-exporter inexistantes.
- `alertmanager.yml:14` → `http://api:3000/internal/alerts/prometheus` : **route inexistante** → aucune alerte livrée, aucun canal humain.
- `alerts.yml` : 5 règles ; rien sur 5xx, latence, webhooks en échec, `pending` anciens (le fichier parasite montrait des collect pending depuis 19 000 min), TLS, backups.
- Grafana : aucun service, `GRAFANA_PASSWORD` orphelin, dashboards vides. Loki : `auth_enabled: false`, rétention non appliquée, promtail monte `docker.sock`. Rien n'est déployé.

## 5. Recommandations

### P0
1. **Retirer l'APK debug** publié ; ne publier qu'un release signé, targetSdk ≥ 35.
2. **Purger `reset-creds.js`** (fait dans `ovh-prod-clean`), **changer le mot de passe Cloud DB** et les comptes de démo.
3. **WooCommerce** : signature obligatoire, contrôle montant/devise, corriger le contrat payload et pay-links ; sinon retirer le zip.
4. **Double paiement** : `Idempotency-Key` obligatoire (app + SDK) et middleware sur `/merchant/collect|disburse|withdraw|transfer/payout`.
5. **Sorties de fonds sans second facteur** : biométrie/PIN côté app **et** TOTP/PIN côté backend ; appliquer réellement le 2FA au login.
6. **Infra non reproductible** : versionner le nginx réellement utilisé ; corriger `deploy-ovh.sh` et le rollback.
7. **Backups** : `pg_dump` vers la Cloud DB (TLS, secret fichier 600, export chiffré hors serveur) ; vérifier l'échec du cron actuel.
8. **Alerting** : implémenter `/internal/alerts/prometheus` ou receiver réel ; bloquer `/metrics` et `/internal/` dans nginx ; refuser `?token=`.

### P1
Android : corriger `@Multipart`+`@Body`, implémenter ou retirer deep link/QR, `FLAG_SECURE`, supprimer `Log.d` login, logging NONE, pinning, Room chiffré ou purgé, refresh token, `BIOMETRIC_STRONG`, root-check actif, wrapper Gradle, URL debug distincte, versionCode. SDK Android : jamais de `sk_live_` côté client ; corriger disburse/getTransaction/scanQR/sandbox ; livrer un vrai AAR. SDK JS/PHP : aligner les routes sur `apiKeyAuth` ou exposer `/public/disburse|transactions/:id|refunds` ; `timingSafeEqual` ; `php >=8.0`. Backend : vérifier `X-API-Secret` ou le retirer ; clés hachées. nginx : certificat `app.`/`card.`, HSTS/CSP partout, zone paiement sur les routes réelles, `default_server`. Node 22, nginx stable, `npm ci` non-root. Expo : `expo-secure-store`, pas de mode admin mobile, ou retirer l'app.

### P2
Nettoyage `.bak`, layouts morts, dépendances inutiles, `local.properties` ; mettre à jour `OVH_DEPLOYMENT.md` ; tests Android/SDK et CI ; Loki/Grafana réels ; KYB en multipart ; `healthcheck-prod.sh` notifiant.
