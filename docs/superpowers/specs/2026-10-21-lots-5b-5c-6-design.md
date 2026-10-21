# PR commune — lots 5B, 5C et 6

## Objectif validé

Livrer dans une seule PR le raccordement des alertes, une recette navigateur des trois portails
et un audit résiduel avec corrections ciblées. Des commits distincts permettent de relire chaque
lot. Base de départ : `72dc6f7aa38846e3149e0806a884e02bec4f570c` (lot 5A fusionné et déployé).

Le périmètre de lancement reste les six pays de la CEMAC et la RDC. Aucune activation de GIMAC,
de nouvel opérateur, de corridor ou de retrait carte n'est incluse.

## Conception retenue

La solution réutilise Alertmanager et le SMTP existant comme capacités, sans créer un nouveau
service applicatif de notification. Une recette navigateur isolée complète les tests SQL existants,
sans présenter des réponses API simulées comme une validation financière de bout en bout.
L'audit vérifie le code actuel et corrige les risques reproductibles dans les parcours concernés.

Alternatives écartées : créer un webhook backend supplémentaire ajouterait une authentification,
une gestion des reprises et un historique à maintenir ; tester directement en production ferait
dépendre la CI du VPN, des opérateurs et de données réelles. Ces deux approches ne sont pas retenues.

Les trois sous-projets sont décrits séparément pour pouvoir les implémenter et valider indépendamment :

- [5B — livraison des alertes](2026-10-21-lot5b-alert-delivery-design.md).
- [5C — recette navigateur](2026-10-21-lot5c-browser-recipe-design.md).
- [6 — audit résiduel](2026-10-21-lot6-residual-audit-design.md).

## Contraintes communes

- Aucun paiement, email, SMS ou message réel pendant les tests.
- Aucun secret, PIN, PAN/CVV, jeton d'accès ou contenu de `.env` dans les artefacts.
- Une seule PR, commits par lot ; aucune fusion ni activation de production par cette implémentation.
- Tests locaux et CI requis ; les corrections financières doivent avoir un test de régression.
- Les accès VPN/opérateurs indisponibles sont signalés comme non vérifiés, jamais comme réussis.
- Versions des outils verrouillées ; pas de mise à niveau majeure opportuniste.
- Les scripts de test écoutent uniquement sur loopback et refusent les cibles de production.

## Critères de livraison

1. La configuration Alertmanager est validée et un simulateur SMTP local reçoit un déclenchement
   puis sa résolution ; les erreurs TLS/authentification échouent visiblement.
2. Les vrais builds app/cardholder, merchant et admin sont exercés par navigateur, sans réseau externe.
3. Les intentions de paiement app survivent à un rechargement après réponse perdue, sans nouveau débit.
4. Les labels de métriques n'exposent plus de chemins secrets ou d'identifiants fournis par l'utilisateur.
5. Le rapport d'audit distingue corrigé, ouvert, non reproduit et non vérifiable, avec preuves et versions.
6. Backend, tests des portails, builds, promtool, validation Alertmanager et recette navigateur passent.

## État de cette conception

Le regroupement et cette conception écrite ont été approuvés dans la conversation. Les plans sont
disponibles pour revue avant exécution :

- [Lot 6 — corrections et audit](../plans/2026-10-21-lot6-residual-audit.md).
- [Lot 5B — livraison des alertes](../plans/2026-10-21-lot5b-alert-delivery.md).
- [Lot 5C — recette navigateur](../plans/2026-10-21-lot5c-browser-recipe.md).

Ordre recommandé : corrections de reprise/métriques du lot 6, lot 5B, lot 5C, puis clôture du rapport
d'audit et validation globale. Le lot 5B est indépendant des corrections frontend ; la recette 5C
doit tester le comportement app corrigé. Aucun code de produit, aucune dépendance et aucun outil de
recette n'ont été modifiés à ce stade.
