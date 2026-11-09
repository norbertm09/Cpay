# C-Pay Mobile (Expo)

Application mobile Android et iOS de la plateforme **C-Pay** (éditeur : Calculus Plus SAS).
Version 2.7.1 — Expo SDK 54 / React Native 0.81 (lot 5 de l'audit 2026-11-02), alignée sur la caisse marchande (docs/CAISSE-API.md).

Identifiants de bundle : `global.cpay.mobile` (iOS et Android), scheme `cpay`.

## Fonctions

- Connexion marchand (email / téléphone + mot de passe), 2FA TOTP, changement de mot de passe forcé. **Application marchande uniquement** : le mode administrateur a été retiré (lot 5).
- Self-registration marchand.
- Encaissement Mobile Money (MTN MoMo, Airtel Money) via `POST /api/v1/merchant/collect`, avec suivi du statut en attente.
- QR Code et Pay Link via `POST /api/v1/merchant/pay-links` (le QR est le rendu local de l'URL courte), partage natif, WhatsApp, SMS, copie, envoi serveur WhatsApp/SMS.
- Historique transactions et règlements, tokenisation, connecteurs CRM/compta, pilot, support.
- Compte : profil, politique de confidentialité, **suppression de compte** (demande avec délai de rétractation de 30 jours, annulable) — exigence Google Play / Apple.
- **Retrait / payout marchand** : désactivé côté serveur (410 `FEATURE_DISABLED`). L'écran affiche « Fonctionnalité en cours d'intégration ».

## Flux d'authentification

1. `POST /api/v1/merchant/auth/login` `{ emailOrPhone, password }`.
   - Réponse `200 { mfaRequired: true, mfaToken }` → écran code à 6 chiffres → `POST …/auth/2fa/validate { mfaToken, code }`.
   - Réponse session : `{ access_token, refresh_token, expires_in, user|admin, mustChangePassword }`.
2. La session (`mode`, `accessToken`, `refreshToken`, `expiresAt`, `mustChangePassword`) et le profil sont stockés dans **`expo-secure-store`** (Keychain / Keystore). `AsyncStorage` ne contient aucune donnée sensible.
3. `mustChangePassword: true` → écran de changement de mot de passe obligatoire (`POST …/auth/change-password { currentPassword, newPassword }`). Le serveur révoque alors toutes les sessions : l'app revient au login.
4. L'access token expire en 15 min (`expires_in: 900`). Le client HTTP (`apiFetch`) :
   - rafraîchit **proactivement** quand il reste moins de 60 s (`POST …/auth/refresh { refreshToken }` → nouvelle paire, rotation) ;
   - sur **401**, rafraîchit une fois puis rejoue la requête ;
   - un seul refresh en vol à la fois (vol unique) ; si le refresh échoue (`INVALID_REFRESH`, `REFRESH_REUSED`…), la session est effacée et l'app revient au login.
5. Au démarrage, la session stockée est revalidée par `GET …/auth/me`.
6. Déconnexion : `POST …/auth/logout { refreshToken }` puis effacement local.

Les réponses `410 { code: 'FEATURE_DISABLED' }` (et les routes supprimées) sont affichées comme « Fonctionnalité en cours d'intégration », jamais comme une erreur.
Un encaissement `status: 'pending'` est suivi via `GET /api/v1/merchant/collect/:id/status` toutes les 3 s pendant 90 s, puis l'écran indique « En attente de confirmation ».

## Configuration

Variable d'environnement (lue au build par Expo) :

```text
EXPO_PUBLIC_API_BASE_URL=https://api.c-pay.global
```

Valeur par défaut : `https://api.c-pay.global`. Placer la variable dans un fichier `.env` à la racine du projet ou dans l'environnement EAS.

## Développement

```bash
npm install
npm run start
```

Puis ouvrir sur Android ou iOS via Expo Go / un build de développement.

## Builds

Android (local, nécessite le SDK Android) :

```bash
npm run android
```

Android via EAS :

```bash
npm run build:android        # eas build -p android
```

iOS (macOS/Xcode en local, ou EAS Build) :

```bash
npm run build:ios            # eas build -p ios
```

Profils EAS : `preview` (distribution interne) et `production` (`autoIncrement`). Version applicative : 2.7.0, `versionCode` Android 270.

## Vérification syntaxique rapide

```bash
npx esbuild App.js --bundle --platform=neutral --loader:.js=jsx --outfile=/dev/null \
  --external:react-native --external:expo* --external:@react-native-async-storage/* --external:react-native-*
```
