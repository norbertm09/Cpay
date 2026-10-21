import React, { act } from 'react';
import { webcrypto } from 'node:crypto';
import { vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { usePaymentIntent } from './usePaymentIntent';

global.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
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
afterEach(() => { unmount(); vi.restoreAllMocks(); });

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
  const send = vi.fn();
  await act(async () => { await expect(intent.execute({ ...payment, amount: 2000 }, send)).rejects.toThrow(); });
  expect(send).not.toHaveBeenCalled();
});

test('explicit new intent is possible only after a known result', async () => {
  let key;
  await act(async () => { await intent.execute(payment, async body => { key = body.idempotencyKey; return {}; }); });
  act(() => intent.startNew());
  await act(async () => { await intent.execute({ ...payment, amount: 2000 }, async body => { expect(body.idempotencyKey).not.toBe(key); return {}; }); });
});

test('PIN refusal then uncertain corrected retry blocks a new intent across reload', async () => {
  let key;
  await act(async () => { await expect(intent.execute(payment, async body => {
    key = body.idempotencyKey;
    throw { response: { status: 422, data: { code: 'INVALID_PIN' } } };
  })).rejects.toBeDefined(); });
  expect(intent.canStartNew).toBe(true);
  await act(async () => { await expect(intent.execute(payment, async body => {
    expect(body.idempotencyKey).toBe(key);
    expect(JSON.parse(sessionStorage.getItem(sessionStorage.key(0))).known).toBe(false);
    throw new Error('response lost after debit');
  })).rejects.toThrow('response lost after debit'); });
  expect(intent.canStartNew).toBe(false);
  unmount(); mount();
  expect(intent.canStartNew).toBe(false);
  act(() => expect(() => intent.startNew()).toThrow());
  await act(async () => { await intent.execute(payment, async body => {
    expect(body.idempotencyKey).toBe(key); return { txn: { txnId: 'existing-order' } };
  }); });
  expect(intent.canStartNew).toBe(true);
});

test('storage unavailable blocks sending and can recover without changing intent', async () => {
  const send = vi.fn();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  await act(async () => { await expect(intent.execute(payment, send)).rejects.toThrow(); });
  expect(send).not.toHaveBeenCalled();
});

test.each(['{broken', '', '{}', 'null'])('corrupt storage %j is not silently replaced by a new intention', async raw => {
  await act(async () => { await expect(intent.execute(payment, async () => { throw new Error('offline'); })).rejects.toThrow(); });
  const key = sessionStorage.key(0); sessionStorage.setItem(key, raw);
  unmount(); mount();
  const send = vi.fn();
  await act(async () => { await expect(intent.execute(payment, send)).rejects.toThrow(); });
  expect(send).not.toHaveBeenCalled();
});

test('stale actor callback cannot send or overwrite another actor', async () => {
  const old = intent.execute;
  act(() => root.render(<Harness identity={{ ...actor, cardholderId: 'actor-b' }} />));
  const send = vi.fn();
  await act(async () => { await expect(old(payment, send)).rejects.toThrow(); });
  expect(send).not.toHaveBeenCalled(); expect(intent.restored).toBeNull();
});

test('double click submits once while busy and late completion cannot mark a new actor known', async () => {
  let resolve;
  const send = vi.fn(() => new Promise(r => { resolve = r; }));
  let first;
  await act(async () => { first = intent.execute(payment, send); });
  await act(async () => { await expect(intent.execute(payment, send)).rejects.toThrow(); });
  act(() => root.render(<Harness identity={{ ...actor, cardId: 'card-b' }} />));
  await act(async () => { resolve({}); await expect(first).rejects.toThrow(); });
  expect(intent.pending).toBe(false); expect(send).toHaveBeenCalledTimes(1);
});
