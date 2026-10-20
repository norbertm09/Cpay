'use strict';
const { enqueue } = require('./settlement.engine');
// enqueue({ txnId, merchantId, amount, currency }, client?) — `client` : transaction SQL en cours (WAVE-6)
module.exports = { enqueue };
