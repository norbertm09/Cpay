import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { usePaymentIntent } from './usePaymentIntent';

global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, 'crypto', { value: require('crypto').webcrypto, configurable: true });
const actor = { cardholderId: 'actor-a', cardId: 'card-a', currency: 'XAF' };
const payment = { merchantId: 'merchant-a', amount: 1000, description: 'Test' };
let root, host, intent;
function Harness({ identity }) { intent = usePaymentIntent(identity); return <span>{intent.error}</span>; }
function mount(identity = actor) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(<Harness identity={identity} />));
}
function unmount() { act(() => root.unmount()); host.remove(); }
beforeEach(() => { sessionStorage.clear(); mount(); });
afterEach(() => { unmount(); jest.restoreAllMocks(); });

test('lost response and reload reuse the persisted intention and key', async () => {
  let key;
  await act(async () => { await expect(intent.execute(payment, async body => {
    key = body.idempotencyKey;
    expect(JSON.stringify(sessionStorage)).toContain(key);
    throw new Error('offline');
  })).rejects.toThrow('offline'); });
  unmount(); mount();
  expect(intent.restored).toEqual(payment);
  await act(async () => { await intent.execute(payment, async body => {
    expect(body.idempotencyKey).toBe(key); return { txn: { txnId: 'order-a' } };
  }); });
  expect(intent.canStartNew).toBe(true);
});

test('whitelist excludes PIN, credentials and unknown fields', async () => {
  await act(async () => { await intent.execute({ ...payment, pin: 'fixture-pin', token: 'fixture-token', password: 'fixture-password' }, async body => {
    expect(body.pin).toBeUndefined(); return { txn: {} };
  }); });
  expect(JSON.stringify(sessionStorage)).not.toMatch(/pin|token|password|fixture-/i);
});

test.each([undefined, 409, 500, 422])('unknown outcome %s cannot change parameters or start a new order', async status => {
  await act(async () => { await expect(intent.execute(payment, async () => { throw { response: status ? { status, data: {} } : undefined }; })).rejects.toBeDefined(); });
  act(() => { expect(() => intent.startNew()).toThrow(); });
  const send = jest.fn();
  await act(async () => { await expect(intent.execute({ ...payment, amount: 2000 }, send)).rejects.toThrow(); });
  expect(send).not.toHaveBeenCalled();
});

test('explicit new intent is possible only after a known result', async () => {
  let key;
  await act(async () => { await intent.execute(payment, async body => { key = body.idempotencyKey; return {}; }); });
  act(() => intent.startNew());
  await act(async () => { await intent.execute({ ...payment, amount: 2000 }, async body => { expect(body.idempotencyKey).not.toBe(key); return {}; }); });
});

test('storage unavailable blocks sending and can recover without changing intent', async () => {
  const send = jest.fn();
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  await act(async () => { await expect(intent.execute(payment, send)).rejects.toThrow(); });
  expect(send).not.toHaveBeenCalled();
});

test('corrupt storage is not silently replaced by a new intention', async () => {
  await act(async () => { await expect(intent.execute(payment, async () => { throw new Error('offline'); })).rejects.toThrow(); });
  const key = sessionStorage.key(0); sessionStorage.setItem(key, '{broken');
  unmount(); mount();
  const send = jest.fn();
  await act(async () => { await expect(intent.execute(payment, send)).rejects.toThrow(); });
  expect(send).not.toHaveBeenCalled();
});

test('stale actor callback cannot send or overwrite another actor', async () => {
  const old = intent.execute;
  act(() => root.render(<Harness identity={{ ...actor, cardholderId: 'actor-b' }} />));
  const send = jest.fn();
  await act(async () => { await expect(old(payment, send)).rejects.toThrow(); });
  expect(send).not.toHaveBeenCalled(); expect(intent.restored).toBeNull();
});

test('double click submits once while busy and late completion cannot mark a new actor known', async () => {
  let resolve;
  const send = jest.fn(() => new Promise(r => { resolve = r; }));
  let first;
  await act(async () => { first = intent.execute(payment, send); });
  await act(async () => { await expect(intent.execute(payment, send)).rejects.toThrow(); });
  act(() => root.render(<Harness identity={{ ...actor, cardId: 'card-b' }} />));
  await act(async () => { resolve({}); await expect(first).rejects.toThrow(); });
  expect(intent.pending).toBe(false); expect(send).toHaveBeenCalledTimes(1);
});
