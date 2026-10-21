const { test, expect } = require('./fixture.cjs');
test('external requests and unknown API calls are intercepted before network access', async ({ page, scenario }) => {
  await page.goto(scenario.origin + '/connexion');
  await page.evaluate(async () => { try { await fetch('https://outside.example.test/never-send'); } catch (_) {} });
  expect(scenario.violations.pop()).toBe('External request blocked');
  scenario.state.authorized = true;
  await page.evaluate(async () => { await fetch('/api/v1/unexpected-fixture'); });
  expect(scenario.violations.pop()).toContain('Unexpected API:');
});
