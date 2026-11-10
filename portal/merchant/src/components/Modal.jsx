import React, { useEffect, useRef } from 'react';
import Icon from './Icon';
import Button from './Button';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// Tab / Maj+Tab restent dans la boite de dialogue (audit § 5 : le focus sortait vers la page masquee)
const trapTab = (e, container) => {
  if (e.key !== 'Tab' || !container) return;
  const items = Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) { e.preventDefault(); container.focus?.(); return; }
  const first = items[0]; const last = items[items.length - 1]; const active = document.activeElement;
  if (e.shiftKey && (active === first || !container.contains(active))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || !container.contains(active))) { e.preventDefault(); first.focus(); }
};

// Fenêtre modale accessible : rôle dialog, Échap, Tab piégé, focus initial, fermeture au clic
// sur le voile. `side` = tiroir latéral (détail), sinon modale centrée.
export const Modal = ({ title, subtitle, onClose, children, footer, size, side, closeLabel = 'Fermer', locked }) => {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !locked) onClose?.(); trapTab(e, ref.current); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const first = ref.current?.querySelector('input, select, textarea, button:not(.modal-close)');
    const previouslyFocused = document.activeElement;
    (first || ref.current)?.focus?.();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; previouslyFocused?.focus?.(); };
  }, [onClose, locked]);
  const box = side ? 'drawer' : `modal${size === 'lg' ? ' modal-lg' : ''}`;
  return (
    <div className={`overlay${side ? ' right' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose?.(); }}>
      <div className={box} role="dialog" aria-modal="true" aria-labelledby="dlg-title" ref={ref} tabIndex={-1}>
        <div className={side ? 'drawer-head' : 'modal-head'}>
          <div className="truncate"><h2 id="dlg-title" className="truncate">{title}</h2>{subtitle && <div className="card-sub">{subtitle}</div>}</div>
          {!locked && <Button variant="ghost" size="sm" onClick={onClose} aria-label={closeLabel} className="modal-close"><Icon name="close" /></Button>}
        </div>
        <div className={side ? 'drawer-body' : 'modal-body'}>{children}</div>
        {footer && <div className={side ? 'drawer-foot' : 'modal-foot'}>{footer}</div>}
      </div>
    </div>
  );
};
export const Drawer = (props) => <Modal side {...props} />;

// Confirmation d'une action destructive.
export const ConfirmDialog = ({ title, message, confirmLabel = 'Confirmer', danger = true, busy, onConfirm, onClose }) => (
  <Modal title={title} onClose={onClose} locked={busy}
    footer={<><Button onClick={onClose} disabled={busy}>Annuler</Button><Button variant={danger ? 'danger-solid' : 'primary'} onClick={onConfirm} loading={busy}>{confirmLabel}</Button></>}>
    <p className="text-2">{message}</p>
  </Modal>
);
export default Modal;
