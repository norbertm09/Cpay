'use strict';
// Read-only production reconciliation report: never repairs or reprices historical money.
require('dotenv').config();
const { query,pool }=require('../src/config/database');
(async()=>{
 const checks=[
  ['active_pay_link_duplicates',`SELECT COUNT(*)::int AS n FROM (SELECT pay_link_id FROM transactions WHERE pay_link_id IS NOT NULL AND status IN ('pending','authorized') GROUP BY pay_link_id HAVING COUNT(*)>1) d`],
  ['authorized_missing_or_inconsistent_net',`SELECT COUNT(*)::int AS n FROM transactions WHERE type IN ('collect','qr_payment','pay_link') AND status='authorized' AND (net_amount IS NULL OR fee_amount IS NULL OR net_amount<0 OR fee_amount<0 OR abs(amount-fee_amount-net_amount)>0.001)`],
  ['merchant_currency_mismatch',`SELECT COUNT(*)::int AS n FROM transactions t JOIN merchants m USING(merchant_id) WHERE t.status='authorized' AND t.currency<>m.currency`],
  ['legacy_payouts_needing_reconciliation',`SELECT COUNT(*)::int AS n FROM transactions WHERE settlement_status IN ('en_cours','soumis','echec')`],
  ['settled_queue_without_batch',`SELECT COUNT(*)::int AS n FROM settlement_queue WHERE settled=TRUE AND batch_id IS NULL`],
  ['legacy_settlement_also_in_queue',`SELECT COUNT(*)::int AS n FROM transactions t JOIN settlement_queue q ON q.transaction_id=t.transaction_id WHERE t.settlement_status IN ('regle','soumis','en_cours','echec')`],
 ];
 const tables=await query("SELECT to_regclass('public.card_transactions') AS cards,to_regclass('public.virtual_cards') AS wallets");
 if(tables.rows[0].cards && tables.rows[0].wallets) checks.push(['card_payment_without_merchant_credit',`SELECT COUNT(*)::int AS n FROM card_transactions c WHERE c.type='payment' AND c.status='completed' AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.gateway_name='cpay_wallet' AND t.gateway_payment_id=c.txn_id::text AND t.merchant_id=c.merchant_id AND t.amount=c.amount AND t.currency=c.currency AND t.status='authorized')`]);
 else {console.error('Missing card_transactions/virtual_cards: app wallet schema must be provisioned and reconciled');process.exitCode=1;}
 let blockers=0;
 for(const [name,sql]of checks){const r=await query(sql);const count=Number(r.rows[0].n);console.log(JSON.stringify({check:name,count}));if(count)blockers++;}
 if(blockers){console.error('Reconciliation required. Do not reopen financial traffic or automatically manufacture corrective credits.');process.exitCode=1;}
 else console.log('No anomalies found by these checks; operator statements, migrations and smoke tests still require validation.');
})().catch(err=>{console.error('Financial integrity check failed:',err.message);process.exitCode=1;}).finally(()=>pool.end());
