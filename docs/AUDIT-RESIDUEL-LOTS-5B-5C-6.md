# Audit résiduel — lots 5B, 5C et 6

Audit du 21 octobre 2026, base `72dc6f7aa38846e3149e0806a884e02bec4f570c`, branche `codex/lots-5b-5c-6`. Le diff du PR et ses commits constituent la référence des corrections. Les anciens audits sont des instantanés historiques. Ce rapport distingue le code testé des configurations et accords partenaires non accessibles à cet audit.

## Constats et preuves

| Constat / impact | État | Correction ou action restante |
|---|---|---|
| P1 : intention app volatile, risque de recréer une clé après réponse perdue | corrigé et testé | `d41f587`, `portal/cardholder/src/hooks/usePaymentIntent.js` et `pages/pay/PayPage.jsx` : persistance avant envoi, même clé au rechargement, isolation acteur/carte/devise, aucun PIN conservé, stockage corrompu bloquant. Hook, écran, recette navigateur et tests SQL de rejeu. |
| P1 : secrets de webhook et identifiants dans les labels HTTP, cardinalité libre | corrigé et testé | `249c1b7`, `backend/src/config/metrics.js` : catégories fixes, méthodes bornées, routes inconnues `unmatched`. Reproduction Supertest avec secrets, UUID, query strings et 100 chemins inconnus, dont montages imbriqués. |
| P1 : en-tête marchand conservant 100 000 après réservation de 5 000 | corrigé et testé | `portal/merchant/src/hooks/useCashSummary.js`, `layout/AppShell.jsx` : les actualisations du résumé invalident les instances montées. Recette retrait : disponible 95 000 ; aucun second POST. |
| P1 : panne du résumé marchand sans erreur visible | corrigé et testé | `pages/caisse/Retirer.jsx` : erreur avec réessai, nouvelle émission bloquée tant que résumé indisponible. Dernier solde connu explicitement nommé dans l'en-tête. |
| P1 : receiver d'alerte non raccordé à une livraison effective | corrigé et testé localement | `84ced7e`, `1dcba2a`, `monitoring/alertmanager/` : SMTP natif STARTTLS obligatoire, certificat vérifié, secret fichier, configuration privée. Véritable Alertmanager : firing, resolved, rejet CA non fiable et réessai après refus SMTP. Activation production non vérifiable. |
| P1 : dépendances critiques signalées par npm | corrigé et testé pour les critiques mesurées | Lockfiles compatibles mis à jour sans `--force`, notamment `proxy-addr` 2.0.8. Zéro critical dans les huit mesures finales. Les autres alertes restent ouvertes. |
| P1 : Nodemailer de production conserve une alerte high | ouvert | `backend/package-lock.json` : migration majeure 10.x à préparer avec tests des emails métier. Voir notamment GHSA-6vj9-mwq6-2f5v et GHSA-v53p-9fqp-m79j. Ne pas déclarer le backend sans vulnérabilité. |
| P2 : outillage CRA et dépendances transitives vulnérables | ouvert | Migration de chaîne de build à isoler. Les portails sont servis comme fichiers statiques ; le classement npm `omit=dev` inclut CRA déclaré en dépendance et ne prouve pas une exposition de toutes ces bibliothèques au navigateur. |
| P2 : absence de lock app/admin portable | corrigé et testé | Nouveaux lockfiles et pin TypeScript 4.9.5 compatible CRA5 ; installations propres `npm ci` des quatre applications. Aucun chemin vers les modules d'un autre checkout. |
| P2 : jeton app persistant `ch_token` | ouvert | `portal/cardholder/src` conserve le jeton d'accès dans localStorage : exposition en cas de XSS. Le stockage d'intention n'y ajoute ni PIN ni jeton. Migration de session à cadrer séparément avec refresh/logout et protection CSRF. |
| TLS PostgreSQL, rotation des secrets, accès VPN et opérateurs | non vérifiable | `backend/src/config/database.js` vérifie le certificat si TLS activé, mais autorise une désactivation explicite avec avertissement. Vérifier les paramètres réels, certificats et preuves de rotation en exploitation. Aucun secret de production inspecté. |
| Rôles, IDOR et transitions financières | testé sur les cas de la suite, couverture exhaustive non vérifiable | Suites backend financières, autorisations, rapprochement et idempotence conservées. La réussite des tests ne certifie pas toutes les routes ni une configuration de production. |

## Mesures npm reproductibles

Commandes : `npm audit --json` et `npm audit --omit=dev --json`, après `npm ci`, dans chaque application. Sorties brutes conservées hors Git dans le dossier d'audit local. Un code de sortie de vulnérabilité n'est pas un échec réseau ni un résultat nul.

| Application | Toutes : critique / high / moderate / low | Omit dev : critique / high / moderate / low |
|---|---|---|
| Backend | 0 / 31 / 5 / 0 | 0 / 1 / 0 / 0 |
| App | 0 / 63 / 35 / 3 | 0 / 63 / 35 / 3 |
| Merchant | 0 / 63 / 35 / 3 | 0 / 63 / 35 / 3 |
| Admin | 0 / 63 / 35 / 3 | 0 / 63 / 35 / 3 |

Ces nombres datent de cet audit et peuvent évoluer avec les avis du registre. Les mises à jour majeures ne sont pas appliquées automatiquement.

## Sept pays et trois familles de moyens

Références de code : `backend/src/services/capabilities/registry.js`, `services/detection/detection.engine.js`, `services/gateways/gimac.gateway.js`, `middleware/capability.js`. Tous les pays ci-dessous sont annoncés dans le périmètre et reconnus par leur indicatif. Détection d'un pays ne signifie pas opérateur certifié ou paiement disponible.

| Pays / devise | Mobile money : code | Carte : encaissement | GIMAC |
|---|---|---|---|
| Cameroun / XAF | Connecteurs présents, configuration requise | Checkout générique, configuration pays requise | planned |
| Centrafrique / XAF | planned, connecteurs manquants | Même condition | planned |
| Congo / XAF | Connecteurs présents, configuration requise | Même condition | planned |
| Gabon / XAF | planned, connecteurs manquants | Même condition | planned |
| Guinée équatoriale / XAF | planned, connecteurs manquants | Même condition | planned |
| Tchad / XAF | planned, connecteurs manquants | Même condition | planned |
| RD Congo / CDF | Connecteurs présents, configuration requise | Même condition | unavailable |

Pour les sept pays, la configuration de production, l'activation effective et la validation partenaire sont **non vérifiables** ici. `active` dans le registre signifie présence de code et de configuration, pas certification partenaire. Les retraits/transferts carte sont `unavailable`. Les retraits mobile money dépendent du provider et de ses accès payout ; les transferts wallet/banque restent conditionnés par la file manuelle et les comptes de collecte actifs, sans intégration GIMAC implicite.

Les marchands historiques SN/CI restent tolérés par défaut ; pour un périmètre strict, l'exploitation doit examiner `CAPABILITY_LEGACY_ALLOW=false`. Aucune nouvelle inscription hors lancement n'est autorisée par le guard. Aucun changement silencieux des soldes ou des règles de routage n'est effectué par ce lot.

## Limites et suite

La revue indépendante a reproduit un défaut supplémentaire : après un refus PIN, une tentative corrigée dont la réponse était perdue conservait le statut « connu ». Le hook remet désormais `known:false` en stockage avant chaque envoi, sans changer la clé. Le test refus → reprise incertaine → rechargement interdit une nouvelle intention et vérifie le rejeu de la même clé.

Deux points mineurs restent ouverts : ajouter un scénario protocole SMTP `535` (mauvais identifiant/mot de passe) ; préciser dans le runbook le montage du fichier de scrape à `/etc/prometheus/secrets/metrics_token` et sa correspondance avec `METRICS_TOKEN` côté backend. Le générateur valide le fichier fourni mais ne configure pas automatiquement Prometheus.

Validation locale fraîche : backend **777/777** (36 suites), app **16/16**, merchant **46/46**, admin **25/25** ; trois builds réussis. Recette navigateur **17/17**, harnais serveur **2/2**, configuration/protocole SMTP **14/14** ; promtool valide les neuf règles et les scénarios. Un timeout backend sous builds concurrents a été suivi d'un succès isolé du guard (23/23) puis d'une suite complète 777/777, sans augmenter les délais. La validation CI réelle est publiée sur le PR, séparément de ces résultats locaux.

La recette 5C utilise les vrais builds et des API simulées strictes ; les tests SQL vérifient séparément les écritures financières. Les essais SMTP 5B emploient un récepteur local sans transfert externe. VPN, relais réel, destinataires d'astreinte, accès opérateurs et GIMAC restent à valider en exploitation. Les autres portails et applications natives ne bénéficient pas de la même recette navigateur dans ce lot.

Avant ouverture d'un rail : contrat partenaire, configuration sécurisée, tests sandbox encaissement/retrait/transfert, callbacks, rapprochement et reprise après incident. Avant activation des alertes : appliquer le runbook `LOT-5B-ALERTES.md` avec les paramètres réels. Les comptes-rendus CI et la revue du PR complètent les résultats locaux ; aucune fusion ni aucun déploiement ne découle automatiquement de cet audit.
