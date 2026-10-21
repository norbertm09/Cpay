# Lot 5C — recette navigateur isolée

Les trois interfaces React réelles sont construites depuis le même commit, puis servies sur 127.0.0.1:4311 (app), :4312 (merchant), :4313 (admin). Chromium utilise des contrats API synthétiques explicites. Tout appel externe, WebSocket ou endpoint API non déclaré fait échouer la recette. Aucun opérateur, paiement réel ou relais SMTP de production n'est appelé.

## Reproduire

Avec Node 22, installer avec `npm ci` dans `portal/cardholder`, `portal/merchant`, `portal/admin` et `e2e`. Construire chaque portail avec `REACT_APP_API_BASE_URL` vide. Dans `e2e`, exécuter `npx playwright install chromium`, puis `npm test`. Sous Linux, ajouter `--with-deps` à l'installation Chromium. Le job CI `browser-recipes` effectue ces étapes sur le commit du PR ; les builds de production gardent leur configuration habituelle.

Le lanceur possède les trois serveurs et les ferme à la fin, y compris après échec. Un port déjà occupé ou un build absent provoque un échec ; aucun serveur existant n'est réutilisé. Les captures, vidéos et traces sont désactivées pour ne pas conserver les champs d'authentification. Les identités et mots de passe de test sont factices.

## Preuves attendues

- App : succès, refus explicite, réponse perdue après effet puis rechargement/rejeu avec la même clé et un seul effet simulé, panne API, stockage bloqué, routes protégées et session expirée.
- Merchant : retrait incertain puis succès ou échec par consultation du même identifiant, une seule création, fonds réservés et solde d'en-tête actualisé ; panne du résumé avec erreur et reprise ; protection des routes et expiration.
- Admin : file inconnue et santé du rapprochement visibles, erreur API distincte d'une file vide, protection des routes et expiration.
- Barrière réseau : une origine externe et un endpoint inconnu sont effectivement bloqués.

Le hook app complète ces parcours par des tests de double clic, isolation acteur/carte, réponse tardive, stockage corrompu et nouvelle intention explicite. Les tests SQL du backend vérifient séparément l'absence de double débit. Cette recette prouve le comportement navigateur face aux réponses prévues ; elle ne constitue pas une validation de bout en bout des opérateurs, du VPN ni des bases de production.
