const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadMonitoringSettings, renderAlertmanagerConfig, writeConfig } = require('./config.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = {
  ALERT_SMTP_HOST: 'smtp.example.test', ALERT_SMTP_PORT: '587', ALERT_SMTP_USER: 'ops',
  ALERT_SMTP_FROM: 'alerts@example.test', ALERT_SMTP_TO: 'ops@example.test',
  ALERT_SMTP_PASSWORD_FILE: '/secrets/smtp', MONITORING_METRICS_TOKEN_FILE: '/secrets/metrics',
};
const reader = file => { if (file === '/secrets/smtp') return 'fixture-password'; if (file === '/secrets/metrics') return 'fixture-token'; throw new Error('unreadable'); };
for (const key of Object.keys(env).filter(k => k !== 'ALERT_SMTP_PORT')) test(`missing ${key} fails without secrets`, () => {
  const input = { ...env }; delete input[key];
  assert.throws(() => loadMonitoringSettings(input, { readFileSync: reader }), /Configuration/);
});
test('implicit TLS, invalid ports and control characters are rejected', () => {
  for (const port of ['465', '0', '70000', '587x']) assert.throws(() => loadMonitoringSettings({ ...env, ALERT_SMTP_PORT: port }, { readFileSync: reader }));
  assert.throws(() => loadMonitoringSettings({ ...env, ALERT_SMTP_TO: 'ops@example.test\nBcc: attacker@example.test' }, { readFileSync: reader }));
});
test('empty, missing files and bad CA fail closed', () => {
  for (const readFileSync of [() => '', () => { throw new Error('secret-file-failure'); }]) {
    assert.throws(() => loadMonitoringSettings(env, { readFileSync }), /Configuration/);
  }
  assert.throws(() => loadMonitoringSettings({ ...env, ALERT_SMTP_CA_FILE: '/missing/ca' }, { readFileSync: reader }), /Configuration/);
});
test('native config contains file paths and required TLS, not credentials or webhook', () => {
  const settings = loadMonitoringSettings(env, { readFileSync: reader });
  const config = renderAlertmanagerConfig(settings, { templateFile: '/templates/alerts.tmpl' });
  const encoded = JSON.stringify(config);
  assert.equal(config.global.smtp_require_tls, true);
  assert.equal(config.global.smtp_tls_config.insecure_skip_verify, false);
  assert.equal(config.receivers[0].email_configs[0].send_resolved, true);
  assert.equal(config.global.smtp_auth_password_file, '/secrets/smtp');
  assert.doesNotMatch(encoded, /fixture-password|fixture-token|internal\/alerts|webhook_configs/);
});
test('special characters remain structured values; optional CA is verified', () => {
  const settings = loadMonitoringSettings({ ...env, ALERT_SMTP_USER: 'ops"\\quoted', ALERT_SMTP_CA_FILE: '/ca' }, { readFileSync: f => f === '/ca' ? '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----' : reader(f) });
  const copy = JSON.parse(JSON.stringify(renderAlertmanagerConfig(settings, { templateFile: '/t' })));
  assert.equal(copy.global.smtp_auth_username, 'ops"\\quoted');
  assert.equal(copy.global.smtp_tls_config.ca_file, '/ca');
});
test('configuration cannot be written inside a public directory or over existing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpay-config-'));
  try {
    assert.throws(() => writeConfig(path.join(dir, 'public', 'config.yml'), {}), /public/);
    const output = path.join(dir, 'config.yml'); writeConfig(output, { a: 'quoted"\nvalue' });
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { a: 'quoted"\nvalue' });
    assert.throws(() => writeConfig(output, { a: 2 }), /existe/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
