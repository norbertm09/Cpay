import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Modal, Button, PinInput, Alert } from '../../components';
import { errorMessage } from '../../utils/errors';
import { isPin } from '../../utils/validation';

/**
 * Definition / changement du code PIN. `onSubmit({ currentPin, newPin })`.
 * `askCurrent` : demande le PIN actuel (carte deja protegee).
 */
export default function PinModal({ open, onClose, onSubmit, askCurrent = true, title = 'Code PIN de la carte' }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const reset = () => { setCur(''); setNext(''); setConfirm(''); setError(''); };
  const close = () => { reset(); onClose(); };

  const submit = async () => {
    if (askCurrent && !isPin(cur)) { setError('Saisissez votre code PIN actuel (4 chiffres).'); return; }
    if (!isPin(next)) { setError('Le nouveau code PIN doit comporter 4 chiffres.'); return; }
    if (/^(\d)\1{3}$/.test(next) || ['1234', '0000', '4321'].includes(next)) { setError('Choisissez un code PIN moins prévisible.'); return; }
    if (next !== confirm) { setError('Les deux codes ne correspondent pas.'); return; }
    setLoading(true); setError('');
    try { await onSubmit({ currentPin: askCurrent ? cur : undefined, newPin: next }); toast.success('Code PIN enregistré'); close(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  };

  return (
    <Modal open={open} title={title} onClose={loading ? undefined : close}
      footer={<><Button variant="outline" onClick={close} disabled={loading}>Annuler</Button><Button variant="primary" onClick={submit} loading={loading}>Enregistrer</Button></>}>
      <div className="stack">
        <p className="small text-2">Le code PIN est demandé pour confirmer vos paiements. Ne le communiquez à personne.</p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        {askCurrent ? <div className="field"><span className="field-label center">PIN actuel</span><PinInput value={cur} onChange={setCur} label="PIN actuel" autoFocus name="pin-cur" /></div> : null}
        <div className="field"><span className="field-label center">Nouveau PIN</span><PinInput value={next} onChange={setNext} label="Nouveau PIN" autoFocus={!askCurrent} name="pin-new" /></div>
        <div className="field"><span className="field-label center">Confirmer le nouveau PIN</span><PinInput value={confirm} onChange={setConfirm} label="Confirmation du PIN" name="pin-conf" /></div>
      </div>
    </Modal>
  );
}
