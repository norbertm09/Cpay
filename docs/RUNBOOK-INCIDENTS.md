# Runbook incidents — C-Pay 2.7

Procédures courtes, à suivre dans l'ordre, pour les deux incidents rencontrés en novembre 2026. Les commandes se
lancent sur le serveur de production (`/opt/cplus`, utilisateur `deploy`) sauf mention contraire. Aucune commande
ci-dessous n'affiche de secret ; ne jamais coller `backend/.env` ou un jeton dans un ticket ou un chat.

## 1. Portails en 502 (admin, marchand, porteur, partenaires)

Symptômes : `https://app.c-pay.global` (ou `admin`, `card`, `partners`) répond `502 Bad Gateway` ; l'API
(`https://api.c-pay.global/health`) répond normalement. Cause vue le 2026-11-10 : conteneurs nginx des portails en
boucle de redémarrage (`Restarting (1)`) après un déploiement.

### 1.1 Diagnostic (2 minutes)

```sh
cd /opt/cplus
./scripts/healthcheck-prod.sh                       # API, vitrine, 4 portails (admin : 200 ou 403 acceptés)
cd docker && docker compose ps                      # colonne STATUS : « Up » attendu, « Restarting » = incident
cat web-router/active/active.conf                   # couleur active des portails (blue | green)
docker logs --tail 30 cplus-merchant-blue           # ou -green ; idem cplus-admin-*, cplus-cardholder-*, cplus-partners-*
docker logs --tail 30 cplus-web-router              # routeur qui tient 127.0.0.1:3002-3005
```

Depuis la bascule bleu/vert (novembre 2026), un déploiement ne remplace plus un portail en service : la nouvelle
couleur doit servir `index.html` avant la bascule, sinon le déploiement s'arrête en laissant l'ancienne couleur en
ligne. Un 502 après déploiement vient donc plutôt du routeur (`cplus-web-router` arrêté) ou du vhost hôte.

- `Restarting (1)` + message nginx `permission denied` / `nginx -t` en erreur : image cassée → § 1.2.
- `cplus-web-router` absent ou `Restarting` : `cd /opt/cplus/docker && docker compose up -d web-router`, puis
  `docker logs cplus-web-router` (configuration `web-router/default.conf`, fichier `active/active.conf` présent ?).
- `Up` mais 502 : le reverse proxy hôte ne joint plus le port (`3002`-`3005`) → `sudo nginx -t`,
  `sudo systemctl reload nginx`, puis `curl -sI http://127.0.0.1:3002/` ; si le port répond, l'incident est côté
  vhost hôte (`/etc/nginx/sites-available/cpay`).
- `Up` et `curl 127.0.0.1:3002` répond 200 mais le site public 502 : certificat / vhost / pare-feu — vérifier
  `sudo certbot certificates` et `sudo ufw status`.

### 1.2 Rétablissement : rollback (moins d'une minute)

```sh
cd /opt/cplus && ./scripts/deploy.sh --rollback
./scripts/healthcheck-prod.sh
```

Le rollback redémarre les images du commit précédent sans reconstruction (étiquettes `<VERSION>-<sha12>`, récupérées
depuis GHCR si elles ont été purgées). Les migrations ne sont pas annulées (schéma compatible ascendant). Si
`healthcheck-prod.sh` reste en échec après le rollback, l'incident n'est pas lié au déploiement : revenir à § 1.1.

### 1.3 Redéploiement du correctif

Depuis le 2026-11-10, `deploy.sh` échoue (code non nul, message `PORTAILS_KO`) si un portail ne répond pas après
`compose up`, et `deploy.yml` vérifie les quatre portails en HTTPS : un déploiement « réussi » avec un portail en
boucle n'est plus possible. La CI démarre chaque image portail sans root ni capacité avant de la publier.

1. Corriger sur une branche, PR vers `main`, attendre la CI verte (job `docker`).
2. Le déploiement part automatiquement (`deploy.yml` après CI verte) ; sinon `workflow_dispatch` avec la référence.
3. Vérifier : `./scripts/healthcheck-prod.sh` puis le portail dans un navigateur (connexion + une page métier).

### 1.4 Ce qu'il ne faut pas faire

- Ne pas relancer `docker compose up -d --force-recreate` en boucle : si l'image est cassée, le conteneur redémarrera
  encore. Rollback d'abord, correction ensuite.
- Ne pas modifier les Dockerfiles directement sur le serveur : la prochaine CI écraserait la correction.

## 2. Ordre de paiement sortant incertain (« décision Finance »)

Contexte (audit du 10 novembre, § 2) : un retrait / transfert vers Mobile Money est `sending`, `processing` ou
`unknown` ; l'API de l'opérateur n'a pas confirmé ni refusé (coupure pendant l'envoi, délai dépassé). Le solde du
marchand est réservé ; aucun second envoi n'est possible tant que l'ordre n'est pas résolu.

### 2.1 Ce que fait le système seul

- Balayage automatique (`sweepUncertainPayouts`) : relance le statut auprès de l'opérateur ; un envoi interrompu avant
  réponse est marqué `interrupted_before_response` / `interrupted_in_grace` et passe en **revue** après le délai de
  grâce. Une réponse tardive de l'opérateur produit l'évènement `late_operator_response` et résout l'ordre.
- Courriel d'alerte ops (`email.service`) quand un retrait reste `processing` / `unknown` au-delà du délai configuré ;
  pas d'alerte Prometheus dédiée à ce jour (à ajouter avec les métriques caisse).

### 2.2 Résolution manuelle (rôle `finance_admin`, `ops_admin` ou `super_admin`)

Dans le portail admin : **Opérations → Caisse (`/operations/caisse`) → ouvrir l'ordre → « Décision Finance »**
(bouton présent seulement si l'ordre est résoluble). Ou par l'API :

```sh
POST /api/v1/admin/cash/transfers/<id>/resolve
{ "outcome": "completed" | "failed", "evidence": "<référence opérateur ou relevé>", "note": "<explication>" }
```

Règles :

1. **Preuve d'abord** : relevé du compte opérateur (portail MTN / Airtel / Orange / Wave) ou référence de transaction.
   `evidence` (4 caractères minimum) est obligatoire et conservé dans l'historique de l'ordre (évènement
   `finance_decision` : auteur, décision, preuve, note, statut d'origine).
2. `completed` : l'argent est bien parti → le solde réservé est consommé, l'ordre passe `completed`.
3. `failed` : l'opérateur confirme qu'aucun paiement n'a eu lieu → le solde est libéré, le marchand peut recommencer.
4. Ne jamais résoudre `failed` sur un simple délai : si l'opérateur ne sait pas répondre, laisser en revue et
   escalader au support opérateur. Un `failed` erroné suivi d'un nouvel envoi = double paiement.
5. Après résolution, vérifier dans l'ordre que l'évènement `finance_decision` apparaît avec la preuve. Un 409
   `INVALID_STATUS` signifie que l'ordre a changé entre-temps (réponse tardive de l'opérateur) : recharger avant
   de décider.

### 2.3 Rapport

Chaque décision manuelle est notée dans le journal des incidents (date, identifiant d'ordre, opérateur, décision,
preuve, administrateur). Les ordres en attente de décision : `GET /api/v1/admin/cash/transfers?status=uncertain`
(alias couvrant `pending`, `sending`, `processing`, `unknown`) ; l'historique de chaque ordre garde l'évènement
`finance_decision`.

## 3. Rappels transverses

- Sauvegardes : `scripts/backup-db.sh` (chiffrées `age`, copie distante) ; restauration de test :
  `scripts/restore-test.sh`. Ne jamais restaurer en production sans sauvegarde préalable du moment.
- Journal API : `docker logs cplus-api-blue --since 10m` (ou `cplus-api-green` : la couleur active est dans
  `docker/api-router/active/active.conf`) ; les réponses 5xx ne contiennent plus le détail interne
  (reliquat 2026-11) — chercher le `requestId` renvoyé au client dans le journal.
- Supervision : Grafana / Prometheus (`docs/EXPLOITATION.md` § 3) ; alertes `APIDown`, `PostgreSQLDown`,
  `HostRebootRequired`, `BackupFailed` / `BackupStale`, certificats.
