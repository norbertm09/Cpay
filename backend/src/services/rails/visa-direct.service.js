'use strict';

const { request } = require('./visa.client');

const ensureOk = (result, label) => {
  if (result.statusCode >= 200 && result.statusCode < 300) return result.body;
  const err = new Error(result.body?.message || result.body?.responseStatus?.message || `${label} failed`);
  err.statusCode = result.statusCode;
  err.response = result.body;
  throw err;
};

const stan = () => String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
const rrn = () => `${new Date().getFullYear().toString().slice(-1)}${String(Date.now()).slice(-11)}`.slice(0, 12);
const nowIsoNoMs = () => new Date().toISOString().replace(/\.\d{3}Z$/, '');

const baseFundsPayload = ({ txnId, amount, currency, sender = {}, recipient = {}, cardAcceptor = {} }) => ({
  acquiringBin: Number(process.env.VISA_ACQUIRING_BIN),
  acquirerCountryCode: Number(process.env.VISA_ACQUIRER_COUNTRY_CODE || 840),
  businessApplicationId: process.env.VISA_BUSINESS_APPLICATION_ID || 'AA',
  localTransactionDateTime: nowIsoNoMs(),
  retrievalReferenceNumber: rrn(),
  systemsTraceAuditNumber: Number(stan()),
  transactionCurrencyCode: currency,
  amount: Number(amount),
  senderName: sender.name || process.env.VISA_SENDER_NAME || 'C-Pay Merchant',
  senderAddress: sender.address || process.env.VISA_SENDER_ADDRESS || 'CPlus',
  senderCountryCode: sender.countryCode || process.env.VISA_SENDER_COUNTRY_CODE || '180',
  senderAccountNumber: sender.accountNumber || process.env.VISA_SENDER_ACCOUNT_NUMBER,
  recipientName: recipient.name || 'Recipient',
  cardAcceptor: {
    name: cardAcceptor.name || process.env.VISA_CARD_ACCEPTOR_NAME || 'CPlus',
    terminalId: cardAcceptor.terminalId || process.env.VISA_CARD_ACCEPTOR_TERMINAL_ID || 'TERM0001',
    idCode: cardAcceptor.idCode || process.env.VISA_CARD_ACCEPTOR_ID_CODE || 'CPLUS0000000001',
    address: cardAcceptor.address || { country: process.env.VISA_CARD_ACCEPTOR_COUNTRY || 'COD' },
  },
  merchantCategoryCode: process.env.VISA_MCC || '6012',
  transactionIdentifier: Number(String(txnId).replace(/\D/g, '').slice(0, 15).padEnd(15, '0')),
});

const pushFunds = async ({ txnId, amount, currency = 'USD', recipientPrimaryAccountNumber, sender = {}, recipient = {}, cardAcceptor = {}, extra = {} }) => {
  const body = {
    ...baseFundsPayload({ txnId, amount, currency, sender, recipient, cardAcceptor }),
    recipientPrimaryAccountNumber,
    ...extra,
  };
  const result = await request({
    method: 'POST',
    path: '/visadirect/fundstransfer/v1/pushfundstransactions',
    body,
  });
  return ensureOk(result, 'Visa Direct push funds');
};

const pullFunds = async ({ txnId, amount, currency = 'USD', senderPrimaryAccountNumber, senderCardExpiryDate, sender = {}, cardAcceptor = {}, extra = {} }) => {
  const body = {
    ...baseFundsPayload({ txnId, amount, currency, sender, cardAcceptor }),
    senderPrimaryAccountNumber,
    senderCardExpiryDate,
    senderCurrencyCode: currency,
    ...extra,
  };
  const result = await request({
    method: 'POST',
    path: '/visadirect/fundstransfer/v1/pullfundstransactions',
    body,
  });
  return ensureOk(result, 'Visa Direct pull funds');
};

const queryTransaction = async (query) => {
  const result = await request({
    method: 'GET',
    path: '/visadirect/v1/transactionquery',
    query: {
      acquiringBIN: query.acquiringBIN || process.env.VISA_ACQUIRING_BIN,
      stan: query.stan,
      rrn: query.rrn,
      requestType: query.requestType,
      transactionIdentifier: query.transactionIdentifier,
      caid: query.caid,
      transactionStartDate: query.transactionStartDate,
      transactionEndDate: query.transactionEndDate,
      fields: query.fields,
      limit: query.limit,
      offset: query.offset,
    },
  });
  return ensureOk(result, 'Visa Direct transaction query');
};

const accountWalletPayout = async ({ txnId, amount, currency, payoutMethod = 'W', recipientDetail, senderDetail, extra = {} }) => {
  const body = {
    recipientDetail,
    senderDetail: senderDetail || {
      name: process.env.VISA_PAYOUT_SENDER_NAME || 'CPlus',
      type: process.env.VISA_PAYOUT_SENDER_TYPE || 'C',
      senderAccountNumber: process.env.VISA_PAYOUT_SENDER_ACCOUNT_NUMBER || 'CPLUS',
      address: { country: process.env.VISA_PAYOUT_SENDER_COUNTRY || 'COD', city: process.env.VISA_PAYOUT_SENDER_CITY || 'Kinshasa', addressLine1: process.env.VISA_PAYOUT_SENDER_ADDRESS || 'CPlus' },
    },
    payoutMethod,
    transactionDetail: {
      initiatingPartyId: Number(process.env.VISA_PAYOUT_INITIATING_PARTY_ID),
      businessApplicationId: process.env.VISA_PAYOUT_BUSINESS_APPLICATION_ID || 'FD',
      statementNarrative: process.env.VISA_PAYOUT_NARRATIVE || 'C-Pay payout',
      transactionAmount: Number(amount),
      transactionCurrencyCode: currency,
      settlementCurrencyCode: process.env.VISA_PAYOUT_SETTLEMENT_CURRENCY || currency,
      clientReferenceId: txnId,
      senderSourceOfFunds: process.env.VISA_PAYOUT_SOURCE_OF_FUNDS || '01',
    },
    ...extra,
  };
  const result = await request({ method: 'POST', path: '/visapayouts/v3/payouts', body });
  return ensureOk(result, 'Visa Account and Wallet payout');
};

const validateAccountWalletPayout = async (payload) => {
  const result = await request({ method: 'POST', path: '/visapayouts/v3/payouts/validate', body: payload });
  return ensureOk(result, 'Visa Account and Wallet payout validation');
};

const queryPayout = async ({ id, idType = 'CLIENT_REFERENCE_ID', initiatingPartyId }) => {
  const result = await request({
    method: 'GET',
    path: '/visapayouts/v3/payouts',
    query: { id, idType, initiatingPartyId: initiatingPartyId || process.env.VISA_PAYOUT_INITIATING_PARTY_ID },
  });
  return ensureOk(result, 'Visa payout query');
};

const getAccountBalance = async ({ initiatingPartyId, currencyCode } = {}) => {
  const result = await request({
    method: 'GET',
    path: '/visapayouts/v3/payouts/accountBalance',
    query: { initiatingPartyId: initiatingPartyId || process.env.VISA_PAYOUT_INITIATING_PARTY_ID, currencyCode },
  });
  return ensureOk(result, 'Visa payout account balance');
};

module.exports = {
  pushFunds,
  pullFunds,
  queryTransaction,
  accountWalletPayout,
  validateAccountWalletPayout,
  queryPayout,
  getAccountBalance,
};
