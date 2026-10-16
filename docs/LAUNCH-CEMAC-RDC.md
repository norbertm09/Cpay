# Périmètre initial : CEMAC et RD Congo

Périmètre confirmé : Cameroun, République centrafricaine, République du Congo, Gabon, Guinée équatoriale et Tchad (CEMAC, XAF), plus République démocratique du Congo (CDF). Il s’agit de sept pays. Sénégal et Côte d’Ivoire sont hors lancement ; les connecteurs historiques ne sont pas supprimés par cette modification éditoriale.

Trois familles de moyens : cartes bancaires, opérateurs de monnaie mobile et GIMAC/GIMACPAY. Encaissement, retrait et transfert sont les opérations visées ; un moyen ou un corridor ne doit être présenté comme disponible qu’après activation et validation du partenaire concerné. QR et liens sont des parcours d’accès à ces moyens, pas de nouvelles familles de paiement.

## Écarts techniques identifiés

- `backend/src/services/detection/detection.engine.js` ne définit actuellement dans ce périmètre que CM, CG et CD. CF, GA, GQ et TD ne sont pas encore intégrés. Ne pas confondre la liste commerciale des pays et la disponibilité réelle des opérateurs.
- `backend/src/services/gateways/gimac.gateway.js` contient un TODO et lève une erreur : aucune connexion GIMAC opérationnelle n’est démontrée dans ce dépôt. Avant activation, obtenir les spécifications et accès officiels du partenaire, implémenter les appels/callbacks et tester encaissement, retrait, transfert et rapprochement.
- Les retraits carte ne sont pas pris en charge par l’orchestrateur général ; ne pas annoncer leur disponibilité générale.
- Les parcours de transferts et de bénéficiaires actuels restent ceux du code ; la présente PR ne raccorde pas les banques à GIMAC et ne crée pas de nouveaux flux financiers.
- Les listes de pays d’inscription, règles KYB, devises, routage et configurations doivent être mises en cohérence et validées pour CF/GA/GQ/TD avant ouverture réelle.

La vitrine, sa démonstration, les formulaires, les métadonnées, les textes associés et la base de connaissances de l’assistant sont alignés sur ce périmètre, avec les statuts d’intégration explicites. Le contrôle de périmètre de la démonstration ne constitue pas une restriction de l’API de paiement ni un mécanisme d’activation pays.

## Références

- CEMAC, liste officielle des six États : https://cemac.int/about/
- GIMAC, services et participants : https://gimac-afr.com/nos-services/
- GIMAC, opérations interopérables et corridors : https://gimac-afr.com/faq/

Ces sources décrivent les institutions et leurs services, pas un agrément ou une activation de C-Pay.
