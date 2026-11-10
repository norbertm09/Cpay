// Audit 2026-11-10 § 3 : la détection d'opérateur de la saisie précédente est invalidée dès que le numéro change.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { detectApi } from '../../services/api';
import { usePhoneDetection } from './shared';

global.IS_REACT_ACT_ENVIRONMENT = true;
let current;
function Harness({ phone }) { current = usePhoneDetection(phone, true, 'CG'); return null; }
let root, host;
beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

test('changing the number drops the previous detection before the new answer arrives', async () => {
  const pending = [];
  vi.spyOn(detectApi, 'phone').mockImplementation((phone) => new Promise((resolve) => pending.push({ phone, resolve })));
  act(() => root.render(<Harness phone="060000001" />));
  await act(async () => { vi.advanceTimersByTime(450); });
  expect(pending).toHaveLength(1);
  await act(async () => { pending[0].resolve({ data: { success: true, operator: 'MTN_MOMO', phone: '+242060000001' } }); });
  expect(current.detect).toMatchObject({ operator: 'MTN_MOMO', phone: '+242060000001' });

  // l'utilisateur corrige le numéro : plus aucune détection exploitable tant que la nouvelle réponse n'est pas là
  act(() => root.render(<Harness phone="050000002" />));
  expect(current.detect).toBeNull();
  await act(async () => { vi.advanceTimersByTime(450); });
  expect(current.detect).toBeNull(); expect(current.detecting).toBe(true);
  await act(async () => { pending[1].resolve({ data: { success: true, operator: 'AIRTEL_MONEY', phone: '+242050000002' } }); });
  expect(current.detect).toMatchObject({ operator: 'AIRTEL_MONEY' });
});
