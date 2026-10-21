import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useFinancialIntent } from './useFinancialIntent';

global.IS_REACT_ACT_ENVIRONMENT = true;
const actor = { merchantId: 'merchant-a', userId: 'staff-a' };
const payment = { amount: 1200, direction: 'wallet_to_bank', accountId: 'bank-a' };
let root, host, intent;
function Harness({ user = actor, operation = 'transfer' }) {
  intent = useFinancialIntent(user, operation);
  return <span>{intent.error}</span>;
}
function mount(user = actor, operation = 'transfer') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness user={user} operation={operation} />));
}
function unmount() { act(() => root.unmount()); host.remove(); }
beforeEach(() => { sessionStorage.clear(); mount(); });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

test('network uncertainty and reload reuse the same submitted business intent', async () => {
  let firstKey;
  await act(async () => {
    await expect(intent.execute(payment, async (_, key) => { firstKey = key; throw new Error('connection lost'); })).rejects.toThrow();
  });
  unmount(); mount();
  expect(intent.restored).toEqual(payment);
  let replayKey;
  await act(async () => { await intent.execute(payment, async (_, key) => { replayKey = key; return { data: { transferId: 'order-1' } }; }); });
  expect(replayKey).toBe(firstKey);
});

test('renewing step-up confirmation keeps the key and stores no secrets or unknown fields', async () => {
  let firstKey, sent;
  await act(async () => {
    await expect(intent.execute({ ...payment, confirm: { password: 'secret-password' }, token: 'secret-token' }, async (_, key) => {
      firstKey = key; throw { response: { status: 428, data: { code: 'STEP_UP_REQUIRED' } } };
    })).rejects.toBeDefined();
  });
  await act(async () => {
    await intent.execute({ ...payment, confirm: { code: '934762' } }, async (body, key) => { sent = body; expect(key).toBe(firstKey); return { data: {} }; });
  });
  expect(sent.confirm).toEqual({ code: '934762' });
  const storage = JSON.stringify(sessionStorage);
  expect(storage).not.toMatch(/password|secret-token|934762|confirm|token/);
});

test.each([409, 500])('HTTP %s cannot discard or change an unresolved intent', async (status) => {
  await act(async () => { await expect(intent.execute(payment, async () => { throw { response: { status, data: {} } }; })).rejects.toBeDefined(); });
  let sent = false;
  await act(async () => {
    await expect(intent.execute({ ...payment, amount: 1300 }, async () => { sent = true; })).rejects.toThrow(/opération/);
    expect(() => intent.startNew()).toThrow(/opération/);
  });
  expect(sent).toBe(false);
});

test('known result remains replayable until an explicit new operation', async () => {
  let firstKey, secondKey;
  await act(async () => { await intent.execute(payment, async (_, key) => { firstKey = key; return { data: {} }; }); });
  unmount(); mount();
  expect(intent.canStartNew).toBe(true);
  act(() => intent.startNew());
  await act(async () => { await intent.execute({ ...payment, amount: 1500 }, async (_, key) => { secondKey = key; return { data: {} }; }); });
  expect(secondKey).not.toBe(firstKey);
});

test('merchant, authenticated user and operation each isolate saved intent', async () => {
  await act(async () => { await expect(intent.execute(payment, async () => { throw new Error('offline'); })).rejects.toThrow(); });
  for (const [user, operation] of [
    [{ ...actor, userId: 'staff-b' }, 'transfer'],
    [{ ...actor, merchantId: 'merchant-b' }, 'transfer'],
    [actor, 'withdraw'],
  ]) {
    unmount(); mount(user, operation);
    expect(intent.restored).toBeNull();
  }
  unmount(); mount();
  expect(intent.restored).toEqual(payment);
});

test('storage failure prevents sending and can be retried after storage recovers', async () => {
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  let sent = false;
  await act(async () => { await expect(intent.execute(payment, async () => { sent = true; })).rejects.toThrow(/enregistrement/); });
  expect(sent).toBe(false);
  Storage.prototype.setItem = original;
  await act(async () => { await intent.execute(payment, async () => { sent = true; return { data: {} }; }); });
  expect(sent).toBe(true);
});

test('a retained callback cannot send under another actor after account switch or logout', async () => {
  const execute = intent.execute;
  act(() => root.render(<Harness user={{ ...actor, userId: 'staff-b' }} />));
  let sent = false;
  await act(async () => { await expect(execute(payment, async () => { sent = true; })).rejects.toThrow(/session/); });
  act(() => root.render(<Harness user={null} />));
  await act(async () => { await expect(intent.execute(payment, async () => { sent = true; })).rejects.toThrow(/session/); });
  expect(sent).toBe(false);
});

test('a retained confirmation cannot send after the form unmounts', async () => {
  const execute = intent.execute;
  unmount();
  let sent = false;
  await expect(execute(payment, async () => { sent = true; })).rejects.toThrow(/session/);
  expect(sent).toBe(false);
  mount();
});

test('late response after actor switch cannot populate the next actor form', async () => {
  let finish, request;
  await act(async () => { request = intent.execute(payment, () => new Promise(resolve => { finish = resolve; })); });
  act(() => root.render(<Harness user={{ ...actor, userId: 'staff-b' }} />));
  await act(async () => {
    finish({ data: { transferId: 'old-actor-order' } });
    await expect(request).rejects.toThrow(/session/);
  });
  expect(intent.restored).toBeNull();
});

test.each(['VALIDATION_ERROR', 'PHONE_INVALID', 'INVALID_PHONE', 'CURRENCY_MISMATCH'])('%s permits correcting business fields after a safe pre-execution rejection', async (code) => {
  let firstKey, correctedKey;
  await act(async () => {
    await expect(intent.execute(payment, async (_, key) => { firstKey = key; throw { response: { status: 400, data: { code } } }; })).rejects.toBeDefined();
  });
  await act(async () => {
    await intent.execute({ ...payment, amount: 1500 }, async (_, key) => { correctedKey = key; return { data: {} }; });
  });
  expect(correctedKey).not.toBe(firstKey);
});

test('explicit new operation cannot replace a known order while its replay is in flight', async () => {
  await act(async () => { await intent.execute(payment, async () => ({ data: {} })); });
  let finish, request;
  await act(async () => { request = intent.execute(payment, () => new Promise(resolve => { finish = resolve; })); });
  act(() => { expect(() => intent.startNew()).toThrow(/cours/); });
  await act(async () => { finish({ data: {} }); await request; });
  act(() => intent.startNew());
  expect(sessionStorage.length).toBe(0);
});


test('resource-backed validation failure cannot rotate to a second payment', async () => {
  let firstKey, retryKey;
  await act(async () => {
    await expect(intent.execute(payment, async (_, key) => {
      firstKey = key;
      throw { response: { status: 422, data: { code: 'VALIDATION_ERROR', txnId: 'created-order' } } };
    })).rejects.toBeDefined();
  });
  await act(async () => {
    await intent.execute(payment, async (_, key) => { retryKey = key; return { data: {} }; });
  });
  expect(retryKey).toBe(firstKey);
});

test('a response from an unmounted form cannot overwrite an explicitly newer saved operation', async () => {
  await act(async () => { await intent.execute(payment, async () => ({ data: {} })); });
  let finish, request, freshKey;
  await act(async () => { request = intent.execute(payment, () => new Promise(resolve => { finish = resolve; })); });
  unmount(); mount();
  act(() => intent.startNew());
  await act(async () => {
    await expect(intent.execute({ ...payment, amount: 1800 }, async (_, key) => { freshKey = key; throw new Error('offline'); })).rejects.toThrow();
  });
  await act(async () => { finish({ data: {} }); await expect(request).rejects.toThrow(); });
  unmount(); mount();
  expect(intent.restored.amount).toBe(1800);
  let retryKey;
  await act(async () => { await intent.execute({ ...payment, amount: 1800 }, async (_, key) => { retryKey = key; return { data: {} }; }); });
  expect(retryKey).toBe(freshKey);
});

test('switching away and back does not revive a stale strong-auth callback', async () => {
  const execute = intent.execute;
  act(() => root.render(<Harness user={{ ...actor, userId: 'staff-b' }} />));
  act(() => root.render(<Harness user={actor} />));
  let sent = false;
  await act(async () => { await expect(execute(payment, async () => { sent = true; })).rejects.toThrow(/session/); });
  expect(sent).toBe(false);
});
