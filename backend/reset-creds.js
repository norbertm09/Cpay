const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const DB_URL = `postgresql://cplus_user:Pinzi131416@am1622114-001.eu.clouddb.ovh.net:35534/cplus_db?sslmode=require`;

async function main() {
  const [mHash, cHash, aHash] = await Promise.all([
    bcrypt.hash('Merchant@2024', 12),
    bcrypt.hash('Card@Holder2024', 12),
    bcrypt.hash('Admin@CPlus2024', 12),
  ]);

  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  // Reset merchant
  const mr = await client.query(
    `UPDATE merchants SET password_hash=$1 WHERE email='merchant@cplus.africa' RETURNING email`,
    [mHash]
  );
  console.log('Merchant reset:', mr.rowCount, 'row(s)');

  // Reset cardholder
  const cr = await client.query(
    `UPDATE cardholders SET password_hash=$1, failed_attempts=0, locked_until=NULL WHERE email='cardholder@cplus.africa' RETURNING email`,
    [cHash]
  );
  console.log('Cardholder reset:', cr.rowCount, 'row(s)');

  // Reset admin
  const ar = await client.query(
    `UPDATE admin_users SET password_hash=$1 WHERE email='admin@cplus.africa' RETURNING email`,
    [aHash]
  );
  console.log('Admin reset:', ar.rowCount, 'row(s)');

  // Vérifier tables disponibles
  if (mr.rowCount === 0) {
    const t = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('merchants','cardholders','admin_users','users')`);
    console.log('Tables:', t.rows.map(r=>r.table_name));
  }

  await client.end();
}
main().catch(console.error);
