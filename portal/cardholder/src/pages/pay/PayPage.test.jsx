import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import PayPage from './PayPage';
import * as ops from '../../services/operations';

jest.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: {
  cardholderId: 'actor-fixture', card: { cardId: 'card-fixture', balance: 5000, currency: 'XAF', status: 'active' },
}, patchCard: jest.fn() }) }));
jest.mock('../../services/operations', () => ({ pay: jest.fn(), payLinkStatus: jest.fn() }));
jest.mock('./QrScanner', () => () => null);
jest.mock('../../components', () => {
  const R = require('react');
  return {
    Card: ({ children }) => <div>{children}</div>, Alert: ({ children }) => <div role="alert">{children}</div>,
    Button: ({ children, type = 'button', onClick, disabled }) => <button type={type} onClick={onClick} disabled={disabled}>{children}</button>,
    Input: ({ label, value, onChange }) => <label>{label}<input value={value} onChange={onChange} /></label>,
    AmountInput: ({ value, onChange }) => <input aria-label="Montant" value={value} onChange={onChange} />,
    PinInput: ({ value, onChange }) => <input aria-label="PIN" value={value} onChange={e => onChange(e.target.value)} />,
    Icon: () => null, Badge: ({ children }) => <span>{children}</span>, Steps: () => null,
  };
});
global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, 'crypto', { value: require('crypto').webcrypto, configurable: true });
let root, host;
function mount() { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<MemoryRouter><PayPage /></MemoryRouter>)); }
function unmount() { act(() => root.unmount()); host.remove(); }
const change = (selector, value) => act(() => Simulate.change(host.querySelector(selector), { target: { value } }));
const submit = () => act(async () => Simulate.submit(host.querySelector('form')));
beforeEach(() => { sessionStorage.clear(); ops.pay.mockReset(); mount(); });
afterEach(unmount);

test('lost response reload restores same merchant, amount and key without another intention', async () => {
  act(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent.includes('Saisir')).click());
  change('input', '11111111-1111-4111-8111-111111111111'); await submit();
  change('[aria-label="Montant"]', '1000'); await submit();
  ops.pay.mockRejectedValueOnce(new Error('network lost'));
  change('[aria-label="PIN"]', '1234'); await submit();
  expect(ops.pay).toHaveBeenCalledTimes(1);
  const first = ops.pay.mock.calls[0][0];
  expect(host.textContent).toContain('Résultat non confirmé');
  unmount(); mount();
  expect(host.textContent).toContain('Paiement enregistré');
  expect(host.querySelector('[aria-label="PIN"]').value).toBe('');
  const modify = Array.from(host.querySelectorAll('button')).find(b => b.textContent.includes('Modifier le montant'));
  expect(modify.disabled).toBe(true);
  ops.pay.mockResolvedValueOnce({ txn: { txnId: 'fixture-order' }, newBalance: 3995 });
  change('[aria-label="PIN"]', '1234'); await submit();
  expect(ops.pay.mock.calls[1][0].idempotencyKey).toBe(first.idempotencyKey);
  expect(host.textContent).toContain('Paiement effectué');
});
