# Correctifs de l’audit du 16 octobre 2026

## Comportement livré

- Un résultat opérateur `pending` renvoie `success:false,pending:true,status:pending` ; seul `authorized` consomme un lien de paiement. Un index PostgreSQL limite un lien à une tentative active ; un second appel ne déclenche pas un second débit opérateur.
- Les nouvelles transactions Mobile Money et carte hébergée enregistrent les frais et le net avant tout appel au prestataire ; les callbacks complètent les valeurs absentes lors de l’autorisation. `cpay_calculate_fee` utilise les surcharges `merchant_fees` lorsqu’elles existent, sinon le barème J+1 existant par méthode et niveau KYB. Les tarifs historiques ne sont pas recalculés automatiquement.
- Les paiements app, y compris `/payment/tokenized` pour une carte interne, débitent le porteur et créditent le marchand dans le même COMMIT. Le marchand doit être actif et dans la même devise ; le montant doit être un nombre JSON valide. Le principal est crédité au marchand ; les frais porteur existants (0,5 % / 1 % pour la route tokenisée) sont distincts.
- `Idempotency-Key` (8–128 caractères) est désormais obligatoire pour ces deux paiements app. Réutiliser la même clé et le même corps lors d’une reprise réseau ; un corps différent donne 409. Le portail app transmet cette clé ; les signatures Android ont été adaptées. Les autres clients doivent être mis à jour avant réouverture.
- Les anciens appels `settleTransaction` alimentent la file J+1 commune. Leur versement instantané indépendant est supprimé pour éviter la concurrence avec les retraits. Ne pas annoncer de règlement instantané avec cette livraison.
- Retraits et J+1 partagent le verrou marchand. Les lots réservent leur net dans le solde. `cash_offset_amount` trace la part déjà consommée/réservée par la caisse : brut − frais − compensation caisse = net à verser. Un lot entièrement compensé ne provoque aucun appel opérateur. Si un retrait réservé est ensuite annulé, le solde libéré est disponible en caisse ; il n’est pas automatiquement reversé une deuxième fois par le lot existant.
- Les lots échoués restent réservés jusqu’au rapprochement manuel. Aucun rejet ne libère automatiquement des fonds dont l’issue externe peut être incertaine. Un lot soumis à un opérateur ne peut pas être rejeté manuellement par l’ancienne route Finance.
- KYB/KYC et configuration des notifications : mutations réservées à `super_admin` / `ops_admin`. Modification du bénéficiaire historique : rôle `owner`, confirmation forte et audit obligatoire.
- Validation/rejet Finance : référence ou motif obligatoire, états sources contrôlés, 404/409 adaptés, audit dans la même transaction SQL. L’export CSV utilise Axios avec le Bearer.
- Le verrou global J+1 est acquis et libéré sur la même connexion PostgreSQL. Une connexion dont le déverrouillage échoue est retirée du pool.

## Avant toute mise en production

1. Comparer le commit déployé et les modifications locales de `/opt/cplus` avec la branche de la PR. Sauvegarder le code local, `backend/.env` hors Git et PostgreSQL via le dispositif existant. Tester la restauration en préproduction.
2. En préproduction, installer les dépendances verrouillées du backend (`npm ci`), exécuter `npm test` et compiler les portails app, merchant et admin. Les tests d’intégration financiers utilisent PostgreSQL embarqué PGlite ; ils ne sollicitent ni serveur distant ni prestataire réel. Jest utilise `--experimental-vm-modules` pour ce moteur de test.
3. Exécuter `cd backend && npm run check:financial` sur une copie récente de la production. Le script est en lecture seule ; un code de sortie non nul impose un rapprochement. Il détecte notamment les doubles tentatives sur liens, nets manquants, sorties historiques incertaines, devises incohérentes et paiements app sans crédit marchand. Il ne fabrique aucune écriture de régularisation.
4. Valider les tarifs `merchant_fees`, les relevés opérateurs et les écritures de caisse existantes. Les soldes historiques ambigus, versements instantanés anciens et paiements app sans contrepartie exigent une décision financière documentée. Ne pas inventer des crédits en appliquant les tarifs actuels à tout l’historique.
5. Préparer une fenêtre de maintenance. Suspendre les entrées financières publiques et les jobs opérateurs, arrêter les anciennes API et `settlement-cron` avant la migration. Éviter tout mélange entre anciens et nouveaux workers. Le script de déploiement standard n’impose pas lui-même cette fenêtre.

## Migration et livraison coordonnée

La migration additive `backend/database/010_audit_financial_integrity.sql` ajoute la clé de réessai app, la compensation de caisse des lots, la fonction de frais et l’unicité d’une tentative active par lien. Elle ne supprime aucune donnée ni table. Les liens de lots existants sont repris uniquement depuis `settlement_queue.batch_id`.

L’index unique refusera de se créer si des liens ont déjà plusieurs transactions `pending/authorized`. Rapprocher ces cas avant de relancer la migration ; ne pas supprimer arbitrairement des transactions financières. Une autorisation ancienne avec net manquant reste à rapprocher et n’est pas automatiquement réglée.

Après approbation de la PR et choix d’un commit/tag exact, utiliser le mécanisme standard décrit dans `docs/CI-CD.md` et `scripts/deploy.sh`, pendant la maintenance. Ne pas utiliser `--skip-migrations` pour cette livraison. Il faut exécuter la migration avec la nouvelle image API avant de servir le nouveau code, puis livrer ensemble API et portail app ; le portail admin contient le téléchargement CSV corrigé. Maintenir les jobs arrêtés jusqu’à la fin des contrôles.

Relancer `npm run check:financial` avec la configuration de préproduction puis avec celle de production, sans afficher de secrets. Pour Docker, exécuter le script dans l’image API avec les variables existantes ; l’image et le nom de service dépendent du déploiement. Le code de sortie et les rapprochements opérateurs doivent être approuvés avant réouverture.

## Recette obligatoire

- App : paiement valide (un débit, un crédit marchand), mauvaise devise, marchand suspendu, plafond, PIN incorrect, montant chaîne refusé, même clé rejouée et corps différent refusé.
- Paiement public : pending ne clôture pas le lien ; callback accepté le clôture ; callback refusé ne crée aucun crédit ; doubles appels concurrents ne provoquent pas deux débits.
- Merchant : collecter, constater le net, retirer puis lancer J+1, et inversement. Le total sorti doit correspondre au net acquis. Vérifier les cas retrait en attente/annulé et lot échoué.
- Admin : support refusé sur KYB/KYC/configuration ; owner requis et step-up sur bénéficiaire ; référence de virement obligatoire ; export CSV téléchargé ; absence de faux succès pour un identifiant inconnu.
- Vérifier /health, erreurs API, journaux de règlements et relevés réels du prestataire en sandbox. Aucun test local ne remplace ces contrôles externes.

## Retour arrière

Garder les entrées financières et les jobs suspendus en cas d’anomalie. Conserver la migration additive et les nouvelles écritures ; ne pas supprimer les crédits marchands ou les clés de réessai après usage. Un retour aveugle à l’ancienne API réintroduit les défauts de double sortie et ne comprend pas la nouvelle comptabilité. Le rollback technique de `scripts/deploy.sh --rollback` doit rester en maintenance ; ne rouvrir qu’après rapprochement et choix d’une version compatible. Ne pas restaurer une sauvegarde antérieure par-dessus des paiements postérieurs sans rapprochement externe.
