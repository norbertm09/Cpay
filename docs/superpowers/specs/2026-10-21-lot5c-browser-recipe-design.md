# Lot 5C — recette navigateur app, marchand et admin

## Objectif et approche

Ajouter une recette Playwright Chromium des vrais builds React `portal/cardholder` (app web),
`portal/merchant` et `portal/admin`. Cette recette teste le comportement visible et les requêtes
émises ; les services financiers restent couverts séparément par les tests SQL du backend.
L'application Android native n'est pas incluse dans cette recette navigateur.

Des serveurs statiques locaux servent les builds avec repli SPA. Un simulateur d'API déterministe
ou les interceptions du navigateur utilisent les contrats réels des services frontend. Tout appel
externe non prévu échoue : aucune cible `c-pay.global`, aucun accès VPN et aucune transaction réelle.

## Scénarios minimaux

| Portail | Parcours et assertions |
|---|---|
| App/cardholder | Connexion et accès protégé ; paiement confirmé ; erreur explicite ; réponse perdue puis rechargement et reprise avec la même intention ; aucun PIN/jeton dans le stockage de l'intention |
| Merchant | Retrait ou transfert incertain : fonds réservés ; actualisation du même identifiant par GET ; confirmation ou refus ; pas de POST de paiement supplémentaire lors du refresh |
| Merchant | Nouvelle opération explicite seulement après traitement de l'intention précédente ; isoler les sessions/utilisateurs et les erreurs de stockage |
| Admin | Connexion ; files incertaines/à examiner ; santé du rapprochement ; détail affichant les réservations ; absence d'action de rejet forcé sur résultat incertain |
| Tous | API indisponible : erreur visible et possibilité de reprise ; aucune confirmation fictive ; accès protégé sans session |

Les assertions portent sur les montants, statuts et nombres/identités de requêtes, sans dépendre
d'un grand nombre de détails CSS. Les scénarios restaurent un état propre à chaque test et ne partagent
pas de contexte navigateur. Les jeux d'essai utilisent des identités et références fictives.

## Intégration et limites

Ajouter le runner et son lockfile dans un répertoire de recette dédié, sans ajouter Playwright aux
dépendances de production des portails. Le job CI utilise les builds correspondant au commit testé,
installe une version verrouillée du navigateur et conserve rapport/traces seulement en cas d'échec.
Les traces ne contiennent que les comptes fictifs et ne sont jamais produites contre la production.

L'app/cardholder n'a actuellement pas de script `test`. Ajouter les tests unitaires utiles aux
corrections de reprise, en conservant CRA pour ce lot. Ne pas migrer les trois portails vers un autre
bundler. Les tests simulés ne constituent pas une preuve d'authentification opérateur ou de comptabilité
réelle ; le rapport associe ces résultats aux preuves SQL distinctes.

## Validation

La commande locale unique prépare les serveurs, lance Chromium et nettoie les processus même en cas
d'échec. Les ports sont explicites et les collisions échouent clairement. Tester au moins un retour
direct sur une route SPA, une expiration de session et un rechargement pendant une réponse incertaine.
Le job doit échouer si une API non simulée est appelée ou si un second ordre est émis lors d'une reprise.
