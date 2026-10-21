# Lot 5B — livraison des alertes par SMTP

Les alertes utilisent le récepteur natif email d'Alertmanager 0.34.1. L'ancien webhook interne
inexistant est retiré. La configuration fournie dans Git est une référence volontairement incomplète :
générer une configuration privée avant de charger le service. Ce lot ne démarre aucune supervision
en production et ne transmet aucun email réel pendant ses vérifications.

## Configuration et secrets

Les noms et exemples figurent dans `monitoring/monitoring.env.example`. Fournir les variables à
l'environnement du générateur, séparément de `backend/.env` ; ce dernier n'est jamais chargé.

| Variable | Contenu |
|---|---|
| `ALERT_SMTP_HOST` | Nom du relais STARTTLS ou IPv4 |
| `ALERT_SMTP_PORT` | 587 par défaut ; 465 refusé (TLS implicite incompatible avec cette configuration) |
| `ALERT_SMTP_USER` | Identifiant SMTP |
| `ALERT_SMTP_FROM`, `ALERT_SMTP_TO` | Une adresse simple d'expéditeur et une adresse ops, sans nom d'affichage |
| `ALERT_SMTP_PASSWORD_FILE` | Fichier privé contenant le mot de passe SMTP |
| `MONITORING_METRICS_TOKEN_FILE` | Fichier privé contenant le token du scrape API |
| `ALERT_SMTP_CA_FILE` | Certificat PEM d'une autorité privée, si nécessaire |

Les fichiers secrets doivent être UTF-8 sans BOM, privés, lisibles par leur consommateur. Ne pas
les écrire dans Git, dans un build React, dans un répertoire public ni dans les logs. Utiliser les
fichiers/secrets de l'exploitant ; ne pas copier le token API dans une URL. La configuration générée
référence seulement les chemins. Les chemins doivent exister dans l'environnement d'exécution
d'Alertmanager ; en conteneur, prévoir les montages correspondants et le template au même chemin.
La validation de présence ne remplace pas les permissions du système hôte.

Depuis la racine du dépôt, avec les variables déjà définies :

```sh
node scripts/configure-monitoring.cjs --output monitoring/generated/alertmanager.next.yml
amtool check-config monitoring/generated/alertmanager.next.yml
```

Le générateur refuse de remplacer un fichier existant. Il publie atomiquement un nouveau fichier,
avec permissions 0600 lorsque le système les prend en charge. Sur Windows, vérifier également les
ACL du dossier privé. Le TLS est obligatoire et le certificat est vérifié ; aucune option ne permet
`insecure_skip_verify`. Une CA manquante/invalide doit être corrigée, jamais contournée.

Les délais de production restent : regroupement 30 s, intervalle de groupe 5 min, répétition 4 h.
Le message ne reprend que statut, nom de l'alerte (80 caractères), sévérité (24) et résumé (240).
Les autres labels/annotations, détails d'ordre et références privées ne sont pas inclus.

## Recette locale reproductible

Prérequis : Node 22, `tar`, OpenSSL. Windows peut utiliser l'OpenSSL de Git ; sinon définir
`OPENSSL_BIN`. Le téléchargement officiel est figé et son SHA256 est contrôlé avant extraction.

```sh
node scripts/fetch-alertmanager.cjs
node --test monitoring/alertmanager/config.test.cjs
node --test monitoring/tests/alert-delivery.test.cjs
```

Les tests créent une clé et un certificat temporaires, leur propre configuration OpenSSL et un
SMTP loopback sans transfert sortant. Ils lancent le vrai Alertmanager et `amtool check-config`,
puis démontrent : email firing suivi d'un resolved, certificat inconnu rejeté, identifiants refusés
(`535`, vague 7) et refus SMTP temporaire suivi d'une livraison après reprise. Les fichiers privés et
processus sont nettoyés en fin de test.

Scénario `535` (mauvais identifiant ou mot de passe) : le fichier mot de passe contient une valeur
fausse ; le fixture répond `535 Authentication failed` à chaque `AUTH` (après STARTTLS uniquement).
Comportement attendu et vérifié : aucun message livré, aucun repli en clair, erreur explicite dans
le journal d'Alertmanager (texte `535`, jamais le secret), compteurs
`alertmanager_notification_requests_failed_total{integration="email"}` puis
`alertmanager_notifications_failed_total{integration="email"}` incrémentés, et nouvelles tentatives
bornées par le backoff exponentiel d'Alertmanager (au plus dix `AUTH` sur cinq secondes dans la
recette, pas de boucle serrée). Un `535` ne se résout jamais seul : corriger les identifiants et
recharger la configuration. Côté backend, le même `535` est remonté par les services e-mail avec le
code `EAUTH` et sans nouvelle tentative (`backend/src/tests/wave7-smtp-fixture.test.js`).
Les adresses `example.test` ne reçoivent aucun email externe.

`ALERTMANAGER_BIN` et `AMTOOL_BIN` peuvent désigner les binaires de cette même version déjà installés.
Un outil manquant fait échouer la recette ; aucun test de livraison n'est ignoré silencieusement.
La CI exécute les mêmes vérifications en complément des règles et scénarios promtool du lot 5A.

## Scrape Prometheus : fichier secret `metrics_token`

Le générateur (`scripts/configure-monitoring.cjs`) **valide** seulement que le fichier désigné par
`MONITORING_METRICS_TOKEN_FILE` existe et n'est pas vide ; il **ne configure pas Prometheus** et ne
monte rien. Le raccordement du scrape protégé est une étape d'exploitation distincte, décrite ici.

| Élément | Valeur | Rôle |
|---|---|---|
| `backend/.env` → `METRICS_TOKEN` | secret | `backend/src/config/metrics.js` : sans valeur, `/metrics` répond 404 ; sinon comparaison en temps constant de l'en-tête `Authorization: Bearer <token>` (403 sinon). Jamais en query string. |
| `MONITORING_METRICS_TOKEN_FILE` (hôte) | fichier privé contenant **exactement** le même token | Validé par le générateur ; c'est ce fichier qu'il faut monter dans le conteneur Prometheus. |
| `/etc/prometheus/secrets/metrics_token` (conteneur) | point de montage, lecture seule | `monitoring/prometheus/prometheus.yml`, job `cplus-api` : `authorization.credentials_file`. Prometheus lit le fichier à chaque scrape et retire les blancs de début/fin. |

Règles sur le fichier :

- une seule ligne, UTF-8 sans BOM ; un saut de ligne final est toléré (Prometheus le retire), tout
  autre caractère rend le token différent de `METRICS_TOKEN` et le scrape passe à `403` ;
- propriétaire `65534` (`nobody`, utilisateur de l'image `prom/prometheus`) en mode `0400`, ou
  groupe `65534` en mode `0440` ; jamais lisible par tous, jamais dans Git, un build, un log ni une URL ;
- rotation : changer `METRICS_TOKEN` et le fichier dans la même intervention, redémarrer l'API puis
  recharger Prometheus ; entre les deux, le scrape est `DOWN` (`APIDown` après 30 s).

Montage : `monitoring/docker-compose.monitoring.yml` (référence, non démarré automatiquement) monte
`${MONITORING_METRICS_TOKEN_FILE}` sur `/etc/prometheus/secrets/metrics_token:ro` et exécute Prometheus
sous l'uid `65534`. Avec un autre orchestrateur, reproduire ce chemin exact ou adapter
`credentials_file` dans `prometheus.yml`.

Vérification (depuis la racine du dépôt, variables du fichier privé chargées ; aucune commande
n'affiche le token) :

```sh
# 1. Même valeur des deux côtés (sortie vide = identique)
cmp <(tr -d '[:space:]' < "$MONITORING_METRICS_TOKEN_FILE") \
    <(grep '^METRICS_TOKEN=' backend/.env | cut -d= -f2- | tr -d '[:space:]"') && echo "token identique"
# 2. Fichier visible et privé dans le conteneur (propriétaire/mode, taille > 0)
docker compose -f monitoring/docker-compose.monitoring.yml --env-file <privé> exec prometheus \
  sh -c 'ls -ln /etc/prometheus/secrets/metrics_token && wc -c < /etc/prometheus/secrets/metrics_token'
# 3. Configuration valide dans le conteneur (promtool exige la présence de credentials_file :
#    le lancer sur l'hôte échoue si /etc/prometheus/secrets/ n'y existe pas)
docker compose -f monitoring/docker-compose.monitoring.yml --env-file <privé> exec prometheus \
  promtool check config /etc/prometheus/prometheus.yml
# 4. L'API accepte le token du fichier : 200 attendu (403 = token différent, 404 = METRICS_TOKEN absent)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $(tr -d '[:space:]' < "$MONITORING_METRICS_TOKEN_FILE")" http://127.0.0.1:3001/metrics
# 5. Cible UP côté Prometheus
curl -s http://127.0.0.1:9090/api/v1/targets \
  | jq -r '.data.activeTargets[] | select(.labels.job=="cplus-api") | "\(.health) \(.lastError)"'
```

Un `403` au point 4 ou `down` au point 5 avec `server returned HTTP status 403` signifie un token
différent (espaces, guillemets, BOM, rotation partielle) ; `404` signifie que l'API n'a pas de
`METRICS_TOKEN`. Ne jamais contourner en passant le token en query string ou en désactivant l'auth.

## Activation et retour arrière

1. L'exploitant confirme le relais STARTTLS, le destinataire ops et les fichiers secrets.
2. Valider la configuration générée avec `amtool` et les règles avec `promtool`.
3. Confirmer que Prometheus/Alertmanager sont effectivement déployés et que le scrape protégé est `UP`
   (section « Scrape Prometheus » ci-dessus). Le compose applicatif et `scripts/deploy.sh` ne les activent
   pas automatiquement ; `monitoring/docker-compose.monitoring.yml` est une référence à valider.
4. Charger la configuration validée par le mécanisme d'exploitation retenu. Une notification réelle
   de test doit être explicitement autorisée, reçue et résolue avant de déclarer le canal opérationnel.
5. Conserver la dernière configuration valide pour revenir en arrière. Une configuration qui ciblait
   le webhook inexistant ne constitue pas un retour arrière fonctionnel ; en l'absence de canal valide,
   signaler l'indisponibilité et utiliser la procédure d'astreinte existante.

La livraison locale ne prouve pas les identifiants SMTP de production. SMTP reste une garantie de
reprise : un arrêt après acceptation mais avant enregistrement peut conduire à une notification répétée.

Référence : https://prometheus.io/docs/alerting/latest/configuration/
