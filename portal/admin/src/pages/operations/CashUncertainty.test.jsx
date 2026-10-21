import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import CashPage from './CashPage';
import CashTransferDrawer from './CashTransferDrawer';
import { cashApi } from '../../services/api';
import { fmtDateTime } from '../../utils/format';
jest.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    admin: {
      role: 'ops_admin'
    },
    hasRole: () => true
  })
}));
jest.mock('../../services/api', () => ({
  cashApi: {
    stats: jest.fn(),
    reconciliationStatus: jest.fn(),
    transfers: jest.fn(),
    transfer: jest.fn(),
    reject: jest.fn(),
    markExecuted: jest.fn()
  }
}));
const transfer = {
  transferId: 't-1',
  reference: 'TRF-uncertain',
  direction: 'wallet_to_bank',
  status: 'unknown',
  amount: 12500,
  currency: 'XAF',
  fee: 500,
  net: 12000,
  merchantId: 'm-1',
  merchant: 'Shop',
  merchantEmail: 'shop@example.com',
  createdAt: '2026-10-20T08:00:00Z',
  completedAt: null,
  bankAccount: {
    bankName: 'Bank',
    accountMasked: '****1234'
  },
  unknownSince: '2026-10-20T09:00:00Z',
  lastStatusCheckAt: '2026-10-20T11:00:00Z',
  needsReview: true,
  events: []
};
let root, host;
const flush = async (fn = () => {}) => {
  await act(async () => {
    fn();
    await Promise.resolve();
  });
};
const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.startsWith(text));
const click = async text => {
  expect(button(text)).toBeDefined();
  await flush(() => button(text).click());
};
const mount = async (url, content = <CashPage />) => flush(() => root.render(<MemoryRouter future={{
  v7_startTransition: true,
  v7_relativeSplatPath: true
}} initialEntries={[url]}>{content}</MemoryRouter>));
beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  cashApi.reconciliationStatus.mockResolvedValue({
    data: {
      enabled: true,
      scheduled: true,
      running: false,
      lastSuccessfulAt: null,
      consecutiveFailures: 0
    }
  });
  cashApi.stats.mockResolvedValue({
    data: {
      queues: {
        pendingManual: {
          count: 2,
          amount: 25000
        },
        awaitingFunds: {
          count: 1,
          amount: 5000
        },
        processing: {
          count: 3
        },
        unknown: {
          count: 4,
          amount: 50000
        },
        needsReview: {
          count: 1,
          amount: 12500
        }
      }
    }
  });
  cashApi.transfers.mockResolvedValue({
    data: {
      data: [transfer],
      total: 1
    }
  });
  cashApi.transfer.mockResolvedValue({
    data: transfer
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await flush(() => root.unmount());
  host.remove();
});
test('unknown queue shows reserved funds, timestamps and server counts', async () => {
  await mount('/?queue=unknown');
  expect(cashApi.transfers).toHaveBeenLastCalledWith({
    status: 'unknown',
    limit: 50,
    offset: 0
  });
  expect(button('Issue inconnue')).toBeDefined();
  expect(button('Issue inconnue').textContent).toContain('4');
  expect(host.textContent).toContain('Fonds réservés');
  expect(host.textContent).toContain('paiement non confirmé');
  expect(host.textContent).toContain(fmtDateTime(transfer.lastStatusCheckAt));
  expect(host.textContent).toContain(fmtDateTime(transfer.unknownSince));
});
test('review queue uses needsReview flag without an invented status', async () => {
  await mount('/');
  await click('À examiner');
  expect(cashApi.transfers).toHaveBeenLastCalledWith({
    needsReview: 1,
    limit: 50,
    offset: 0
  });
  expect(host.textContent).toContain('Examen requis');
});
test('queue error is visible and retry loads the queue', async () => {
  cashApi.transfers.mockRejectedValueOnce({
    response: {
      status: 500
    }
  });
  await mount('/?queue=unknown');
  expect(host.textContent).toContain('Chargement impossible');
  expect(host.textContent).not.toContain('File vide');
  await click('Réessayer');
  expect(host.textContent).toContain(transfer.reference);
});
test.each(['unknown', 'processing'])('%s drawer preserves reservation and exposes recovery timestamps without overrides', async status => {
  cashApi.transfer.mockResolvedValue({
    data: {
      ...transfer,
      status
    }
  });
  await mount('/', <CashTransferDrawer id="t-1" initial={{
    ...transfer,
    status
  }} onClose={() => {}} />);
  expect(host.textContent).toContain('Fonds réservés');
  expect(host.textContent).toContain('paiement non confirmé');
  expect(host.textContent).toContain('Dernier contrôle du statut');
  expect(host.textContent).toContain(fmtDateTime(transfer.lastStatusCheckAt));
  expect(host.textContent).toContain('Issue inconnue depuis');
  expect(host.textContent).toContain(fmtDateTime(transfer.unknownSince));
  expect(host.textContent).toContain('Examen requis');
  expect(button('Rejeter')).toBeUndefined();
  expect(button('Marquer exécuté')).toBeUndefined();
  expect(cashApi.reject).not.toHaveBeenCalled();
  expect(cashApi.markExecuted).not.toHaveBeenCalled();
});
test('detail fetch failure remains visible with initial data and supports read-only retry', async () => {
  cashApi.transfer.mockRejectedValueOnce({
    response: {
      status: 500
    }
  });
  await mount('/', <CashTransferDrawer id="t-1" initial={transfer} onClose={() => {}} />);
  expect(host.textContent).toContain('Chargement impossible');
  await click('Réessayer');
  expect(cashApi.transfer).toHaveBeenCalledTimes(2);
  expect(host.textContent).not.toContain('Chargement impossible');
  expect(host.textContent).toContain('Fonds réservés');
});
test('all transfers filter offers unknown status', async () => {
  await mount('/?tab=transferts');
  expect(host.querySelector('select[aria-label="Statut"] option[value="unknown"]')).not.toBeNull();
});
test('reconciliation health shows last success without replacing the queue', async () => {
  cashApi.reconciliationStatus.mockResolvedValue({
    data: {
      enabled: true,
      scheduled: true,
      running: false,
      lastSuccessfulAt: '2026-10-20T12:00:00Z',
      consecutiveFailures: 0
    }
  });
  await mount('/?queue=unknown');
  expect(host.textContent).toContain('Dernier rapprochement réussi');
  expect(host.textContent).toContain(fmtDateTime('2026-10-20T12:00:00Z'));
  expect(host.textContent).toContain(transfer.reference);
});
test.each([{
  enabled: false,
  expected: 'Rapprochement automatique désactivé'
}, {
  enabled: true,
  scheduled: true,
  lastSuccessfulAt: null,
  expected: 'Aucun rapprochement réussi enregistré'
}, {
  enabled: true,
  scheduled: true,
  consecutiveFailures: 2,
  expected: 'Dernier rapprochement incomplet ou en échec'
}])('health reports $expected without inventing success', async state => {
  cashApi.reconciliationStatus.mockResolvedValue({
    data: state
  });
  await mount('/?queue=unknown');
  expect(host.textContent).toContain(state.expected);
  expect(host.textContent).toContain(transfer.reference);
});
test('health failure stays nonblocking and does not expose server details', async () => {
  cashApi.reconciliationStatus.mockRejectedValue({
    response: {
      status: 500,
      data: {
        error: 'secret-provider-token'
      }
    }
  });
  await mount('/?queue=unknown');
  expect(host.textContent).toContain('Suivi du rapprochement indisponible');
  expect(host.textContent).not.toContain('secret-provider-token');
  expect(button('Consulter')).toBeDefined();
});
test('headline aggregates describe requested withdrawals rather than confirmed payments', async () => {
  await mount('/');
  expect(host.textContent).toContain('Retraits demandés');
  expect(host.textContent).toContain('Transferts demandés vers banque');
  expect(host.textContent).not.toContain('Retiré (wallet)');
});
test('missing health payload does not claim the scheduler is active', async () => {
  cashApi.reconciliationStatus.mockResolvedValue({
    data: {}
  });
  await mount('/?queue=unknown');
  expect(host.textContent).toContain('Suivi du rapprochement indisponible');
  expect(host.textContent).toContain(transfer.reference);
});
test('unknown queue summary shows reserved amount from server stats', async () => {
  await mount('/?queue=unknown');
  expect(host.textContent).toContain('50\u202f000 réservés');
});
