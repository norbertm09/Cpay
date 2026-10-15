'use strict';
const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'CPlus API',
      version: require('../package.json').version,
      description: `## API de Paiement CPlus — Congo Brazzaville

CPlus est une plateforme de paiement permettant la **collection** et le **décaissement** via Mobile Money (MTN MoMo, Airtel Money) et carte bancaire (CyberSource, MIGS).

### Authentification
Deux méthodes d'authentification sont disponibles :
- **JWT Bearer Token** — pour les applications utilisant un compte merchant
- **API Key** — pour les intégrations serveur-à-serveur (recommandé)

### Environnements
| Environnement | URL |
|---|---|
| Production | https://api.c-pay.global/api/v1 |
| Sandbox | https://api.c-pay.global/api/v1 (avec credentials sandbox) |

### Codes d'erreur
| Code | Description |
|---|---|
| 401 | Non authentifié — Token ou API Key invalide |
| 403 | Permission refusée |
| 422 | Données invalides |
| 500 | Erreur serveur |`,
      contact: {
        name: 'Support CPlus',
        email: 'support@c-pay.global',
        url: 'https://c-pay.global/developers'
      },
      license: { name: 'Propriétaire', url: 'https://c-pay.global/terms' }
    },
    servers: [
      { url: 'https://api.c-pay.global/api/v1', description: 'Production' },
      { url: 'http://localhost:3000/api/v1', description: 'Développement local' }
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Clé API générée depuis le portail merchant (merchant.c-pay.global → API Keys)'
        },
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token JWT obtenu via POST /merchant/auth/login'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Message d\'erreur' },
            code: { type: 'string', example: 'ERROR_CODE' }
          }
        },
        Transaction: {
          type: 'object',
          properties: {
            transaction_id: { type: 'string', format: 'uuid' },
            type: { type: 'string', enum: ['collect', 'disburse'], example: 'collect' },
            amount: { type: 'number', example: 5000 },
            currency: { type: 'string', example: 'XAF' },
            fee_amount: { type: 'number', example: 75 },
            net_amount: { type: 'number', example: 4925 },
            status: { type: 'string', enum: ['pending', 'authorized', 'failed', 'reversed'], example: 'authorized' },
            payment_method: { type: 'string', example: 'airtel_money' },
            auth_code: { type: 'string', example: 'AUTH123456' },
            reference: { type: 'string', example: 'COL-ABC123' },
            customer_phone: { type: 'string', example: '+242060000001' },
            initiated_at: { type: 'string', format: 'date-time' }
          }
        },
        PayLink: {
          type: 'object',
          properties: {
            pay_link_id: { type: 'string', format: 'uuid' },
            short_id: { type: 'string', example: 'ABC12345' },
            short_url: { type: 'string', example: 'https://pay.c-pay.global/ABC12345' },
            amount: { type: 'number', example: 5000 },
            currency: { type: 'string', example: 'XAF' },
            description: { type: 'string', example: 'Commande #001' },
            status: { type: 'string', enum: ['pending', 'paid', 'cancelled', 'expired'] },
            expires_at: { type: 'string', format: 'date-time' },
            psp: { type: 'string', enum: ['cybersource', 'migs'], example: 'cybersource' },
            payment_method: { type: 'string', enum: ['card', 'mobile_money'], example: 'card' }
          }
        }
      }
    },
    tags: [
      { name: 'Auth', description: 'Authentification et gestion des tokens' },
      { name: 'Collection', description: 'Encaissement via MoMo ou carte bancaire' },
      { name: 'Disbursement', description: 'Décaissement vers Mobile Money' },
      { name: 'Pay Links', description: 'Liens de paiement et QR Codes' },
      { name: 'Transactions', description: 'Historique et détail des transactions' },
      { name: 'API Keys', description: 'Gestion des clés API' }
    ],
    paths: {
      // ─── AUTH ────────────────────────────────────────────────
      '/merchant/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Connexion merchant',
          description: 'Authentifie un merchant et retourne un JWT access token (8h) et un refresh token.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['emailOrPhone', 'password'],
                  properties: {
                    emailOrPhone: { type: 'string', example: 'merchant@exemple.com' },
                    password: { type: 'string', format: 'password', example: 'MotDePasse123!' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Connexion réussie',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      access_token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIs...' },
                      refresh_token: { type: 'string' },
                      merchant: {
                        type: 'object',
                        properties: {
                          merchantId: { type: 'string', format: 'uuid' },
                          businessName: { type: 'string', example: 'Ma Boutique' },
                          email: { type: 'string' },
                          kybLevel: { type: 'integer', example: 1 }
                        }
                      }
                    }
                  }
                }
              }
            },
            401: { description: 'Identifiants incorrects', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } }
          }
        }
      },

      // ─── COLLECTION MoMo ─────────────────────────────────────
      '/merchant/public/collect': {
        post: {
          tags: ['Collection'],
          summary: 'Encaissement Mobile Money',
          description: `Initie une demande de paiement Mobile Money vers le téléphone du client.

**Opérateurs supportés (Congo Brazzaville) :**
- \`airtel_money\` — Airtel Money CG
- \`mtn_momo\` — MTN MoMo CG

**Flow :**
1. Appel API → transaction créée avec statut \`pending\`
2. Le client reçoit une notification USSD sur son téléphone
3. Le client confirme avec son PIN MoMo
4. Webhook envoyé à votre endpoint avec le statut final (\`authorized\` ou \`failed\`)

**Délai de confirmation :** 30 secondes à 5 minutes selon l'opérateur.`,
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['amount', 'customerPhone', 'method'],
                  properties: {
                    amount: { type: 'number', minimum: 100, example: 5000, description: 'Montant en XAF (minimum 100)' },
                    currency: { type: 'string', default: 'XAF', example: 'XAF' },
                    customerPhone: { type: 'string', example: '+242060000001', description: 'Numéro de téléphone du client au format international' },
                    method: { type: 'string', enum: ['airtel_money', 'mtn_momo'], example: 'airtel_money', description: 'Opérateur Mobile Money' },
                    description: { type: 'string', example: 'Commande #001', description: 'Description de la transaction (optionnel)' },
                    reference: { type: 'string', example: 'REF-001', description: 'Référence unique de votre système (optionnel)' }
                  }
                },
                examples: {
                  airtel: {
                    summary: 'Encaissement Airtel Money',
                    value: { amount: 5000, currency: 'XAF', customerPhone: '+242060000001', method: 'airtel_money', description: 'Achat produit #001', reference: 'CMD-2026-001' }
                  },
                  mtn: {
                    summary: 'Encaissement MTN MoMo',
                    value: { amount: 10000, currency: 'XAF', customerPhone: '+242055000001', method: 'mtn_momo', description: 'Facture mensuelle', reference: 'FAC-2026-001' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Transaction initiée — en attente de confirmation client',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean', example: true },
                      reference: { type: 'string', example: 'API-XYZ123' },
                      txnId: { type: 'string', format: 'uuid' },
                      status: { type: 'string', example: 'pending', description: 'Statut initial — en attente de confirmation MoMo' },
                      message: { type: 'string', example: 'Demande envoyée au client. En attente de confirmation.' }
                    }
                  },
                  example: { success: true, reference: 'CMD-2026-001', txnId: '550e8400-e29b-41d4-a716-446655440000', status: 'pending' }
                }
              }
            },
            401: { description: 'API Key invalide', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
            403: { description: 'Permission collect non accordée', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
            422: { description: 'Paramètres invalides', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } }
          }
        }
      },

      // ─── COLLECTION CARTE ─────────────────────────────────────
      '/merchant/public/pay-links': {
        post: {
          tags: ['Collection', 'Pay Links'],
          summary: 'Créer un lien de paiement par carte',
          description: `Génère un lien de paiement sécurisé que vous envoyez au client.

**Flow :**
1. Créer le lien → reçoit \`short_url\` (ex: https://pay.c-pay.global/ABC123)
2. Envoyer le lien au client (SMS, WhatsApp, Email)
3. Le client ouvre le lien sur son navigateur
4. Le client saisit ses informations de carte
5. PSP autorise → webhook envoyé → statut \`paid\`

**PSP supportés :**
- \`cybersource\` — CyberSource (Visa/Mastercard)
- \`migs\` — Mastercard Internet Gateway Service

**Expiration :** 24h par défaut.`,
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['amount'],
                  properties: {
                    amount: { type: 'number', minimum: 100, example: 25000, description: 'Montant en XAF' },
                    currency: { type: 'string', default: 'XAF' },
                    description: { type: 'string', example: 'Facture #INV-2026-001' },
                    psp: { type: 'string', enum: ['cybersource', 'migs'], default: 'cybersource', description: 'Processeur de paiement carte' },
                    paymentMethod: { type: 'string', enum: ['card', 'mobile_money'], default: 'card' },
                    recipientPhone: { type: 'string', example: '+242060000001', description: 'Numéro pour envoi automatique du lien par SMS (optionnel)' }
                  }
                },
                examples: {
                  carte: {
                    summary: 'Lien paiement carte CyberSource',
                    value: { amount: 25000, currency: 'XAF', description: 'Facture INV-001', psp: 'cybersource', paymentMethod: 'card' }
                  },
                  avecSMS: {
                    summary: 'Lien + envoi SMS automatique',
                    value: { amount: 15000, currency: 'XAF', description: 'Commande #42', psp: 'cybersource', paymentMethod: 'card', recipientPhone: '+242060000001' }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'Lien créé',
              content: {
                'application/json': {
                  schema: { '$ref': '#/components/schemas/PayLink' },
                  example: { pay_link_id: '550e8400...', short_id: 'ABC12345', short_url: 'https://pay.c-pay.global/ABC12345', amount: 25000, currency: 'XAF', status: 'pending', expires_at: '2026-07-10T10:00:00Z' }
                }
              }
            }
          }
        }
      },

      // ─── DISBURSEMENT ─────────────────────────────────────────
      '/merchant/disburse': {
        post: {
          tags: ['Disbursement'],
          summary: 'Décaissement Mobile Money',
          description: `Envoie des fonds vers un numéro Mobile Money.

**Opérateurs supportés (Congo Brazzaville) :**
- \`airtel_money\` — Airtel Money CG
- \`mtn_momo\` — MTN MoMo CG

**Prérequis :**
- Solde suffisant sur le compte merchant
- KYB niveau 1 minimum
- Permission \`disburse\` sur l'API Key

**Délai de traitement :** Quasi-instantané (< 60 secondes).`,
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['amount', 'recipientPhone', 'operator'],
                  properties: {
                    amount: { type: 'number', minimum: 500, example: 10000, description: 'Montant à envoyer en XAF (minimum 500)' },
                    currency: { type: 'string', default: 'XAF' },
                    recipientPhone: { type: 'string', example: '+242060000001', description: 'Numéro MoMo du bénéficiaire' },
                    operator: { type: 'string', enum: ['airtel_money', 'mtn_momo'], example: 'airtel_money' },
                    description: { type: 'string', example: 'Remboursement commande #42' },
                    reference: { type: 'string', example: 'DISB-001' }
                  }
                },
                examples: {
                  airtel: {
                    summary: 'Décaissement Airtel Money',
                    value: { amount: 10000, currency: 'XAF', recipientPhone: '+242060000001', operator: 'airtel_money', description: 'Remboursement client', reference: 'DISB-2026-001' }
                  },
                  mtn: {
                    summary: 'Décaissement MTN MoMo',
                    value: { amount: 25000, currency: 'XAF', recipientPhone: '+242055000001', operator: 'mtn_momo', description: 'Paiement fournisseur', reference: 'PAY-FOURN-001' }
                  }
                }
              }
            }
          },
          responses: {
            200: {
              description: 'Décaissement initié',
              content: {
                'application/json': {
                  example: { success: true, txnId: '550e8400...', reference: 'DISB-001', status: 'pending', amount: 10000, fee: 150, net: 9850 }
                }
              }
            },
            422: { description: 'Solde insuffisant ou paramètres invalides' }
          }
        }
      },

      // ─── TRANSACTIONS ─────────────────────────────────────────
      '/merchant/public/transactions': {
        get: {
          tags: ['Transactions'],
          summary: 'Liste des transactions',
          description: 'Retourne la liste paginée des transactions du merchant authentifié.',
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: 'Numéro de page' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 }, description: 'Nombre de résultats par page' },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'authorized', 'failed'] }, description: 'Filtrer par statut' },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['collect', 'disburse'] }, description: 'Filtrer par type' }
          ],
          responses: {
            200: {
              description: 'Liste des transactions',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      data: { type: 'array', items: { '$ref': '#/components/schemas/Transaction' } },
                      total: { type: 'integer', example: 150 },
                      page: { type: 'integer', example: 1 },
                      limit: { type: 'integer', example: 20 }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // ─── API KEYS ─────────────────────────────────────────────
      '/merchant/api-keys': {
        get: {
          tags: ['API Keys'],
          summary: 'Lister les API Keys',
          description: 'Retourne la liste des API Keys du merchant (clés masquées).',
          security: [{ BearerAuth: [] }],
          responses: {
            200: {
              description: 'Liste des clés',
              content: {
                'application/json': {
                  example: { data: [{ key_id: 'uuid', key_name: 'Mon App', api_key: 'sk_live_xxxx****yyyy', is_active: true, permissions: ['collect', 'transactions'], last_used_at: '2026-07-09T10:00:00Z' }] }
                }
              }
            }
          }
        },
        post: {
          tags: ['API Keys'],
          summary: 'Créer une API Key',
          description: `Génère une nouvelle paire clé/secret.

**⚠️ Important :** La clé secrète (\`api_secret\`) n'est affichée qu'une seule fois à la création. Conservez-la en lieu sûr.`,
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['keyName'],
                  properties: {
                    keyName: { type: 'string', example: 'Application Mobile v2' },
                    permissions: { type: 'array', items: { type: 'string', enum: ['collect', 'disburse', 'transactions', 'pay_links'] }, example: ['collect', 'transactions'] }
                  }
                }
              }
            }
          },
          responses: {
            201: {
              description: 'Clé créée — secret affiché une seule fois',
              content: {
                'application/json': {
                  example: { success: true, message: 'Conservez ces credentials — ils ne seront plus affichés.', key: { api_key: 'sk_live_abc123...', api_secret: 'sk_secret_xyz789...', permissions: ['collect', 'transactions'] } }
                }
              }
            }
          }
        }
      }
    }
  },
  apis: []
};

const specs = swaggerJsdoc(options);

// ─── Partners paths ───────────────────────────────────────────────
const partnersTags = [
  { name:'Partners Auth',         description:'Authentification partenaires (Banque / Agence / Agent)' },
  { name:'Partners Dashboard',    description:'Statistiques et KPIs par profil' },
  { name:'Partners Agencies',     description:'Gestion des agences' },
  { name:'Partners Agents',       description:'Gestion des agents et flottants' },
  { name:'Partners Transactions', description:'Transactions agents' },
  { name:'Partners Rapport',      description:'Rapports consolidés' },
  { name:'Partners 2FA',          description:'Double authentification' },
  { name:'Tenants',               description:'Configuration multi-tenant' },
];

const partnersPaths = {
  '/partners/auth/login': { post: { tags:['Partners Auth'], summary:'Connexion partenaire',
    description:'Authentifie un utilisateur partenaire et retourne un JWT (8h).\n\n**Rôles:** bank_admin, bank_user, agency_admin, agency_user, customer_care, caissier_maker, caissier_checker, controleur, financier, agent',
    requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['email','password'],
      properties:{ email:{type:'string',example:'bank@cplus.africa'}, password:{type:'string',example:'Bank@CPlus2026'} } } } } },
    responses:{ 200:{ description:'Connexion réussie', content:{ 'application/json':{ example:{
      access_token:'eyJhbGciOiJIUzI1NiIs...', refresh_token:'eyJ...',
      user:{ id:'uuid', name:'Admin Banque', email:'bank@cplus.africa', role:'bank_admin', bankName:'Banque Centrale CPlus' }
    }}}}, 401:{ description:'Identifiants incorrects' } } } },

  '/partners/auth/forgot-password': { post: { tags:['Partners Auth'], summary:'Code de réinitialisation',
    requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['email'], properties:{ email:{type:'string'} } } } } },
    responses:{ 200:{ description:'Code envoyé par email' } } } },

  '/partners/auth/reset-password': { post: { tags:['Partners Auth'], summary:'Réinitialiser le mot de passe',
    requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['email','code','newPassword'],
      properties:{ email:{type:'string'}, code:{type:'string',example:'123456'}, newPassword:{type:'string',minLength:8} } } } } },
    responses:{ 200:{ description:'Mot de passe réinitialisé ✅' }, 400:{ description:'Code invalide ou expiré' } } } },

  '/partners/auth/change-password': { post: { tags:['Partners Auth'], summary:'Changer son mot de passe',
    security:[{BearerAuth:[]}],
    requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['currentPassword','newPassword'],
      properties:{ currentPassword:{type:'string'}, newPassword:{type:'string',minLength:8} } } } } },
    responses:{ 200:{ description:'Mot de passe modifié ✅' }, 401:{ description:'Mot de passe actuel incorrect' } } } },

  '/partners/dashboard': { get: { tags:['Partners Dashboard'], summary:'KPIs dashboard par profil',
    security:[{BearerAuth:[]}],
    parameters:[
      { name:'agencyId', in:'query', schema:{ type:'string', format:'uuid' }, description:'Filtrer par agence (Bank Admin)' },
      { name:'agentId',  in:'query', schema:{ type:'string', format:'uuid' }, description:'Filtrer par agent' }
    ],
    responses:{ 200:{ description:'KPIs', content:{ 'application/json':{ example:{
      role:'bank', agencies:5, agents:32, txnsToday:128, volumeToday:6450000, volumeMonth:185000000
    }}}}} } },

  '/partners/agencies': {
    get:{ tags:['Partners Agencies'], summary:'Lister les agences', security:[{BearerAuth:[]}],
      responses:{ 200:{ description:'Liste des agences', content:{ 'application/json':{ example:{
        data:[{ agency_id:'uuid', agency_name:'Agence Brazzaville Centre', agency_code:'AGC-BZV-001', float_balance:1000000, status:'active', agent_count:8 }]
      }}}}} },
    post:{ tags:['Partners Agencies'], summary:'Créer une agence (bank_admin)', security:[{BearerAuth:[]}],
      requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['agencyName','agencyCode'],
        properties:{ agencyName:{type:'string',example:'Agence Pointe-Noire'}, agencyCode:{type:'string',example:'AGC-PNR-001'},
          city:{type:'string'}, address:{type:'string'}, contactPhone:{type:'string'}, floatBalance:{type:'number',example:500000} } } } } },
      responses:{ 201:{ description:'Agence créée ✅' }, 403:{ description:'Permission insuffisante' } } }
  },

  '/partners/agents': {
    get:{ tags:['Partners Agents'], summary:'Lister les agents', security:[{BearerAuth:[]}],
      responses:{ 200:{ description:'Liste des agents', content:{ 'application/json':{ example:{
        data:[{ agent_id:'uuid', first_name:'Jean', last_name:'Agent', email:'agent@banque.cg', float_balance:150000, float_limit:500000, status:'active' }]
      }}}}} },
    post:{ tags:['Partners Agents'], summary:'Créer un agent', security:[{BearerAuth:[]}],
      requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['firstName','email'],
        properties:{ firstName:{type:'string'}, lastName:{type:'string'}, email:{type:'string'}, phone:{type:'string'},
          agencyId:{type:'string',format:'uuid'}, floatLimit:{type:'number',default:500000} } } } } },
      responses:{ 201:{ description:'Agent créé', content:{ 'application/json':{ example:{
        agent_id:'uuid', email:'agent@banque.cg', tempPassword:'Agent@A1B2C3'
      }}}}} }
  },

  '/partners/agents/{agentId}/float': { patch:{ tags:['Partners Agents'], summary:'Gérer flottant agent',
    security:[{BearerAuth:[]}],
    parameters:[{ name:'agentId', in:'path', required:true, schema:{ type:'string', format:'uuid' } }],
    requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['amount'],
      properties:{ amount:{type:'number',minimum:1,example:100000}, type:{type:'string',enum:['float_in','float_out'],default:'float_in'} } } } } },
    responses:{ 200:{ description:'Flottant mis à jour ✅' }, 400:{ description:'Montant invalide ou solde insuffisant' } } } },

  '/partners/collect': { post:{ tags:['Partners Transactions'], summary:'Encaissement Mobile Money (Agent)',
    description:'Initie un encaissement. **Frais:** 1.5%. **Rôle:** agent uniquement.',
    security:[{BearerAuth:[]}],
    requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['amount','customerPhone','method'],
      properties:{ amount:{type:'number',minimum:100,example:5000}, customerPhone:{type:'string',example:'+242060000001'},
        method:{type:'string',enum:['airtel_money','mtn_momo'],example:'airtel_money'}, description:{type:'string'}, reference:{type:'string'} } },
      examples:{ airtel:{ summary:'Airtel Money', value:{ amount:5000, customerPhone:'+242060000001', method:'airtel_money' } },
        mtn:{ summary:'MTN MoMo', value:{ amount:10000, customerPhone:'+242055000001', method:'mtn_momo' } } } } } },
    responses:{ 200:{ description:'Encaissement réussi', content:{ 'application/json':{ example:{
      success:true, txnId:'uuid', reference:'AGT-XYZ123', status:'completed', amount:5000, fee:75, net:4925
    }}}}, 400:{ description:'Erreur' }, 403:{ description:'Rôle agent requis' } } } },

  '/partners/disburse': { post:{ tags:['Partners Transactions'], summary:'Décaissement Mobile Money (Agent)',
    description:'Envoie des fonds depuis le flottant. **Frais:** 1%. **Prérequis:** solde suffisant.',
    security:[{BearerAuth:[]}],
    requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['amount','recipientPhone','method'],
      properties:{ amount:{type:'number',minimum:500,example:10000}, recipientPhone:{type:'string',example:'+242060000001'},
        method:{type:'string',enum:['airtel_money','mtn_momo']}, description:{type:'string'}, reference:{type:'string'} } } } } },
    responses:{ 200:{ description:'Décaissement réussi', content:{ 'application/json':{ example:{
      success:true, txnId:'uuid', reference:'DSB-001', status:'completed', amount:10000, fee:100
    }}}}, 400:{ description:'Solde flottant insuffisant' } } } },

  '/partners/transactions': { get:{ tags:['Partners Transactions'], summary:'Historique transactions',
    security:[{BearerAuth:[]}],
    parameters:[
      { name:'page',     in:'query', schema:{ type:'integer', default:1 } },
      { name:'limit',    in:'query', schema:{ type:'integer', default:20, maximum:100 } },
      { name:'status',   in:'query', schema:{ type:'string', enum:['pending','completed','failed'] } },
      { name:'type',     in:'query', schema:{ type:'string', enum:['collect','disburse','float_in','float_out'] } },
      { name:'agencyId', in:'query', schema:{ type:'string', format:'uuid' } },
      { name:'agentId',  in:'query', schema:{ type:'string', format:'uuid' } },
      { name:'dateFrom', in:'query', schema:{ type:'string', format:'date' }, example:'2026-07-01' },
      { name:'dateTo',   in:'query', schema:{ type:'string', format:'date' }, example:'2026-07-31' },
    ],
    responses:{ 200:{ description:'Liste paginée', content:{ 'application/json':{ example:{
      data:[{ txn_id:'uuid', type:'collect', amount:5000, fee_amount:75, status:'completed', agent_name:'Jean Agent', initiated_at:'2026-07-12T10:00:00Z' }],
      total:150, volume:750000, page:1, limit:20
    }}}}} } },

  '/partners/transactions/report': { get:{ tags:['Partners Rapport'], summary:'Rapport consolidé',
    security:[{BearerAuth:[]}],
    parameters:[
      { name:'dateFrom', in:'query', required:true, schema:{ type:'string', format:'date' } },
      { name:'dateTo',   in:'query', required:true, schema:{ type:'string', format:'date' } },
      { name:'agencyId', in:'query', schema:{ type:'string', format:'uuid' } },
      { name:'agentId',  in:'query', schema:{ type:'string', format:'uuid' } },
      { name:'groupBy',  in:'query', schema:{ type:'string', enum:['day','week','month'], default:'day' } },
    ],
    responses:{ 200:{ description:'Rapport', content:{ 'application/json':{ example:{
      totals:{ total_txns:500, total_volume:25000000, total_fees:375000 },
      byPeriod:[{ period:'2026-07-01', count:45, volume:2250000, fees:33750 }],
      topAgents:[{ agent_name:'Jean Agent', agency_name:'Agence Centre', count:120, volume:6000000 }]
    }}}}} } },

  '/partners/auth/2fa/status':  { get:  { tags:['Partners 2FA'], summary:'Statut 2FA', security:[{BearerAuth:[]}],
    responses:{ 200:{ description:'Statut', content:{ 'application/json':{ example:{ mfaEnabled:false } } } } } } },
  '/partners/auth/2fa/setup':   { post: { tags:['Partners 2FA'], summary:'Initialiser la 2FA', security:[{BearerAuth:[]}],
    responses:{ 200:{ description:'Secret + QR Code', content:{ 'application/json':{ example:{ secret:'BASE32SECRET', qrCode:'otpauth://totp/...' } } } } } } },
  '/partners/auth/2fa/verify':  { post: { tags:['Partners 2FA'], summary:'Activer la 2FA', security:[{BearerAuth:[]}],
    requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['token','secret'],
      properties:{ token:{type:'string',example:'123456'}, secret:{type:'string'} } } } } },
    responses:{ 200:{ description:'2FA activée ✅' } } } },
  '/partners/auth/2fa/disable': { post: { tags:['Partners 2FA'], summary:'Désactiver la 2FA', security:[{BearerAuth:[]}],
    requestBody:{ required:true, content:{ 'application/json':{ schema:{ type:'object', required:['token'],
      properties:{ token:{type:'string',example:'123456'} } } } } },
    responses:{ 200:{ description:'2FA désactivée' } } } },

  '/partners/tenant/config': { get:{ tags:['Tenants'], summary:'Configuration du tenant courant',
    description:'Retourne la configuration visuelle basée sur le subdomain appelant.',
    responses:{ 200:{ description:'Config tenant', content:{ 'application/json':{ example:{
      tenant_id:'uuid', display_name:'Banque Centrale CPlus', primary_color:'#12b6c7',
      secondary_color:'#1d4f92', accent_color:'#00c896', subdomain:'bcplus'
    }}}}} } },
};

specs.tags  = [...(specs.tags||[]), ...partnersTags];
specs.paths = { ...specs.paths, ...partnersPaths };
module.exports = specs;
