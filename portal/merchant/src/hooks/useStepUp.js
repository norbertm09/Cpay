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
import { useState, useCallback, useRef, useLayoutEffect } from 'react';
import toast from 'react-hot-toast';
import { isStepUp } from '../services/api';
import { errorMessage } from '../utils/errors';

export const useStepUp = (user) => {
  const [state, setState] = useState(null);
  const runRef = useRef(null);
  const actor = JSON.stringify([user?.userId, user?.merchantId, user?.role]);
  const actorRef = useRef(actor);
  // Invalidate synchronously: an old callback must fail even before effects run.
  if (actorRef.current !== actor) {
    actorRef.current = actor;
    runRef.current = null;
  }
  useLayoutEffect(() => {
    setState(null);
    return () => { runRef.current = null; };
  }, [actor]);
  const mfa = !!user?.mfaEnabled;
  const request = useCallback((run, methods) => {
    if (actorRef.current !== actor || runRef.current?.busy) return;
    const operation = { run, actor, busy: false };
    runRef.current = operation;
    setState({ operation, methods: methods?.length ? methods : (mfa ? ['totp'] : ['password']), error: null, busy: false });
  }, [mfa, actor]);
  const operation = state?.operation;
  const close = useCallback(() => {
    if (runRef.current !== operation) return;
    runRef.current = null; setState(null);
  }, [operation]);
  const confirm = useCallback(async (confirmObj) => {
    if (!operation || runRef.current !== operation || operation.actor !== actorRef.current || operation.busy) return;
    // React state updates are batched; the ref latch also guards same-tick submits.
    operation.busy = true;
    setState(s => s && ({ ...s, busy: true, error: null }));
    try {
      await operation.run(confirmObj);
      if (runRef.current !== operation) return;
      runRef.current = null; setState(null);
    } catch (err) {
      if (runRef.current !== operation) return;
      if (isStepUp(err)) {
        operation.busy = false;
        const methods = err.response?.data?.methods;
        const msg = err.response?.data?.error;
        setState(s => s && ({ ...s, busy: false, methods: methods?.length ? methods : s.methods, error: msg && msg !== 'STEP_UP_REQUIRED' ? msg : 'Code ou mot de passe invalide, réessayez.' }));
        return;
      }
      runRef.current = null; setState(null);
      toast.error(errorMessage(err));
    }
  }, [operation]);
  const visibleState = state && operation?.actor === actor && runRef.current === operation ? state : null;
  return { state: visibleState, request, close, confirm };
};
