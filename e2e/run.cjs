'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startPortalServer } = require('./serve-portals.cjs');
const servers = [];
let child;
const stop = () => { if (child && child.exitCode === null) child.kill(); for (const s of servers) { s.closeAllConnections(); s.close(); } };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
(async () => {
  try {
    for (const [portal, port] of [['cardholder', 4311], ['merchant', 4312], ['admin', 4313]]) servers.push(await startPortalServer({ root: path.resolve(__dirname, `../portal/${portal}/build`), port }));
    const code = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', ...process.argv.slice(2)], { cwd: __dirname, stdio: 'inherit', windowsHide: true });
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
    });
    process.exitCode = code;
  } finally { stop(); }
})().catch(err => { console.error(`Browser recipe failed: ${err.code || err.message}`); process.exitCode = 1; });
