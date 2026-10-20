# Premier lot de sécurisation

## Comportement

- Les POST `/api/v1/card2momo`, `/api/v1/momo2card` et `/api/v1/momo2momo` renvoient maintenant HTTP 410 et `FEATURE_DISABLED` après authentification, avant tout débit, collecte, versement ou création d'ordre. Aucune option ne permet leur réactivation accidentelle. Les routes de caisse récentes restent inchangées.
- Les routes de suivi et webhooks existantes restent présentes pour les opérations antérieures. Leurs limites de rapprochement historiques ne sont pas corrigées par cette suspension : les encours doivent être examinés par les opérations, sans réémettre automatiquement les ordres.
- Une erreur d'un contrôle antifraude remonte au gestionnaire de mode dégradé existant. `block` empêche l'appel opérateur ; `review` conserve le comportement existant (poursuite avec journalisation et alerte) ; `allow_limited` ne poursuit que dans les limites configurées. Un refus explicite d'un autre contrôle garde la priorité. Le mode de production et les plafonds doivent être choisis explicitement.
- Les deux services SMTP vérifient les certificats et imposent TLS (STARTTLS obligatoire lorsque la connexion ne commence pas déjà en TLS). Aucun contournement par certificat non vérifié n'est proposé.

## SMTP et autorités privées

Le magasin de confiance Node est utilisé par défaut. Pour une autorité privée, configurer au choix :

```dotenv
SMTP_TLS_CA_FILE=/run/secrets/smtp-ca.pem
# Alternative : SMTP_TLS_CA avec le contenu PEM (retours à la ligne réels ou \n).
```

`SMTP_TLS_CA` a priorité sur `SMTP_TLS_CA_FILE`. Monter le fichier dans le conteneur API si cette option est utilisée. Un fichier configuré illisible empêche l'envoi ; une chaîne de certificat non fiable est refusée par TLS. Vérifier les emails de réinitialisation et notification en staging avec le fournisseur réel avant déploiement. Un serveur dont le certificat était jusque-là accepté seulement grâce au mode non sûr devra être corrigé ou muni d'une autorité de confiance appropriée.

## Validation

Les tests `security-first-lot.test.js` exercent les trois routes, le vrai moteur antifraude et l'orchestrateur avec les fournisseurs simulés, ainsi que les deux transports SMTP. Ils couvrent les modes dégradés, la configuration de confiance et l'absence d'envoi si le fichier CA est introuvable. Aucun paiement ni email réel n'est envoyé.

La suspension ne rembourse ni n'annule les opérations historiques et ne constitue pas un raccordement GIMAC ou de nouveaux pays. Les autres lots de l'audit (idempotence, portails, réconciliation, schéma, dépendances) restent à traiter.
