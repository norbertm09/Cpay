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
dans le run que l'étape de signature n'affiche pas « non signés ». Première release : contrôler que `minifyEnabled`
ne casse rien (installer l'APK universel signé et refaire le plan de test).

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

### 2.4 À faire côté code avant la soumission iOS (PR à venir)
- Aligner l'app Expo sur la caisse actuelle (numéro local sans indicatif, référence automatique, états de capacité).
- Retirer le mode administrateur mobile (surface d'attaque inutile pour une app marchande publique).
- Écran « Confidentialité / Supprimer mon compte » exigé par Apple et Google.

## 3. Comptes et dépenses à prévoir

| Poste | Coût | Délai |
|---|---|---|
| Google Play Console | 25 USD une fois | vérification 1 à 3 jours |
| Apple Developer Program | 99 USD / an | D-U-N-S 1 à 2 semaines pour une société |
| Expo EAS | gratuit (file lente) ou 19 USD / mois (priorité) | immédiat |
| Appareils de test | 1 Android récent, 1 iPhone | |
