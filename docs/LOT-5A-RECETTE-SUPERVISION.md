# Lot 5A — recette financière et règles de supervision

## Périmètre et preuves

Ce lot complète les services existants, sans migration ni changement des règles de paiement.
Les tests utilisent PostgreSQL embarqué (PGlite) et les vrais services de caisse/finalisation.
Seules les frontières opérateur/SMTP sont simulées. Il ne s'agit pas d'une recette navigateur,
d'une preuve de raccordement GIMAC ou d'une certification opérateur.

Depuis `backend` :

```sh
npm ci
npm test -- src/tests/lot4-cash-recovery.test.js --testTimeout=60000
npm test -- --testTimeout=60000
```

Les sept nouveaux cas, regroupés sous `lot 5A`, partagent la base jetable de la suite de reprise :

| Parcours | Contrôles attendus |
|---|---|
| Encaissement en attente → confirmation → callback rejoué | Aucun crédit avant confirmation ; brut 25 000 XAF, frais 250, net disponible 24 750 ; une entrée de règlement et un événement |
| Encaissement refusé → confirmation tardive | Aucun crédit ni mise en règlement ; état terminal conservé |
| Retrait incertain → introuvable → confirmé | Brut 10 000 réservé, net opérateur 9 900, frais 100 ; disponible 14 750 ; après confirmation réservation 0 et disponible inchangé |
| Retrait incertain → introuvable → refus explicite | Réservation maintenue tant que le résultat est introuvable ; disponible rétabli à 24 750 seulement après refus |
| Timeout → nouvel ordre sans solde suffisant | Réservation du premier ordre maintenue ; le second n'atteint pas l'opérateur |
| Transfert bancaire vérifié → file manuelle → exécution | Brut 5 000 réservé, frais 50, net 4 950 ; une seule transition d'exécution ; aucune API bancaire inventée |
| Encaissement/approvisionnement CDF sur marchand XAF | Aucune augmentation du solde XAF |

Les relectures d'un retrait finalisé ne réémettent aucun paiement et n'ajoutent aucun événement.
La recette ne prétend pas tester un rejeu HTTP de POST : les tests d'idempotence durable existants
restent distincts. Les confirmations de ces cas appellent la machine de finalisation après la
frontière d'authentification du callback ; les signatures et permissions sont testées ailleurs.

## Alertes Prometheus

Les règles dans `monitoring/prometheus/alerts.yml` sont validées avec Prometheus/promtool 3.5.0,
également utilisé par un job CI dédié. Depuis `monitoring/prometheus` :

```sh
promtool check rules alerts.yml
promtool test rules reconciliation.test.yml
```

| Alerte | Condition avant temporisation | Temporisation |
|---|---|---|
| `ReconciliationMetricsMissing` | Scrape API réussi mais au moins une métrique nécessaire manque | 5 min |
| `ReconciliationNotScheduled` | Au moins un worker activé, aucun minuteur programmé | 5 min |
| `ReconciliationStalled` | Aucun succès depuis plus de 10 min ; si aucun succès depuis le démarrage, grâce de 10 min d'uptime | 5 min |
| `ReconciliationFailures` | Au moins trois échecs consécutifs sur une instance et aucun succès du groupe depuis plus de 5 min | 5 min |

Un succès récent d'une autre instance évite les faux positifs liés au verrou PostgreSQL partagé.
Les règles agrègent par `job`, `env`, `service` : **un seul groupe doit correspondre à une seule base
de rapprochement**. Pour plusieurs bases indépendantes, utiliser des jobs ou labels `service` distincts.
Les scénarios couvrent aussi reprise après incident, redémarrage, métriques partiellement absentes,
instance en attente du verrou et minuteur volontairement désactivé.

Ces seuils supposent le cycle par défaut de 120 secondes. Si `RECONCILE_INTERVAL_SECONDS` dépasse
600 secondes ou si un cycle peut durer plus de dix minutes, adapter les seuils ET leurs tests avant
activation. Un cycle bloqué est signalé par l'absence de succès. `RECONCILE_ENABLED=false` désactive
les alertes d'exécution embarquée ; un cron externe doit disposer de sa propre supervision.
L'absence de métriques reste signalée même si le minuteur est désactivé.

## Installation et livraison des notifications : limites actuelles

La présence de fichiers de configuration dans Git ne démontre pas que Prometheus, Alertmanager ou
les exporters sont déployés. Le compose applicatif ne les démarre pas. Ce lot ajoute des règles
testées, sans déployer de nouvelle infrastructure et sans modifier le réseau privé de l'admin.

**Le récepteur historique `http://api:3000/internal/alerts/prometheus` de la configuration
Alertmanager ne correspond à aucune route backend. Ne pas le considérer comme opérationnel.**
Le raccordement à un canal existant, son authentification et un test de livraison/résolution sont
à traiter dans le lot suivant. Aucune alerte n'est déclarée livrée par ce lot.
Les alertes SMTP sur opérations incertaines du lot 4 restent un mécanisme séparé.

Avant d'activer ces règles en production :

1. Vérifier le scrape `/metrics` avec son fichier secret `METRICS_TOKEN`, jamais dans une URL ou un log.
2. Charger les règles, vérifier les cibles `UP` et vérifier les expressions dans Prometheus.
3. Confirmer les groupes d'instances, le cycle réel et la présence des métriques requises.
4. Raccorder un récepteur autorisé et faire un test sans données client ni transaction financière.
5. Vérifier la réception, la résolution et les responsabilités d'intervention.

Les alertes d'âge des ordres individuels, le test réel du canal et la recette navigateur des trois
portails ne sont pas compris dans les preuves automatisées de ce lot.

## Recette manuelle app / marchand / admin (environnement de test)

Utiliser uniquement des comptes de recette et des connecteurs sandbox confirmés. Ne jamais réémettre
une opération réelle pour provoquer un timeout. Aucune activation de pays ou corridor n'est nécessaire.

1. Relever le commit déployé, la devise, les soldes initiaux et l'identifiant de l'ordre de test.
2. App : créer un encaissement de test ; vérifier l'état en attente, puis la confirmation/refus réel
   du simulateur. Une actualisation doit conserver le même ordre et le même résultat.
3. Marchand : comparer brut, frais, net et solde aux valeurs de la matrice ; vérifier le message
   « fonds réservés » d'un retrait incertain et actualiser ce même ordre. Un nouvel ordre est une
   intention distincte, jamais une technique de reprise.
4. Admin, via le VPN prévu : ouvrir Caisse et vérifier `/api/v1/admin/cash/reconcile/status` avec un
   compte ops/super-admin. Attendre un cycle, puis contrôler les trois étapes, `lastSuccessfulAt`
   et `consecutiveFailures`. Une instance qui attend le verrou doit être distinguée de l'exécutante.
5. Vérifier les files incertaines/à examiner, l'absence d'action de rejet forcé et l'historique final.
6. Documenter résultats attendus/observés, identifiants de test et captures expurgées ; ne pas inscrire
   de secrets, PAN/CVV, comptes bancaires complets ou données personnelles dans la PR.

## État de l'audit

Les anciens rapports restent des instantanés de leurs versions. Les lots 1 à 4 ont livré la
suspension de flux historiques risqués, l'idempotence durable, les contrôles de comptes bancaires
et la reprise des résultats incertains. Ce lot renforce leur vérification, sans certifier l'ensemble
de la plateforme. La validation authentifiée du worker en production reste à recueillir côté VPN ;
les accès opérateurs réels, la livraison des alertes et la recette navigateur restent à confirmer.
