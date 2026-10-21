'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const invalid = name => new Error(`Configuration invalide : ${name}`);
function loadMonitoringSettings(env, { readFileSync = fs.readFileSync } = {}) {
  const value = name => {
    const v = env[name];
    if (typeof v !== 'string' || !v.trim() || /[\r\n\0]/.test(v) || v.length > 2048 || /^REQUIRED/i.test(v)) throw invalid(name);
    return v.trim();
  };
  const smtpHost = value('ALERT_SMTP_HOST');
  if (!/^[a-zA-Z0-9.-]+$/.test(smtpHost)) throw invalid('ALERT_SMTP_HOST');
  const rawPort = env.ALERT_SMTP_PORT || '587';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535 || Number(rawPort) === 465) throw invalid('ALERT_SMTP_PORT (STARTTLS requis, pas TLS implicite 465)');
  const email = name => { const v = value(name); if (!/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(v)) throw invalid(name); return v; };
  const secret = name => {
    const file = value(name);
    try { if (!String(readFileSync(file, 'utf8')).trim()) throw invalid(name); } catch (_) { throw invalid(name); }
    return file;
  };
  const settings = { smtpHost, smtpPort: Number(rawPort), smtpUser: value('ALERT_SMTP_USER'), smtpFrom: email('ALERT_SMTP_FROM'), smtpTo: email('ALERT_SMTP_TO'),
    passwordFile: secret('ALERT_SMTP_PASSWORD_FILE'), metricsTokenFile: secret('MONITORING_METRICS_TOKEN_FILE'), caFile: null };
  if (env.ALERT_SMTP_CA_FILE) {
    settings.caFile = secret('ALERT_SMTP_CA_FILE');
    if (!String(readFileSync(settings.caFile, 'utf8')).includes('-----BEGIN CERTIFICATE-----')) throw invalid('ALERT_SMTP_CA_FILE');
  }
  return settings;
}
function renderAlertmanagerConfig(settings, { templateFile }) {
  if (!templateFile) throw invalid('templateFile');
  return {
    global: { resolve_timeout: '5m', smtp_smarthost: `${settings.smtpHost}:${settings.smtpPort}`, smtp_from: settings.smtpFrom,
      smtp_auth_username: settings.smtpUser, smtp_auth_password_file: settings.passwordFile, smtp_require_tls: true,
      smtp_tls_config: { insecure_skip_verify: false, min_version: 'TLS12', ...(settings.caFile ? { ca_file: settings.caFile } : {}) } },
    templates: [templateFile],
    route: { receiver: 'ops-email', group_by: ['alertname', 'service', 'severity'], group_wait: '30s', group_interval: '5m', repeat_interval: '4h' },
    receivers: [{ name: 'ops-email', email_configs: [{ to: settings.smtpTo, send_resolved: true,
      headers: { Subject: '{{ template "cpay.subject" . }}' }, html: '{{ template "cpay.html" . }}' }] }],
  };
}
function writeConfig(output, config) {
  const target = path.resolve(output);
  if (target.split(/[\\/]/).some(part => ['public', 'build', 'dist', '.git'].includes(part.toLowerCase()))) throw new Error('Répertoire public ou protégé refusé.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) throw new Error('Le fichier existe déjà ; choisissez une nouvelle destination puis validez avant remplacement.');
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.linkSync(temp, target); // Atomic publish without replacing existing configuration.
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
module.exports = { loadMonitoringSettings, renderAlertmanagerConfig, writeConfig };
