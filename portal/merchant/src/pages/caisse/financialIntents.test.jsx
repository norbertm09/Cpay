import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { cashApi, accountApi } from '../../services/api';
import { Retirer } from './Retirer';
import { Transferer } from './Transferer';
import { Encaisser } from './Encaisser';

let mockAvailable = 100000;
let mockOpen = true;
jest.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { userId: 'u1', merchantId: 'm1', currency: 'XAF', country: 'CG' } }) }));
jest.mock('../../hooks/useCashSummary', () => ({ useCashSummary: () => ({ summary: { currency: 'XAF', balance: { available: mockAvailable } }, state: 'ok', reload: () => {} }) }));
jest.mock('../../hooks/useCapabilities', () => ({ useCapabilities: () => ({ isOpen: () => mockOpen, isPilot: () => false }) }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, host;
async function mount(Component) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Component /></MemoryRouter>); });
}
function unmount() { act(() => root.unmount()); host.remove(); }
function button(text) { return [...host.querySelectorAll('button')].find(b => b.textContent.includes(text)); }
async function click(text) { await act(async () => { Simulate.click(button(text)); }); }
async function change(input, value) { await act(async () => { Simulate.change(input, { target: { value } }); }); }
beforeEach(() => {
  sessionStorage.clear(); mockAvailable = 100000; mockOpen = true;
  jest.spyOn(cashApi, 'getWallet').mockResolvedValue({ status: 200, data: { phone: '+242061234567', operator: 'MTN' } });
  jest.spyOn(accountApi, 'bankAccounts').mockResolvedValue({ data: { data: [] } });
  jest.spyOn(cashApi, 'listTransfers').mockResolvedValue({ data: { data: [] } });
});
afterEach(() => { unmount(); jest.restoreAllMocks(); });

test.each([
  ['withdraw', Retirer, null],
  ['createTransfer', Transferer, 'Banque → Wallet'],
  ['collect', Encaisser, 'Carte'],
])('%s restores business fields on reload and resends the same order key', async (method, Component, option) => {
  const sent = [];
  jest.spyOn(cashApi, method).mockImplementation(async (body, key) => {
    sent.push({ body, key }); throw new Error('offline');
  });
  await mount(Component);
  if (option) await click(option);
  await change(host.querySelector('.amount-input input'), '900');
  await change(host.querySelector('.amount-input input'), '1200');
  await act(async () => { Simulate.submit(host.querySelector('form')); });
  if (method === 'withdraw') {
    await change(document.querySelector('input[type="password"]'), 'secret-password');
    await act(async () => { Simulate.submit(document.querySelector('.modal form')); });
  }
  expect(sent).toHaveLength(1);
  mockAvailable = 0; mockOpen = false;
  unmount(); await mount(Component);
  expect(host.querySelector('.amount-input input').value).toBe('1200');
  expect(host.querySelector('button[type="submit"]').disabled).toBe(false);
  await act(async () => { Simulate.submit(host.querySelector('form')); });
  if (method === 'withdraw') {
    await change(document.querySelector('input[type="password"]'), 'renewed-password');
    await act(async () => { Simulate.submit(document.querySelector('.modal form')); });
  }
  expect(sent).toHaveLength(2);
  expect(sent[1].key).toBe(sent[0].key);
  expect(JSON.stringify(sessionStorage)).not.toMatch(/secret-password|renewed-password/);
});

test('withdraw keeps the same order when the server requests renewed strong confirmation', async () => {
  const sent = [];
  jest.spyOn(cashApi, 'withdraw').mockImplementation(async (body, key) => {
    sent.push({ body, key });
    if (sent.length === 1) throw { response: { status: 428, data: { code: 'STEP_UP_REQUIRED', methods: ['password'] } } };
    return { data: { reference: 'withdraw-1', status: 'pending', amount: 1200 } };
  });
  await mount(Retirer);
  await change(host.querySelector('.amount-input input'), '1200');
  await act(async () => { Simulate.submit(host.querySelector('form')); });
  await change(document.querySelector('input[type="password"]'), 'expired-password');
  await act(async () => { Simulate.submit(document.querySelector('.modal form')); });
  expect(document.querySelector('.modal')).not.toBeNull();
  await change(document.querySelector('input[type="password"]'), 'fresh-password');
  await act(async () => { Simulate.submit(document.querySelector('.modal form')); });
  expect(sent).toHaveLength(2);
  expect(sent[1].key).toBe(sent[0].key);
  expect(sent[1].body.confirm).toEqual({ password: 'fresh-password' });
  expect(JSON.stringify(sessionStorage)).not.toMatch(/password|confirm/);
  expect(host.textContent).toContain('withdraw-1');
  await click('Nouveau retrait');
  expect(host.querySelector('.amount-input input').value).toBe('');
  expect(sessionStorage.length).toBe(0);
});
