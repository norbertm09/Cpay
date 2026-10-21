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
puis démontrent : email firing suivi d'un resolved, certificat inconnu rejeté, refus SMTP temporaire
suivi d'une livraison après reprise. Les fichiers privés et processus sont nettoyés en fin de test.
Les adresses `example.test` ne reçoivent aucun email externe.

`ALERTMANAGER_BIN` et `AMTOOL_BIN` peuvent désigner les binaires de cette même version déjà installés.
Un outil manquant fait échouer la recette ; aucun test de livraison n'est ignoré silencieusement.
La CI exécute les mêmes vérifications en complément des règles et scénarios promtool du lot 5A.

## Activation et retour arrière

1. L'exploitant confirme le relais STARTTLS, le destinataire ops et les fichiers secrets.
2. Valider la configuration générée avec `amtool` et les règles avec `promtool`.
3. Confirmer que Prometheus/Alertmanager sont effectivement déployés et que le scrape protégé est `UP`.
   Le compose applicatif et `scripts/deploy.sh` ne les activent pas automatiquement.
4. Charger la configuration validée par le mécanisme d'exploitation retenu. Une notification réelle
   de test doit être explicitement autorisée, reçue et résolue avant de déclarer le canal opérationnel.
5. Conserver la dernière configuration valide pour revenir en arrière. Une configuration qui ciblait
   le webhook inexistant ne constitue pas un retour arrière fonctionnel ; en l'absence de canal valide,
   signaler l'indisponibilité et utiliser la procédure d'astreinte existante.

La livraison locale ne prouve pas les identifiants SMTP de production. SMTP reste une garantie de
reprise : un arrêt après acceptation mais avant enregistrement peut conduire à une notification répétée.

Référence : https://prometheus.io/docs/alerting/latest/configuration/
