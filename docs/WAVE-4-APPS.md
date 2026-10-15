# Vague 4 — applications mobiles « Caisse » (Android natif + Expo)

Contrat de référence : `docs/CAISSE-API.md`. Vocation : le marchand **encaisse** ses recettes
(Mobile Money, carte), **retire** vers son wallet, **transfère** wallet ↔ banque et consulte un
**journal** unique. Les deux apps sont tolérantes aux champs optionnels absents (backend implémenté
en parallèle) et affichent « Fonctionnalité en cours d'intégration » sur `410 FEATURE_DISABLED`.

Aucune nouvelle dépendance. Android : ZXing (`zxing-android-embedded`) déjà présent pour le QR ;
Expo : `react-native-qrcode-svg` déjà présent. Les versions (`build.gradle`, `app.json`,
`package.json`) ne sont pas touchées ici.

---

## 1. Android (`android/app/src/`, package `global.cpay.app`, profil marchand)

### Couche commune
| Fichier | Changement |
|---|---|
| `common/ApiService.kt` | Section « MERCHANT — CAISSE » : `cashSummary`, `cashCollect` (POST, `@Header("Idempotency-Key")`), `cashCollectStatus`, `cashWallet` (200/204), `cashWalletUpdate` (PUT), `cashWithdraw`, `cashTransfers` (direction/status/limit/offset), `cashTransferDetail`, `cashTransferCreate`, `cashTransferCancel`, `cashHistory` (from/to/type/limit/offset) ; `detectPhone` (`POST detect/phone`, public). L'ancien `merchantWithdraw` utilise `LegacyWithdrawRequest`. |
| `common/Models.kt` | `CashBalance`, `CashToday` (+ `byMethod`), `CashLimits`, `CashWallet`, `CashProfile`, `CashSummary`, `CashCollectRequest/Response` (+ `payLink`), `CashCollectStatus`, `CashWalletRequest`, `WithdrawRequest { amount, description?, confirm: Map<String,String> }`, `WithdrawResponse`, `TransferRequest`, `BankInstructions`, `Transfer` (+ `canCancel`, `statusLabel`), `TransfersResponse`, `HistoryEntry`, `HistoryTotals` (`in`/`out`), `HistoryResponse`, `StepUpError`, `PhoneDetection`/`PhoneAlternative`, `CashLabels` (opérateurs, statuts, couleurs). `ApiError` gagne `methods` (428) et `available` (422). `UserInfo` gagne `mfaEnabled`, `currency`, `country`, `kybLevel`. `BankAccount` gagne `bankName`, `accountMasked`, `isVerified`. |
| `common/ApiErrors.kt` | Codes caisse + `cashMessage(httpCode, ApiError, currency)` / `cashMessage(Response, …)` : messages dédiés `INSUFFICIENT_BALANCE` (avec `available`), `DAILY_LIMIT_EXCEEDED`, `WALLET_MISSING`, `STEP_UP_REQUIRED`, `CURRENCY_MISMATCH`, `FUNDING_UNAVAILABLE`, `MERCHANT_INACTIVE`, 429, 410 ; `isStepUp()`. |
| `common/ApiClient.kt` | `/detect/phone` ajouté aux routes publiques (pas de bearer, pas de refresh sur 401) ; `CashSession`/`StepUp` réinitialisés à la déconnexion. |
| `common/ReceiptActivity.kt` | Statuts `authorized` → « Approuvé », `expired` → « Refusé », méthode `mobile_money`. |
| `merchant/StepUp.kt` | Confirmation forte partagée : méthode via `GET /merchant/auth/me` (`user.mfaEnabled`, cache session) → dialogue TOTP 6 chiffres ou mot de passe → appel ; sur `428 { methods }` relit la méthode et redemande (3 essais). `StepUp.run(ctx, titre) { confirm -> api… }`. |
| `merchant/CashSession.kt` | Cache mémoire du dernier `CashSummary` (devise, solde) entre écrans. |
| `merchant/MerchantMainActivity.kt` | Barre basse : **Caisse · Encaisser · Retirer · Transférer · Journal** (`menu/merchant_nav.xml`, icône `drawable/ic_transfer.xml`). `selectTab()`, `openProfile()`, `openSettlements()`, `openTerminals()`, `openPayLinks()`, `openKyb()`, `openTransactions()`, `openBankAccounts()` (= `MerchTransferFragment`, gestion des comptes), `openDisburse()` (ancien décaissement). `BottomNavigationView` est limité à 5 entrées : **Profil** est accessible depuis l'en-tête de l'accueil Caisse (bouton 👤). |
| `merchant/PairingActivity.kt` | `appVersion = BuildConfig.VERSION_NAME` (plus de « 2.6.0 » en dur). |

### Écrans
| Écran | Fichiers | Endpoints |
|---|---|---|
| **Caisse** (accueil) | `fragments/MerchDashboardFragment.kt`, `layout/fragment_merch_dashboard.xml` | `GET merchant/cash/summary` — solde disponible / en attente / réservé, encaissements du jour par méthode (Mobile Money, carte), retiré, 4 tuiles, aides onboarding (wallet manquant → Retirer ; aucun compte bancaire → Comptes ; `cardAcceptance`), bouton ↻ (pas de `SwipeRefreshLayout` dans les dépendances) et rechargement `onResume`, accès Règlements / Terminaux / Liens / Comptes / Décaisser / KYB / Profil. |
| **Encaisser** | `fragments/CollectFragment.kt`, `layout/fragment_collect.xml` (+ `dialog_collect_waiting.xml` existant) | Onglets Mobile Money / Carte / NFC. Mobile Money : clavier montant (0-9, 000, ⌫), numéro client avec **détection live** `POST detect/phone` (debounce 450 ms : pays, opérateur, devise, alerte devise ≠ compte, puces d'alternatives Wave / Express Union → `operator`), `POST merchant/cash/collect` (`Idempotency-Key`), puis **sondage** `GET merchant/cash/collect/{txnId}` toutes les 3 s / 90 s max (dialogue avec compte à rebours et annulation) → `authorized` : reçu (`ReceiptActivity`) ; `failed`/`expired` : refus ; délai : « En attente de confirmation ». Carte : `method=card` → `payLink.shortUrl` + **QR ZXing**, copier / ouvrir / partager, expiration ; `410` → message fonction en cours. NFC : message existant. |
| **Retirer** | `fragments/WithdrawFragment.kt`, `layout/fragment_withdraw.xml` (+ `dialog_transfer_result.xml`) | `GET cash/summary` (disponible, `withdrawDailyRemaining / withdrawDailyMax`), `GET cash/wallet` (200 / 204), formulaire wallet (opérateur `CashLabels.OPERATORS`, numéro avec détection qui présélectionne l'opérateur) → `PUT cash/wallet` avec step-up ; montant + libellé → `POST cash/withdraw` avec step-up → dialogue résultat (référence, statut, net, frais). Contrôles locaux solde / plafond, messages dédiés `INSUFFICIENT_BALANCE`, `DAILY_LIMIT_EXCEEDED`, `WALLET_MISSING` (ouvre le formulaire), `FEATURE_DISABLED` (bouton désactivé). `DisburseFragment` conservé (accueil → « Décaisser »). |
| **Transférer** | `fragments/TransfersFragment.kt`, `layout/fragment_transfers.xml`, `layout/item_cash_transfer.xml` | Bascule Wallet → Banque / Banque → Wallet. Wallet → banque : `GET merchant/bank-accounts` filtré `verified` (sinon aide + « Gérer mes comptes » → `MerchTransferFragment`), montant ≥ `transferMin`, step-up, `POST cash/transfers` → dialogue (`processing` / `pending_manual` J+1). Banque → wallet : `POST cash/transfers` direction `bank_to_wallet` → **instructions** (banque, titulaire, compte, IBAN, SWIFT, référence, échéance) avec copie par champ et « Tout copier ». Liste `GET cash/transfers?limit=20` avec badges de statut, bouton Instructions (`awaiting_funds`) et **Annuler** (`awaiting_funds`, `pending_manual`) → `POST cash/transfers/{id}/cancel`. Remplace `MerchTransferFragment` dans la navigation (fichier conservé pour les comptes bancaires). |
| **Journal** | `fragments/CashJournalFragment.kt`, `layout/fragment_cash_journal.xml`, `layout/item_history_entry.xml` | `GET cash/history?type&limit=30&offset` : puces Tous / Encaissements / Retraits / Vers banque / Approvisionnements, totaux entrées / sorties (`totals.in/out`), compteur, **défilement infini** (+ bouton « Charger plus »), ↻. `MerchTransactionsFragment` reste accessible (`openTransactions()`). |

Chaînes : `res/values/strings.xml` (section « WAVE-4 : caisse marchande », français).

### Vérifications faites / non faites
- XML : tous les layouts, menu, drawable et `strings.xml` validés avec `xml.dom.minidom`.
- Cohérence des ids ViewBinding (`b.xxx` ↔ `@+id/xxx`) et des références `R.id/R.string/R.layout/R.drawable` vérifiée par script.
- **Pas de compilation Kotlin** (aucun SDK Android dans l'environnement ; le wrapper `android/gradlew` existe pour la CI). À compiler en CI : `cd android && ./gradlew :app:assembleDebug`.

---

## 2. Expo (`mobile/cpay-mobile/App.js`, mode marchand)

Onglets marchand : **Caisse · Encaisser · Retirer · Transférer · Journal** puis QR/Lien, Historique,
Tokens, CRM/Compta, Pilot, Support (inchangés). Mode admin inchangé.

| Élément | Description |
|---|---|
| `withStepUp(session, titre, fn)` + `StepUpHost` | Modal unique (`Modal` RN) : `{ code }` si `session.user.mfaEnabled` (renvoyé par `/auth/me`), sinon `{ password }` ; sur `428 STEP_UP_REQUIRED { methods }` relit la méthode et redemande (3 essais) ; annulation → `null`. |
| `cashMessage(err, currency)` | Messages dédiés aux codes de la caisse (voir Android). |
| `useCashSummary()` | `GET /merchant/cash/summary` + `reload`. |
| `usePhoneDetection(phone)` | `POST /detect/phone` (sans jeton) debounce 450 ms → `{ detection, detecting }`. |
| `useCashCollectPolling(result, setResult)` | `GET /merchant/cash/collect/:txnId` toutes les 3 s, 90 s max → `timedOut` (« En attente de confirmation »). |
| `CaisseHome` | Solde, aujourd'hui par méthode, aides onboarding (wallet, compte bancaire, `cardAcceptance`), 4 tuiles, accès QR/Lien, Historique, Support. |
| `CollectScreen` | Mobile Money (montant + montants rapides, numéro, carte de détection, alternatives → `operator`, `POST /merchant/cash/collect` avec `idempotencyKey`, suivi, `CashCollectResult` avec partage du reçu) · Carte (`method=card` → `CardLinkCard` : QR local `react-native-qrcode-svg`, copier / partager / ouvrir, expiration ; 410 → notice) · NFC (notice). |
| `WithdrawScreen` | Wallet (`GET/PUT /merchant/cash/wallet`, puces opérateurs, détection), montant, plafond restant, `POST /merchant/cash/withdraw` avec step-up + `idempotencyKey`, carte résultat. |
| `TransfersScreen` + `FundingInstructions` | Bascule direction, comptes vérifiés (`GET /merchant/bank-accounts`), `POST /merchant/cash/transfers` avec step-up + `idempotencyKey`, instructions avec copie par champ / tout copier, liste avec statuts, Instructions et Annuler (`POST …/:id/cancel`). |
| `JournalScreen` | `GET /merchant/cash/history` avec filtre type, totaux, pagination « Charger plus ». |
| `Chips` | Nouveau composant de puces (opérateurs, comptes, filtres). |

Supprimés : `PaymentScreen` (ancien `POST /merchant/collect`), `usePendingCollect`, `ResultCard`,
`MerchantHome`. `LinkScreen` (pay-links) et `HistoryScreen` (transactions / règlements) conservés.

Vérification : `npm install` puis `esbuild --bundle --platform=neutral --loader:.js=jsx` et
`@babel/core` + `babel-preset-expo` (voir README) — OK, `node_modules` et lockfile supprimés ensuite.
Non vérifié : rendu sur appareil (pas d'Expo Go ici).

---

## 3. Endpoints utilisés (les deux apps)

| Méthode | Route | Usage |
|---|---|---|
| GET | `/merchant/cash/summary` | Caisse, Retirer, Transférer, Encaisser (devise) |
| POST | `/merchant/cash/collect` (`Idempotency-Key`) | Encaisser Mobile Money / carte |
| GET | `/merchant/cash/collect/:txnId` | Sondage 3 s / 90 s |
| GET / PUT | `/merchant/cash/wallet` (PUT : `confirm`) | Retirer — wallet |
| POST | `/merchant/cash/withdraw` (`Idempotency-Key`, `confirm`) | Retirer |
| GET | `/merchant/cash/transfers?limit=20` | Liste des transferts |
| POST | `/merchant/cash/transfers` (`Idempotency-Key`, `confirm`) | Wallet → banque, banque → wallet |
| POST | `/merchant/cash/transfers/:id/cancel` | Annulation |
| GET | `/merchant/cash/history?type&limit&offset` | Journal |
| GET | `/merchant/bank-accounts` | Comptes vérifiés (Transférer) |
| GET | `/merchant/auth/me` | `user.mfaEnabled` (méthode de step-up) |
| POST | `/detect/phone` (public) | Détection pays / opérateur / devise / alternatives |

---

## 4. Plan de test manuel

Préparer : un marchand avec 2FA désactivé (step-up = mot de passe) et un avec 2FA activé (TOTP),
un solde disponible > 0, un compte bancaire `verified`, un compte de collecte C-Pay pour la devise.

1. **Caisse** — ouvrir l'app : solde disponible / en attente, encaissements du jour par méthode.
   Sans wallet : l'aide « Enregistrez votre wallet » s'affiche et mène à Retirer. Sans compte
   bancaire : aide « Ajoutez un compte bancaire ». ↻ recharge. 👤 (Android) ouvre le profil.
2. **Encaisser — détection** : saisir un numéro MTN CM (`+2376…`) → « MTN MoMo · Cameroun · XAF » ;
   numéro Orange SN → alternative Wave proposée ; numéro d'un pays non supporté → message d'erreur,
   bouton refusé tant qu'aucune alternative n'est choisie ; numéro d'une autre devise → alerte devise.
3. **Encaisser — Mobile Money** : montant 500, numéro valide → dialogue « En attente du client »
   avec compte à rebours ; confirmer côté client/sandbox → reçu « Approuvé » ; refuser → « Paiement
   refusé » ; ne rien faire 90 s → « En attente de confirmation » et le mouvement apparaît dans le
   Journal en `pending`. Rejouer la même requête (coupure réseau simulée) : pas de doublon
   (`Idempotency-Key`).
4. **Encaisser — Carte** : montant → lien + QR, copier / partager / ouvrir ; marchand d'un pays sans
   passerelle carte → « Fonctionnalité en cours d'intégration ». NFC → même message.
5. **Retirer — wallet** : enregistrer un wallet (saisir le numéro : l'opérateur se présélectionne) →
   demande de mot de passe (ou code TOTP) ; code faux → « Confirmation refusée — 2 essai(s) » ;
   annuler → rien n'est envoyé ; valide → wallet affiché « Vérifié après le premier retrait ».
6. **Retirer** : montant > disponible → « Solde insuffisant — disponible : … » (local puis serveur) ;
   montant > plafond restant → message plafond ; montant valide + confirmation → dialogue « Retrait
   demandé » avec référence `PAY-…`, solde et plafond rechargés, ligne `withdraw` dans le Journal.
   Compte 2FA : le dialogue demande un code à 6 chiffres. Forcer un `428` (mot de passe faux) :
   l'app redemande avec la méthode annoncée par `methods`.
7. **Transférer — wallet → banque** : choisir le compte vérifié, montant ≥ `transferMin`, confirmer
   → statut `processing` ou « Traitement J+1 » (`pending_manual`) ; la ligne apparaît dans la liste ;
   `pending_manual` → bouton Annuler → statut `cancelled`. Sans compte vérifié : aide + accès aux comptes.
8. **Transférer — banque → wallet** : montant → instructions (banque, titulaire, compte, IBAN/SWIFT,
   référence `FND-…`, échéance), copie champ par champ et « Tout copier » ; la ligne `awaiting_funds`
   propose Instructions et Annuler ; après `confirm-funds` côté admin → `completed`, solde crédité,
   ligne `transfer_in` dans le Journal. Devise sans compte de collecte → `FUNDING_UNAVAILABLE`.
9. **Journal** : filtres par type, totaux entrées / sorties, défilement jusqu'au bout → chargement
   automatique de la page suivante (Android) / « Charger plus » (Expo), ↻.
10. **Session** : laisser l'access expirer (> 15 min) puis lancer un retrait → refresh transparent,
    opération confirmée sans reconnexion ; refresh révoqué → retour au login.
11. **410** : backend avec caisse désactivée → tous les écrans affichent « en cours d'intégration »
    sans erreur technique.

---

## 5. Points ouverts

- Valeur du champ `operator` de `POST /merchant/cash/collect` : les apps renvoient l'identifiant
  d'alternative tel que fourni par `/detect/phone` (`WAVE`, `EXPRESS_UNION`) ; le contrat cite
  `wave`, `express_union`… — à normaliser côté backend (insensible à la casse) ou à confirmer.
- `GET /merchant/bank-accounts` : le filtrage « vérifié » accepte `status ∈ {verified, active}` ;
  l'ajout de compte reste sur l'ancien écran Android (`MerchTransferFragment`) et sur le portail pour Expo.
- Android : pas de `SwipeRefreshLayout` (dépendance absente) → bouton ↻ + rechargement `onResume`.
- Android : `BottomNavigationView` limite à 5 entrées → Profil déplacé dans l'en-tête de l'accueil.
- `GET /merchant/cash/history` sans `currency` par ligne : les apps affichent la devise du résumé / du profil.
- Compilation Kotlin non exécutée ici (pas de SDK) ; rendu Expo non testé sur appareil.
