# Audit des applications mobiles C-Pay

Dépôt `/home/user/cpay`, branche `develop`, commit `e8a536e` ; PR 37 (`feature/mobile-stores`, commit `8d53bc2`) lue en complément.
Périmètre : app Android native marchande (`android/`, `global.cpay.app`, versionName 2.7.0 / versionCode 2) et app Expo (`mobile/cpay-mobile/`, `global.cpay.mobile`, Expo SDK 51 / RN 0.74.5).
Méthode : lecture seule du code, pas de compilation (aucun SDK disponible). Chaque constat cite `fichier:ligne`.
Hors périmètre (connu) : absence de test sur appareil réel, pas de keystore de release, pas de compte Play/Apple.

Sévérités : **P0** bloquant la publication ou le pilote · **P1** à corriger avant l'ouverture aux marchands · **P2** dette à planifier.

---

## Synthèse

| | Android natif | Expo |
|---|---|---|
| Constats P0 | 2 (targetSdk 34, suppression de compte / confidentialité) | 2 (SDK 51 obsolète, suppression de compte) |
| Constats P1 | 5 | 2 |
| Constats P2 | 5 | 2 |
| Note de maturité | **C** | **D** |

L'app Android est fonctionnellement cohérente avec le contrat `docs/CAISSE-API.md` (auth unifiée, step-up, encaissement, journal hors ligne) et son socle sécurité est correct (jetons chiffrés, pas de cleartext, composants non exportés). Elle n'est en revanche pas publiable en l'état : `targetSdk 34` est refusé par Google Play depuis le 31/08/2025, aucun parcours de suppression de compte n'existe et la politique de confidentialité est un gabarit « À COMPLÉTER ». Côté fiabilité monétaire, deux écarts au contrat vague 6 sont à corriger avant les marchands : la clé d'idempotence est régénérée à chaque appui (double ordre possible sur reprise réseau) et le statut `unknown` des retraits est affiché comme un succès.

L'app Expo est un prototype mono-fichier (1 843 lignes) sur un SDK en fin de vie, qui embarque un mode administrateur et n'est pas alignée sur la caisse actuelle (pays du marchand, référence). Elle ne peut pas servir de base iOS sans une montée de version majeure et un dégraissage.

---

## Constats

### P0-1 · Android : `compileSdk`/`targetSdk` 34 refusés par Google Play

**Preuve.** `android/app/build.gradle:8` `compileSdk 34`, `:14` `targetSdk 34` ; `android/build.gradle:2` AGP 8.2.0, Kotlin 1.9.22 ; `android/gradle/wrapper/gradle-wrapper.properties` Gradle 8.5 ; `.github/workflows/ci.yml:211` et `release.yml:74` n'installent que `platforms;android-34`.
**Impact.** Depuis le 31 août 2025, Google Play exige `targetSdk ≥ 35` pour toute nouvelle app et toute mise à jour ; selon le calendrier annuel de Google, l'exigence passe à 36 (Android 16) à partir du 31 août 2026. Toute soumission en novembre 2026 sera rejetée à l'import de l'AAB. Android 15+ impose aussi l'edge-to-edge par défaut pour les apps `targetSdk ≥ 35` : les écrans à `android:screenOrientation="portrait"` (manifest, toutes les activités) et les en-têtes personnalisés (`view_screen_header.xml`) devront gérer les insets.
**Correction.** Passer `compileSdk 36`/`targetSdk 36`, AGP ≥ 8.7, Gradle ≥ 8.9, Kotlin 2.x ; mettre à jour `ci.yml`/`release.yml` ; traiter l'edge-to-edge (`WindowCompat.setDecorFitsSystemWindows` + insets sur les en-têtes et la barre basse) ; vérifier `security-crypto 1.1.0-alpha06` → 1.1.0 stable et `biometric 1.1.0` → 1.2.x.

### P0-2 · Suppression de compte et politique de confidentialité absentes (Android et Expo)

**Preuve.** Aucune occurrence de suppression de compte dans les deux apps (`grep -ri "supprim.*compte|delete.*account"` sur `android/` et `mobile/` : rien) ni d'endpoint backend (`backend/src/routes/merchant.routes.js` : seuls `DELETE /bank-accounts/:id`, `/terminals/:id`, `/api-keys/:id`, `/pay-links/:id`). Les apps permettent la création de compte en autonomie (`RegisterActivity.kt`, `App.js:374` « Inscription »). La page `portal/landing/legal/confidentialite.html:50` affiche « **À COMPLÉTER avant publication** » avec des champs `[ainsi]` et des durées de conservation non validées. Aucune URL de confidentialité ni de suppression n'est référencée dans l'app (ni `strings.xml`, ni `MoreFragment.kt`, ni `MerchProfileFragment.kt`). La PR 37 (`docs/MOBILE-STORES.md` §1.4, §2.3) pointe `https://c-pay.global/legal/confidentialite` alors que le fichier est `confidentialite.html` (vérifier la réécriture côté serveur) et liste l'écran « Confidentialité / Supprimer mon compte » comme « PR à venir ».
**Impact.** Google Play exige, pour toute app permettant de créer un compte, une URL web de demande de suppression et son équivalent dans l'app (politique « Suppression de compte », obligatoire depuis 2024) ; Apple exige la suppression de compte **dans l'app** depuis juin 2022. La fiche « Sécurité des données » ne peut pas être remplie honnêtement avec une politique gabarit. Refus assuré à la revue.
**Correction.** (1) Backend : `POST /merchant/account/deletion-request` (step-up, délai de rétractation, anonymisation compatible LCB-FT) ; (2) Android : entrée « Confidentialité et données » dans `MoreFragment` (section Compte) avec lien vers la politique et bouton « Supprimer mon compte » ; (3) Expo : même écran ; (4) finaliser `confidentialite.html` avec un conseil, publier une page `/legal/suppression-compte` et renseigner les deux URL dans les consoles.

### P0-3 · Expo : SDK 51 / RN 0.74 en fin de vie, incompatible avec les exigences stores 2026

**Preuve.** `mobile/cpay-mobile/package.json:14-21` : `expo ~51.0.0`, `react-native 0.74.5`, `react 18.2.0`, `@react-native-async-storage/async-storage ^1.23.1`, `expo-secure-store ~13.0.2`. `app.json` ne fixe ni `ios.buildNumber`, ni `ios.infoPlist`, ni `android.compileSdkVersion`.
**Impact.** Expo SDK 51 (mai 2024) cible Android 14 (API 34) et se construit par défaut avec Xcode 15 : refus Google Play (voir P0-1) et refus App Store Connect (iOS 18 SDK/Xcode 16 exigés depuis avril 2025, iOS 26 SDK/Xcode 26 depuis avril 2026). SDK 51 ne reçoit plus de correctifs de sécurité ; `eas-version: latest` dans `mobile-expo.yml:50` (PR 37) finira par refuser de construire un SDK aussi ancien.
**Correction.** Migrer vers Expo SDK 54 (RN 0.81, API 36, iOS 26 SDK, Nouvelle Architecture activée) : `npx expo install --fix`, async-storage 2.x, vérifier `react-native-qrcode-svg`/`react-native-svg` ; ajouter `ios.buildNumber`, `ios.infoPlist.ITSAppUsesNonExemptEncryption=false`, retirer `supportsTablet: true` tant qu'aucune capture iPad n'est prévue ; renseigner `appleTeamId` (`eas.json` PR 37 : `A_RENSEIGNER`).

### P1-1 · Android : clé d'idempotence régénérée à chaque appui (double ordre sur reprise)

**Preuve.** `CollectCustomerFragment.kt:200-201` `val ref = generateRef("ENC"); val idem = generateRef("IDK")` à chaque `submit()` ; `WithdrawFragment.kt:278` `val idem = SecurityManager.generateRef("IDK")` à chaque `doWithdraw()` ; `CollectCardFragment.kt:create()` idem ; `SecurityManager.kt:60-64` `generateRef` = horodatage base 36 + 4 chiffres. Sur `catch (e: Exception)` (`CollectCustomerFragment.kt:231`, `WithdrawFragment.kt:300`) l'écran affiche « Connexion impossible » et réactive le bouton ; l'appui suivant repart avec une nouvelle clé. Aucun traitement de `409 IDEMPOTENCY_RETRY_AFTER_ERROR` / `IDEMPOTENCY_REPLAY` ni de `IDEMPOTENCY_IN_PROGRESS` (`ApiErrors.kt` ne connaît pas ces codes).
**Impact.** `docs/CAISSE-API.md` §0 exige « une clé stable par intention » : après un timeout OkHttp (30 s, `ApiClient.kt:82-84`) ou un 5xx, l'ordre a pu être créé côté serveur ; le rejeu avec une nouvelle clé crée un **second** encaissement (deux invites USSD au client) ou un **second retrait**. Le seul cas couvert est le `428` dans `StepUp.run`, où la clôture réutilise la même clé (`WithdrawFragment.kt:285-287`).
**Correction.** Porter la clé dans l'état du fragment (`onSaveInstanceState`) et la conserver tant que le résultat est inconnu (exception réseau, 5xx, 409, 428) ; la régénérer seulement après une réponse définitive ou un « Nouvel encaissement » explicite, à l'image de l'app Expo (`App.js:746-751` : clé stable, régénérée uniquement quand les champs changent) ; traiter `IDEMPOTENCY_REPLAY` comme un succès et `IDEMPOTENCY_RETRY_AFTER_ERROR` par un renvoi vers le Journal ; utiliser `UUID.randomUUID()` plutôt que horodatage + 4 chiffres.

### P1-2 · Android et Expo : statut `unknown` des retraits affiché comme un succès

**Preuve.** `WithdrawFragment.kt:290-293` : toute réponse `isSuccessful` déclenche `showResult` ; `showResult:311-328` force `ResultSheet.Kind.SUCCESS` et le titre « Retrait demandé » ; `StatusUi.statusLabel:14-27` n'a pas de branche `unknown` (`else -> status`, affiche le mot anglais brut) ; `CashLabels.transferStatus` (`Models.kt`) et `statusColors` idem. Expo : `App.js:513-516` `transferStatusLabel` sans `unknown`, `App.js:974-980` carte « Retrait demandé » quel que soit le statut. Aucune occurrence de `unknown` dans le code Kotlin ni dans `App.js`.
**Impact.** `CAISSE-API.md` §0 et §5 : `201 { status: "unknown", outcome: "unknown" }` signifie que l'opérateur n'a ni confirmé ni refusé ; les fonds restent réservés, le marchand doit suivre `GET /merchant/cash/transfers/:id`. Un marchand qui lit « Retrait demandé » puis voit son wallet non crédité relancera un retrait (voir P1-1) ou ouvrira un ticket. Le Journal et `JournalDetailSheet` afficheront « unknown » en anglais.
**Correction.** Ajouter `unknown` (« Résultat incertain — fonds réservés, suivi dans le Journal ») et `processing` dans `StatusUi`/`CashLabels`/`strings.xml` ; dans `showResult`, `Kind.WARNING` quand `status in (unknown, processing)` avec bouton « Suivre dans le Journal » ; côté Expo même chose dans `transferStatusLabel` et la carte de résultat.

### P1-3 · Android : cache Room en clair, jamais purgé à la déconnexion

**Preuve.** `AppDatabase.kt:18-22` base `cplus_db` sans chiffrement ; `TransactionEntity.kt:146-157` persiste `customerPhone`, `authCode`, `amount`, `description` ; `CacheEntryEntity` stocke le JSON brut de `CashSummary` (solde, wallet du marchand) et de `HistoryResponse` (`counterparty`). `CacheManager.clearJson:88-90` n'est appelé nulle part (`grep clearJson` : définition seule) ; `ApiClient.logout():253-272` et `onSessionLost():235-247` vident la session, `CashSession` et `StepUp` mais pas Room ; `SessionManager.clearSession():129-136` non plus. Les clés de cache (`KEY_CASH_SUMMARY`, `keyHistory`) ne sont pas préfixées par le `merchantId`.
**Impact.** Sur un terminal partagé ou revendu, le marchand suivant voit hors ligne le solde, le wallet et les derniers mouvements (avec numéros de clients) du précédent (`CaisseHomeFragment.kt:114-118`, `CashJournalFragment.kt:125-135`). Données personnelles de tiers conservées sans chiffrement, en contradiction avec la fiche « Sécurité des données » à remplir.
**Correction.** Appeler `CacheManager.clearJson` et `transactionDao().purgeAll()` dans `ApiClient.logout` et `onSessionLost` ; préfixer les clés par `SessionManager.userId` ; limiter les champs persistés (masquer `customerPhone` en `06 ** ** 56`) ; évaluer SQLCipher ou `EncryptedFile` si le cache hors ligne doit rester complet.

### P1-4 · Android : deep link exporté factice qui avale les liens de paiement

**Preuve.** `AndroidManifest.xml:69-76` : `DeepLinkActivity` `exported="true"`, `autoVerify="true"`, `https://pay.c-pay.global` ; `DeepLinkActivity.kt:6-12` : `// TODO: Handle pay.c-pay.global deep links` puis `finish()`. `CollectCardFragment.kt:btnOpen` ouvre `Intent(ACTION_VIEW, Uri.parse(u))` sur cette même URL. Aucun `assetlinks.json` dans le dépôt (`find . -name assetlinks.json` : rien).
**Impact.** Dès qu'un `assetlinks.json` sera publié (ou sur Android ≤ 11 via la boîte de choix), le bouton « Ouvrir » du lien carte et tout lien `pay.c-pay.global` touché sur le téléphone du marchand s'ouvriront dans l'app et se fermeront aussitôt. Les relecteurs Play/Apple testent les deep links déclarés ; un intent-filter exporté sans traitement est aussi un signalement classique d'audit.
**Correction.** Retirer l'intent-filter tant que la fonctionnalité n'existe pas, ou l'implémenter (ouvrir la page dans un Custom Tab, ou router `/pay/:shortId` vers le détail du mouvement) ; ouvrir les liens carte via `CustomTabsIntent` ; publier `assetlinks.json` uniquement avec l'implémentation.

### P1-5 · Android : profil « Porteur » et écrans hérités embarqués dans l'app marchande

**Preuve.** `ProfileSelectActivity.kt:24-25` propose « Porteur de carte » (`activity_profile_select.xml:26`). `QRScanActivity.kt:48-56` envoie le texte scanné à `PaymentConfirmActivity`, qui fait `finish()` immédiatement (`PaymentConfirmActivity.kt:6-11`) : le scan ne mène nulle part et affiche un `Toast` avec le contenu brut du QR (`:51`). `TransferFragment.kt` (499 lignes), `CardsFragment.kt`, `TopUpFragment.kt` (410 géré par désactivation du bouton `:143-145`) : flux GTP non pilotés. Côté marchand, `MoreFragment.kt:60` expose « Décaisser » → `DisburseFragment` (`:159-160` : désactive le bouton après un 410) et `MerchTransferFragment` (ancien écran). Dépendances déclarées mais non référencées dans le code Kotlin : `MPAndroidChart`, `Glide`, `mlkit:barcode-scanning`, `androidx.camera:*` (`build.gradle:89-101`, `grep` : aucune utilisation). La permission `CAMERA` (`manifest:5`) ne sert qu'à `QRScanActivity`.
**Impact.** Surface fonctionnelle non testée exposée aux relecteurs et aux marchands (un marchand qui choisit « Porteur » se retrouve sur un écran de login dont le backend n'est pas en pilote) ; permission `CAMERA` à justifier dans la fiche alors qu'elle ne sert à rien d'utile ; APK alourdi (ML Kit ≈ 3 Mo, CameraX) ; dette de maintenance (≈ 2 400 lignes cardholder).
**Correction.** Flag de build `MERCHANT_ONLY` (ou suppression) : masquer la carte « Porteur », retirer `CAMERA`, `QRScanActivity`, `PaymentConfirmActivity`, les quatre dépendances mortes, « Décaisser » et `LegacyWithdrawRequest`/`merchantWithdraw` (`ApiService.kt:135-136`, `Models.kt:231`) ; garder le code porteur dans une branche ou un module séparé.

### P1-6 · Expo : mode administrateur dans une app destinée aux stores

**Preuve.** `App.js:422` segment « Marchand / Admin » sur l'écran de connexion ; `:358-361` `/admin/auth/login` ; `:296-298` onglets admin (APIs, Marchands, Monitoring, Rails, Pilot) ; `:1525,1553-1554,1568,1603,1615,1647` appels `/admin/stats/global`, `/admin/api-configs/*/test`, `/admin/merchants` (création) ; `:1616` affiche le **mot de passe temporaire** d'un marchand dans un `Alert` ; `:1340-1350` écran « Rails » Visa avec `countryCode: 'COD'` et bénéficiaire `Client / C-Pay` codés en dur ; `:1484` `/admin/pilot/features`.
**Impact.** Une app publique révèle l'existence et la forme des routes d'administration, facilite le credential stuffing sur `/admin/auth/login`, et met des outils de test de rails de paiement à portée de n'importe quel téléphone. La PR 37 le reconnaît (« Retirer le mode administrateur mobile », `MOBILE-STORES.md` §2.4) sans le faire.
**Correction.** Supprimer `AdminApp`, `RailsScreen`, `AdminApis`, `AdminMerchants`, `AdminMonitoring`, le segment de mode et `PREF_MODE_KEY` ; si un outil admin mobile est voulu, en faire un build interne séparé (bundle distinct, distribution EAS `internal` uniquement).

### P1-7 · Expo : non aligné sur la caisse actuelle (numéro local, référence, capacités)

**Preuve.** `App.js:624` `apiFetch('/detect/phone', { body: { phone: clean } })` sans `country` alors que `CAISSE-API.md` §3 bis exige `country` pour un numéro local et que l'Android l'envoie (`CollectCustomerFragment.kt:121-122`). Le corps d'encaissement (`App.js:772`) n'a pas de champ `reference` (pas de saisie facture/ticket). Placeholders `+237 6 70 00 00 00` (`:786`) et « format +242... » exigé pour l'envoi de lien (`:1230`). `isFeatureUnavailable` (`:85-86`) assimile tout `404` sans corps à « Fonctionnalité en cours d'intégration », masquant une route mal configurée. `cardAcceptance` n'est pas exploité pour désactiver l'onglet carte (`CaisseHome`, `:672-735`).
**Impact.** Un marchand congolais saisissant `066123456` verra « Opérateur non reconnu » ; impossible de rattacher une référence ; messages d'erreur trompeurs.
**Correction.** Envoyer `country: session.user.country` dans la détection, ajouter le champ `reference` pré-rempli (`ENC-…`), lire `profile.cardAcceptance` pour l'onglet Carte, restreindre `isFeatureUnavailable` au `410`/`FEATURE_DISABLED`.

### P2-1 · Android : durcissement écran et biométrie

**Preuve.** Aucun `FLAG_SECURE` dans le code (`grep` : rien) : solde, numéros de clients, QR 2FA (`TwoFAActivity.kt:90-91` affiche le secret TOTP en clair `:87`) et feuille de mot de passe apparaissent dans les captures et l'aperçu des apps récentes. `BiometricHelper.kt:13` `BIOMETRIC_WEAK` ; le déverrouillage n'est qu'une porte UI (`SplashActivity.kt:70-82`), le refresh token reste utilisable sans lui ; `UiPrefs.biometricLock` désactivé par défaut. `SecurityManager.isDeviceRooted`, `isTokenExpired`, `logSecurityEvent` (`SecurityManager.kt:9-23, 67-76`) ne sont appelés nulle part. Pas de certificate pinning (`network_security_config.xml` sans `<pin-set>`).
**Impact.** Fuite d'informations par capture/écran de verrouillage ; biométrie de classe 2 (visage 2D) acceptée pour une app financière ; code mort donnant une fausse impression de contrôle.
**Correction.** `window.setFlags(FLAG_SECURE)` sur `MerchantMainActivity`, `TwoFAActivity`, `ReceiptActivity`, `LoginActivity` ; `BIOMETRIC_STRONG or DEVICE_CREDENTIAL` ; activer le verrou par défaut pour les marchands ; supprimer ou brancher `SecurityManager` ; étudier un `<pin-set>` avec épingle de secours (backend derrière CDN : vérifier la stabilité des certificats avant).

### P2-2 · Android : le build « debug » distribué aux testeurs journalise les corps HTTP

**Preuve.** `ApiClient.kt:68-70` `HttpLoggingInterceptor.Level.BODY` si `BuildConfig.DEBUG`, appliqué au client principal et au client de refresh (`:78, :87`) ; `LoginActivity.kt:86` `Log.d`. La PR 37 fait du `assembleDebug` (artefact `android-debug-apk`, `ci.yml:228`) le build de test terrain pointé sur `api.dev.c-pay.global` (`MOBILE-STORES.md` §1.1).
**Impact.** Mots de passe, codes TOTP, `refreshToken`, numéros de clients et soldes lisibles dans `logcat` par toute app disposant de `READ_LOGS` (ADB, outils de support) sur les téléphones des testeurs.
**Correction.** `Level.HEADERS` + `redactHeader("Authorization")` en debug, ou un build type `staging` (dev server, `minifyEnabled true`, logging `NONE`) distinct du debug développeur.

### P2-3 · Android : R8 jamais éprouvé, règles ProGuard « garde-tout »

**Preuve.** `proguard-rules.pro:4-8` garde intégralement `retrofit2.**`, `okhttp3.**`, `com.google.gson.**`, `global.cpay.app.common.**` ; aucune règle `-keep class * extends com.google.gson.reflect.TypeToken` ni pour les `Map<String, Any>` des réponses (`ApiService.kt:54,57,60…`) hormis `Signature`. `release.yml` ne tourne que sur tag ; `ci.yml` ne construit que le debug ; `WAVE-5-ANDROID.md:138` et `MOBILE-STORES.md` §1.3 demandent de « contrôler que minifyEnabled ne casse rien » — jamais fait.
**Impact.** Le premier AAB minifié est un saut dans l'inconnu (désérialisation Gson des `data class` Kotlin, coroutines Retrofit) ; en même temps, les règles larges annulent l'essentiel du gain de R8.
**Correction.** Ajouter `:app:assembleRelease` (non signé) à `ci.yml` avec un test instrumenté de fumée (login + résumé caisse sur un mock) ; s'appuyer sur les règles consommateur livrées par OkHttp/Retrofit/Gson récents et garder seulement `-keep class global.cpay.app.common.Models* { *; }` + `-keepclassmembers` sur `@SerializedName`.

### P2-4 · Qualité : textes codés en dur, détection d'erreur par sous-chaîne, zéro test

**Preuve.** Environ 70 chaînes françaises hors `strings.xml` : `ChangePasswordActivity.kt:58-61`, `RegisterActivity.kt:44-45`, `QRScanActivity.kt:51,63`, `ApiErrors.cashMessage:59-72`, `Models.kt:803-832`, tout le paquet `cardholder/` (`TransferFragment.kt:311-484`, `ProfileFragment.kt:100-254`, `CardsFragment.kt:119-215`). `PairingActivity.kt:249-252` décide du message en cherchant `"deja lie"` dans le corps d'erreur. `android/app/src/` ne contient que `main` (aucun `test/` ni `androidTest/`) alors que JUnit/Espresso sont déclarés (`build.gradle:111-113`). Expo : un seul fichier `App.js` de 1 843 lignes, aucun test, le CI se limite à une transformation esbuild (`ci.yml:196`).
**Impact.** Localisation (anglais annoncé « bientôt », `profile_language_soon`) impossible sans reprise ; régressions silencieuses sur les flux monétaires ; relecture et revue de code coûteuses.
**Correction.** Déplacer les chaînes restantes dans `strings.xml` (lint `HardcodedText` en erreur) ; comparer `ApiErrors.of(r).code` plutôt que des sous-chaînes ; tests unitaires ciblés (`ApiClient` refresh/401 avec `MockWebServer`, `SecurityManager.validatePhone`, `StatusUi`), un test instrumenté du parcours Encaisser ; découper `App.js` en modules + Jest.

### P2-5 · Expo : configuration de publication incomplète et divergente

**Preuve.** `app.json:30` `extra.apiBaseUrl` n'est lu nulle part (`App.js:25` lit `EXPO_PUBLIC_API_BASE_URL`) ; `MOBILE-STORES.md` tableau « Serveur visé : extra.apiBaseUrl » est donc faux. Pas de `ios.buildNumber`, `ios.infoPlist`, `privacyManifests` ; `supportsTablet: true` (captures iPad exigées) ; `android.permissions: ["INTERNET"]` ok ; `eas.json` (PR 37) `appleTeamId: "A_RENSEIGNER"` ; `production.autoIncrement: true` cohabite avec `versionCode: 270` maintenu par `scripts/bump-version.sh:78` (source de version locale vs distante EAS à trancher). `mobile-expo.yml` fait `npm install` sans lockfile (`package-lock.json` absent) : builds non reproductibles.
**Impact.** Rejets ou allers-retours à la soumission ; builds dont le serveur cible dépend d'une variable d'environnement EAS non documentée.
**Correction.** Supprimer `extra.apiBaseUrl` ou l'utiliser via `Constants.expoConfig.extra` ; fixer `cli.appVersionSource` ; ajouter `package-lock.json` et `npm ci` ; compléter `ios.*` ; corriger la documentation.

---

## Points positifs vérifiés

1. **Stockage des jetons chiffré et surface d'export minimale.** `SessionManager.kt:28-36` : `EncryptedSharedPreferences` AES-256-GCM/SIV avec `MasterKey` Keystore ; `AndroidManifest.xml:19,26` `allowBackup=false`, `usesCleartextTraffic=false` + `network_security_config.xml` ; seules `SplashActivity` et `DeepLinkActivity` sont exportées, toutes les autres `exported="false"`. Expo : jetons dans `expo-secure-store` avec séparation profil/jetons pour la limite de 2 Ko, `AsyncStorage` réservé aux préférences (`App.js:91-130`).
2. **Rafraîchissement de jeton robuste et concurrent-safe.** `ApiClient.kt:117-229` : refresh proactif < 60 s, `Authenticator` single-flight sous `ReentrantLock`, garde anti-boucle (`responseCount ≥ 2`), distinction 401 jeton / 401 métier (`isTokenFailure`), panne réseau pendant le refresh ≠ déconnexion, client de refresh sans intercepteur d'auth. Équivalent Expo (`refreshInFlight`, `App.js:169-200`).
3. **Confirmation forte conforme au contrat.** `StepUp.kt` : méthode résolue via `/auth/me` et mise en cache par utilisateur, reprise sur `428 { methods }`, 3 tentatives, aucun secret persisté, dialogue annulable ; `WithdrawFragment.kt:263-309` : bouton désactivé pendant l'appel, contrôles solde/plafond côté client, codes `422/428/410` traduits (`ApiErrors.cashMessage`). Expo : `withStepUp` réutilise la même clé d'idempotence sur 428 (`App.js:550-566`).
4. **Parcours d'encaissement soigné et aligné sur la PR 31.** `CollectCustomerFragment.kt:114-139` : détection avec debounce 450 ms **et pays du marchand** (`SessionManager.userCountry`), alternatives en puces, alerte de devise ; `CollectWaitingFragment.kt:76-109` : sondage 3 s / 90 s avec bascule « en attente » et annulation par Retour explicite ; `CollectResultFragment` : reçu, partage, réessai. Toutes les références de ressources (`@string`, `@drawable`, `@layout`, `@color`) sont résolues (vérification croisée), `strings.xml` est entièrement en français.
5. **Mode hors ligne honnête et écran de capacités.** `CaisseHomeFragment.kt:111-124,159-167` et `CashJournalFragment.kt:122-137,150-159` : repli sur le cache Room avec bandeau « Hors ligne — données du <date> » ; `render:195-199` exploite `profile.cardAcceptance` (`unavailable` / `tap_to_phone_pending`) et les 410 sont affichés comme « en cours d'activation », jamais comme une erreur ; aides d'onboarding (wallet, banque, KYB) fermables et mémorisées.

---

## Notes de maturité

**Android natif : C.** Architecture et sécurité de base solides pour un pilote fermé (APK direct), mais non publiable : P0-1 et P0-2 bloquent la fiche Play, P1-1/P1-2 exposent à des doubles ordres et à des retraits « incertains » présentés comme réussis, P1-3 à P1-5 relèvent d'un nettoyage avant ouverture. Avec les P0/P1 traités et un premier build release éprouvé (P2-3), l'app atteindrait B.

**Expo : D.** Prototype fonctionnel mais SDK en fin de vie, mode administrateur embarqué, écart au contrat caisse actuel, mono-fichier sans test. À considérer comme une base à refondre (SDK 54, suppression de l'admin, modules, tests) avant de servir l'iOS.

## Ordre de traitement suggéré

1. P0-1 (targetSdk 36 + CI release non signé) et P0-2 (suppression de compte + confidentialité) — préalables à toute soumission.
2. P1-1 et P1-2 — intégrité monétaire, avant le premier marchand hors équipe.
3. P1-3, P1-4, P1-5 — nettoyage et vie privée, dans la même release.
4. Expo : P0-3 puis P1-6/P1-7, sinon ne pas engager le compte Apple.
5. P2 au fil de l'eau, en commençant par P2-2 (build staging) et P2-3 (release éprouvée).
