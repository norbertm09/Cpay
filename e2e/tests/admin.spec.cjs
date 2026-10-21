const { test, expect, login } = require('./fixture.cjs');
test.use({ portal: 'admin' });
test('unknown queue shows reserved funds and recovery health without forced rejection', async ({ page, scenario }) => {
  await login(page, scenario, '/operations/caisse?queue=unknown');
  await expect(page.getByText('FIXTURE-PAY-1')).toBeVisible();
  await expect(page.getByText(/fonds restent réservés|fonds réservés/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Consulter', exact: true }).click();
  await expect(page.getByRole('button', { name: /Rejeter|Marquer exécuté/ })).toHaveCount(0);
  expect(scenario.state.gets.some(p => p.endsWith('/cash/reconcile/status'))).toBe(true);
});
test('failed queue load shows an error rather than an empty queue', async ({ page, scenario }) => {
  scenario.state.failures.add('GET /api/v1/admin/cash/transfers');
  await login(page, scenario, '/operations/caisse?queue=unknown');
  await expect(page.getByText(/Service de recette indisponible/).first()).toBeVisible();
  await expect(page.getByText('File vide')).toHaveCount(0);
});
test('admin deep link without session is protected', async ({ page, scenario }) => {
  await page.goto(scenario.origin + '/operations/caisse'); await expect(page).toHaveURL(/\/login$/);
});
test('expired admin session returns to login', async ({ page, scenario }) => {
  await login(page, scenario, '/operations/caisse?queue=unknown'); scenario.state.expired = true; await page.reload();
  await expect(page).toHaveURL(/\/login$/);
});
