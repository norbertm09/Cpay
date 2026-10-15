#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { validateEnv } = require('../src/config/env');

const report = validateEnv({ strict: false });

if (report.missing.length) {
  console.error('Variables obligatoires manquantes ou placeholders:');
  report.missing.forEach((name) => console.error(`- ${name}`));
}

if (report.warnings.length) {
  console.warn('\nConnecteurs a completer selon les pays/providers actifs:');
  report.warnings.forEach(({ provider, missing }) => {
    console.warn(`- ${provider}: ${missing.join(', ')}`);
  });
}

if (report.missing.length) process.exit(1);
console.log('Environnement minimal production OK.');
