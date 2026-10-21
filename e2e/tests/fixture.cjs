const { test: base, expect } = require('@playwright/test');
const { createScenario, origins } = require('../fixtures/contracts.cjs');
const test = base.extend({
  portal: ['cardholder', { option: true }],
  scenario: [async ({ context, portal }, use) => {
    const scenario = createScenario(portal), violations = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!Object.values(origins).includes(url.origin)) { violations.push('External request blocked'); return route.abort('blockedbyclient'); }
      if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
        const handled = await scenario.handle(route);
        if (handled === null) { violations.push(`Unexpected API: ${route.request().method()} ${url.pathname}`); return route.fulfill({ status: 503, body: '{}' }); }
        return;
      }
      return route.continue();
    });
    context.on('page', page => page.on('pageerror', err => violations.push('Browser error: ' + err.message)));
    for (const page of context.pages()) page.on('pageerror', err => violations.push('Browser error: ' + err.message));
    await context.routeWebSocket('**/*', ws => { violations.push('WebSocket blocked'); ws.close(); });
    await use({ ...scenario, violations });
    expect(violations, 'All traffic must be local and explicitly simulated').toEqual([]);
  }, { auto: true }],
});
async function login(page, scenario, destination) {
  await page.goto(scenario.origin + (scenario.state.portal === 'cardholder' ? '/connexion' : '/login'));
  await page.locator('input[autocomplete="username"]').fill('fixture@example.test');
  await page.locator('input[autocomplete="current-password"]').fill('Fixture-Only-Password!');
  await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
  await expect(page).not.toHaveURL(/\/(login|connexion)$/);
  await page.goto(scenario.origin + destination);
}
module.exports = { test, expect, login };
