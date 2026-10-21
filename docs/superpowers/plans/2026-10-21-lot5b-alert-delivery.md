# Lot 5B — Alert Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le récepteur inexistant par une configuration SMTP sûre et démontrer firing/resolved avec un relais local.

**Architecture:** Un générateur Node sans secret embarqué produit la configuration native Alertmanager. Un test de protocole lance le binaire officiel et un serveur SMTP STARTTLS éphémère, séparément de l'application.

**Tech Stack:** Node 22, Alertmanager/amtool 0.34.1, OpenSSL, tests Node natifs, Prometheus/promtool 3.5.0 existant.

**Spec:** `docs/superpowers/specs/2026-10-21-lot5b-alert-delivery-design.md` et contraintes communes de `2026-10-21-lots-5b-5c-6-design.md`.

## Global Constraints

- Aucun paiement, email, SMS ou message réel pendant les tests.
- Aucun secret, PIN, PAN/CVV, jeton d'accès ou contenu de `.env` dans les artefacts.
- Une seule PR, commits par lot ; aucune fusion ni activation de production par cette implémentation.
- TLS obligatoire, certificat vérifié ; autorité privée configurable. Aucun mode non vérifié en production.
- Les scripts de test écoutent uniquement sur loopback et refusent les cibles de production.
- Aucun démarrage automatique de supervision dans `scripts/deploy.sh` ; aucune route backend d'alertes à créer.

## Review Focus

- Secrets absents, vides ou fichiers illisibles : échec avant lancement, aucune valeur révélée.
- Valeurs avec guillemets, retours ligne ou métacaractères : structure de configuration intacte, pas d'interprétation shell.
- SMTP TLS implicite 465 configuré par erreur : refus explicite ; aucune rétrogradation en clair.
- Refus SMTP temporaire ou certificat non fiable : pas de faux succès ; reprise vérifiable après correction.
- Champs d'alerte excessifs/sensibles : seuls nom, sévérité, statut et résumé bornés sont envoyés.

## Task 1: Configuration native vérifiable

**Files:**
- Create: `monitoring/alertmanager/config.cjs`, `monitoring/alertmanager/config.test.cjs`, `monitoring/alertmanager/alerts.tmpl`.
- Create: `scripts/configure-monitoring.cjs`, `monitoring/monitoring.env.example`, `docs/LOT-5B-ALERTES.md`.
- Modify: `monitoring/alertmanager/alertmanager.yml`, `.gitignore`.

**Interfaces:**
- `loadMonitoringSettings(env, {readFileSync})` retourne `{smtpHost,smtpPort,smtpUser,smtpFrom,smtpTo,passwordFile,caFile,metricsTokenFile}` ou lève une erreur de configuration sans secret.
- Variables : `ALERT_SMTP_HOST`, `ALERT_SMTP_PORT` (587 par défaut, 465 refusé), `ALERT_SMTP_USER`, `ALERT_SMTP_FROM`, `ALERT_SMTP_TO`, `ALERT_SMTP_PASSWORD_FILE`, `ALERT_SMTP_CA_FILE` optionnel, `MONITORING_METRICS_TOKEN_FILE`.
- `renderAlertmanagerConfig(settings, {templateFile})` retourne un objet avec SMTP TLS vérifié, `smtp_auth_password_file`, `email_configs`, `send_resolved:true` et les temporisations existantes.
- CLI `node scripts/configure-monitoring.cjs --output <fichier>` : écrit atomiquement hors des répertoires publics, permissions 0600 lorsque supportées ; aucun `.env` backend chargé.
- Les chemins secrets sont ceux visibles par Alertmanager ; les exemples documentent les montages nécessaires.

- [ ] Écrire les tests Node : chaque variable requise absente, secret vide/illisible, port invalide/465, injection de valeurs, CA optionnelle, fichier de sortie public refusé, échec sans impression du mot de passe/token.
- [ ] Exécuter `node --test monitoring/alertmanager/config.test.cjs` ; observer le RED pour les fonctions absentes.
- [ ] Implémenter les interfaces ; sérialiser une structure JSON valide en YAML plutôt que concaténer des valeurs utilisateur. Garder les secrets par chemin, jamais par valeur dans la configuration.
- [ ] Remplacer le récepteur historique par la configuration documentée et son template limité aux quatre champs autorisés ; exemples non opérationnels sans génération explicite.
- [ ] Relancer les tests, puis `amtool check-config <configuration générée avec fixtures>` ; attendu : succès.
- [ ] Documenter configuration, chargement, secret de scrape, autorité privée, SMTP 587 versus 465, absence de déploiement automatique et retour arrière ; ignorer configuration générée, secrets et sorties de recette.
- [ ] Commit : `feat: configure native SMTP alert delivery`.

## Task 2: Preuve locale du protocole et CI

**Files:**
- Create: `scripts/fetch-alertmanager.cjs`, `monitoring/tests/smtp-fixture.cjs`, `monitoring/tests/alert-delivery.test.cjs`.
- Modify: `.github/workflows/ci.yml`, `docs/LOT-5B-ALERTES.md`.

**Interfaces:**
- Fetcher : télécharge Alertmanager et amtool 0.34.1 depuis la release officielle selon plateforme ; vérifie le fichier SHA256 officiel avant extraction dans un cache ignoré ; erreur fatale si échec.
- `startSmtpFixture({cert,key,transientRejects})` retourne `{port,messages,close}` ; serveur loopback uniquement, STARTTLS et AUTH de test, aucune connexion SMTP sortante.
- Test : utilise `ALERTMANAGER_BIN`, `AMTOOL_BIN`, `OPENSSL_BIN` ou les outils préparés. Génère une CA éphémère et un certificat localhost dans un répertoire temporaire.

- [ ] Écrire un test d'intégration qui lance la vraie configuration, poste une alerte à l'API locale `/api/v2/alerts`, vérifie firing puis resolved dans `messages` et les champs permis. Un POST d'alerte seul n'est pas une preuve de livraison.
- [ ] Ajouter les cas : certificat non fiable, CA approuvée, refus SMTP temporaire puis reprise ; vérifier aussi l'absence de champs secrets et la borne du résumé. Chaque cas doit produire une assertion de succès ou d'échec explicite, jamais un skip silencieux.
- [ ] Implémenter le relais de test avec les modules Node `net`/`tls`, et le lancement des binaires ; délais bornés, logs expurgés, nettoyage `finally`, `windowsHide:true` pour les processus Windows. Les temporisations accélérées ne concernent que la configuration de recette.
- [ ] Exécuter `node --test monitoring/tests/alert-delivery.test.cjs` ; attendu : tous les scénarios passent sans SMTP externe.
- [ ] Étendre le job CI monitoring avec Node 22, téléchargement vérifié, tests de configuration et de livraison ; conserver les tests promtool existants. Aucune dépendance à un secret GitHub de production.
- [ ] Commit : `test: verify alert firing and resolution over local SMTP`.

## Livraison

- [ ] Revue du diff et vérification locale fraîche des deux commandes Node et de promtool.
- [ ] Dans la PR, distinguer livraison locale démontrée et SMTP/pile de production non activés.
