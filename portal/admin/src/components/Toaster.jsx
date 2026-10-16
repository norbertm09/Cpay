import React, { useEffect, useState } from 'react';
import Icon from './Icon';
import { subscribe, dismiss } from '../utils/toast';

const ICON = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };

export default function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => subscribe(setItems), []);
  if (!items.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>
          <Icon name={ICON[t.type]} size={16} />
          <span>{t.message}</span>
          <button type="button" aria-label="Fermer" onClick={() => dismiss(t.id)}><Icon name="x" size={14} /></button>
        </div>
      ))}
    </div>
  );
}
