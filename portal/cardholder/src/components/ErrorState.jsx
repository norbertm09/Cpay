import React from 'react';
import Icon from './Icon';
import Button from './Button';
import { errorMessage } from '../utils/errors';

export default function ErrorState({ error, onRetry, title = 'Impossible de charger ces données' }) {
  return (
    <div className="empty" role="alert">
      <div className="empty-icon" style={{ background: 'var(--error-50)', color: 'var(--error)' }}><Icon name="alert-triangle" size={26} /></div>
      <h3>{title}</h3>
      <p>{errorMessage(error)}</p>
      {onRetry ? <Button variant="outline" icon="refresh-cw" onClick={onRetry}>Réessayer</Button> : null}
    </div>
  );
}
