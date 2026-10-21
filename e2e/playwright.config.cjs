const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests', timeout: 30000, globalTimeout: 180000, expect: { timeout: 7000 }, workers: 1,
  reporter: [['line']], forbidOnly: !!process.env.CI, retries: 0,
  use: { browserName: 'chromium', serviceWorkers: 'block', trace: 'off', video: 'off', screenshot: 'off' },
});
