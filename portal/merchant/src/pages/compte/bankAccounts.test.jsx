import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { api, authApi, accountApi, cashApi } from '../../services/api';
import { BankAccountForm } from '../caisse/shared';
import { Comptes } from './Comptes';
let mockUser = { userId: 'u1', merchantId: 'm1', role: 'owner', country: 'CG' };
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));
let mockStepUpProps;
vi.mock('../../components', async () => {
 const actual = await vi.importActual('../../components');
 return { ...actual, StepUpModal: props => { mockStepUpProps = props; return <actual.StepUpModal {...props} />; } };
});
global.IS_REACT_ACT_ENVIRONMENT = true;
let root, host;
async function mount(node) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); await act(async () => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{node}</MemoryRouter>)); }
async function change(input, value) { await act(async () => Simulate.change(input, { target: { value } })); }
async function submit(form) { await act(async () => Simulate.submit(form)); }
async function fill() { await change(host.querySelector('select'), 'bank1'); const inputs = host.querySelectorAll('input'); await change(inputs[0], 'Company'); await change(inputs[1], '123456789'); await submit(host.querySelector('form')); }
async function confirm(value) { await change(document.querySelector('.modal input'), value); await submit(document.querySelector('.modal form')); }
beforeEach(() => {
 mockUser = { userId: 'u1', merchantId: 'm1', role: 'owner', country: 'CG' };
 vi.spyOn(authApi, 'institutions').mockResolvedValue({ data: { institutions: [{ institution_id: 'bank1', name: 'Bank', type: 'bank' }] } });
 vi.spyOn(accountApi, 'bankAccounts').mockResolvedValue({ data: { data: [{ accountId: 'b1', accountName: 'Company', accountNumber: '123456789', institution: { name: 'Test Bank' }, status: 'pending_verification' }, { accountId: 'b2', status: 'rejected' }, { accountId: 'b3', status: 'verified' }] } });
 vi.spyOn(cashApi, 'getWallet').mockResolvedValue({ data: { phone: '123456789', operator: 'mtn_momo' } });
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.restoreAllMocks(); });
test.each([false, true])('adding requires strong confirmation (MFA %s)', async mfaEnabled => {
 const sent = []; vi.spyOn(accountApi, 'addBankAccount').mockImplementation(async body => { sent.push(body); return { data: {} }; });
 await mount(<BankAccountForm user={{ ...mockUser, mfaEnabled }} onSaved={() => {}} />); await fill();
 expect(sent).toHaveLength(0); expect(document.querySelector('.modal')).not.toBeNull(); await confirm(mfaEnabled ? '123456' : 'private-password');
 expect(sent[0].confirm).toEqual(mfaEnabled ? { code: '123456' } : { password: 'private-password' }); expect(JSON.stringify(sessionStorage)).not.toContain('private-password');
});
test('428 changes confirmation method and allows retry', async () => {
 let calls = 0; const sent = []; vi.spyOn(accountApi, 'addBankAccount').mockImplementation(async body => { sent.push(body); if (++calls === 1) throw { response: { status: 428, data: { methods: ['totp'] } } }; return { data: {} }; });
 await mount(<BankAccountForm user={mockUser} onSaved={() => {}} />); await fill(); expect(document.querySelector('.modal')).not.toBeNull(); await confirm('old-password');
 expect(document.querySelector('.modal input[type="password"]')).toBeNull(); await confirm('123456'); expect(sent[1].confirm).toEqual({ code: '123456' });
});
test('DELETE serializes confirmation in axios request body', async () => {
 let request; const adapter = api.defaults.adapter; api.defaults.adapter = async config => { request = config; return { status: 200, data: {}, headers: {}, config }; };
 try { await accountApi.deleteBankAccount('b1', { password: 'secret' }); expect(request.data).toBe(JSON.stringify({ confirm: { password: 'secret' } })); } finally { api.defaults.adapter = adapter; }
});
test('owner removal waits for strong confirmation', async () => {
 const sent = []; vi.spyOn(accountApi, 'deleteBankAccount').mockImplementation(async (...args) => { sent.push(args); return {}; }); await mount(<Comptes />);
 await act(async () => Simulate.click([...host.querySelectorAll('button')].find(b => b.textContent === 'Retirer')));
 expect(document.querySelector('.modal').textContent).toContain('Test Bank'); expect(document.querySelector('.modal').textContent).toContain('Company'); expect(document.querySelector('.modal').textContent).toContain('6789'); expect(document.querySelector('.modal').textContent).not.toContain('123456789'); expect(document.querySelector('.modal input[type="password"]')).not.toBeNull(); expect(sent).toHaveLength(0); await confirm('secret'); expect(sent[0]).toEqual(['b1', { password: 'secret' }]);
});
test('cashier reads statuses but cannot add or remove', async () => {
 mockUser.role = 'cashier'; await mount(<Comptes />); expect(host.textContent).toContain('En attente de vérification'); expect(host.textContent).toContain('Rejeté'); expect(host.textContent).toContain('Vérifié');
 expect([...host.querySelectorAll('button')].some(b => /Ajouter|Retirer/.test(b.textContent))).toBe(false); expect(host.textContent).toContain('inutilisable');
});
test('direct non-owner form cannot submit an account', async () => {
 await mount(<BankAccountForm user={{ ...mockUser, role: 'cashier' }} onSaved={() => {}} />); expect(host.querySelector('button[type="submit"]')?.disabled ?? true).toBe(true);
});
test('cancelling bank confirmation sends no account request', async () => {
 const add = vi.spyOn(accountApi, 'addBankAccount').mockResolvedValue({ data: {} });
 await mount(<BankAccountForm user={mockUser} onSaved={() => {}} />); await fill();
 await act(async () => Simulate.click([...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Annuler')));
 expect(document.querySelector('.modal')).toBeNull(); expect(add).not.toHaveBeenCalled();
});
test('removal accepts TOTP and renews confirmation after 428', async () => {
 mockUser.mfaEnabled = true; const sent = [];
 vi.spyOn(accountApi, 'deleteBankAccount').mockImplementation(async (...args) => { sent.push(args); if (sent.length === 1) throw { response: { status: 428, data: { methods: ['password'] } } }; return {}; });
 await mount(<Comptes />); await act(async () => Simulate.click([...host.querySelectorAll('button')].find(b => b.textContent === 'Retirer')));
 await confirm('123456'); expect(document.querySelector('.modal input[type="password"]')).not.toBeNull(); await confirm('renewed-password');
 expect(sent).toEqual([['b1', { code: '123456' }], ['b1', { password: 'renewed-password' }]]);
});

test.each(['add', 'remove'])('%s cannot confirm a previous owner operation after switching users', async kind => {
 const mutation = vi.spyOn(accountApi, kind === 'add' ? 'addBankAccount' : 'deleteBankAccount').mockResolvedValue({ data: {} });
 const node = () => kind === 'add' ? <BankAccountForm user={mockUser} onSaved={() => {}} /> : <Comptes />;
 await mount(node());
 if (kind === 'add') await fill(); else await act(async () => Simulate.click([...host.querySelectorAll('button')].find(b => b.textContent === 'Retirer')));
 const oldConfirm = mockStepUpProps.onConfirm;
 mockUser = { ...mockUser, userId: 'other-owner', merchantId: 'other-merchant' };
 await act(async () => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{node()}</MemoryRouter>));
 await act(async () => oldConfirm({ password: 'old-secret' }));
 expect(mutation).not.toHaveBeenCalled(); expect(document.querySelector('.modal input')).toBeNull();
});
test('same-tick repeated confirmation creates only one account', async () => {
 let finish; const add = vi.spyOn(accountApi, 'addBankAccount').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
 await mount(<BankAccountForm user={mockUser} onSaved={() => {}} />); await fill();
 await act(async () => { mockStepUpProps.onConfirm({ password: 'secret' }); mockStepUpProps.onConfirm({ password: 'secret' }); });
 expect(add).toHaveBeenCalledTimes(1);
 await act(async () => finish({ data: {} }));
});
test('a cancelled old confirmation cannot confirm a replacement operation', async () => {
 const add = vi.spyOn(accountApi, 'addBankAccount').mockResolvedValue({ data: {} });
 await mount(<BankAccountForm user={mockUser} onSaved={() => {}} />); await fill(); const stale = mockStepUpProps.onConfirm;
 await act(async () => mockStepUpProps.onClose()); await submit(host.querySelector('form'));
 await act(async () => stale({ password: 'old-secret' })); expect(add).not.toHaveBeenCalled();
});

test('add summary stays bound to the account awaiting confirmation', async () => {
 const sent = []; vi.spyOn(accountApi, 'addBankAccount').mockImplementation(async body => { sent.push(body); return { data: {} }; });
 await mount(<BankAccountForm user={mockUser} onSaved={() => {}} />); await fill();
 await change(host.querySelector('form input'), 'Changed Company');
 expect(document.querySelector('.modal').textContent).toContain('Company'); expect(document.querySelector('.modal').textContent).not.toContain('Changed Company');
 await confirm('secret'); expect(sent[0].accountName).toBe('Company');
});
