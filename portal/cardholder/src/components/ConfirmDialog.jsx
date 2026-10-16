import React from 'react';
import Modal from './Modal';
import Button from './Button';

export default function ConfirmDialog({ open, title, message, confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger, loading, onConfirm, onClose, children }) {
  return (
    <Modal
      open={open} title={title} onClose={loading ? undefined : onClose} closable={!loading}
      footer={(
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      )}
    >
      {message ? <p className="text-2">{message}</p> : null}
      {children}
    </Modal>
  );
}
