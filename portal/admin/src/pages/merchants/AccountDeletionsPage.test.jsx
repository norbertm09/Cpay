import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from '../../test/simulate';
import { MemoryRouter } from 'react-router-dom';
import AccountDeletionsPage from './AccountDeletionsPage';
import { merchantsApi } from '../../services/api';
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ admin: { role: 'ops_admin' }, hasRole: () => true }) }));
vi.mock('../../services/api', () => ({ merchantsApi: { deletionRequests: vi.fn(), processDeletion: vi.fn() } }));

const request = {
  requestId: 'req-1', merchantId: 'm-1', businessName: 'Boutique Moungali', country: 'CG', currency: 'XAF', status: 'pending',
  reason: 'Fin d’activité', channel: 'android', requestedAt: '2026-11-01T10:00:00Z', retractUntil: '2026-12-01T10:00:00Z',
  balanceAtRequest: 12500, processedAt: null, email: 'boutique@example.com', canCancel: true,
};
let root, host;
const flush = async (fn = () => {}) => { await act(async () => { fn(); await Promise.resolve(); }); };
const button = (label) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const click = async (label) => { const b = button(label); expect(b).toBeDefined(); await flush(() => b.click()); };
const mount = async () => flush(() => root.render(<MemoryRouter><AccountDeletionsPage /></MemoryRouter>));

beforeEach(() => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  merchantsApi.deletionRequests.mockResolvedValue({ data: { data: [request], page: 1, limit: 50 } });
  merchantsApi.processDeletion.mockResolvedValue({ data: { success: true } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await flush(() => root.unmount()); host.remove(); });

test('liste les demandes à traiter avec le marchand, le solde et le délai de rétractation', async () => {
  await mount();
  expect(merchantsApi.deletionRequests).toHaveBeenCalledWith({ status: 'pending', page: 1, limit: 50 });
  expect(host.textContent).toContain('Boutique Moungali');
  expect(host.textContent).toContain('Fin d’activité');
  expect(host.textContent).toContain('À traiter');
  expect(host.textContent).toContain('délai en cours');
  expect(button('Fermer le compte')).toBeDefined();
  expect(button('Refuser')).toBeDefined();
});

test('le refus exige un motif puis appelle PATCH avec status=rejected et la note', async () => {
  await mount();
  await click('Refuser');
  const confirm = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Refuser').pop();
  expect(confirm.disabled).toBe(true);
  const ta = host.querySelector('[aria-label="Motif du refus"]');
  await flush(() => Simulate.change(ta, { target: { value: 'Solde à régulariser' } }));
  expect(confirm.disabled).toBe(false);
  await flush(() => confirm.click());
  expect(merchantsApi.processDeletion).toHaveBeenCalledWith('req-1', { status: 'rejected', note: 'Solde à régulariser' });
  expect(merchantsApi.deletionRequests).toHaveBeenCalledTimes(2);
});

test('la fermeture avertit si le délai court et si le solde est non nul, puis appelle PATCH status=processed', async () => {
  await mount();
  await click('Fermer le compte');
  expect(host.textContent).toContain('délai de rétractation n’est pas écoulé');
  expect(host.textContent).toContain('Solde non nul');
  const confirm = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Fermer le compte').pop();
  await flush(() => confirm.click());
  expect(merchantsApi.processDeletion).toHaveBeenCalledWith('req-1', { status: 'processed', note: undefined });
});

test('les demandes traitées n’ont plus d’action', async () => {
  merchantsApi.deletionRequests.mockResolvedValue({ data: { data: [{ ...request, status: 'processed', processedAt: '2026-12-02T09:00:00Z' }] } });
  await mount();
  expect(host.textContent).toContain('Compte fermé');
  expect(button('Fermer le compte')).toBeUndefined();
});
