// Confirmation forte (step-up, CAISSE-API §6).
//
// Les opérations sensibles (retrait, transfert, enregistrement du wallet)
// exigent un objet `confirm` : { code } si le 2FA est actif, sinon
// { password }. En cas de 428 STEP_UP_REQUIRED la liste `methods` de la
// réponse fait foi et la fenêtre reste ouverte pour une nouvelle saisie.
//
// useStepUp(user) renvoie { state, request(run, methods?), close, confirm } :
//   request(run) ouvre la fenêtre ; run(confirm) est la fonction métier.
//   Elle doit gérer elle-même ses erreurs (toast) SAUF le 428 qu'elle
//   laisse remonter pour que la fenêtre redemande la confirmation.
import { useState, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { isStepUp } from '../services/api';
import { errorMessage } from '../utils/errors';

export const useStepUp = (user) => {
  const [state, setState] = useState(null);
  const runRef = useRef(null);
  const mfa = !!user?.mfaEnabled;
  const request = useCallback((run, methods) => {
    runRef.current = run;
    setState({ methods: methods?.length ? methods : (mfa ? ['totp'] : ['password']), error: null, busy: false });
  }, [mfa]);
  const close = useCallback(() => { runRef.current = null; setState(null); }, []);
  const confirm = useCallback(async (confirmObj) => {
    const run = runRef.current;
    if (!run) return;
    setState(s => s && ({ ...s, busy: true, error: null }));
    try {
      await run(confirmObj);
      runRef.current = null; setState(null);
    } catch (err) {
      if (isStepUp(err)) {
        const methods = err.response?.data?.methods;
        const msg = err.response?.data?.error;
        setState(s => s && ({ ...s, busy: false, methods: methods?.length ? methods : s.methods, error: msg && msg !== 'STEP_UP_REQUIRED' ? msg : 'Code ou mot de passe invalide, réessayez.' }));
        return;
      }
      runRef.current = null; setState(null);
      toast.error(errorMessage(err));
    }
  }, []);
  return { state, request, close, confirm };
};
