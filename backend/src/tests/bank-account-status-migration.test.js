'use strict';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const ddl = fs.readFileSync(path.join(__dirname, '../../database/009_wave4_cash.sql'), 'utf8');
const bankDdl = ddl.slice(ddl.indexOf('CREATE TABLE IF NOT EXISTS financial_institutions'), ddl.indexOf('-- ─── 3.'));
const migration = path.join(__dirname, '../../database/012_bank_account_validation.sql');
test('versioned bank schema accepts pending_verification after upgrade, without losing legacy accounts', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(bankDdl);
    await pg.exec(`INSERT INTO bank_accounts(owner_type,owner_id,account_number,account_name,status) VALUES ('merchant','11111111-1111-4111-8111-111111111111','123456789','OLD','verified');`);
    if (fs.existsSync(migration)) { const sql = fs.readFileSync(migration, 'utf8'); await pg.exec(sql); await pg.exec(sql); }
    await expect(pg.query(`INSERT INTO bank_accounts(owner_type,owner_id,account_number,account_name,status) VALUES ('merchant','11111111-1111-4111-8111-111111111111','987654321','NEW','pending_verification') RETURNING status`)).resolves.toMatchObject({ rows: [{ status: 'pending_verification' }] });
    expect((await pg.query("SELECT account_name,status FROM bank_accounts WHERE account_name='OLD'")).rows).toEqual([{account_name:'OLD',status:'verified'}]);
  } finally { await pg.close(); }
}, 60000);
