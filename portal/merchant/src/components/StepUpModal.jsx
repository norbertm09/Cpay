import React, { useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import { OtpInput, PasswordInput } from './Field';

// Fenêtre de confirmation forte (TOTP ou mot de passe), pilotée par useStepUp.
export const StepUpModal = ({ title = 'Confirmer l’opération', summary, methods, error, busy, onConfirm, onClose }) => {
  const totp = (methods || []).includes('totp');
  const [val, setVal] = useState('');
  const canSubmit = totp ? val.length === 6 : val.length > 0;
  const submit = (e) => { e?.preventDefault(); if (!canSubmit || busy) return; onConfirm(totp ? { code: val } : { password: val }); };
  return (
    <Modal title={title} onClose={onClose} locked={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Annuler</Button><Button variant="primary" onClick={submit} disabled={!canSubmit} loading={busy}>Confirmer</Button></>}>
      <form onSubmit={submit}>
        {summary && <div className="kv-box mb-4">{summary}</div>}
        <p className="small text-2 mb-3">{totp ? 'Saisissez le code à 6 chiffres de votre application d’authentification.' : 'Saisissez votre mot de passe pour confirmer.'}</p>
        {totp
          ? <OtpInput value={val} onChange={setVal} error={error} autoFocus />
          : <PasswordInput label="Mot de passe" value={val} onChange={setVal} autoComplete="current-password" error={error} autoFocus required />}
        <button type="submit" className="sr-only">Confirmer</button>
      </form>
    </Modal>
  );
};
export default StepUpModal;
