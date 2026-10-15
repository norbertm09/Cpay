# Vague 3 — apps mobiles, reliquats backend, portails/SDK, logo HD (branche `wave-3`)

Base : `wave-2`. Backend : **20 suites / 475 tests verts** (18 / 446 avant), tous les fichiers touchés passent
`node --check`. Aucune migration SQL, aucune nouvelle variable d'environnement obligatoire.

## 1. Backend — ce qui change

### 1.1 `POST /api/v1/admin/users/:id/reset-password` (était un stub TODO)
- `:id` = `merchant_users.user_id` par défaut (`?type=merchant`, cohérent avec `GET/POST /admin/users` qui
  ne manipulent que `merchant_users`) ; `?type=admin` cible `admin_users.admin_id`.
- Droits : `ops_admin` → comptes marchands uniquement (403 sur `type=admin`) ; `super_admin` → marchands
  et admins (y compris un autre `super_admin`), jamais son propre compte (422 `SELF_RESET`, utiliser
  `/auth/change-password`).
- Effet : mot de passe temporaire `generateTempPassword()` (16 caractères aléatoires, préfixe `Tmp-` /
  `Adm-`), `bcrypt` coût 12, `temp_password=TRUE` (⇒ `mustChangePassword` au prochain login), **2FA
  inchangé**, `revokeAll(actorType, id)` (toutes les sessions refresh révoquées, les access tokens expirent
  sous 15 min), `audit_logs` `USER_PASSWORD_RESET` (sans le mot de passe).
- Réponse : `{ success, type, email, tempPassword, mustChangePassword:true, message }` — le mot de passe
  en clair est renvoyé **une seule fois** à l'admin. Il n'existe pas de service e-mail fiable :
  **procédure** : l'admin transmet le mot de passe temporaire à l'utilisateur par un canal sûr (appel
  téléphonique, remise en main propre, message chiffré), jamais par e-mail en clair ni par ticket ; l'utilisateur
  doit le changer à la première connexion.

### 1.2 CRM — désassignation (`PATCH /admin/crm/leads/:id`, `/claims/:id`)
Plus de `COALESCE` : champ **absent** = inchangé ; `assignedTo: null` (ou `""`) = `assigned_to = NULL` ;
uuid = remplacé (422 sinon) ; même règle pour `notes` / `resolution` (`null` ou `""` = effacé) ; un corps
vide répond 422. `resolved_at` est posé sur `resolved`/`closed` comme avant.

### 1.3 Webhooks sortants — en-têtes `X-CPay-*`
Un seul helper `services/webhooks/outgoing.js` (HMAC-SHA256 hex du corps brut, préfixe `sha256=`) utilisé
par les trois émetteurs (intégrations, test de webhook marchand, `triggerMerchantWebhook`). Chaque
livraison envoie `X-CPay-Signature`, `X-CPay-Event`, `X-CPay-Timestamp`, `User-Agent: CPay-Webhooks/1.0`
**et** les anciens `X-CPlus-Signature` / `X-CPlus-Event` dans leur format historique (transition ; retrait
dans une vague ultérieure). Contrat complet pour la page développeurs : [`WEBHOOKS-SORTANTS.md`](WEBHOOKS-SORTANTS.md).

### 1.4 Réconciliation des transactions Mobile Money `pending`
- `POST /api/v1/admin/reconcile` ne couvrait que MTN/Airtel. Il couvre maintenant **Orange, Wave, Africell,
  Express Union, Free Money, Moov** : pour chaque `transactions.status='pending'` avec
  `gateway_payment_id`, âgée de plus de `minAgeMinutes` (défaut 5, corps `{ maxAgeHours, minAgeMinutes }`),
  le provider est retrouvé par `gateway_name` (clé `orange_cg`, `wave_sn`…) ou, pour les lignes antérieures
  au déploiement, par `detected_operator` + `detected_country` ; `getProvider(key).getStatus()` est appelé
  quand il existe.
- **Une seule machine d'état** : la finalisation des webhooks (claim atomique `status='pending'`,
  `response_code`, règlement enfilé, `pay_links.paid`, `transaction_events`) a été extraite dans
  `services/mobilemoney/finalize.service.js` et est utilisée par `routes/webhooks-mm.routes.js` **et** par
  la réconciliation (`transaction_events.event_type = <PROVIDER>_RECONCILE`).
- Opérateur injoignable, `statusPath` absent, provider sans endpoint de statut, montant/devise
  incohérents, statut encore `PENDING` → la ligne reste `pending` (jamais `failed` sur erreur réseau).
- Nouveau `getStatus` Wave (`GET /v1/checkout/sessions/{id}`) pour les encaissements ; **Orange n'a pas
  d'endpoint de statut branché** (voir §4) ; Africell / Express Union / Free Money / Moov exigent
  `extra_params.statusPath` (à obtenir des opérateurs, voir [`OPERATEURS-A-CONFIRMER.md`](OPERATEURS-A-CONFIRMER.md)).
- Le routeur Mobile Money renseigne désormais `transactions.gateway_name` avec la **clé de gateway**
  (`orange_cg`) au lieu du nom d'opérateur (`ORANGE_MONEY`), comme le faisaient déjà les gateways carte ;
  l'agrégat « par gateway » du tableau de bord admin mélange les deux valeurs pendant la transition.
- CLI pour cron : `node scripts/reconcile-pending.js [--max-age-hours=24] [--min-age-minutes=5] [--limit=100] [--json]`
  (même service que la route admin). Résumé : `{ scanned, authorized, failed, still_pending, skipped, errors, by_provider }`.
- MTN/Airtel : chemin hotfix v1 inchangé.

### 1.5 Rate limiters
Tous les `rateLimit(` (`server.js` et routes) fixent `standardHeaders` (`true` ou `'draft-7'`) et
`legacyHeaders:false` — vérifié par un test statique (`wave3-webhooks-out.test.js`). **Le store est en
mémoire** : les compteurs sont par processus. Avec plus d'un nœud API (réplication Docker, second serveur),
il faut un store partagé (`rate-limit-redis` + Redis, ou `rate-limit-postgresql`) pour que les limites de
login / paiement restent effectives ; tant qu'un seul conteneur `api` tourne, rien à faire.

### 1.6 Marque
Chaînes visibles par les utilisateurs (`CPlus` → `C-Pay`) dans les SMS (reçu, lien de paiement), e-mails
(sujets, pied de page, bienvenue, réinitialisation, KYC), WhatsApp de test, messages payeur envoyés aux
opérateurs (`payerMessage`, `description`, narrations de virement), titre Swagger. Les identifiants
techniques (`CPLUS_V2`, `CPLUS001`, en-têtes `X-CPlus-*`, Sender ID SMPP par défaut `CPLUS`) ne changent pas.

## 2. Variables d'environnement
Aucune nouvelle variable obligatoire. Rappels : `WEBHOOK_PATH_SECRET`, `WAVE_WEBHOOK_SECRET`,
`<PROVIDER>_WEBHOOK_TOKEN` (vague 2) ; `extra_params.statusPath` par provider pour activer la
re-interrogation de statut (réconciliation **et** webhooks).

## 3. Déploiement

```bash
cd /opt/cplus && git fetch origin && git checkout wave-3
./scripts/backup-db.sh --label pre-wave-3
cd docker && docker compose build api && docker compose up -d api
curl -s https://api.c-pay.global/health
```

Puis :
1. Réconcilier les transactions initiées avant le déploiement (toutes vagues confondues) :
   `POST /api/v1/admin/reconcile {"maxAgeHours":720,"minAgeMinutes":5}` depuis le portail admin, ou
   `docker compose run --rm --no-deps api node scripts/reconcile-pending.js --max-age-hours=720 --json`.
2. Planifier la réconciliation (toutes les 10 min) — par exemple un service compose sur le modèle de
   `settlement-cron`, ou le crontab de l'hôte :
   `*/10 * * * * cd /opt/cplus/docker && docker compose run --rm --no-deps api node scripts/reconcile-pending.js >> /var/log/cpay-reconcile.log 2>&1`
3. Publier le contrat `WEBHOOKS-SORTANTS.md` sur la page développeurs et annoncer la date de retrait des
   en-têtes `X-CPlus-*`.
4. Compléter `OPERATEURS-A-CONFIRMER.md` avec les opérateurs ; renseigner `statusPath` dès réception.

## 4. Points ouverts
- **Orange Money** : aucune API de statut branchée (le `pay_token` nécessaire à `paymentstatus` n'est pas
  conservé) → une transaction Orange sans callback reste `pending` (`skipped: no_status_endpoint`) ; à
  confirmer avec Orange, puis stocker `pay_token` et ajouter `getStatus` dans `orange.provider.js`.
- **Wave versements (B2C)** : pas d'endpoint de statut confirmé → `getStatus` renvoie `available:false`.
- `triggerMerchantWebhook` conserve un secret de repli `cplus-default-secret` quand le marchand n'a pas
  de `webhook_secret` (comportement historique) ; à supprimer quand tous les marchands auront régénéré
  leur secret.
- Les anciens en-têtes `X-CPlus-*` sont encore émis ; retrait = `legacy:false` dans `outgoing.js`.
- Store partagé des rate limiters si passage à plusieurs nœuds (§1.5).

## 5. Apps mobiles

### 5.1 Android natif (`android/`, 2.7.0, versionCode 2) — détail dans `docs/WAVE-3-ANDROID.md`
- Jetons d'accès 15 min : `SessionManager` stocke le refresh opaque et l'expiration ; `ApiClient` rafraîchit en amont (60 s avant expiration) et une fois sur 401 (verrou single-flight), puis rejoue la requête ; refus du refresh → session effacée, retour à l'écran de profil « Session expirée ».
- Login : `mfaRequired` → `TwoFAActivity` en mode connexion (`/auth/2fa/validate`) ; `mustChangePassword` → `ChangePasswordActivity` forcée ; logout serveur (`/auth/logout { refreshToken }`).
- 410 `FEATURE_DISABLED` (recharge, déchargement, retrait, sans contact) → message « Fonctionnalité en cours d'intégration », bouton désactivé.
- Marque C-Pay (nom d'app, thèmes, reçus, User-Agent `CPay-Android/2.7.0`), icônes de lanceur et icône adaptative à partir du logo HD.
- **Non compilé ici** (pas de SDK Android) : exécuter `./gradlew :app:assembleRelease` et le plan de test manuel de `docs/WAVE-3-ANDROID.md` avant publication. À la première ouverture après mise à jour depuis 2.6.0, l'utilisateur est déconnecté une fois (pas de refresh stocké).

### 5.2 Expo (`mobile/cpay-mobile/`, ex-`cplus-mobile`, 2.7.0, versionCode 270)
- Session dans `expo-secure-store` (`cpay.session`, `cpay.user`), refresh single-flight amont + sur 401, 2FA, mot de passe forcé, logout serveur, revalidation au démarrage via `/auth/me`.
- Écrans alignés sur les routes actuelles : encaissement `POST /merchant/collect` avec suivi `GET /merchant/collect/:id/status` (3 s, 90 s max), liens/QR via `/merchant/pay-links`, retrait affiché « en cours d'intégration », onglet Rails déplacé côté admin.
- Icône, icône adaptative et splash générés à partir du logo HD (`assets/`).
- Vérifié par Babel + esbuild uniquement (pas de simulateur) ; `eas.json` sans `projectId` (à créer avec `eas init`).

## 6. Portails, SDK, plugin
- Profil chargé via `GET /auth/me` (marchand, admin, porteur, partenaires) avec repli sur le décodage local ; refresh 15 min via cookie `cp_rt_<portail>` sur les 7 portails (single-flight) ; QR codes générés localement (`qrcode.react`) au lieu d'un service tiers.
- SDK JavaScript `@c-pay/sdk` 1.1.0 (`CPayClient`, alias `CPlusClient`), SDK PHP `calculus-plus/cpay-sdk` (namespace `CPay`, shims `CPlusSDK`), SDK Android (`typealias CPay`), plugin WooCommerce 2.7.0 (`WC_CPay_Gateway` + alias ; slug, identifiant `cplus` et métadonnées conservés pour ne pas casser les installations existantes ; webhook non signé refusé dès qu'un secret est configuré).
- Archives `cpay-android-sdk-v2.7.0.zip` et `cpay-payment-gateway-v2.7.0.zip` reconstruites, empreintes SHA-256 publiées sur la page développeurs.

## 7. Logo Calculus Plus HD
Le logo fourni (PDF, image 1536×1024) remplace l'ancien logo vectoriel bleu/cyan partout : `logo-calculus.png` (fond transparent) dans la vitrine et les 7 portails, `favicon.ico`/`favicon.png`/`apple-touch-icon.png` générés à partir de l'emblème, `og-image.png` 1200×630 pour les partages, icônes Android (mipmaps + adaptive icon sur fond blanc), icônes Expo, logo du plugin WooCommerce allégé (600 px). Les anciens `logo-calculus.svg` et `favicon.svg` sont supprimés. La palette des sites (bleu `#1d4f92` / cyan) est conservée ; l'orange du logo (`#f07800`) peut devenir la couleur d'accent sur demande.
