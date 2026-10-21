import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import CashPage from './CashPage';
import { cashApi } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
vi.mock('../../hooks/useAuth', () => ({
  useAuth: vi.fn()
}));
vi.mock('../../services/api', () => ({
  cashApi: {
    stats: vi.fn(),
    bankAccounts: vi.fn(),
    verifyBankAccount: vi.fn(),
    rejectBankAccount: vi.fn()
  }
}));
const account = {
  accountId: 'ba-1',
  bankName: 'Bank Test',
  accountMasked: '****1234',
  accountName: 'Alice Account',
  status: 'pending_verification',
  merchantId: 'm-1',
  merchant: 'Alice Shop',
  merchantEmail: 'alice@example.com',
  createdAt: '2026-10-20T12:00:00Z',
  verifiedAt: null,
  verificationMethod: null
};
let root, host;
const flush = async (fn = () => {}) => {
  await act(async () => {
    fn();
    await Promise.resolve();
  });
};
const button = label => [...host.querySelectorAll('button')].find(b => b.textContent === label);
const click = async label => {
  const b = button(label);
  expect(b).toBeDefined();
  await flush(() => b.click());
};
const change = async (label, value) => {
  const el = host.querySelector(`[aria-label="${label}"]`);
  expect(el).not.toBeNull();
  await flush(() => Simulate.change(el, {
    target: {
      value
    }
  }));
};
const mount = async () => flush(() => root.render(<MemoryRouter future={{
  v7_startTransition: true,
  v7_relativeSplatPath: true
}} initialEntries={['/?tab=comptes-marchands']}><CashPage /></MemoryRouter>));
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  useAuth.mockReturnValue({
    admin: {
      role: 'ops_admin'
    }
  });
  cashApi.stats.mockResolvedValue({
    data: {}
  });
  cashApi.bankAccounts.mockResolvedValue({
    data: {
      data: [account]
    }
  });
  cashApi.verifyBankAccount.mockResolvedValue({
    data: {}
  });
  cashApi.rejectBankAccount.mockResolvedValue({
    data: {}
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await flush(() => root.unmount());
  host.remove();
});
test('loads masked pending accounts and selected filter', async () => {
  await mount();
  expect(host.textContent).toContain('****1234');
  expect(host.textContent).toContain('Alice Shop');
  expect(cashApi.bankAccounts).toHaveBeenCalledWith({
    status: 'pending_verification'
  });
  await change('Statut des comptes marchands', 'rejected');
  expect(cashApi.bankAccounts).toHaveBeenLastCalledWith({
    status: 'rejected'
  });
});
test('requires evidence then verifies and refreshes', async () => {
  await mount();
  await click('Vérifier');
  expect(host.querySelector('[role="dialog"]').textContent).toContain('****1234');
  expect(button('Confirmer la vérification').disabled).toBe(true);
  await change('Méthode de vérification', 'document');
  await change('Référence de vérification', ' DOC-123 ');
  await change('Note de vérification', ' checked ');
  await click('Confirmer la vérification');
  expect(cashApi.verifyBankAccount).toHaveBeenCalledWith('ba-1', {
    method: 'document',
    reference: 'DOC-123',
    note: 'checked'
  });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(cashApi.bankAccounts).toHaveBeenCalledTimes(2);
});
test('reject validates reason', async () => {
  await mount();
  await click('Rejeter');
  await change('Motif du rejet', 'bad');
  expect(button('Confirmer le rejet').disabled).toBe(true);
  await change('Motif du rejet', ' Document illisible ');
  await click('Confirmer le rejet');
  expect(cashApi.rejectBankAccount).toHaveBeenCalledWith('ba-1', 'Document illisible');
});
test('forbidden role makes no account calls', async () => {
  useAuth.mockReturnValue({
    admin: {
      role: 'support_admin'
    }
  });
  await mount();
  expect(cashApi.bankAccounts).not.toHaveBeenCalled();
  expect(button('Vérifier')).toBeUndefined();
});
test('500 retains evidence and 409 clears stale action and refreshes', async () => {
  cashApi.verifyBankAccount.mockRejectedValueOnce({
    response: {
      status: 500
    }
  }).mockRejectedValueOnce({
    response: {
      status: 409
    }
  });
  await mount();
  await click('Vérifier');
  await change('Méthode de vérification', 'manual');
  await change('Référence de vérification', 'OPS-22');
  await click('Confirmer la vérification');
  expect(host.querySelector('[role="alert"]').textContent).toContain('serveur');
  expect(host.querySelector('[aria-label="Référence de vérification"]').value).toBe('OPS-22');
  await click('Confirmer la vérification');
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(cashApi.bankAccounts).toHaveBeenCalledTimes(2);
});
test('list error retries to empty state', async () => {
  cashApi.bankAccounts.mockRejectedValueOnce({
    response: {
      status: 500
    }
  }).mockResolvedValueOnce({
    data: {
      data: []
    }
  });
  await mount();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await click('Réessayer');
  expect(host.textContent).toContain('Aucun compte marchand');
});
test('server forbidden removes decisions and prevents further account calls', async () => {
  cashApi.verifyBankAccount.mockRejectedValueOnce({
    response: {
      status: 403
    }
  });
  await mount();
  await click('Vérifier');
  await change('Méthode de vérification', 'manual');
  await change('Référence de vérification', 'OPS-403');
  await click('Confirmer la vérification');
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(button('Vérifier')).toBeUndefined();
  expect(cashApi.bankAccounts).toHaveBeenCalledTimes(1);
});
test('busy confirmation blocks repeated decisions and cancellation until server response', async () => {
  let resolve;
  cashApi.verifyBankAccount.mockReturnValueOnce(new Promise(r => {
    resolve = r;
  }));
  await mount();
  await click('Vérifier');
  await change('Méthode de vérification', 'micro_deposit');
  await change('Référence de vérification', 'DEP-1');
  await click('Confirmer la vérification');
  expect(button('Confirmer la vérification').disabled).toBe(true);
  expect(button('Annuler').disabled).toBe(true);
  expect(cashApi.bankAccounts).toHaveBeenCalledTimes(1);
  await click('Confirmer la vérification');
  expect(cashApi.verifyBankAccount).toHaveBeenCalledTimes(1);
  await flush(() => resolve({
    data: {}
  }));
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(cashApi.bankAccounts).toHaveBeenCalledTimes(2);
});
test('list forbidden blocks filter and refresh without retry', async () => {
  cashApi.bankAccounts.mockRejectedValueOnce({
    response: {
      status: 403
    }
  });
  await mount();
  expect(button('Actualiser les comptes').disabled).toBe(true);
  expect(host.querySelector('[aria-label="Statut des comptes marchands"]').disabled).toBe(true);
  expect(button('Réessayer')).toBeUndefined();
  expect(button('Vérifier')).toBeUndefined();
});
test('verification evidence enforces backend reference and note bounds', async () => {
  await mount();
  await click('Vérifier');
  await change('Méthode de vérification', 'manual');
  await change('Référence de vérification', 'r'.repeat(129));
  expect(button('Confirmer la vérification').disabled).toBe(true);
  await change('Référence de vérification', 'r'.repeat(128));
  await change('Note de vérification', 'n'.repeat(1001));
  expect(button('Confirmer la vérification').disabled).toBe(true);
  await change('Note de vérification', 'n'.repeat(1000));
  expect(button('Confirmer la vérification').disabled).toBe(false);
});
