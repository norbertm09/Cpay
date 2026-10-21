'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };
async function startPortalServer({ root, port, host = '127.0.0.1' }) {
  if (host !== '127.0.0.1') throw new Error('Only loopback binding is permitted');
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error('Portal build missing');
  const base = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (_) { res.writeHead(400).end(); return; }
    const file = path.resolve(base, '.' + pathname);
    if (pathname.includes('\0') || (file !== base && !file.startsWith(base + path.sep))) { res.writeHead(403).end(); return; }
    let target = file;
    try {
      if (!fs.statSync(target).isFile()) throw new Error('not a file');
    } catch (_) {
      if (path.extname(pathname) || pathname.startsWith('/api/')) { res.writeHead(404).end(); return; }
      target = path.join(base, 'index.html');
    }
    const real = fs.realpathSync(target);
    if (!real.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
module.exports = { startPortalServer };
if (require.main === module) {
  const servers = [];
  const close = () => { for (const s of servers) { s.closeAllConnections(); s.close(); } };
  (async () => {
    for (const [portal, port] of [['cardholder', 4311], ['merchant', 4312], ['admin', 4313]]) {
      servers.push(await startPortalServer({ root: path.resolve(__dirname, `../portal/${portal}/build`), port }));
    }
    console.log('Three recipe portals listening on loopback');
  })().catch(err => { console.error(`Recipe server failed: ${err.code || err.message}`); close(); process.exitCode = 1; });
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
