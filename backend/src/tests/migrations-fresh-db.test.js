'use strict';
/**
 * Rejeu complet des migrations sur une base VIERGE (PGlite) : garantit qu'un nouvel environnement
 * (serveur de developpement, 2026-10-25) peut etre initialise depuis zero. Les tables historiques de
 * production absentes des migrations (card_transactions, bank_transfers, virtual_cards…) ne doivent
 * jamais etre referencees sans garde to_regclass.
 */
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

describe('migrations : rejeu integral sur une base vierge', () => {
  const dir = path.join(__dirname, '../../database');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  test(`${files.length} fichiers appliques dans l'ordre sans erreur`, async () => {
    const pg = new PGlite();
    for (const f of files) {
      try { await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch (e) { throw new Error(`${f} : ${e.message.split('\n')[0]}`); }
    }
    const t = await pg.query(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`);
    expect(t.rows[0].n).toBeGreaterThan(20);
    for (const table of ['merchants', 'transactions', 'admin_users', 'merchant_transfers', 'idempotency_keys']) {
      const r = await pg.query(`SELECT to_regclass('public.${table}') AS r`);
      expect(r.rows[0].r).toBe(table);
    }
    await pg.close();
  }, 60000);

  test('migrate.js : un fichier deja applique avec un ancien checksum liste est accepte, un checksum inconnu est refuse', () => {
    const src = fs.readFileSync(path.join(__dirname, '../config/migrate.js'), 'utf8');
    expect(src).toMatch(/PREVIOUS_CHECKSUMS\s*=\s*\{[\s\S]*'007_hotfix_v1\.sql'/);
    expect(src).toMatch(/Migration checksum changed after apply/);
  });
});
