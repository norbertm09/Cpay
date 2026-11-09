# nginx hôte (reverse proxy de production)

Depuis la 2.7.0 le reverse proxy de production est le **nginx de l'hôte** (paquet Ubuntu), pas le conteneur
`nginx` de `docker-compose.yml` (profil `standalone-nginx`, conservé pour le développement). Les certificats
Let's Encrypt sont gérés par `certbot` sur l'hôte (`certbot.timer`), les conteneurs n'écoutent que sur `127.0.0.1`.

| Hôte | Cible | Notes |
|---|---|---|
| `c-pay.global`, `www.` | `root /opt/cplus/portal/landing` (statique) | CSP stricte (`snippets/cpay-security-landing.conf`), `/csp-report` relayé vers l'API |
| `api.c-pay.global` | `proxy_pass http://127.0.0.1:3001` | `/metrics`, `/internal/` bloqués publiquement ; zone de limitation sur les routes de paiement |
| `merchant.c-pay.global` | `127.0.0.1:3002` | SPA Vite (`try_files` côté conteneur) |
| `app.c-pay.global`, `card.` | `127.0.0.1:3003` | portail porteur |
| `admin.c-pay.global` | `127.0.0.1:3004` | back-office |
| `pay.c-pay.global` | `127.0.0.1:3001` (`/pay/…`) | pages de paiement hébergées |

## Fichiers

- `snippets/cpay-webhook-allowlist.conf` — allowlist `geo` des callbacks opérateurs. Installée par
  `scripts/init-vps.sh` dans `/etc/nginx/snippets/`, **inactive tant que `default 0`**. À activer dès que MTN et
  Airtel ont communiqué leurs plages d'adresses (voir `docs/OPERATEURS-A-CONFIRMER.md` § 2).
- Le vhost complet (`/etc/nginx/sites-available/cpay`) et les snippets de sécurité vivent sur le serveur ; ils sont
  transportés d'un serveur à l'autre par `scripts/vps-export.sh` → `scripts/init-vps.sh --import`. Après une
  migration, copier le vhost ici (`docker/nginx-host/cpay.conf`) pour le versionner : c'est la seule partie de
  l'infrastructure encore hors dépôt.

## Pièges connus

- `proxy_pass http://172.20.0.x:3000` (IP interne d'un conteneur) n'est pas portable : utiliser `127.0.0.1:3001`.
  `init-vps.sh` corrige automatiquement ce motif à l'import.
- Un `add_header` dans un `location` annule tous ceux hérités du `server` : toujours ré-inclure
  `snippets/cpay-security-*.conf` dans le `location` concerné.
- Après un renouvellement Let's Encrypt, nginx doit être rechargé : hook
  `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` (posé par `init-vps.sh`).

## En-têtes de sécurité des portails (lot 2, 2026-11-09)

`snippets/cpay-security-spa.conf` : HSTS, nosniff, `X-Frame-Options DENY`, `Referrer-Policy`, `Permissions-Policy` et une
**Content-Security-Policy** (`script-src 'self'`, `connect-src 'self' https://api.c-pay.global`, styles inline tolérés,
`frame-ancestors 'none'`). À inclure dans chaque bloc `server` des portails (`admin.`, `merchant.`, `app.`, `card.`,
`partners.`, `bank.`, `agency.`, `agent.`) :

```nginx
include snippets/cpay-security-spa.conf;
```

Les conteneurs portails posent déjà la même CSP (`docker/nginx-spa.conf`, origine de l'API injectée au build par
`Dockerfile.portal`). Sur le serveur de développement, remplacer `https://api.c-pay.global` par `https://api.dev.c-pay.global`.
