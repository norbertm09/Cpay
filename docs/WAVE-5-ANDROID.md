# Vague 5 — refonte de l'application Android marchande (« très conviviale »)

Branche `wave-5`, dossier `android/` uniquement (Kotlin, package `global.cpay.app`). Objectif : une caisse
mobile **simple et agréable** au comptoir (usage à une main, réseau parfois dégradé), sans toucher au
contrat d'authentification (vague 3) ni aux contrats de la caisse (`docs/CAISSE-API.md`). Le profil
porteur reste fonctionnel et reçoit uniquement le nouveau thème.

## 1. Système de design (Material 3)

- `com.google.android.material:material` **1.11.0 → 1.12.0** (compatible `compileSdk 34`) ;
  `androidx.swiperefreshlayout:swiperefreshlayout:1.1.0` ajouté (tirer-pour-actualiser). Aucun autre
  changement dans `app/build.gradle`.
- `res/values/themes.xml` : `Theme.CPay` hérite de `Theme.Material3.Light.NoActionBar` (clair uniquement,
  pas de mode sombre). `Theme.CPay.Splash` et `Theme.CPay.NoActionBar` conservés (manifeste inchangé).
- Jetons de couleur (`res/values/colors.xml`) :

  | Jeton | Valeur | Usage |
  |---|---|---|
  | `brand_navy` | `#12306e` | titres, barre basse active, dégradé du solde |
  | `brand_primary` (`colorPrimary`) | `#1d4f92` | liens, icônes, états sélectionnés, boutons tonals |
  | `brand_accent` (`colorSecondary`) | `#f07800` | **boutons principaux** (Encaisser, Retirer…), tuile Encaisser |
  | `brand_cyan` (`colorTertiary`) | `#00b4c8` | fin du dégradé, approvisionnements |
  | `surface` / `surface_dim` / `surface_variant` | `#ffffff` / `#f3f5f9` / `#eef2f8` | cartes, fond, clavier |
  | `outline` | `#d9e0ea` | bordures de cartes et champs |
  | `on_surface` / `on_surface_variant` | `#15213a` / `#5b6676` | texte principal / secondaire |
  | `success_main` + `success_container` | `#1b8a4c` / `#e3f5ea` | approuvé, effectué, entrées |
  | `warn_main` + `warn_container` | `#b45f06` / `#fff1dc` | en attente, hors ligne |
  | `error_main` + `error_container` | `#c0392b` / `#fde8e6` | refusé, erreurs |

  Les anciens noms (`primary`, `primary_dark`, `accent`, `bg`, `card`, `border`, `text`…) utilisés par les
  écrans porteur sont **remappés** sur ces valeurs ; les formes `bg_*.xml` utilisent désormais les jetons.
- Formes : composants 12 dp (`ShapeAppearance.CPay.Small/Medium`), cartes et tuiles 16–20 dp
  (`ShapeAppearance.CPay.Large`), feuilles inférieures 24 dp en haut. Espacement sur grille de 8 dp.
- Typographie : `TextAppearance.CPay.Display` (40 sp), `Amount` (32 sp), `Title` (22 sp), `Subtitle` (16 sp),
  `Body` (15 sp), `Secondary` (13 sp), `Label`, `Overline` (11 sp capitales).
- Composants : `Widget.CPay.Button` (orange, 52 dp), `.Primary` (56 dp), `.Tonal`, `.Outlined`, `.Text`,
  `.Danger`, `.Key` (touches 60 dp du clavier), `.Icon` (48 dp) ; `Widget.CPay.Card` (+ `.Flat`, `.Tile`) ;
  `Widget.CPay.TextInputLayout` (+ `.Dropdown`) avec texte d'aide / d'erreur ; `Widget.CPay.Chip` (+ `.Amount`) ;
  `Widget.CPay.BottomNavigation` (indicateur orange) ; `ThemeOverlay.CPay.BottomSheet`.
- Icônes : **vectoriels inline** (`res/drawable/ic_*.xml`, chemins Material, teintés par `app:tint` /
  `iconTint`). Seul PNG : le logo HD `drawable-nodpi/logo_cpay.png` (copie de `portal/merchant/public/logo-calculus.png`).
- Chaînes : toutes dans `res/values/strings.xml` (français, vouvoiement, **aucun emoji**) ; les écrans
  marchands historiques conservés (Décaisser, Comptes bancaires, Terminaux, Règlements, Liens, KYB,
  Historique) ont été débarrassés de leurs emojis. Les écrans porteur ne sont pas retouchés.
- Accessibilité : `contentDescription` sur toutes les icônes actives, cibles ≥ 48 dp (boutons icône 48 dp,
  touches 60 dp, lignes de liste ≥ 64 dp), ordre de lecture naturel (en-tête → contenu → action principale).

## 2. Navigation (marchand)

```
SplashActivity ──(session + verrou biométrique optionnel)──► MerchantMainActivity
      │ (pas de session)                                           │
      ▼                                                            │  BottomNavigationView (4 onglets, racines sans pile)
ProfileSelectActivity ─► LoginActivity ─► TwoFAActivity (login)    │  ├─ Caisse     CaisseHomeFragment
                            │              ChangePasswordActivity  │  ├─ Encaisser  CollectAmountFragment
                            └─► RegisterActivity / ForgotPassword  │  ├─ Journal    CashJournalFragment
                                                                   │  └─ Plus       MoreFragment
PairingActivity (si non appairé ; « Continuer sans terminal » mémorisé)
                                                                   Écrans empilés (push + Retour) :
  Caisse ─ tuiles ─► Retirer (WithdrawFragment) · Transférer (TransfersFragment) · Journal · Encaisser
  Encaisser ─► CollectCustomerFragment ─► CollectWaitingFragment ─► CollectResultFragment
            └► CollectCardFragment (lien + QR plein écran)      └► NFC : dialogue « Bientôt disponible »
  Plus ─► Retirer · Transférer · Liens de paiement · Décaisser · Terminaux · Règlements · Comptes bancaires ·
          Historique des transactions · Dossier KYB · Profil et sécurité (MerchProfileFragment) ·
          Support (SupportFragment) · Déconnexion
  Profil ─► TwoFAActivity (configuration) · ChangePasswordActivity · PairingActivity · Terminaux
```

`MerchantMainActivity` : `switchTab()` (vide la pile puis remplace la racine), `push(fragment, tag)`,
`popTo(tag)`, `pop()`, `popToRoot()` ; re-toucher l'onglet courant revient à sa racine ; Retour dépile, puis
revient sur Caisse, puis quitte. Les anciens `openXxx()` sont conservés (`openWithdraw`, `openTransfers`,
`openProfile`, `openSettlements`, `openTerminals`, `openPayLinks`, `openKyb`, `openTransactions`,
`openBankAccounts`, `openDisburse`) + `openSupport`, `openMore`, `openHome`.

## 3. Écrans

| Écran | Fichiers | Points clés |
|---|---|---|
| Choix du profil | `activity_profile_select.xml` | logo HD, deux grandes cartes (Marchand mis en avant, Porteur) |
| Connexion | `activity_login.xml`, `LoginActivity.kt` | `TextInputLayout` 56 dp, bascule mot de passe intégrée, bandeau d'erreur, bouton empreinte si session (access + refresh) du même profil ; `EXTRA_AUTO_BIOMETRIC` lance l'invite directement |
| Splash | `activity_splash.xml`, `SplashActivity.kt` | logo, version depuis `BuildConfig`, **verrou biométrique** (`UiPrefs.biometricLock`) : succès → écran principal, refus/annulation → connexion |
| 2FA / mot de passe / inscription / oubli / appairage | layouts restylés, ids conservés | libellés via `strings.xml` ; appairage : « Continuer sans terminal » enregistre `pairingSkipped` (plus de boucle appairage ↔ principal) |
| **Caisse** | `fragment_caisse_home.xml`, `CaisseHomeFragment.kt` | solde disponible 36 sp avec œil (`UiPrefs.balanceHidden`), en attente / réservé, aujourd'hui (nombre + montant, Mobile Money vs carte, retiré), 4 tuiles 112 dp, aides fermables (wallet, compte bancaire, KYB niveau 0 ; `UiPrefs.dismissHint`), 5 dernières opérations (`GET cash/history?limit=5`) avec puces de statut et détail, `SwipeRefreshLayout`, **bandeau hors ligne « données du … »** depuis le cache Room |
| **Encaisser — montant** | `fragment_collect_amount.xml`, `CollectAmountFragment.kt` | montant 44 sp auto-ajusté + devise, puces de montants rapides (cumulables), clavier 3 × 4 (touches 60 dp, appui long sur ⌫ = effacer), bouton orange Mobile Money, Carte (lien + QR), Sans contact → « Bientôt disponible » honnête |
| **Encaisser — client** | `fragment_collect_customer.xml`, `CollectCustomerFragment.kt` | numéro (22 sp), détection live `POST detect/phone` (450 ms) : drapeau (indicateurs régionaux du pays ISO), initiales + couleur de l'opérateur, puce devise, alerte devise ≠ compte, alternatives en `Chip` à sélection unique (`operator`), libellé optionnel, bouton « Encaisser 12 500 XAF » ; `POST cash/collect` avec `Idempotency-Key` |
| **Encaisser — attente** | `fragment_collect_waiting.xml`, `CollectWaitingFragment.kt` | anneau de progression 90 s, « Le client confirme sur son téléphone », compte à rebours, sondage `GET cash/collect/:txnId` toutes les 3 s ; Annuler / Retour → résultat « en attente » |
| **Encaisser — résultat** | `fragment_collect_result.xml`, `CollectResultFragment.kt` | succès (reçu, partage), refus (Réessayer → écran client pré-rempli), en attente (explication, suivi dans le Journal) ; « Nouvel encaissement » |
| **Encaisser — carte** | `fragment_collect_card.xml`, `CollectCardFragment.kt` | `method=card` → QR ZXing 280 dp plein écran, lien, expiration, copier / partager / ouvrir ; 410 → message |
| **Retirer** | `fragment_withdraw.xml`, `WithdrawFragment.kt` | carte solde + plafond restant, wallet (initiales opérateur, puce vérifié), formulaire wallet (liste déroulante + détection), montant 24 sp + « Tout retirer », **estimation des frais** (`limits.withdrawFeePercent/Fixed/Min`, champs ajoutés à `CashLimits`), step-up, feuille de résultat |
| **Transférer** | `fragment_transfers.xml`, `TransfersFragment.kt` | bascule `MaterialButtonToggleGroup`, compte vérifié en liste déroulante, minimum en aide, step-up **uniquement wallet → banque** (§5 : aucune confirmation forte pour l'approvisionnement), instructions de virement en feuille (copie par champ / tout copier), liste avec puces et détail (instructions, annulation) |
| **Journal** | `fragment_cash_journal.xml`, `CashJournalFragment.kt`, `StickyHeaderDecoration.kt` | en-têtes de jour collants (Aujourd'hui / Hier / date), puces de filtre, recherche référence / téléphone (sur les lignes chargées, l'API n'a pas de `q`), totaux entrées / sorties, défilement infini, tirer-pour-actualiser, détail en feuille (`JournalDetailSheet`) avec reçu et partage, cache Room de la première page + bandeau hors ligne |
| **Plus** | `fragment_more.xml`, `MoreFragment.kt` | carte compte (initiales, KYB, terminal), sections Opérations / Outils / Compte, déconnexion confirmée |
| **Profil et sécurité** | `fragment_merch_profile.xml`, `MerchProfileFragment.kt` | identité (`GET merchant/auth/me`), 2FA (statut + configuration), mot de passe, **verrou biométrique** (`MaterialSwitch`), langue (Français, autres bientôt), terminal, déconnexion, version |
| **Support** | `fragment_support.xml`, `SupportFragment.kt` | e-mail `support@c-pay.global`, demandes (`GET/POST merchant/support/tickets`) avec feuille de création |
| Reçu | `activity_receipt.xml`, `ReceiptActivity.kt` | logo, puce de statut, devise transmise par l'extra `currency`, impression / SMS / partage |

Composants partagés : `view_screen_header.xml` (retour 48 dp + titre), `view_offline_banner.xml`,
`sheet_step_up.xml` (`merchant/StepUp.kt` en `BottomSheetDialog`, même logique 428 / `methods`),
`sheet_result.xml` (`common/ui/ResultSheet.kt`), `sheet_journal_detail.xml`, `sheet_funding_instructions.xml`,
`sheet_new_ticket.xml`, `item_history_entry.xml`, `item_journal_header.xml`, `item_cash_transfer.xml`,
`item_more_entry.xml`, `item_more_header.xml`, `item_detail_row.xml`, `item_instruction_row.xml`, `item_ticket.xml`.
Utilitaires : `common/ui/Fmt.kt` (montants `fr-FR`, dates ISO → « 15 oct. 2026 à 14:32 », libellés de jour),
`StatusUi.kt` (puces de statut, icônes de type, couleurs / initiales d'opérateur, drapeau), `Net.kt`,
`UiPrefs.kt` (préférences d'interface non sensibles : solde masqué, aides fermées, verrou biométrique,
appairage ignoré), `StickyHeaderDecoration.kt`.

## 4. Hors ligne

- `db/CacheEntryEntity` + `CacheDao` (table `cache_entries`, Room **version 2**, `fallbackToDestructiveMigration`
  déjà en place) ; `CacheManager.putJson / getJson` (Gson). Clés : `cash_summary`, `cash_history_<type|all>`.
- Caisse : à l'échec réseau, le dernier résumé et les 5 dernières opérations viennent du cache, bandeau
  « Hors ligne — données du <date> ». Journal : première page du filtre courant en cache, même bandeau.
- **Aucune file d'attente** : aucune opération monétaire n'est mise en attente hors ligne (les boutons
  envoient, l'erreur réseau est affichée).

## 5. Couche auth / réseau

Inchangée (`ApiClient`, `ApiService`, `ApiErrors`, `AuthFlow`, `SessionManager`). Ajouts additifs :
`CashLimits.withdrawFeePercent/Fixed/Min` + `estimateWithdrawFee()` dans `Models.kt` ;
`BiometricHelper.authenticate(..., onCancel)` et libellés via ressources. `UiPrefs.onLogout()` est appelé lors
de la déconnexion depuis Plus / Profil (le solde redevient visible).

## 6. Fichiers supprimés

`merchant/fragments/CollectFragment.kt`, `MerchDashboardFragment.kt` (remplacés), `res/layout/fragment_collect.xml`,
`fragment_merch_dashboard.xml`, `dialog_collect_waiting.xml`, `activity_collect.xml`, `item_card.xml`,
`item_bank_account.xml` (layouts morts). `fragment_merch_profile.xml` réécrit (il n'était plus utilisé) ;
`MerchProfileFragment` utilise désormais `FragmentMerchProfileBinding` (le porteur garde `fragment_profile.xml`).

## 7. Vérifications effectuées ici (pas de SDK Android dans le conteneur)

- XML : tous les layouts, menus, drawables, anims, couleurs et `strings.xml` analysés avec `xml.dom.minidom`.
- Script de cohérence (`verify.py`, exécuté sur `android/app/src/main`) : chaque `@string/@drawable/@color/@layout/@style/@id/@anim/@menu`
  des XML et chaque `R.id/R.string/R.drawable/R.layout/R.color/R.anim` du Kotlin existe ; chaque `b.xxx` /
  `binding.xxx` correspond à un `@+id` du layout de la classe `…Binding` (y compris les `include` `header` et
  `offline_banner`) ; aucune référence aux classes / layouts supprimés ; aucun emoji dans `strings.xml` et dans
  le code marchand / commun / onboarding ; aucun layout orphelin ; équilibre des accolades et parenthèses.
- **Compilation Kotlin non exécutée** : à faire en CI (`cd android && ./gradlew :app:assembleDebug`).

## 8. Plan de test manuel (appareil)

Pré-requis : backend vague 4 (`/merchant/cash/*`), un marchand sans 2FA et un avec 2FA, solde > 0, un compte
bancaire `verified`, un numéro Mobile Money sandbox.

1. **Onboarding** : lanceur → splash (logo, version) → choix du profil (logo HD, deux cartes) → connexion
   marchand : erreur si champs vides, bascule œil du mot de passe, « Mot de passe oublié » et « Créer un
   compte » ouvrent les bons écrans ; compte 2FA → écran « Vérification en deux étapes » ; mot de passe
   temporaire → écran « Nouveau mot de passe » obligatoire.
2. **Biométrie** : Plus → Profil et sécurité → activer « Déverrouillage biométrique » ; tuer l'app → au
   lancement l'invite d'empreinte apparaît ; annuler → écran de connexion avec bouton « Déverrouiller avec mon
   empreinte » ; succès → Caisse sans ressaisie.
3. **Appairage** : premier lancement non appairé → écran d'appairage ; « Continuer sans terminal » → Caisse
   (et plus de retour en boucle à l'appairage) ; Profil → Terminal → « Appairer » → code 6 chiffres.
4. **Caisse** : solde, œil masque / affiche (persistant), aujourd'hui (nombre, Mobile Money, carte, retiré),
   aides : sans wallet → carte « Enregistrez votre wallet » (× la ferme durablement, Enregistrer ouvre Retirer),
   sans compte bancaire → Comptes, KYB 0 → Dossier KYB ; 5 dernières opérations (toucher → détail, reçu) ;
   tirer pour actualiser ; mode avion → bandeau « Hors ligne — données du … » et données en cache.
5. **Encaisser Mobile Money** : clavier (000, ⌫, appui long), puces rapides cumulables, montant < 100 →
   erreur ; Mobile Money → numéro MTN CM : drapeau, « MTN », XAF ; numéro Orange SN : alternative Wave en puce ;
   numéro d'une autre devise → alerte ; Encaisser → écran d'attente (anneau, compte à rebours) ; confirmer
   côté sandbox → « Paiement reçu », reçu et partage ; refuser → « Paiement refusé » → Réessayer pré-remplit
   le numéro ; ne rien faire 90 s ou Annuler → « En attente de confirmation », ligne `pending` dans le Journal.
   Retour depuis l'écran client ramène au clavier avec le montant conservé.
6. **Encaisser carte** : Carte → QR plein écran, lien, expiration, copier / partager / ouvrir ; marchand sans
   passerelle → « Fonctionnalité en cours d'intégration ». Sans contact → dialogue « Bientôt disponible ».
7. **Retirer** : sans wallet → « Enregistrer mon wallet » (liste opérateurs, détection pré-sélectionne,
   confirmation forte en feuille : mot de passe ou code 6 chiffres ; faux → « Confirmation refusée — 2
   essai(s) ») ; « Tout retirer » remplit le minimum entre solde et plafond ; estimation des frais sous le
   montant ; retrait → feuille « Retrait demandé » (référence, statut, wallet, frais) → bouton Journal.
8. **Transférer** : Vers ma banque (compte en liste déroulante, minimum en aide, step-up) → feuille
   « Transfert demandé » (J+1 si `pending_manual`) ; Approvisionner → **pas de step-up**, feuille d'instructions
   (copie par champ, tout copier, échéance) ; liste : toucher une ligne → détail, « Instructions » pour
   `awaiting_funds`, « Annuler le transfert » pour `awaiting_funds` / `pending_manual`.
9. **Journal** : en-têtes Aujourd'hui / Hier collants au défilement, puces de filtre, recherche par référence
   ou téléphone, totaux, défilement jusqu'en bas → page suivante, tirer pour actualiser, détail → reçu /
   partage ; mode avion → bandeau hors ligne avec la dernière page en cache.
10. **Plus / Profil / Support** : chaque entrée ouvre son écran et Retour revient sur Plus ; Profil : statut 2FA,
    mot de passe (non forcé : Retour revient au profil), langue → message, déconnexion confirmée ; Support :
    e-mail, nouvelle demande → liste.
11. **Porteur** : connexion porteur, accueil, cartes, solde, payer, profil fonctionnent avec le nouveau thème
    (aucune régression attendue : layouts inchangés, couleurs remappées).

## 9. Points ouverts

- Compilation et rendu réels à valider en CI puis sur appareil (TalkBack : ordre de lecture, libellés).
- Recherche du Journal côté client uniquement (pas de paramètre `q` dans `GET /merchant/cash/history`).
- Pas de sondage du statut du lien carte (`GET /pay/:shortId/status` n'est pas dans `ApiService` ; le paiement
  apparaît dans le Journal).
- Drapeaux du pays rendus par les indicateurs régionaux Unicode (dépend de la police de l'appareil).
- Mode sombre non fourni (optionnel) ; une seule langue (français).
