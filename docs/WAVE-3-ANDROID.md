# Vague 3 — application Android native « C-Pay » (2.7.0)

Branche `wave-3`, dossier `android/` (Kotlin, package `global.cpay.app`, applicationId inchangé).
Alignement sur le contrat d'authentification unifié du backend (vagues 1-2, `docs/WAVE-2.md`,
`backend/src/middleware/auth.js`) et passe de marque « C-Pay ».

## 1. Ce qui change

### Authentification (access 15 min + refresh opaque avec rotation)
- `common/SessionManager.kt` : stocke en plus de l'access token le **refresh token** (`refresh_token`)
  et l'**échéance** de l'access (`token_expires_at`, epoch ms) dans les mêmes `EncryptedSharedPreferences`
  (`cplus_session`, AES-256-GCM). `saveTokens()` / `saveSession()` (nouvelle signature avec
  `refreshToken` + `expiresInSec`), `isAccessTokenExpiringSoon` (marge 60 s), `clearSession()` efface
  les trois (l'appairage terminal est conservé).
- `common/ApiClient.kt` réécrit :
  - `AuthInterceptor` : en-têtes (`User-Agent: CPay-Android/<version>`, `X-App-Platform`, `Accept`),
    bearer sauf sur les routes publiques (`/auth/login|register|2fa/validate|refresh|forgot-password|reset-password`),
    **refresh proactif** quand l'access expire dans < 60 s.
  - `TokenAuthenticator` (OkHttp `Authenticator`) : sur **401** dont le `code` est `INVALID_TOKEN` /
    `MISSING_TOKEN` (ou absent), rafraîchit **une seule fois** (single-flight via `ReentrantLock`,
    double vérification : si un autre appel a déjà rafraîchi, on réutilise le nouveau jeton) puis
    **rejoue** la requête avec le nouvel access. Les 401 métier (`INVALID_TOTP`, mot de passe
    incorrect…) ne déclenchent pas de refresh. Jamais de rejeu sur `/auth/logout`.
  - Refresh : `POST /<merchant|cardholder>/auth/refresh { "refreshToken": "<opaque>" }` via un client
    OkHttp dédié (sans intercepteur d'auth), réponse `{ access_token, refresh_token, expires_in }` →
    nouvelle paire stockée. Refus `400/401/403/422` (`INVALID_REFRESH`, `REFRESH_REUSED`, révocation)
    → `onSessionLost()` : session effacée, broadcast `global.cpay.app.LOGOUT`, retour à
    `ProfileSelectActivity` avec toast « Session expirée ». Erreur réseau / 429 / 5xx → **pas** de
    déconnexion (la requête échoue normalement).
  - L'ancien comportement « 401 ⇒ déconnexion immédiate » et le décodage local du JWT
    (`SecurityManager.isTokenExpired`) ne sont plus utilisés par le client.
  - `ApiClient.logout()` : `POST …/auth/logout { refreshToken }` (refresh préalable si l'access
    expire, erreurs ignorées) puis effacement local. Utilisé par `ProfileFragment`,
    `MerchProfileFragment` et `ChangePasswordActivity`.
- `common/ApiService.kt` : `merchantLogout` / `cardholderLogout` prennent un corps `RefreshRequest`,
  ajout de `merchant2FAValidate` / `cardholder2FAValidate` (`POST …/auth/2fa/validate`) et
  `merchantMe` / `cardholderMe` (`GET …/auth/me`).
- `common/Models.kt` : `AuthResponse` gagne `expires_in`, `mfaToken`, `mustChangePassword`, `error`,
  `code` (+ `hasSession`) ; nouveaux `RefreshRequest`, `MfaValidateRequest`, `ApiError { error, code,
  attemptsLeft, lockedUntil }`.
- `common/ApiErrors.kt` (nouveau) : lecture unique de `errorBody` → `ApiError`, `message()` et
  `isFeatureDisabled()`.
- `common/AuthFlow.kt` (nouveau) : `saveAndEnter()` (session → prefs → écran suivant),
  `enterApp()` (main ou changement de mot de passe forcé), `toLogin()`.

### 2FA au login
- `onboarding/LoginActivity.kt` : si le login répond `200 { mfaRequired: true, mfaToken }`, ouvre
  `TwoFAActivity` en mode `login` (extras `mode`, `mfa_token`, `user_type`, `identifier`). Sinon
  session → `AuthFlow.saveAndEnter`. Erreurs structurées (401 + `attemptsLeft`, 403 `SUSPENDED`,
  423 verrouillé, 429). Le bouton biométrique n'apparaît que si une session (access **et** refresh)
  du même profil existe. « Mot de passe oublié » transmet maintenant le bon `user_type`.
- `common/TwoFAActivity.kt` : nouveau mode `login` réutilisant la même UI (`layout_verify`) ; titre /
  sous-titre / libellé adaptés (ids ajoutés dans `res/layout/activity_2fa.xml` : `tv_2fa_title`,
  `tv_2fa_subtitle`, `tv_verify_label`). `POST …/auth/2fa/validate { mfaToken, code }` → session.
  `INVALID_TOTP` → « Code invalide », `INVALID_MFA_TOKEN` (5 min dépassées) → retour au login.
  Le mode configuration (setup/verify depuis le profil) est inchangé.

### mustChangePassword
- `common/ChangePasswordActivity.kt` + `res/layout/activity_change_password.xml` (nouveaux, déclarés
  dans le manifeste). Ouvert en mode forcé par `AuthFlow.enterApp` quand login / 2FA / inscription
  renvoient `mustChangePassword: true`, et par `SplashActivity` si `GET …/auth/me` le remonte.
  Corps `{ currentPassword, newPassword }` vers `POST /merchant/account/change-password` ou
  `POST /cardholder/profile/change-password` (alias de `/auth/change-password`). Le backend révoque
  toutes les sessions après le changement : l'app efface la session et renvoie au login du profil.
  Retour / « Se déconnecter » en mode forcé = logout.
- `ProfileFragment.changePassword()` (porteur, dans l'app) applique la même règle (reconnexion).
- `onboarding/SplashActivity.kt` : si une session existe, appelle `/auth/me` (ce qui déclenche le
  refresh si nécessaire) avant d'entrer ; panne réseau ⇒ entrée dans l'app comme avant.
- `onboarding/RegisterActivity.kt` : utilise `AuthFlow.saveAndEnter` (refresh + expiry + mustChangePassword).

### 410 FEATURE_DISABLED
- `TopUpFragment` (`/cardholder/topup`, `/cardholder/unload`) et `DisburseFragment` (`/merchant/withdraw`) :
  un 410 (ou `code: FEATURE_DISABLED`) affiche « Fonctionnalité en cours d'intégration » et désactive
  le bouton concerné. `DisburseFragment` (décaissement) utilise aussi le message structuré.
- `CollectFragment` : l'onglet NFC (`/merchant/collect/contactless`) affiche ce même message.
- Les routes GTP `cards/{id}/topup|unload` sont déclarées dans `ApiService` mais n'ont aucun appelant
  dans l'app : rien à changer. Chaîne `feature_disabled` ajoutée dans `strings.xml`.

### Marque « C-Pay » (éditeur Calculus Plus SAS)
- `strings.xml` : `app_name` = « C-Pay » (+ `app_editor`, `feature_disabled`, `session_expired`).
- Layouts : `activity_register`, `activity_qr_scan`, `activity_splash`, `fragment_profile`,
  `fragment_merch_profile` (« C-Pay v2.7.0 — Calculus Plus SAS »).
- Kotlin : User-Agent `CPay-Android/<version>`, `BiometricHelper` (« Authentification C-Pay »),
  `ReceiptActivity` (reçus / SMS / partage), tags de log `CPay`, `CPay-Security`.
- `themes.xml` + manifeste : styles renommés `Theme.CPay[.Splash|.NoActionBar]` ; `settings.gradle`
  `rootProject.name = "CPay"`. Package, applicationId, `CPlusApp.kt` et noms de fichiers de prefs /
  base Room **inchangés** (identifiants de code, pas de migration).
- `app/build.gradle` : `versionCode 2`, `versionName "2.7.0"`. URL API inchangée
  (`https://api.c-pay.global/api/v1`). Aucune dépendance ajoutée.

## 2. Tests manuels

Pré-requis : backend vague 2 déployé (`/auth/refresh` acceptant `{ refreshToken }` dans le corps).

1. **Login simple** (compte sans 2FA) : connexion → dashboard. Vérifier dans Logcat (`CPay-Auth`)
   l'absence de refresh ; attendre ~14 min (ou mettre `JWT_ACCESS_TTL` court côté backend) puis
   naviguer : un `refresh OK (expires_in=900)` doit apparaître sans retour au login.
2. **401 + rejeu** : avec un access expiré mais un refresh valide (ex. app tuée > 15 min puis
   relancée), le splash appelle `/auth/me` → refresh → entrée dans l'app.
3. **Refresh refusé** : révoquer les sessions côté serveur (changement de mot de passe depuis le
   portail, ou `revokeAll`) puis utiliser l'app → toast « Session expirée », écran de choix de profil.
   Réutiliser un ancien refresh ne doit jamais être possible (l'app ne conserve que le dernier).
4. **Single-flight** : ouvrir un onglet qui lance plusieurs requêtes en parallèle (Dashboard) avec un
   access expiré : un seul `POST /auth/refresh` dans les logs serveur, toutes les requêtes réussissent.
5. **2FA** : activer la 2FA depuis Profil → se déconnecter → se reconnecter : écran « Vérification en
   deux étapes » ; mauvais code → « Code invalide » ; bon code → dashboard ; attendre > 5 min avant de
   valider → retour au login.
6. **Mot de passe temporaire** : créer un utilisateur avec `temp_password = TRUE` → après login (ou
   2FA), écran « Nouveau mot de passe » obligatoire ; retour = déconnexion ; après changement →
   message et écran de connexion ; nouvelle connexion → dashboard direct.
7. **Logout** : Profil → Se déconnecter : `POST …/auth/logout` avec `refreshToken` (vérifier en base
   `refresh_tokens.revoked_at`), retour à l'écran de profil, appairage terminal marchand conservé.
8. **410** : Porteur → Recharger / Décharger ; Marchand → Décaisser → onglet Retrait ; Encaisser →
   onglet NFC : message « Fonctionnalité en cours d'intégration », bouton désactivé (topup/unload/retrait).
9. **Marque** : libellé du lanceur « C-Pay », reçus et SMS « C-Pay … », User-Agent
   `CPay-Android/2.7.0` dans les logs nginx.

## 3. Non vérifié ici
- **Aucune compilation** : le conteneur n'a ni SDK Android (`/opt/android-sdk` absent,
  `ANDROID_HOME` vide) ni `kotlinc`, et pas de `gradlew`. Toutes les modifications ont été relues
  manuellement (imports, ids de ressources, signatures) et les XML validés (bien formés). À faire
  avant release : `./gradlew :app:assembleRelease` + lint, puis le parcours §2 sur un appareil.
- `onBackPressed()` (déprécié en API 33+) est utilisé dans `ChangePasswordActivity` : avertissement
  de compilation uniquement.
- Les anciens refresh JWT (fenêtre `AUTH_LEGACY_REFRESH_UNTIL`) ne concernent pas l'app : une
  session 2.6.0 n'a pas de refresh stocké, l'utilisateur sera déconnecté une fois à la première
  expiration et se reconnectera.
