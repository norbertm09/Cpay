const { test, expect, login } = require('./fixture.cjs');
const { M } = require('../fixtures/contracts.cjs');
async function prepare(page, scenario) {
  await login(page, scenario, '/payer');
  await page.getByLabel('Code commerçant ou lien de paiement').fill(M);
  await page.getByRole('button', { name: 'Continuer', exact: true }).click();
  await page.locator('input[inputmode="decimal"]').fill('1000');
  await page.getByRole('button', { name: 'Continuer', exact: true }).click();
}
async function pay(page) {
  const digits = page.getByRole('group', { name: 'Code PIN' }).locator('input');
  for (let i = 0; i < 4; i++) await digits.nth(i).fill(String(i + 1));
  await page.getByRole('button', { name: /^Payer / }).click();
}
test('payment succeeds through the real screen', async ({ page, scenario }) => {
  await prepare(page, scenario); await pay(page);
  await expect(page.getByRole('heading', { name: 'Paiement effectué' })).toBeVisible();
  expect(scenario.state.effects).toBe(1);
});
test('lost response reload resumes the same key and creates only one simulated effect', async ({ page, scenario }) => {
  scenario.state.losePaymentResponse = true;
  await prepare(page, scenario); await pay(page);
  await expect(page.getByText(/Résultat non confirmé/)).toBeVisible();
  const key = scenario.state.posts[0].key;
  await page.reload();
  await expect(page.getByText(/Paiement enregistré/)).toBeVisible();
  const saved = await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('cpay:cardholder-payment-intent:')).map(k => sessionStorage.getItem(k)).join(''));
  expect(/"pin"|"token"|"password"/i.test(saved)).toBe(false);
  await pay(page);
  await expect(page.getByRole('heading', { name: 'Paiement effectué' })).toBeVisible();
  expect(scenario.state.posts.map(p => p.key)).toEqual([key, key]); expect(scenario.state.effects).toBe(1);
});
test('explicit refusal never displays a successful payment', async ({ page, scenario }) => {
  scenario.state.refusePayment = true;
  await prepare(page, scenario); await pay(page);
  await expect(page.getByText('Refus explicite de recette')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Paiement effectué' })).toHaveCount(0);
  expect(scenario.state.effects).toBe(0);
});
test('protected deep link without session redirects to login', async ({ page, scenario }) => {
  await page.goto(scenario.origin + '/payer'); await expect(page).toHaveURL(/\/connexion$/);
});
test('unavailable payment API cannot display success or lose the saved intention', async ({ page, scenario }) => {
  scenario.state.failures.add('POST /api/v1/cardholder/payment');
  await prepare(page, scenario); await pay(page);
  await expect(page.getByText(/Résultat non confirmé/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Paiement effectué' })).toHaveCount(0);
  expect(scenario.state.effects).toBe(0);
});
test('blocked session storage prevents sending the financial request', async ({ context, page, scenario }) => {
  await context.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('cpay:cardholder-payment-intent:')) throw new DOMException('Fixture storage denied');
      return original.call(this, key, value);
    };
  });
  await prepare(page, scenario); await pay(page);
  await expect(page.getByText(/enregistrement du paiement est indisponible/).first()).toBeVisible();
  expect(scenario.state.posts).toHaveLength(0);
});
test('expired app session returns to login after reload', async ({ page, scenario }) => {
  await login(page, scenario, '/payer'); scenario.state.expired = true; await page.reload();
  await expect(page).toHaveURL(/\/connexion$/);
});
