#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { loadMonitoringSettings, renderAlertmanagerConfig, writeConfig } = require('../monitoring/alertmanager/config.cjs');
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/configure-monitoring.cjs --output <fichier prive>');
  const settings = loadMonitoringSettings(process.env);
  writeConfig(args[1], renderAlertmanagerConfig(settings, { templateFile: path.resolve(__dirname, '../monitoring/alertmanager/alerts.tmpl') }));
  console.log('Configuration créée. Valider avec amtool avant chargement. Aucun service démarré.');
} catch (err) { console.error(err.message); process.exitCode = 1; }
