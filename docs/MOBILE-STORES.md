# Application marchande : publication Google Play et App Store

Deux applications existent dans le dépôt. Décision du 1er novembre 2026 : **l'app Android native** (`android/`,
`global.cpay.app`) est l'app marchande du pilote et de Google Play ; **l'app Expo** (`mobile/cpay-mobile/`,
`global.cpay.mobile`) sert l'iOS via EAS Build, et peut aussi produire un Android si une seule base de code est
souhaitée plus tard.

| | Android native | Expo (iOS, et Android optionnel) |
|---|---|---|
| Build | GitHub Actions (`ci.yml` debug à chaque push, `release.yml` APK + AAB signés sur tag `vX.Y.Z`) | GitHub Actions `mobile-expo.yml` → EAS Build (cloud Expo) |
| Serveur visé | debug → `api.dev.c-pay.global` ; release → `api.c-pay.global` | `extra.apiBaseUrl` de `app.json` (production) |
| Signature | keystore dans les secrets `ANDROID_*` | gérée par EAS (`eas credentials`), jamais dans GitHub |
| Distribution test | APK debug (artefact CI) puis piste Internal testing (AAB) | TestFlight |
| Publication | Google Play Console | App Store Connect |

## 1. Android native → Google Play

### 1.1 Tester sur un appareil (dès maintenant)
Actions → dernier run **CI** sur `develop` → artefact `android-debug-apk` → installer l'APK sur un téléphone Android
(autoriser les sources inconnues). Ce build parle au **serveur de développement** ; se connecter avec un marchand de
dev. Plan de test : `docs/WAVE-5-ANDROID.md`.

### 1.2 Keystore de release (une fois, à conserver précieusement)
Sur le PC, dans PowerShell (le JDK est fourni avec Android Studio) :
```
keytool -genkeypair -v -keystore cpay-release.jks -alias cpay -keyalg RSA -keysize 2048 -validity 10000 -storepass "MOT_DE_PASSE_KEYSTORE" -keypass "MOT_DE_PASSE_CLE" -dname "CN=Calculus Plus SAS, O=Calculus Plus, C=CG"
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cpay-release.jks")) | Set-Clipboard
```
Secrets GitHub (Settings → Secrets → Actions, niveau dépôt) : `ANDROID_KEYSTORE_BASE64` (presse-papiers),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` = `cpay`, `ANDROID_KEY_PASSWORD`. Sauvegarder `cpay-release.jks`
et les deux mots de passe dans un coffre : **perdre le keystore interdit toute mise à jour sur Google Play**
(sauf si la signature est déléguée à Google, voir 1.4).

### 1.3 Première release signée
```
./scripts/bump-version.sh 2.7.1          # VERSION, versionName, app.json… (PR vers develop, puis promotion vers main)
git tag -a v2.7.1 -m "C-Pay 2.7.1" && git push origin v2.7.1
```
`release.yml` produit `app-release.aab` et les APK signés, crée la GitHub Release et déploie la production. Vérifier
dans le run que l'étape de signature n'affiche pas « non signés ». Avant chaque release : recette sur l'APK `staging`
(R8 identique, § 1.5 et § 1.7), puis plan de test sur l'APK universel signé.

### 1.4 Google Play Console
1. Compte développeur Google Play (25 USD, une fois) au nom de Calculus Plus SAS ; vérification d'identité (quelques jours).
2. « Créer une application » : C-Pay, français, application, gratuite. Accepter la **signature par Google Play**
   (recommandé : Google conserve la clé finale, le keystore de 1.2 devient clé d'upload).
3. Fiche : titre, description courte et longue, icône 512 px, bannière 1024×500, 4 à 8 captures téléphone
   (prendre les écrans Caisse, Encaisser, Journal, Résultat sur un appareil réel), catégorie Finance,
   e-mail de contact, **politique de confidentialité** = `https://c-pay.global/legal/confidentialite`.
4. Contenu de l'app : questionnaires (classification, sécurité des données : collecte e-mail, téléphone, données
   financières ; chiffrées en transit ; suppression sur demande), public visé 18+, accès avec identifiants de test
   (fournir un marchand de test sur la **production** pour l'examen Google).
5. **Tests internes** : importer l'AAB de la GitHub Release, ajouter les testeurs par e-mail, lien d'opt-in.
   Puis **Tests fermés** pour les marchands pilotes, puis **Production** après le pilote.
6. Chaque nouvelle version : `bump-version.sh`, tag, AAB de la release → Play Console. `versionCode` doit croître
   (le `bump-version.sh` l'incrémente).

### 1.5 Build de recette `staging` (lot 4)

`./gradlew :app:assembleStaging` (artefact CI `android-staging-apk`) : serveur de développement, R8 et ressources
réduites comme la release, **aucun journal HTTP**, identifiant `global.cpay.app.staging` installable à côté de la
release. C'est ce build qui doit être remis aux testeurs terrain ; le `debug` (journal des en-têtes, Authorization
masqué) reste réservé aux développeurs.

### 1.6 Suppression de compte et confidentialité dans l'app (lot 4, exigence Google Play / Apple)

Profil et sécurité → **Confidentialité et données** : lien vers la politique de confidentialité et « Supprimer mon
compte » (propriétaire, confirmation step-up). La demande (`POST /merchant/account/deletion-request`) ouvre un délai
de rétractation de 30 jours affiché dans l'écran, annulable depuis l'app ; les opérations la traitent dans le
back-office (`/admin/account-deletion-requests`). URL web équivalente, à déclarer dans la Play Console :
`https://c-pay.global/legal/suppression-compte.html`.

### 1.7 Chaîne de build, R8 et paliers (lot Android P2 du 2026-11-10, palier AGP 9 / API 37 du 2026-11-11)

Chaîne actuelle (palier AGP 9 / API 37) : **AGP 9.5.1** (Gradle ≥ 9.6, JDK 17, API max 37), **Gradle 9.9.1**,
**compileSdk 37 / targetSdk 37**, **Kotlin intégré à AGP** (plus de plugin `org.jetbrains.kotlin.android` ni de bloc
`kotlinOptions{}` ; `jvmTarget` suit `compileOptions.targetCompatibility` = 17), **KSP 2.3.12** (2.3.13 exclu :
régression sur les exécutions concurrentes), nouveau DSL AGP 9 (`android.newDsl`), Jetifier retiré ; dépendances
stables de septembre 2026 : core 1.19.1 (`core-ktx` est vide depuis 1.19, on dépend de `core`), appcompat 1.8.0,
material 1.14.0, lifecycle 2.11.0, activity 1.13.0, fragment 1.9.1, navigation 2.10.2, Room 2.8.5, Retrofit 3.0,
OkHttp 5.5.1, coroutines 1.10.2. La CI installe `platforms;android-37` et `build-tools;36.0.0`.

- **targetSdk 37 (lot du 2026-11-12)** : revue des changements de comportement d'Android 17 réservés aux apps
  ciblant l'API 37 (page officielle « Behavior changes: Apps targeting Android 17 »). Aucun ne touche C-Pay :
  limite mémoire des widgets (pas de widget), `MessageQueue` sans verrou et champs `static final` inaltérables (aucune
  réflexion de ce type ; Gson lit les champs, ne modifie pas de `static final`), ECH (transparent avec OkHttp 5),
  permission `ACCESS_LOCAL_NETWORK` (l'app ne parle qu'à `api.c-pay.global` ; l'impression des reçus passe par le
  service d'impression système), masquage des mots de passe au clavier physique, délai des SMS OTP (l'app ne lit
  pas les SMS : le code 2FA est saisi), durcissement des lancements d'activité en arrière-plan (aucun), **Certificate
  Transparency activée par défaut** (certificats Let's Encrypt journalisés, `network_security_config` sans épinglage),
  chargement natif sûr (pas de `System.load`), Contacts (non utilisés), `setContentCaptureEnabled` déprécié
  (`FLAG_SECURE` déjà posé sur connexion, 2FA, caisse, reçu), audio en arrière-plan (aucun), contraintes
  d'orientation ignorées sur grands écrans (déjà le cas depuis la cible 36, `resizeableActivity=true`), Bluetooth
  (non utilisé). Les changements « pour toutes les apps » s'appliquaient déjà indépendamment de la cible.
  **Recette** : sur un appareil ou un émulateur Android 17, connexion, caisse (encaissement, retrait), 2FA,
  biométrie, reçu et impression, appairage. Google Play n'exige 37 qu'à partir d'août 2027.
- **R8 sous AGP 9** : `-keep class A` n'implique plus `<init>()` (`android.r8.strictFullModeForKeepRules`) et le
  shrinker de ressources considère classes et ressources ensemble ; les règles de `proguard-rules.pro` gardent déjà
  `<init>(...)` sur les modèles Gson, et la CI construit `assembleRelease` / `bundleRelease` / `assembleStaging`.
  La recette de l'APK `staging` reste obligatoire avant chaque release.
- **Prochain palier** : AGP 10 (mi-2026 selon Google ; retrait de l'opt-out du nouveau DSL) — lot dédié ; Dependabot
  exclut les majeures d'AGP et du wrapper, tout le reste est proposé normalement.
- **Dépréciations (lot du 2026-11-12)** : la session (`SessionManager`) est stockée par `SecureStore`
  (AES-256-GCM, clé non exportable du Keystore Android, IV par écriture, nom de l'entrée authentifié) dans
  `cplus_session_v2` ; l'ancien fichier `EncryptedSharedPreferences` est migré au premier lancement puis supprimé
  (s'il est illisible, l'utilisateur se reconnecte et ré-appaire). `androidx.security:security-crypto`, dont toutes
  les API sont dépréciées, ne sert plus qu'à cette migration : à retirer avec le code de migration après deux
  releases. Retour arrière de `ChangePasswordActivity` via `OnBackPressedDispatcher`, `fallbackToDestructiveMigration(true)`,
  `Bundle()` à la place de `bundleOf`. Le build Kotlin ne produit plus d'avertissement de dépréciation. Test JVM
  `SecureStoreTest` (clé AES en mémoire).

Historique du lot P2 (2026-11-10) : AGP 8.11.1, Gradle 8.13, compileSdk 36, Kotlin 2.2.21 + KSP 2.2.21-2.0.4,
dépendances **compatibles compileSdk 36** (core 1.17, appcompat 1.7.1, lifecycle 2.9.4, activity 1.11, fragment 1.8.9,
navigation 2.9.5, OkHttp 4.12).

- **R8 (audit P2-3)** : les règles « garde-tout » (`retrofit2.**`, `okhttp3.**`, `gson.**`, `global.cpay.app.common.**`)
  sont retirées ; seules les classes portant des champs `@SerializedName` sont conservées (obfuscation autorisée),
  OkHttp/Retrofit 3/Gson apportent leurs règles consommateur. La CI construit `assembleRelease`, `bundleRelease` et
  `assembleStaging` ; un symbole manquant fait échouer le job (`missing_rules.txt` affiché). **Recette obligatoire
  avant chaque release** : installer l'APK `staging` (même R8 que la release) et dérouler connexion, résumé caisse,
  encaissement, retrait, journal, appairage — une désérialisation Gson cassée par R8 ne se voit qu'à l'exécution.
- **Tests unitaires (audit P2-4)** : `./gradlew :app:testDebugUnitTest` (CI, rapport en artefact en cas d'échec) :
  `SecurityManagerTest`, `ApiErrorsTest`, `CashLabelsTest`. Les chaînes restantes hors `strings.xml` (`ApiErrors.cashMessage`,
  `CashLabels`, paquet `cardholder/` masqué) sont le reliquat connu.
- **Biométrie (audit P2-1)** : `BIOMETRIC_STRONG | DEVICE_CREDENTIAL` (plus de visage 2D), verrou à l'ouverture actif
  par défaut (désactivable dans Profil), code mort de `SecurityManager` retiré.
- Le palier « AGP 9 / API 37 » annoncé ici a été livré le 2026-11-11 (voir le haut de cette section).

## 2. Expo → App Store (iOS)

### 2.1 Comptes (une fois)
- **Apple Developer Program** (99 USD/an) au nom de Calculus Plus SAS : D-U-N-S requis pour une organisation
  (gratuit, 1 à 2 semaines) ; sinon compte individuel au nom du dirigeant pour démarrer.
- Compte **Expo** (expo.dev), projet `cpay-mobile`, jeton d'accès (Account settings → Access tokens) → secret
  GitHub `EXPO_TOKEN`.
- Depuis le PC, une fois : `cd mobile/cpay-mobile && npx eas login && npx eas build:configure && npx eas credentials`
  (EAS crée certificat de distribution, profil de provisioning et clé App Store Connect ; rien à copier dans GitHub).
- Renseigner `submit.production.ios.appleTeamId` dans `eas.json` (Team ID du compte Apple).

### 2.2 Builds
Actions → **Mobile Expo (EAS)** → Run workflow : plateforme `ios`, profil `preview` (build interne installable via
lien EAS sur un iPhone enregistré) puis `production` (IPA pour TestFlight). Cocher `submit` pour envoyer sur
TestFlight automatiquement. Le run affiche l'URL du build EAS ; durée 10 à 20 min côté Expo (file gratuite).

### 2.3 App Store Connect
1. Créer l'app (bundle `global.cpay.mobile`, nom C-Pay, SKU `cpay-mobile`).
2. TestFlight : testeurs internes (jusqu'à 100) immédiatement ; testeurs externes après une revue légère.
3. Fiche App Store : captures iPhone 6,7" et 6,5", description, mots-clés, URL d'assistance
   `https://c-pay.global/reclamation.html`, confidentialité `https://c-pay.global/legal/confidentialite`,
   « Nutrition labels » (données financières, coordonnées, identifiants), classification 4+ (finance).
4. Soumission : fournir un compte marchand de test **production**, expliquer le parcours d'encaissement (Apple
   teste réellement ; prévoir un numéro Mobile Money de test ou une vidéo). Délai habituel 24 à 72 h.
5. Chaque version : `bump-version.sh` (met à jour `app.json`), build `production`, `submit`.

### 2.4 État du code Expo (lot 5, 2026-11-09)

Fait : Expo SDK 54 / React Native 0.81 / React 19 (API 36, iOS 26 SDK, Nouvelle Architecture), `package-lock.json` et
`npm ci` dans les workflows, mode administrateur retiré (application marchande uniquement), détection du numéro avec le
pays du marchand (numéro local accepté), champ référence d'encaissement, onglet Carte masqué quand `cardAcceptance`
est `unavailable`, statut de retrait `unknown` affiché comme une vérification en cours, écran **Compte** (profil,
politique de confidentialité, demande et annulation de suppression de compte), `app.json` : `ios.buildNumber`,
`ITSAppUsesNonExemptEncryption=false`, `supportsTablet=false`, `privacyManifests`, `newArchEnabled`,
`allowBackup=false` ; `eas.json` : `appVersionSource=local` (versions tenues par `scripts/bump-version.sh`),
`EXPO_PUBLIC_API_BASE_URL` par profil (`preview` → serveur de dev, `production` → production).

Refonte (2026-11-13) : la logique pure est sortie d'`App.js` (de 1 689 à 1 468 lignes) dans `src/core.js` (constantes,
helpers, erreurs, opérateurs, libellés) et `src/auth-client.js` (session, rafraîchissement, client HTTP, `fetch` et
stockage injectés) ; 9 tests `node --test` (`npm test`) couvrent le flux d'authentification (persistance séparée des
jetons et du profil, rejet d'une ancienne session admin, refresh proactif à vol unique, rejeu unique sur 401, session
vidée sur `REFRESH_REUSED`, session conservée sur coupure réseau, Idempotency-Key transmise, logout) et les helpers.
La CI exécute `npm test` puis la transformation Babel d'`App.js` et de `src/`. Alignement vérifié avec l'app native :
libellé `sending`, mot de passe 10 caractères, statut `unknown` jamais traité en succès, 410 `FEATURE_DISABLED` seul
masqué. Le build EAS n'est pas exécutable depuis l'environnement de développement (compte Expo requis) : premier
`eas build -p android --profile preview` à lancer depuis le poste avec `EXPO_TOKEN`.

Reste à faire avant la soumission : renseigner `submit.production.ios.appleTeamId` (Team ID Apple) dans `eas.json`,
produire les captures iPhone 6,7" et 6,5" depuis un build `preview`, et remplir la fiche « Confidentialité de l'app »
(mêmes réponses que la fiche Sécurité des données Google Play).

## 3. Comptes et dépenses à prévoir

| Poste | Coût | Délai |
|---|---|---|
| Google Play Console | 25 USD une fois | vérification 1 à 3 jours |
| Apple Developer Program | 99 USD / an | D-U-N-S 1 à 2 semaines pour une société |
| Expo EAS | gratuit (file lente) ou 19 USD / mois (priorité) | immédiat |
| Appareils de test | 1 Android récent, 1 iPhone | |

## Identité de l'éditeur

Dénomination, siège et RCCM à déclarer dans les consoles (statut de professionnel DSA, coordonnées de la fiche) : voir `docs/SOCIETE.md`.
