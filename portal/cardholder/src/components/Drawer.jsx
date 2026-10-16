import React, { useEffect, useRef } from 'react';
import Icon from './Icon';

/** Tiroir lateral (desktop) / feuille basse (mobile). */
export default function Drawer({ open, title, onClose, children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="drawer-overlay no-print" onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Détail'} ref={ref} tabIndex={-1}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button type="button" className="btn btn-ghost btn-sm btn-icon no-print" onClick={onClose} aria-label="Fermer"><Icon name="x" /></button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-foot no-print">{footer}</div> : null}
      </aside>
    </>
  );
}
