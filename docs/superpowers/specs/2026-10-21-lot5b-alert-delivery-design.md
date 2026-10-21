# Lot 5B — livraison des alertes

## Constat et choix

`monitoring/alertmanager/alertmanager.yml` envoie actuellement vers
`http://api:3000/internal/alerts/prometheus`, route absente du backend. Les règles du lot 5A sont
testées mais leur présence dans Git ne prouve ni déploiement de Prometheus ni livraison d'un email.

Remplacer ce récepteur par le récepteur SMTP natif d'Alertmanager. Préparer une configuration dédiée
à la supervision, sans lire ou recopier automatiquement tous les secrets du backend. La production
reste inactive tant que le responsable n'a pas configuré et activé cette supervision.

## Comportement attendu

- Configuration SMTP explicite : hôte, port STARTTLS, utilisateur, expéditeur et destinataire ops.
- Mot de passe et token de scrape fournis par fichiers secrets hors Git ; validation avant démarrage.
- TLS obligatoire, certificat vérifié ; autorité privée configurable. Aucun mode non vérifié en production.
- Ne pas supposer qu'un compte SMTP backend configuré pour TLS implicite sur 465 accepte STARTTLS.
  Un relais compatible doit être renseigné ; incompatibilité = erreur explicite, sans repli en clair.
- Alertmanager garde le regroupement, la déduplication et `send_resolved: true`.
- Aucune prétention d'envoi exactement une fois : une reprise SMTP peut produire un doublon.
- Aucun détail de transaction ou secret dans le corps du message ; nom, sévérité, état et résumé bornés.

## Artefacts et exploitation

Adapter la configuration Alertmanager ; ajouter validation/génération contrôlée et exemples sans secrets,
avec procédure de chargement et de retour à la configuration précédente. Les fichiers générés et secrets
doivent être ignorés par Git. La configuration ne doit pas être publiée par un serveur HTTP.

Une recette dédiée peut démarrer Prometheus/Alertmanager et un relais SMTP local éphémère. Elle est
séparée du compose applicatif de production et ne publie ses ports que sur loopback. Les versions sont
figées et les outils officiels vérifient la syntaxe avant le démarrage.

Cette PR ne doit pas démarrer automatiquement la supervision dans `scripts/deploy.sh`, ni envoyer
un email réel pour démontrer le raccordement. Le déploiement de la pile, ses volumes/secrets et la
confirmation d'un destinataire réel sont des actions d'exploitation explicites.

## Validation

Tester la configuration absente/incomplète, les caractères spéciaux dans les valeurs, les fichiers
secrets manquants, le certificat non fiable et une autorité privée approuvée. Le test de protocole
utilise uniquement un SMTP local : notification firing puis resolved, contenu vérifié, aucun appel
à `/internal/alerts/prometheus`. Un rejet SMTP doit être observable et une nouvelle tentative doit
pouvoir aboutir. La validation en CI ne dépend d'aucun identifiant externe.

La livraison locale démontre le protocole et le format ; l'accès SMTP de production reste non vérifié
avant un test réel séparément autorisé.
