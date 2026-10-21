'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startPortalServer } = require('./serve-portals.cjs');
test('loopback SPA server refuses missing assets, traversal and occupied ports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpay-browser-server-'));
  let server;
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>fixture</html>');
    fs.writeFileSync(path.join(dir, 'app.js'), '/* fixture */');
    server = await startPortalServer({ root: dir, port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/operations/caisse`)).status, 200);
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'application/javascript');
    assert.equal((await fetch(`${base}/%2e%2e%2fprivate`)).status, 403);
    await assert.rejects(startPortalServer({ root: dir, port: server.address().port }), /EADDRINUSE/);
    await assert.rejects(startPortalServer({ root: dir, port: 0, host: '0.0.0.0' }), /loopback/);
  } finally { if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } fs.rmSync(dir, { recursive: true, force: true }); }
});
test('missing build fails before opening a server', async () => {
  await assert.rejects(startPortalServer({ root: path.join(os.tmpdir(), 'missing-cpay-build-fixture'), port: 0 }), /build/);
});
