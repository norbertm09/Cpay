# Clés SSH d'administration (publiques)

Un fichier `<nom>.pub` par poste autorisé à se connecter au serveur de production, contenant une seule ligne
`ssh-ed25519 AAAA… commentaire`. **Jamais de clé privée ici.**

À chaque déploiement, `scripts/deploy.sh` appelle `scripts/install-admin-keys.sh`, qui ajoute dans
`~/.ssh/authorized_keys` de l'utilisateur de déploiement (root aujourd'hui, `deploy` après le lot 3) les clés de ce
dossier qui n'y sont pas encore. Les clés déjà présentes ne sont ni dupliquées ni modifiées ; une clé retirée du
dossier n'est **pas** retirée du serveur (révocation à la main, ou `install-admin-keys.sh --prune`, qui ne retire
que les lignes dont le commentaire correspond à un fichier `.pub` disparu).

Pourquoi par le pipeline : quand l'accès interactif est perdu (clé jamais déposée, mot de passe désactivé), le seul
chemin fiable vers le serveur est le déploiement GitHub Actions, qui garde sa propre clé. Fusionner sur `main`
équivaut déjà à exécuter du code sur le serveur : ce mécanisme n'élargit pas la confiance, il la rend visible dans
l'historique git.

Si le déploiement tourne sous l'utilisateur `deploy` (clé de CI à commande forcée), la clé d'administration ajoutée
à son `authorized_keys` donne un shell `deploy` ordinaire (groupe docker) : utiliser alors `sudo` selon la politique
du serveur, ou déposer la clé dans le compte voulu à la main.

Historique : `norbert-pc.pub` déposée le 2026-11-11 (poste de Norbert, clé `cpay1109` générée le 2026-11-09 et jamais
installée avant la désactivation de l'authentification par mot de passe).
