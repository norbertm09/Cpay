// backend/src/services/rails/gtp-card.service.js
// ================================================================
// CPlus 2.6 — GTP Card Service (SOAP — Partner API Web Service v1.7)
// Endpoint : PartnerAPIWebService.svc  |  Operation unique : Submit
// ================================================================
'use strict';

const { v4: uuidv4 } = require('uuid');
const { callSoap, tagAll, parseFlat } = require('./gtp.client');
const { query } = require('../../config/database');

// ─── Formats GTP ─────────────────────────────────────────────────
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const toGtpDate = (d) => {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return null;
  return `${String(dt.getDate()).padStart(2,'0')}-${MONTHS[dt.getMonth()]}-${dt.getFullYear()}`;
};

const fromGtpDate = (s) => {
  if (!s) return null;
  const m = s.match(/^(\d{2})-([A-Z]{3})-(\d{4})$/i);
  if (!m) return s;
  const mi = MONTHS.indexOf(m[2].toUpperCase());
  return mi === -1 ? s : `${m[3]}-${String(mi+1).padStart(2,'0')}-${m[1]}`;
};

const digits = (p) => String(p || '').replace(/\D/g, '');
const mask = (bin, last4) => (bin && last4) ? `${bin.slice(0,4)} **** **** ${last4}` : null;

// ─── HOTFIX IDOR (audit 2.6.0 §2.5) : contrôle de propriété ──────
// Toute opération sur un gtpCardId exige que la carte appartienne au
// porteur (gtp_cards.cardholder_id). Sinon : 404 (pas d'énumération).
const notOwned = () => Object.assign(new Error('Carte introuvable'),
  { code: 'GTP_CARD_NOT_OWNED', statusCode: 404 });

const assertOwner = async (gtpCardId, cardholderId) => {
  const id = parseInt(gtpCardId, 10);
  if (!cardholderId || !Number.isInteger(id)) throw notOwned();
  const r = await query(
    `SELECT gtp_card_id, last4, status FROM gtp_cards
     WHERE gtp_card_id=$1 AND cardholder_id=$2`, [id, cardholderId]);
  if (!r.rows[0]) throw notOwned();
  return r.rows[0];
};

// ─── PING ────────────────────────────────────────────────────────
const ping = async () => {
  const id = Math.floor(Math.random() * 10000);
  const r = await callSoap('PingRequest', { PingID: id });
  const pong = parseInt(r.parsed.PongID, 10);
  return { success: pong === id + 1, pingId: id, pongId: pong };
};

// ─── EMISSION DE CARTE (Instant Issue) ───────────────────────────
const issueCard = async (cardholderId, data = {}) => {
  const ch = await query(
    `SELECT * FROM cardholders WHERE cardholder_id=$1`, [cardholderId]);
  if (!ch.rows[0]) throw new Error('Porteur introuvable');
  const c = ch.rows[0];

  const ex = await query(
    `SELECT gtp_card_id FROM gtp_cards WHERE cardholder_id=$1 AND status != 'cancelled'`,
    [cardholderId]);
  if (ex.rows[0]) {
    const e = new Error('Carte GTP deja emise');
    e.gtpCardId = ex.rows[0].gtp_card_id;
    throw e;
  }

  const first = data.firstName || c.first_name;
  const last  = data.lastName  || c.last_name;

  const r = await callSoap('InstantRegistrationRequest', {
    CustomerID:      data.customerId,
    FirstName:       first,
    MiddleName:      data.middleName,
    LastName:        last,
    PreferredName:   (data.preferredName || `${first} ${last}`).slice(0, 19),
    OtherCustomerID: String(cardholderId).slice(0, 20),
    Address1:        data.address1 || c.address || 'N/A',
    City:            data.city     || c.city    || 'Brazzaville',
    Country:         data.country  || c.country || 'CG',
    StateRegion:     data.stateRegion || 'BZ',
    PostalCode:      data.postalCode,
    BirthDate:       toGtpDate(data.birthDate || c.date_of_birth),
    IDType:          data.idType || (c.id_type === 'passport' ? 1 : 2),
    IDValue:         data.idValue || c.id_number,
    MobilePhoneNumber: digits(data.mobilePhone || c.phone),
    EmailAddress:    data.email || c.email,
    CustomerSource:  data.customerSource || 'OTHER',
    SubCompany:      data.subCompany || process.env.GTP_SUB_COMPANY,
  });

  const gtpId = parseInt(r.parsed.RegistrationCustomerID, 10);
  const last4 = r.parsed.RegistrationLast4Digits || null;

  await query(
    `INSERT INTO gtp_cards (gtp_card_id, cardholder_id, last4, card_masked,
      cardholder_name, status, currency, country, pass_code)
     VALUES ($1,$2,$3,$4,$5,'active','XAF',$6,$7)`,
    [gtpId, cardholderId, last4,
     last4 ? `**** **** **** ${last4}` : null,
     `${first} ${last}`.toUpperCase(),
     data.country || c.country || 'CG',
     r.parsed.RegistrationPassCode || null]);

  await query(
    `UPDATE cardholders SET gtp_customer_id=$1, gtp_last4=$2, gtp_status='active',
     gtp_registered_at=NOW() WHERE cardholder_id=$3`,
    [gtpId, last4, cardholderId]).catch(() => {});

  return {
    gtpCardId: gtpId,
    last4,
    passCode: r.parsed.RegistrationPassCode || null,
    cardMasked: last4 ? `**** **** **** ${last4}` : null,
  };
};

// ─── SOLDE ───────────────────────────────────────────────────────
const getBalance = async (gtpCardId) => {
  const r = await callSoap('BalanceRequest', { CustomerID: gtpCardId });
  return {
    balance: parseFloat(r.parsed.Balance || 0),
    currency: r.parsed.CurrencyCode || 'XAF',
  };
};

// ─── DETAIL CARTE ────────────────────────────────────────────────
const getCardDetails = async (gtpCardId, cardholderId) => {
  await assertOwner(gtpCardId, cardholderId);
  const [bal, cust, bank] = await Promise.all([
    getBalance(gtpCardId),
    callSoap('CustomerDataRequest', { CustomerID: gtpCardId }).catch(() => ({ parsed: {} })),
    callSoap('BankInfoRequest', { CustomerID: gtpCardId }).catch(() => ({ parsed: {} })),
  ]);
  const p = cust.parsed;
  return {
    gtpCardId: parseInt(gtpCardId, 10),
    balance: bal.balance,
    currency: bal.currency,
    last4: p.L4 || null,
    cardMasked: p.L4 ? `**** **** **** ${p.L4}` : null,
    cardholderName: `${p.FirstName || ''} ${p.LastName || ''}`.trim() || null,
    status: p.CardStatus || 'active',
    mobilePhone: p.MobilePhoneNumber || null,
    email: p.EmailAddress || null,
    birthDate: fromGtpDate(p.BirthDate),
    issuingBank: bank.parsed.IssuingBankID || null,
  };
};

// ─── LISTER LES CARTES ───────────────────────────────────────────
const listCards = async (cardholderId) => {
  const local = await query(
    `SELECT gtp_card_id, last4, card_masked, cardholder_name, status, currency
     FROM gtp_cards WHERE cardholder_id=$1 AND status != 'cancelled'`, [cardholderId]);

  if (!local.rows.length) {
    const ch = await query(`SELECT phone FROM cardholders WHERE cardholder_id=$1`, [cardholderId]);
    if (!ch.rows[0]?.phone) return [];

    const s = await callSoap('CustomerSearchRequest', {
      PhoneNumber: digits(ch.rows[0].phone) });
    const blocks = tagAll(s.data, 'CustomerInfo');
    if (!blocks.length) return [];

    const found = [];
    for (const b of blocks) {
      const p = parseFlat(b);
      const gtpId = parseInt(p.CustomerId, 10);
      await query(
        `INSERT INTO gtp_cards (gtp_card_id, cardholder_id, last4, bin, card_masked,
          cardholder_name, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (gtp_card_id) DO NOTHING`,
        [gtpId, cardholderId, p.LastFourDigits, p.Bin,
         mask(p.Bin, p.LastFourDigits),
         `${p.FirstName || ''} ${p.LastName || ''}`.trim(),
         (p.Status || 'active').toLowerCase()]).catch(() => {});

      const bal = await getBalance(gtpId).catch(() => ({ balance: 0, currency: 'XAF' }));
      found.push({
        gtp_card_id: gtpId,
        cardMasked: mask(p.Bin, p.LastFourDigits),
        last4: p.LastFourDigits,
        cardholderName: `${p.FirstName || ''} ${p.LastName || ''}`.trim(),
        status: (p.Status || 'active').toLowerCase(),
        balance: bal.balance,
        currency: bal.currency,
      });
    }
    return found;
  }

  const out = [];
  for (const c of local.rows) {
    const bal = await getBalance(c.gtp_card_id).catch(() => ({ balance: 0, currency: c.currency }));
    out.push({
      gtp_card_id: c.gtp_card_id,
      cardMasked: c.card_masked,
      last4: c.last4,
      cardholderName: c.cardholder_name,
      status: c.status,
      balance: bal.balance,
      currency: bal.currency,
    });
  }
  return out;
};

// ─── TRANSFERT DE FONDS (coeur du systeme) ───────────────────────
const TRANSFER_TYPES = ['CardToWallet','CardToBank','WalletToCard','BankToCard','Payroll'];

const fundTransfer = async ({ gtpCardId, cardholderId, amount, transferType, memo, mobilePhone, currency }) => {
  if (!TRANSFER_TYPES.includes(transferType))
    throw new Error(`TransferType invalide: ${transferType}`);
  if (!(parseFloat(amount) > 0)) throw new Error('Montant invalide');

  // HOTFIX IDOR : la carte doit appartenir au porteur
  const card = await assertOwner(gtpCardId, cardholderId);

  const r = await callSoap('FundTransferRequest', {
    TransferType:      transferType,
    CustomerID:        gtpCardId,
    TransferAmount:    parseFloat(amount).toFixed(2),
    CurrencyCode:      currency || 'XAF',
    ReferenceMemo:     (memo || 'CPlus').slice(0, 100),
    MobilePhoneNumber: digits(mobilePhone),
    Last4Digits:       card.last4,
    ReturnNewBalance:  'true',
  });

  const txnId = r.parsed.TransactionID;
  const newBal = r.parsed.NewBalance ? parseFloat(r.parsed.NewBalance) : null;

  const typeMap = {
    WalletToCard: 'topup', CardToWallet: 'unload',
    BankToCard:   'bank_transfer_in', CardToBank: 'bank_transfer_out',
    Payroll:      'payroll',
  };

  await query(
    `INSERT INTO gtp_card_transactions (gtp_transaction_id, gtp_card_id, cardholder_id,
      type, transfer_type, amount, currency, running_balance, status, description,
      gtp_request_id, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10,NOW())`,
    [txnId, gtpCardId, cardholderId, typeMap[transferType], transferType,
     parseFloat(amount), currency || 'XAF', newBal, memo, r.requestId]).catch(() => {});

  return { transactionId: txnId, newBalance: newBal, transferType, amount: parseFloat(amount) };
};

// ─── TOPUP / UNLOAD ──────────────────────────────────────────────
const topUp = ({ gtpCardId, cardholderId, amount, operator, mmPhone }) =>
  fundTransfer({
    gtpCardId, cardholderId, amount,
    transferType: 'WalletToCard',
    memo: `TopUp ${operator || 'MM'}`,
    mobilePhone: mmPhone,
  });

const unload = ({ gtpCardId, cardholderId, amount, operator, mmPhone }) =>
  fundTransfer({
    gtpCardId, cardholderId, amount,
    transferType: 'CardToWallet',
    memo: `Unload ${operator || 'MM'}`,
    mobilePhone: mmPhone,
  });

// ─── ITEMS 13/14 : BANQUE ⇄ CARTE ────────────────────────────────
const cardToBank = ({ gtpCardId, cardholderId, amount, bankRef, mobilePhone }) =>
  fundTransfer({
    gtpCardId, cardholderId, amount,
    transferType: 'CardToBank',
    memo: bankRef,
    mobilePhone,
  });

const bankToCard = ({ gtpCardId, cardholderId, amount, bankRef, mobilePhone }) =>
  fundTransfer({
    gtpCardId, cardholderId, amount,
    transferType: 'BankToCard',
    memo: bankRef,
    mobilePhone,
  });

// ─── PAIEMENT (carte a carte) ────────────────────────────────────
const payment = async ({ gtpCardId, cardholderId, toCustomerId, toLast4, amount, description, mobilePhone }) => {
  if (!(parseFloat(amount) > 0)) throw new Error('Montant invalide');
  // HOTFIX IDOR : la carte débitée doit appartenir au porteur
  await assertOwner(gtpCardId, cardholderId);
  const type = mobilePhone ? 'FundTransferCardToCardRequestMobile' : 'FundTransferCardToCardRequest';
  const body = {
    PaymentType:    'C2C',
    FromCustomerID: gtpCardId,
    TransferAmount: parseFloat(amount).toFixed(2),
    CurrencyCode:   'XAF',
    ToCustomerID:   toCustomerId,
    Last4Digits:    toLast4,
    FromCardReferenceMemo: (description || 'Paiement CPlus').slice(0, 100),
    ToCardReferenceMemo:   (description || 'Reception CPlus').slice(0, 100),
  };
  if (mobilePhone) body.MobilePhoneNumber = digits(mobilePhone);

  const r = await callSoap(type, body);
  const txnId = r.parsed.TransactionID;

  await query(
    `INSERT INTO gtp_card_transactions (gtp_transaction_id, gtp_card_id, cardholder_id,
      type, amount, currency, status, description, gtp_request_id, completed_at)
     VALUES ($1,$2,$3,'payment',$4,'XAF','completed',$5,$6,NOW())`,
    [txnId, gtpCardId, cardholderId, parseFloat(amount), description, r.requestId]).catch(() => {});

  return {
    transactionId: txnId,
    newBalance: r.parsed.NewBalance ? parseFloat(r.parsed.NewBalance) : null,
    amount: parseFloat(amount),
  };
};

const paymentToken = payment;  // meme mecanisme, token = customerId

// ─── HISTORIQUE ──────────────────────────────────────────────────
const getTransactions = async (gtpCardId, { startDate, endDate, limit } = {}, cardholderId) => {
  await assertOwner(gtpCardId, cardholderId);
  const now = new Date();
  const start = startDate ? new Date(startDate) : new Date(now.getTime() - 90*86400000);

  const r = await callSoap('TransactionActivityRequest', {
    CustomerID:    gtpCardId,
    StartDate:     toGtpDate(start),
    EndDate:       toGtpDate(endDate || now),
    NumberOfTrans: limit || 100,
  });

  return tagAll(r.data, 'TransactionActivityList').map((b) => {
    const p = parseFlat(b);
    return {
      transactionId: p.TransactionID,
      date: fromGtpDate(p.TransactionDate),
      time: p.TransactionTime,
      amount: parseFloat(p.BaseAmount || 0),
      fee: parseFloat(p.Fee || 0),
      totalAmount: parseFloat(p.TotalAmount || 0),
      runningBalance: parseFloat(p.RunningBalance || 0),
      description: p.TransactionDesc,
      reference: p.ReferenceInformation,
      merchantName: p.MerchantName,
      merchantCity: p.MerchantCity,
      currency: p.TransCurrencyCode || 'XAF',
    };
  });
};

// ─── GEL / REACTIVATION ──────────────────────────────────────────
// Toutes ces opérations exigent le cardholderId propriétaire (HOTFIX IDOR).
const freezeCard = async (gtpCardId, mobilePhone, cardholderId) => {
  const c = await assertOwner(gtpCardId, cardholderId);
  const r = await callSoap('DeactivateCardRequest', {
    CustomerID: gtpCardId,
    Last4Digits: c.last4,
    MobilePhoneNumber: digits(mobilePhone),
  });
  const ok = String(r.parsed.Success).toLowerCase() === 'true';
  if (ok) await query(
    `UPDATE gtp_cards SET status='frozen', updated_at=NOW() WHERE gtp_card_id=$1 AND cardholder_id=$2`,
    [gtpCardId, cardholderId]).catch(() => {});
  return { success: ok };
};

const unfreezeCard = async (gtpCardId, mobilePhone, cardholderId) => {
  const c = await assertOwner(gtpCardId, cardholderId);
  const r = await callSoap('ReactivateCardRequest', {
    CustomerID: gtpCardId,
    Last4Digits: c.last4,
    MobilePhoneNumber: digits(mobilePhone),
  });
  const ok = String(r.parsed.Success).toLowerCase() === 'true';
  if (ok) await query(
    `UPDATE gtp_cards SET status='active', updated_at=NOW() WHERE gtp_card_id=$1 AND cardholder_id=$2`,
    [gtpCardId, cardholderId]).catch(() => {});
  return { success: ok };
};

const cancelCard = async (gtpCardId, mobilePhone, cardholderId) => {
  const r = await freezeCard(gtpCardId, mobilePhone, cardholderId);
  if (r.success) await query(
    `UPDATE gtp_cards SET status='cancelled', updated_at=NOW() WHERE gtp_card_id=$1 AND cardholder_id=$2`,
    [gtpCardId, cardholderId]).catch(() => {});
  return r;
};

// ─── PIN ─────────────────────────────────────────────────────────
const changePin = async (gtpCardId, pin, cardholderId) => {
  await assertOwner(gtpCardId, cardholderId);
  const r = await callSoap('PINChangeRequest', { CustomerID: gtpCardId, PIN: pin });
  return { success: String(r.parsed.Success).toLowerCase() === 'true' };
};

const checkPin = async (gtpCardId, pin, cardholderId) => {
  await assertOwner(gtpCardId, cardholderId);
  const r = await callSoap('PINCheckRequest', { CustomerID: gtpCardId, PIN: pin });
  return { valid: String(r.parsed.Success).toLowerCase() === 'true' };
};

// ─── REVERSAL ────────────────────────────────────────────────────
const reverseTransaction = async (gtpCardId, transactionId, reason, cardholderId) => {
  await assertOwner(gtpCardId, cardholderId);
  const r = await callSoap('FundTransferReverseRequest', {
    CustomerID: gtpCardId,
    TransactionID: transactionId,
    ReferenceMemo: (reason || 'Annulation').slice(0, 100),
  });
  return { reversalTransactionId: r.parsed.TransactionID };
};

module.exports = {
  ping,
  issueCard,
  getBalance,
  getCardDetails,
  listCards,
  fundTransfer,
  topUp,
  unload,
  cardToBank,
  bankToCard,
  payment,
  paymentToken,
  getTransactions,
  freezeCard,
  unfreezeCard,
  cancelCard,
  changePin,
  checkPin,
  reverseTransaction,
  assertOwner,
  toGtpDate,
  fromGtpDate,
  TRANSFER_TYPES,
};
