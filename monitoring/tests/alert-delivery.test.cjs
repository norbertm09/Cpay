'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { startSmtpFixture } = require('./smtp-fixture.cjs');
const { loadMonitoringSettings, renderAlertmanagerConfig, writeConfig } = require('../alertmanager/config.cjs');
const root = path.resolve(__dirname, '../..');
const ext = process.platform === 'win32' ? '.exe' : '';
const bin = name => process.env[`${name.toUpperCase()}_BIN`] || path.join(root, '.cache/alertmanager-0.34.1', name + ext);
const openssl = process.env.OPENSSL_BIN || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await wait(200); }
  throw new Error('Local alert delivery assertion timed out');
}
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function scenario({ trust = true, transientRejects = 0 }, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpay-alert-test-'));
  let smtp, child;
  try {
    const cert = path.join(dir, 'local.crt'), key = path.join(dir, 'local.key');
    const opensslConfig = path.join(dir, 'openssl.cnf');
    fs.writeFileSync(opensslConfig, '[req]\ndistinguished_name=dn\n[dn]\n');
    execFileSync(openssl, ['req', '-config', opensslConfig, '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe', windowsHide: true });
    smtp = await startSmtpFixture({ cert: fs.readFileSync(cert), key: fs.readFileSync(key), transientRejects });
    const passwordFile = path.join(dir, 'smtp.secret'), metricsFile = path.join(dir, 'metrics.secret');
    fs.writeFileSync(passwordFile, 'local-fixture-password', { mode: 0o600 }); fs.writeFileSync(metricsFile, 'local-fixture-metrics', { mode: 0o600 });
    const settings = loadMonitoringSettings({ ALERT_SMTP_HOST: '127.0.0.1', ALERT_SMTP_PORT: String(smtp.port), ALERT_SMTP_USER: 'fixture',
      ALERT_SMTP_FROM: 'alerts@example.test', ALERT_SMTP_TO: 'ops@example.test', ALERT_SMTP_PASSWORD_FILE: passwordFile,
      MONITORING_METRICS_TOKEN_FILE: metricsFile, ...(trust ? { ALERT_SMTP_CA_FILE: cert } : {}) });
    const config = renderAlertmanagerConfig(settings, { templateFile: path.join(root, 'monitoring/alertmanager/alerts.tmpl') });
    Object.assign(config.route, { group_wait: '1s', group_interval: '1s' });
    const configFile = path.join(dir, 'alertmanager.yml'); writeConfig(configFile, config);
    execFileSync(bin('amtool'), ['check-config', configFile], { stdio: 'pipe', windowsHide: true });
    const port = await freePort();
    child = spawn(bin('alertmanager'), [`--config.file=${configFile}`, `--storage.path=${path.join(dir, 'data')}`, `--web.listen-address=127.0.0.1:${port}`, '--cluster.listen-address='], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error; child.on('error', err => { error = err; });
    child.stdout.resume(); child.stderr.resume();
    const base = `http://127.0.0.1:${port}`;
    await until(async () => { if (error) throw error; if (child.exitCode !== null) throw new Error('Alertmanager exited'); try { return (await fetch(`${base}/-/ready`)).ok; } catch (_) { return false; } });
    const post = async resolved => {
      const r = await fetch(`${base}/api/v2/alerts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{
        labels: { alertname: 'LocalFixtureAlert', service: 'fixture', severity: 'warning', private_field: 'fixture-sensitive-marker' },
        annotations: { summary: 'Local fixture ' + 'x'.repeat(250) + 'summary-tail-not-permitted', description: 'fixture-sensitive-marker' },
        startsAt: new Date(Date.now() - 10000).toISOString(), endsAt: new Date(Date.now() + (resolved ? -1000 : 120000)).toISOString(),
      }]) }); assert.equal(r.status, 200);
    };
    await run({ smtp, post, base });
  } finally {
    if (child && child.exitCode === null && child.pid) { child.kill(); await Promise.race([once(child, 'exit'), wait(5000)]); }
    if (smtp) await smtp.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test('trusted STARTTLS delivers firing then resolved with bounded non-sensitive content', { timeout: 90000 }, async () => {
  await scenario({}, async ({ smtp, post }) => {
    await post(false); await until(() => smtp.messages.some(m => m.includes('[firing]')));
    await post(true); await until(() => smtp.messages.some(m => m.includes('[resolved]')));
    assert.doesNotMatch(smtp.messages.join('\n'), /fixture-sensitive-marker|summary-tail-not-permitted|local-fixture-password/);
    assert.ok(smtp.tlsConnections >= 2);
  });
});
test('untrusted certificate is rejected rather than sending plaintext', { timeout: 90000 }, async () => {
  await scenario({ trust: false }, async ({ smtp, post, base }) => {
    await post(false);
    await until(async () => /alertmanager_notifications_failed_total\{[^\n]*integration="email"[^\n]*\} [1-9]/.test(await (await fetch(`${base}/metrics`)).text()));
    assert.equal(smtp.messages.length, 0);
  });
});
test('temporary SMTP refusal retries and eventually delivers', { timeout: 90000 }, async () => {
  await scenario({ transientRejects: 1 }, async ({ smtp, post }) => {
    await post(false); await until(() => smtp.messages.length > 0, 60000);
    assert.equal(smtp.rejections, 1);
    assert.ok(smtp.tlsConnections >= 2);
  });
});
