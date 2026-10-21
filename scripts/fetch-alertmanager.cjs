#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const VERSION = '0.34.1';
async function main() {
  const platform = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!platform || !arch) throw new Error('Unsupported monitoring tool platform');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const cache = path.resolve(__dirname, `../.cache/alertmanager-${VERSION}`);
  if (['alertmanager', 'amtool'].every(name => fs.existsSync(path.join(cache, name + suffix)))) {
    for (const name of ['alertmanager', 'amtool']) {
      const output = execFileSync(path.join(cache, name + suffix), ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!output.includes(VERSION)) throw new Error('Cached monitoring tool version mismatch');
    }
    console.log('Verified monitoring tool version available in local cache'); return;
  }
  const folder = `alertmanager-${VERSION}.${platform}-${arch}`;
  const asset = folder + (process.platform === 'win32' ? '.zip' : '.tar.gz');
  const base = `https://github.com/prometheus/alertmanager/releases/download/v${VERSION}`;
  const sumsResponse = await fetch(`${base}/sha256sums.txt`);
  if (!sumsResponse.ok) throw new Error('Cannot download official checksum');
  const match = (await sumsResponse.text()).split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1]?.replace(/^\*/, '') === asset);
  if (!match || !/^[a-f0-9]{64}$/i.test(match[0])) throw new Error('Official checksum missing');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpay-monitoring-download-'));
  try {
    const archive = path.join(temp, asset), response = await fetch(`${base}/${asset}`);
    if (!response.ok) throw new Error('Cannot download official monitoring tools');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive, { flags: 'wx' }));
    const hash = crypto.createHash('sha256');
    for await (const data of fs.createReadStream(archive)) hash.update(data);
    if (hash.digest('hex') !== match[0].toLowerCase()) throw new Error('Monitoring archive SHA256 mismatch');
    execFileSync('tar', ['-xf', archive, '-C', temp], { stdio: 'pipe', windowsHide: true });
    fs.mkdirSync(cache, { recursive: true });
    for (const name of ['alertmanager', 'amtool']) {
      const output = path.join(cache, name + suffix);
      fs.copyFileSync(path.join(temp, folder, name + suffix), output); fs.chmodSync(output, 0o755);
    }
    console.log(`Official monitoring tools ${VERSION} downloaded and SHA256 verified`);
  } finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
main().catch(() => { console.error('Monitoring tool setup failed (download, integrity or platform).'); process.exitCode = 1; });
