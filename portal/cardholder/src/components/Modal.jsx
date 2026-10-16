import React, { useEffect, useRef } from 'react';
import Icon from './Icon';

/** Modale accessible : focus initial, fermeture Echap et clic sur le fond. */
export default function Modal({ open, title, onClose, children, footer, size, closable = true }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape' && closable) onClose?.(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const first = ref.current?.querySelector('input, select, textarea, button:not([data-close])');
    (first || ref.current)?.focus?.();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev?.focus?.(); };
  }, [open, onClose, closable]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && closable) onClose?.(); }}>
      <div className={`modal ${size === 'lg' ? 'modal-lg' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          {closable ? <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onClose} aria-label="Fermer" data-close><Icon name="x" /></button> : null}
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
