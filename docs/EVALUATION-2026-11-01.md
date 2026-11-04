# Évaluation complète C-Pay au 1er novembre 2026 et actions restantes

Version déployée : **2.7.0** (production `c-pay.global` sur 137.74.46.246, développement `dev.c-pay.global` sur
51.91.98.115). Périmètre du pilote : encaissement et retrait Mobile Money au **Congo-Brazzaville** (MTN MoMo,
Airtel Money), portail marchand, portail admin, application Android marchande.

Échelle de maturité : **A** prêt pour le pilote · **B** prêt sous réserve d'une action identifiée · **C** en
attente d'un tiers (opérateur, Apple, Google) · **D** non prêt.

## 1. Synthèse

| Composant | Maturité | Ce qui bloque ou reste |
|---|---|---|
| Infrastructure production (VPS dédié, nginx, TLS, Docker, sauvegardes, déploiement GitHub) | **A** | rien de bloquant ; hygiène des secrets à finir (§ 4) |
| Chaîne CI/CD, environnements dev/prod, branches | **B** | protéger `main` et `develop` (supprimées deux fois par erreur) ; promotion `develop` → `main` en attente (PR 33) |
| Backend API (auth, caisse, idempotence, rapprochement, capacités) | **A** | 824 tests, 40 suites ; aucun défaut ouvert |
| Intégration **MTN MoMo CG** | **B** | clés d'abonnement non saisies ; jeton jamais obtenu ; API Key à confirmer ; IP à déclarer |
| Intégration **Airtel Money CG** | **C** | UAT validé (jeton obtenu) ; identifiants de production et format réel du callback non reçus |
| Portail marchand | **A** | numéro local et référence automatique livrés (PR 31) ; premier encaissement réel non encore réalisé |
| Portail admin | **A** | compte `admin@c-pay.global` réinitialisé, comptes hérités désactivés ; 2FA à réactiver |
| Vitrine, portail porteur, partenaires | **A** / hors pilote | certificat `partners.c-pay.global` expiré, portail hors périmètre |
| Serveur de développement | **A** | opérationnel depuis le 25 octobre (base dédiée, déploiement automatique de `develop`) |
| Supervision et alertes | **D** | pile Prometheus/Alertmanager non activée en production |
| **Application Android marchande** | **B** | compile en CI, jamais installée sur un appareil réel ; pas de signature de release ; build debug pointé sur la production |
| **Application Expo (Android + iOS)** | **D** | aucun build natif jamais produit ; compte Apple et EAS absents |
| Cadre contractuel et conformité | **C** | contrats opérateurs, compte de règlement, KYB marchands, CGU |

Verdict : la plateforme peut ouvrir un **pilote interne** dès que le jeton MTN est validé et qu'un premier
encaissement Airtel réel a abouti (§ 2, actions 1 à 4). L'ouverture à des marchands réels dépend des points C
(Airtel production, listes blanches, contrats). La date du 1er novembre est tenable pour le pilote interne, pas pour
le pilote marchands.

## 2. Actions bloquantes pour le pilote interne (P0, cette semaine)

| # | Action | Qui | Détail |
|---|---|---|---|
| 1 | Clés d'abonnement MTN dans le `.env` de production, `MTN_ENV=production`, suppression de `MTN_CG_ENV` et du doublon `CAPABILITY_ENFORCE`, redémarrage de l'API | Norbert | `MTN_CG_COLL_SUB_KEY_PRIMARY`, `MTN_CG_DISB_SUB_KEY_PRIMARY` (portail MTN, Subscriptions). Test de jeton Collection et Disbursement : `HTTP 200` attendu. Un `401` différent de « missing subscription key » signifie que les deux « API Key » de 32 caractères avec ponctuation ne sont pas des API Keys MoMo |
| 2 | Marchand pilote congolais et premier encaissement Airtel réel (100 XAF, numéro local) | Norbert | admin → Marchands → « Pilote Congo » (CG, XAF) ; portail marchand → Caisse ; journal de l'API ouvert |
| 3 | Déclaration des URL de callback chez MTN et Airtel | Norbert / opérateurs | `https://api.c-pay.global/api/v1/momo/webhooks/mtn` et `…/airtel` (vérifiées joignables) |
| 4 | Promotion `develop` → `main` (PR 33 : migrations rejouables, test PGlite) | Norbert fusionne, Claude ouvre | sans suppression de `develop` |
| 5 | Protection des branches `main` et `develop` | Norbert | Settings → Branches ; empêche aussi la suppression |

## 3. Actions pour le pilote marchands (P1, avant ouverture à des commerçants)

| # | Action | Qui |
|---|---|---|
| 6 | Identifiants de **production** Airtel (`AIRTEL_CG_ENV=production`, `AIRTEL_CG_BASE_URL=https://openapi.airtel.africa` ou l'hôte fourni), `137.74.46.246` en liste blanche chez Airtel et MTN | Norbert / opérateurs |
| 7 | Exemple réel de callback Airtel (en-têtes inclus) → alignement de la vérification de signature `x-airtel-signature` si nécessaire | opérateur → Claude |
| 8 | Checklist de pilote en 9 points (`docs/GO-LIVE-CG.md` § 3.4) : encaissements MTN et Airtel, refus client, callback coupé + rapprochement, retraits, règlement J+1, export CSV, alerte `unknown` | Norbert |
| 9 | Supervision : activer `monitoring/docker-compose.monitoring.yml` sur la prod, SMTP d'alerte, test d'une alerte réelle | Claude (PR) + Norbert (SMTP) |
| 10 | `CAPABILITY_ENFORCE=enforce` après 48 h de pilote interne sans anomalie ; `CAPABILITY_PILOT_CG` retiré à l'ouverture commerciale | Norbert |
| 11 | 2FA réactivée sur `admin@c-pay.global` ; désactivation du marchand de démonstration camerounais | Norbert |
| 12 | Allowlist nginx des callbacks une fois les plages IP reçues (`docker/nginx-host/README.md`) | Norbert |

## 4. Hygiène et dette (P2, dans le mois)

- Rotation du mot de passe Cloud DB `cplus_user`, nouveau `WEBHOOK_PATH_SECRET` (valeurs exposées dans des échanges),
  révocation de l'ancien jeton GitHub, dépôt en privé, suppression des secrets de dépôt `OVH_SSH_HOST` /
  `OVH_KNOWN_HOSTS` (seuls ceux des environnements comptent).
- TLS PostgreSQL : certificat CA OVH dans `DB_SSL_CA_FILE`, retrait de `DB_SSL_REJECT_UNAUTHORIZED=false` et de
  `NODE_TLS_REJECT_UNAUTHORIZED=0` (prod et dev).
- Certificat `partners.c-pay.global` (le joker `-0002` est expiré) ou désactivation du bloc.
- `shred -u /root/cpay-migration-*.tgz` sur la prod ; retrait de l'ancienne clé `cpay_deploy` de `authorized_keys`.
- Versionner le vhost nginx de production dans `docker/nginx-host/` (seule partie d'infrastructure hors dépôt).
- Bloc `default_server` nginx fermant les connexions sur l'IP nue.
- Points backend remontés par la vague 5 et jamais traités : agrégats `GET /merchant/stats/daily`, `fees.collect` par
  moyen dans `/cash/summary`, routes admin porteurs, `refund` (501), liste/révocation de sessions marchand.

## 5. Application mobile

### 5.1 Android marchande (`android/`, Kotlin, `global.cpay.app`, 2.7.0, versionCode 2)

État : refonte Material 3 livrée en vague 5 (Caisse, Encaisser en 4 écrans, Journal, Plus, retraits et transferts
avec confirmation forte, cache hors ligne, biométrie), authentification unifiée (refresh, 2FA, mot de passe forcé),
numéro local avec pays du marchand (PR 31). **Compile en CI à chaque push** (`assembleDebug`, APK téléchargeable dans
les artefacts du run). **Jamais installée ni testée sur un appareil réel**, jamais signée, jamais publiée.

| # | Action | Qui | Délai |
|---|---|---|---|
| M1 | Installer l'APK debug du dernier run CI sur un téléphone Android et dérouler le plan de test de `docs/WAVE-5-ANDROID.md` (connexion, encaissement Airtel 100 XAF, journal, retrait) | Norbert | semaine 1 |
| M2 | Pointer le build **debug** sur `https://api.dev.c-pay.global/api/v1` (aujourd'hui sur la production) et garder la release sur `api.c-pay.global` | Claude (PR) | semaine 1 |
| M3 | Keystore de release : `keytool -genkeypair`, secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` ; sauvegarde du keystore hors serveur | Norbert | semaine 1 |
| M4 | Première release signée : `scripts/bump-version.sh 2.7.1`, tag `v2.7.1` → `release.yml` produit APK + AAB signés et la GitHub Release ; `minifyEnabled` à valider (règles ProGuard) | Claude + Norbert | semaine 2 |
| M5 | Compte Google Play Console (25 USD une fois), fiche de l'app, piste **Internal testing** avec l'AAB, puis **Closed testing** pour les marchands pilotes ; politique de confidentialité en ligne (`c-pay.global/legal/confidentialite`) | Norbert | semaine 2 à 3 |
| M6 | Compléments fonctionnels : `GET /pay/:shortId/status` dans `ApiService` (suivi des liens carte), deep link / QR de paiement, suivi des retraits `unknown`, écran « capacités » (pilote / indisponible par opérateur) | Claude (PR) | semaine 2 à 4 |
| M7 | Durcissement avant Play Store : `FLAG_SECURE` sur les écrans sensibles, pinning TLS optionnel, purge du cache à la déconnexion, `versionCode` incrémenté à chaque release | Claude (PR) | semaine 3 |

### 5.2 Expo (`mobile/cpay-mobile/`, `global.cpay.mobile`, Android + iOS)

État : code aligné sur l'authentification unifiée (vague 3), `eas.json` prêt (profils `preview` et `production`),
**aucun build natif jamais produit**, pas d'iOS possible sans compte Apple. Son périmètre recoupe l'app Android
native (encaissement, pay links, historique) et y ajoute un mode administrateur mobile.

Décision à prendre : **une seule app marchande**. Recommandation : garder l'Android native pour le pilote (plus
aboutie, testée en CI) et réserver Expo à l'iOS, ou l'abandonner si l'iOS n'est pas prioritaire avant 2027.

| # | Action | Qui | Délai |
|---|---|---|---|
| E1 | Décision iOS : oui / non / plus tard | Norbert | semaine 1 |
| E2 | Si oui : Apple Developer Program (99 USD/an) au nom de Calculus Plus, compte Expo, `EXPO_TOKEN` en secret GitHub, `eas credentials` une fois depuis un PC | Norbert | semaine 2 |
| E3 | Workflow `mobile-expo.yml` (déclenchement manuel et sur tag) : `eas build -p ios/android --profile production --non-interactive`, `eas submit` vers TestFlight optionnel | Claude (PR) | semaine 2 |
| E4 | Alignement fonctionnel Expo sur la caisse (numéro local, référence automatique, capacités) et retrait du mode administrateur mobile (surface d'attaque inutile) | Claude (PR) | semaine 3 à 4 |
| E5 | TestFlight interne puis App Store ; fiche, captures, confidentialité | Norbert | semaine 4 et suivantes |

## 6. Calendrier proposé

| Semaine | Objectif |
|---|---|
| 1 (2 au 8 nov.) | P0 1 à 5 ; pilote interne (encaissements réels MTN et Airtel UAT/prod) ; APK debug sur appareil (M1), build debug sur dev (M2), keystore (M3) |
| 2 (9 au 15 nov.) | P1 6 à 9 ; première release signée 2.7.1 (M4) ; Play Console et piste interne (M5) ; décision iOS (E1) |
| 3 (16 au 22 nov.) | P1 10 à 12 ; 5 marchands pilotes sur l'app Android (Closed testing) et le portail ; M6, M7 |
| 4 et suivantes | hygiène P2 ; iOS si décidé (E2 à E5) ; ouverture commerciale après 2 à 4 semaines de pilote sans incident |

## 7. Indicateurs de sortie de pilote

- 100 % des encaissements MTN et Airtel confirmés en moins de 90 s ou refusés avec motif, aucun `pending` de plus de
  10 min non résolu par le rapprochement ;
- aucun retrait resté `unknown` sans revue sous 30 min, alerte e-mail reçue à chaque cas ;
- règlement J+1 juste au centime sur 7 jours consécutifs ;
- zéro incident de sécurité (callbacks refusés légitimement journalisés, aucun accès admin non reconnu) ;
- app Android : 0 plantage sur 20 encaissements par marchand pilote.
