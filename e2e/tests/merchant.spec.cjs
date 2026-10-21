const { test, expect, login } = require('./fixture.cjs');
test.use({ portal: 'merchant' });
for (const status of ['completed', 'failed']) test(`uncertain withdrawal refreshes its order to ${status} without POST replay`, async ({ page, scenario }) => {
  await login(page, scenario, '/caisse/retirer');
  await page.locator('.amount-input input').fill('5000');
  await page.locator('form').first().evaluate(form => form.requestSubmit());
  await page.locator('.modal input[type="password"]').fill('Fixture-Only-Password!');
  await page.locator('.modal form').evaluate(form => form.requestSubmit());
  await expect(page.getByText('Résultat incertain', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/fonds restent réservés/).first()).toBeVisible();
  await expect(page.getByText(/95\s?000/).first()).toBeVisible();
  scenario.state.pollStatus = status;
  await page.getByRole('button', { name: /Actualiser le statut/ }).click();
  await expect(page.getByText(status === 'completed' ? 'Net envoyé' : 'Non envoyé', { exact: true }).first()).toBeVisible();
  expect(scenario.state.posts).toHaveLength(1);
  expect([...new Set(scenario.state.gets.filter(p => /cash\/transfers\//.test(p)))]).toEqual([`/api/v1/merchant/cash/transfers/${scenario.state.transfer.transferId}`]);
});
test('protected route without session cannot submit a withdrawal', async ({ page, scenario }) => {
  await page.goto(scenario.origin + '/caisse/retirer'); await expect(page).toHaveURL(/\/login$/); expect(scenario.state.posts).toHaveLength(0);
});
test('expired merchant session cannot resume a protected action', async ({ page, scenario }) => {
  await login(page, scenario, '/caisse/retirer'); scenario.state.expired = true; await page.reload();
  await expect(page).toHaveURL(/\/login$/); expect(scenario.state.posts).toHaveLength(0);
});
test('unavailable merchant summary shows a recoverable error', async ({ page, scenario }) => {
  scenario.state.failures.add('GET /api/v1/merchant/cash/summary');
  await login(page, scenario, '/caisse/retirer');
  await expect(page.getByText(/Service de recette indisponible|Impossible de charger|Réessayer/).first()).toBeVisible();
  expect(scenario.state.posts).toHaveLength(0);
  scenario.state.failures.clear();
  await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await expect(page.getByRole('link', { name: /Solde disponible 100\s?000/ })).toBeVisible();
});
