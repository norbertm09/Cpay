import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { cashApi, accountApi } from '../../services/api';
import { TransferRecovery } from './TransferRecovery';
import { Retirer } from './Retirer';
import { Transferer } from './Transferer';
import { TransactionDrawer } from '../activite/TransactionDrawer';
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { userId: 'u1', merchantId: 'm1', role: 'owner', currency: 'XAF', country: 'CG' } }) }));
const mockReload = vi.fn();
vi.mock('../../hooks/useCashSummary', () => ({ useCashSummary: () => ({ summary: { currency: 'XAF', balance: { available: 100000 } }, state: 'ok', reload: mockReload }) }));
vi.mock('../../hooks/useCapabilities', () => ({ useCapabilities: () => ({ isOpen: () => true, isPilot: () => false }) }));
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, host;
const unknown = { transferId: 'order-1', reference: 'PAY-1', status: 'unknown', direction: 'withdraw', amount: 1200, fee: 100, net: 1100, currency: 'XAF', unknownSince: '2026-10-21T10:00:00Z', lastStatusCheckAt: '2026-10-21T10:01:00Z', needsReview: true };
async function mount(node) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{node}</MemoryRouter>)); }
async function change(input, value) { await act(async () => Simulate.change(input, { target: { value } })); }
async function submit(form) { await act(async () => Simulate.submit(form)); }
async function launch(Component) { await mount(<Component />); await change(host.querySelector('.amount-input input'), '1200'); await submit(host.querySelector('form')); await change(document.querySelector('.modal input[type="password"]'), 'private-secret'); await submit(document.querySelector('.modal form')); }
async function refresh() { const button = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Actualiser le statut')); expect(button).toBeDefined(); await act(async () => Simulate.click(button)); }
beforeEach(() => {
 sessionStorage.clear(); mockReload.mockClear();
 vi.spyOn(cashApi, 'getWallet').mockResolvedValue({ data: { phone: '+242061234567', operator: 'mtn_momo' } });
 vi.spyOn(accountApi, 'bankAccounts').mockResolvedValue({ data: { data: [{ accountId: 'bank-1', status: 'verified', institution: { name: 'Bank' }, accountNumber: '12345678', accountName: 'Company' }] } });
 vi.spyOn(cashApi, 'listTransfers').mockResolvedValue({ data: { data: [] } });
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.restoreAllMocks(); });
test.each([['withdrawal', Retirer, 'withdraw'], ['transfer', Transferer, 'createTransfer']].flatMap(([name, Component, method]) => ['unknown', 'processing'].map(status => [`${name} ${status}`, Component, method, status])))('%s displays uncertain reservation and gets current completed order without POST replay', async (_name, Component, method, status) => {
 let finish; const post = vi.spyOn(cashApi, method).mockResolvedValue({ status: 201, data: { ...unknown, status } });
 const get = vi.spyOn(cashApi, 'getTransfer').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
 await launch(Component);
 expect(host.textContent).toContain(status === 'unknown' ? 'Résultat incertain' : 'En cours de confirmation'); expect(host.textContent).toContain('fonds restent réservés'); expect(host.textContent).toContain('À confirmer');
 expect(host.textContent).not.toMatch(/Net envoyé|Net viré/); expect(host.textContent).toContain('Dernière vérification'); expect(host.textContent).toContain('Revue');
 expect(get).toHaveBeenCalledWith('order-1');
 const saved = JSON.stringify(sessionStorage);
 await act(async () => finish({ data: { ...unknown, status: 'completed' } }));
 expect(host.textContent).toMatch(/Terminé|terminé/); expect(host.textContent).not.toContain('fonds restent réservés');  expect(host.textContent).toMatch(/Net envoyé|Net viré/); expect(post).toHaveBeenCalledTimes(1); expect(JSON.stringify(sessionStorage)).toBe(saved); expect(saved).not.toContain('private-secret');
});
test.each([['withdrawal', Retirer, 'withdraw'], ['transfer', Transferer, 'createTransfer']])('%s retries only GET for same uncertain order after network failure then rejected', async (_name, Component, method) => {
 const post = vi.spyOn(cashApi, method).mockResolvedValue({ status: 201, data: unknown });
 const get = vi.spyOn(cashApi, 'getTransfer').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: { ...unknown, status: 'rejected', needsReview: false } });
 await launch(Component); const saved = JSON.stringify(sessionStorage); const previousReloads = mockReload.mock.calls.length; expect(host.textContent).toContain('Résultat incertain');
 await refresh(); expect(mockReload).toHaveBeenCalledTimes(previousReloads + 1); expect(get.mock.calls).toEqual([['order-1'], ['order-1']]); expect(post).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('Rejeté'); expect(host.textContent).toContain('Non envoyé'); expect(host.textContent).not.toContain('fonds restent réservés'); expect(JSON.stringify(sessionStorage)).toBe(saved);
});
test('journal transfer detail explains uncertainty and refreshes current order', async () => {
 const get = vi.spyOn(cashApi, 'getTransfer').mockResolvedValue({ data: unknown });
 await mount(<TransactionDrawer row={{ id: 'order-1', reference: 'PAY-1', type: 'withdraw', status: 'unknown', amount: 1200, net: 1100 }} currency="XAF" onClose={() => {}} />);
 expect(host.textContent).toContain('Résultat incertain'); expect(host.textContent).toContain('fonds restent réservés'); expect(host.textContent).toContain('À confirmer');
 get.mockResolvedValue({ data: { ...unknown, status: 'completed' } }); await refresh(); expect(host.textContent).toContain('Terminé');
});

test('status recovery works under the app StrictMode effect replay', async () => {
 const updated = vi.fn(); const get = vi.spyOn(cashApi, 'getTransfer').mockResolvedValue({ data: { ...unknown, status: 'completed' } });
 await mount(<React.StrictMode><TransferRecovery transfer={unknown} onUpdated={updated} /></React.StrictMode>);
 expect(get).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledWith('order-1'); expect(updated).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
});
test.each(['pending', 'error'])('changing order clears previous %s refresh state and ignores its response', async previous => {
 let finish; const updated = vi.fn();
 vi.spyOn(cashApi, 'getTransfer').mockImplementation(() => previous === 'error' ? Promise.reject(new Error('offline')) : new Promise(resolve => { finish = resolve; }));
 await mount(<TransferRecovery transfer={unknown} onUpdated={updated} />);
 await act(async () => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><TransferRecovery transfer={{ ...unknown, transferId: 'order-2', status: 'completed' }} onUpdated={updated} /></MemoryRouter>));
 const button = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Actualiser le statut'));
 expect(button.disabled).toBe(false); expect(host.textContent).not.toContain('Vérification indisponible');
 if (finish) await act(async () => finish({ data: { ...unknown, status: 'rejected' } }));
 expect(updated).not.toHaveBeenCalled();
});
