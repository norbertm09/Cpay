# Audit production 2.6.0 — backend : serveur, middleware, routes, SQL, scripts, tests

Snapshot OVH (branche `ovh-prod-clean`), chemins relatifs à `backend/`. Deux points reproduits par exécution (supertest, DB stubée) : masquage de `/live` `/ready` `/metrics` et contournement de `/internal/settlement/run`.

## 1. Inventaire
- **~340 routes** réparties en 12 fichiers. `merchant.routes.js` 2 225 lignes (routes ajoutées après `module.exports` l.1187), `admin.routes.js` 1 943, `cardholder.routes.js` 1 042, `server.js` 804 dont ~330 lignes de HTML/CSS inline (pages pay-link).
- **Six implémentations distinctes** de la vérification JWT (middleware/auth.js, cardholder, gtp-card, mtn-momo, card2momo, partners, password_reset, distribution, claims) ; seule `middleware/auth.js` impose `JWT_SECRET` en prod.
- Routes mortes/doublons : 5 doublons admin (`GET /merchants` 368 vs 1087, etc.) ; `distributionAdminRouter` et `agentRouter` (11 routes) importés mais jamais montés ; `distribution.routes.js:18` `adminAuth = makeAuth(['admin'])` alors qu'aucun JWT admin n'a `role:'admin'` → `/admin/distribution/*` inaccessible.
- **Base de données** : les migrations 001–006 définissent 26 tables ; **le code référence 45 tables/vues absentes** (cardholders, virtual_cards, card_transactions, agencies, agents, banks, claims, consents, kyb_documents, merchant_api_keys, password_reset_tokens, tenants…), des colonnes absentes (`merchant_users.mfa_enabled/failed_attempts`, `transactions.settlement_status/reference`…), la fonction `calc_fee()` et des valeurs d'enum inexistantes (`'payment'`, `'contactless_nfc'`). **Le schéma versionné ne permet pas de reconstruire la production.**
- Dépendances : Express 4.22 (avec `proxy-addr` **critique** : spoofing d'IP via IPv4-mapped IPv6, impacte rate-limit), helmet 7, jest 29, bcryptjs 2, nodemailer 9 (7 avis high), speakeasy (abandonné depuis 2017). `npm audit` : **42 vulnérabilités (1 critique, 35 high)**. **`axios` et `bcrypt` requis mais non installés** → 500 sur `/merchant/public/collect` et `POST /admin/admin-users`.

## 2. Sécurité

### P0
1. **Secrets de production dans le dépôt** : `reset-creds.js` (URL PostgreSQL OVH avec mot de passe + mots de passe par défaut `Merchant@2024`, `Card@Holder2024`, `Admin@CPlus2024` réappliqués aux comptes `*@cplus.africa`).
2. **Middleware PCI cosmétique** : `pci.middleware.js:53-58` — `pciInputValidation`, `pciSessionCheck`, `pciAuditRequest`, `pciAnomalyDetection`, `pciResponseSanitizer`, `pciContentTypeCheck` sont tous `(req,res,next)=>next()` ; `pciErrorHandler` enregistré après `errorHandler` → jamais exécuté. Les commentaires « REQ 3 masquage PAN », « REQ 10 audit » sont faux.
3. **Webhook MTN non signé → crédit de carte à volonté** (`webhook-handlers.js:10-41`, doublon `mtn-momo.routes.js:262-295`) : `POST {referenceId, status:'SUCCESSFUL'}` crédite `virtual_cards.balance` ; le `referenceId` est renvoyé au client lors du top-up → **un porteur s'auto-confirme**. `/webhooks/psp/stripe` sans signature. Airtel/CyberSource/MIGS : vérification seulement si secret ET en-tête présents.
4. **IDOR cartes virtuelles** : `cardholder.routes.js:262,410,453,779` acceptent `(cardholder_id=$2 OR cardholder_id IS NULL)` et l'INSERT à l'inscription **ne renseigne jamais `cardholder_id`** → toutes les cartes sont orphelines : n'importe quel porteur peut définir le PIN, créditer, décharger ou payer avec la carte d'un autre.
5. **IDOR cartes GTP** : `gtp-card.routes.js:103-216` ne rapproche jamais `:gtpCardId` du porteur ; `cardAuth` local sans contrôle de `type` (tout JWT signé passe).
6. **Monnaie créée sans mouvement réel** : `/cardholder/topup` (« Simuler appel Mobile Money », crédite sans opérateur), `/unload`, `/payment/tokenized` cas 2 (`const authorized = true`, insère une transaction `authorized` pour un `merchantId` arbitraire), `/merchant/withdraw` (payout `authorized` sans transfert, solde sans déduction des retraits précédents → **retraits illimités**), `/collect/contactless` (auth code aléatoire), `/partners/collect|disburse` (`completed` immédiat), `/merchant/public/collect` (`.catch(()=>({txnId:'SIM-…'}))` → **l'API publique renvoie `success:true` avec un txnId fictif**).
7. **Double dépense** : `/transfer/payout` (`merchant.routes.js:811-822`) lit le solde sans verrou ni transaction et sans soustraire `merchant_transfers` ; `partners` float check-then-update non atomique.
8. **Escalade de privilèges admin** : `PATCH|DELETE /admin-users/:id` (`admin.routes.js:1363-1386`) protégés par `adminAuth` seul → un `support_agent` se donne `super_admin`. Même laxisme sur `/finance/settlements/*`, `/merchants/:id/fees|velocity`, `/partners/banks`, `/tenants`.
9. **Clés API `sk_live_` stockées et comparées en clair** (`merchant.routes.js:2060-2108`) ; `api_secret` jamais utilisé.
10. **Page de paiement publique : XSS stocké + PAN/CVV reçus en clair** (`server.js:157,160,275,305-306` : `business_name`/`description` non échappés → un marchand peut poser un skimmer sur `pay.c-pay.global` ; formulaire carte POSTe `cardNum, expiry, cvv` à `/api/v1/pay/:shortId` qui ne les traite même pas).
11. **2FA factice sur toute la plateforme** : `partners` `/auth/2fa/verify` accepte **n'importe quel code à 6 chiffres** ; `/2fa/setup` plante (`toString('base32')`) ; aucun login ne vérifie `mfa_enabled` ; `/auth/2fa/validate` attend un `mfa_pending` que personne n'émet.

### P1
12. Fuites : `SELECT u.*` sur `merchant_users` renvoyé à tout admin (`password_hash`, `mfa_secret`) ; `/notification-configs` renvoie `smtp_pass`, `wa_token`, `smpp_pass` en clair ; `/webhook-config` renvoie `webhook_secret` ; `/api-configs/:id` renvoie les secrets opérateurs au super_admin.
13. Mots de passe temporaires `Math.random()` renvoyés en réponse et stockés en clair dans `admin_notifications` ; `temp_password` jamais contrôlé au login.
14. Reset-link partenaires : token brut renvoyé à l'appelant, `:id` non scopé à la banque, aucune route ne le consomme.
15. Reset mot de passe : pas de révocation des sessions après reset, pas de rate limit par email.
16. Refresh tokens non durcis hors merchant/admin (cardholder : JWT 7 j non stocké ni révocable ; partners idem ; agents : aucun) ; access 15 min au login mais **8 h** à l'inscription.
17. IDOR partenaires (`/agents/:id/status|float` sans `bank_id`, approbations sans scope) et tickets cardholder (`/support/tickets/:id` sans `cardholder_id`).
18. Endpoints exposés : `/internal/settlement/run` ouvert si `INTERNAL_TOKEN` absent (reproduit) ; `GET /momo/balance` sans auth ; `/metrics` token facultatif ; `/api/v1/consent/*` lit/écrit les consentements d'un `userId` arbitraire ; `/merchant/reconcile` lance la réconciliation **globale** sur simple JWT marchand.
19. Rate limiting : rien sur `/pay/:shortId`, registers, forgot-password, `/terminals/pair` (code 6 chiffres), `/partners/auth/login`, envois SMS (`/receipts/sms`, `/pay-links/:id/send` vers numéro arbitraire → SMS pumping).
20. Cookies/CORS : cookie refresh `domain .c-pay.global` + XSS sur `pay.` ; refresh aussi renvoyé en JSON ; CORS inclut `localhost` avec `credentials:true`.
21. Données cartes : `virtual_cards.card_number` en clair ; `/cards/enroll` reçoit PAN+CVV côté serveur, « token » = `SHA-256(pan+chId+JWT_SECRET)` tronqué ; regex `\\s` littérale → Luhn échoue sur tout PAN avec espaces.
22. CSV admin sans échappement ; SSRF webhooks sortants (`http:` accepté, IP privées) ; `webhook_secret` jamais généré → signature avec `'cplus-default-secret'` ; TLS `rejectUnauthorized:false` (PG, SMTP, MTN) ; `err.stack` renvoyé au client (`card2momo.routes.js:273`).

## 3. Bugs fonctionnels vérifiés
| # | Où | Bug |
|---|---|---|
| 1 | `server.js:252` vs 732-744 | `app.get('/:shortId')` déclaré avant `/live`, `/ready`, `/metrics` → **ces trois routes renvoient 404 HTML** (reproduit). Probes et Prometheus cassés. |
| 2 | ~27 handlers async | Express 4 sans `asyncHandler` → une erreur SQL = **requête qui ne répond jamais**. |
| 3 | `merchant.routes.js:1881` | `/account/change-password` lit `req.user.userId` (le JWT porte `sub`) → **changement de mot de passe marchand impossible**. |
| 4 | `:1924` | `/collect/contactless` : `req.merchant` undefined → 500. |
| 5 | `:2134`, `admin.routes.js:1349` | `require('axios')` / `require('bcrypt')` non installés → 500. |
| 6 | `cardholder.routes.js:1032` | `notify` jamais importé → ReferenceError après l'INSERT KYC. |
| 7 | `middleware/idempotency.js:51-60` | Les réponses 5xx sont persistées et rejouées définitivement ; clé « en cours » éternelle si le handler plante ; jamais purgées. |
| 8 | 2FA disable/verify | `mfa_secret` NULL → TypeError 500. |
| 9 | inscriptions | `res.status(201).json()` **dans** `withTransaction` : JWT renvoyé avant COMMIT. |
| 10 | `cardholder.routes.js:795-803` | `/payment/tokenized` cas 1 : solde sans `FOR UPDATE` → double dépense. |
| 11 | pay-links | `shortId = Math.random()` (collision → 500), `expiresIn` non validé. |
| 12 | pagination | `limit` non borné, `page=0` → OFFSET négatif → erreur SQL non attrapée. |
| 13 | `/transfer/payout`, `/transactions/:id/refund` | statut `processing` jamais mis à jour ; remboursement marqué `reversed` **sans appel gateway**. |
| 14 | frais | trois barèmes contradictoires, `calc_fee()` SQL absent des migrations. |
| 15 | timezones | `DATE(initiated_at)` dépend du `timezone` de session PG non fixé. |
| 16 | `server.js:766-777` | `setInterval(reconcilePending)` par instance sans verrou ; pollings `setTimeout` perdus au redémarrage. |

## 4. Qualité et tests
- Trois moteurs de règlement, deux services email, webhooks MTN/Airtel dupliqués, six copies d'auth, deux pages HTML pay-link complètes dans `server.js`, fichiers `.bak` livrés en prod.
- **Tests : 5 suites / 71 tests passent** (détection 36, gateways 27, validation 5, pilot 4, env 2). **Couverture nulle** sur auth, idempotence, PCI, routes, webhooks, settlement, SQL.

## 5. Écart CHANGELOG ↔ code
`/live`/`/ready` : **faux en pratique** (404). Validation centralisée : partielle (5 routes). Idempotence : partielle (routes legacy seulement, pas celles de l'app). JWT durci : merchant/admin seulement. Compte admin par défaut supprimé : vrai dans 002 mais réinjecté par `reset-creds.js`. Gestion d'erreurs centralisée : partielle. Refus du PAN brut : vrai pour `payment_tokens`, contredit par `virtual_cards.card_number` et `/cards/enroll`. Webhooks sortants signés : vrai mais secret par défaut. Runner de migrations : vrai mais 26 tables sur ~70. Feature flags : seul `/merchant/tokens` est gaté. `.env.production.example` : **absent**.

## 6. Recommandations
**P0** : révoquer le mot de passe DB et les comptes de démo ; signatures webhooks obligatoires + re-query opérateur avant crédit ; corriger les IDOR (renseigner `cardholder_id`, vérifier le propriétaire GTP, contrôler `type`, scoper partenaires et tickets) ; désactiver (410) les endpoints qui créent de la valeur sans mouvement réel ; `requireRole('super_admin')` sur admin-users/finance/fees/tenants ; hacher les clés API, chiffrer `api_configurations`, retirer les secrets des réponses ; supprimer ou implémenter le stack PCI ; échapper les pages pay-link et retirer le formulaire carte serveur ; déplacer `/live`, `/ready`, `/metrics` avant `/:shortId` et fail-closed sur `/metrics` et `/internal` ; implémenter réellement la 2FA ou retirer les endpoints.
**P1** : `asyncHandler` partout ou Express 5 ; corriger change-password, `req.merchant`, `notify`, `bcrypt`, `axios` ; auth unifiée avec cookies HttpOnly, rotation, révocation, access 15 min ; rate limiting dédié ; idempotence sur `/merchant/*` monétaires ; exporter le DDL réel (`pg_dump -s`) comme migration de référence ; supprimer les routers morts et doublons ; CSV/SSRF ; mettre à jour les dépendances (42 vulnérabilités).
**P2** : tests supertest avec DB jetable ; découper les fichiers de routes ; job de réconciliation unique verrouillé ; un seul barème de frais en unités entières ; remplacer `speakeasy` par `otplib`.
