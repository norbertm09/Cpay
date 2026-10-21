# Lot 6 — audit résiduel et corrections ciblées

## Méthode et périmètre

Réauditer la base déployée après le lot 5A : flux financiers/idempotence, accès et rôles, secrets et
TLS, capacités CEMAC/RDC, dépendances backend/portails, scripts de déploiement et supervision.
Chaque constat doit mentionner le commit, le chemin, la reproduction et son impact. Ne pas recopier
les verdicts de l'instantané 2.6.0 comme des constats de la version actuelle.

L'audit est en lecture seule vis-à-vis de la production. Les confirmations de rotation de secrets,
du VPN et des comptes opérateurs sont enregistrées comme preuves externes manquantes si indisponibles.

## Deux corrections à instruire en priorité

### Intention de paiement app/cardholder

Le code actuel `pages/pay/PayPage.jsx` conserve la clé dans `useRef` et crée une nouvelle clé dans
`goConfirm`. Un rechargement après réponse perdue perd cette identité. Le backend conserve déjà une
réponse par clé dans `cardholder_payment_requests` : préserver la clé côté app permet de reprendre
le même paiement sans en créer un second.

Conserver en `sessionStorage` une intention à champs autorisés : acteur, carte, marchand, montant,
description, devise et clé. Ne jamais stocker PIN, mot de passe, jetons, PAN ou CVV. L'identité est
isolée par acteur/carte/onglet, persistée avant émission ; stockage illisible ou indisponible = envoi
bloqué avec message clair. Une réponse réseau incertaine conserve l'intention. La reprise réutilise
les mêmes paramètres et la même clé, avec nouvelle saisie du PIN ; une nouvelle intention exige un
résultat connu et une action explicite. Tester changement d'acteur, double clic, rechargement,
réponse tardive, stockage corrompu et modification de paramètres.

Ne pas créer d'endpoint de consultation inventé : utiliser le contrat de rejeu existant, ou documenter
un blocage si l'analyse montre que ce contrat ne suffit pas. Vérifier la cohérence avec les deux
couches d'idempotence avant modification.

### Confidentialité des métriques HTTP

`backend/src/config/metrics.js` utilise `req.path` avec un masquage partiel UUID/nombres. Un segment
secret de webhook ou un identifiant libre peut donc rester dans le label `path` et créer une série
par valeur. Remplacer ce label par des noms/templates de routes bornés ; requête inconnue = catégorie
fixe, sans chemin brut. Préserver les montages Express sans réintroduire un préfixe dynamique secret.
Tester webhook secret, identifiant arbitraire, caractères spéciaux, query string et route inconnue.

## Dépendances et autres constats

Effectuer les audits backend et des trois portails à partir de leurs lockfiles. Corriger les
vulnérabilités reproductibles par mises à jour compatibles avec tests/builds ; distinguer dépendances
de build et code de production. Ne pas utiliser une mise à niveau forcée majeure comme résolution.
Pour une vulnérabilité sans correctif compatible, indiquer version, chemin de dépendance, exposition
et action restante. Une faille grave découverte hors de ces deux corrections doit être portée au
rapport avant d'élargir ce lot à une nouvelle architecture financière.

## Livrables et critères

- Rapport actualisé avec états : corrigé et testé / ouvert / non reproduit / non vérifiable.
- Tests de régression sur les corrections réellement appliquées ; liens vers les preuves locales/CI.
- Matrice pays/moyens distinguant annoncé, détecté, configuré, activé et validé par partenaire.
- Aucun passage en `active` d'un connecteur non validé ; aucun changement des règles financières
  CEMAC/RDC pour rendre un test vert.
- Aucun fichier secret ni sortie d'audit contenant des identifiants de production dans Git.
- Revue indépendante de l'ensemble de la PR avant publication ; backend et portails vérifiés.
