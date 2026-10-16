import React from 'react';
import { Toaster } from 'react-hot-toast';

// Enveloppe du système de notifications : style aligné sur les jetons.
export const Toast = () => (
  <Toaster position="top-right" gutter={8} containerStyle={{ top: 68 }} toastOptions={{
    duration: 4000,
    style: { fontFamily: 'var(--font)', fontSize: 'var(--fs-sm)', color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: 'var(--sh-2)', borderRadius: 'var(--r)', maxWidth: 420 },
    success: { iconTheme: { primary: 'var(--success)', secondary: '#fff' } },
    error: { iconTheme: { primary: 'var(--error)', secondary: '#fff' }, duration: 6000 },
  }} />
);
export default Toast;
