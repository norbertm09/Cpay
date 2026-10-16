import React from 'react';
import Icon from './Icon';
import Button from './Button';
import { errorMessage } from '../utils/errors';

export const EmptyState = ({ icon = 'inbox', title, message, action }) => (
  <div className="empty">
    <div className="ic"><Icon name={icon} size={40} /></div>
    {title && <h3>{title}</h3>}
    {message && <p className="small">{message}</p>}
    {action}
  </div>
);

export const ErrorState = ({ error, message, onRetry }) => (
  <div className="state-error" role="alert">
    <Icon name="alert" size={32} className="ic" />
    <div><strong>Chargement impossible</strong><div className="small muted">{message || errorMessage(error)}</div></div>
    {onRetry && <Button icon="refresh" onClick={onRetry}>Réessayer</Button>}
  </div>
);

// Carte « Fonctionnalité en cours d'intégration » (410 FEATURE_DISABLED / 404).
export const FeatureUnavailable = ({ title = 'Fonctionnalité en cours d’intégration', message }) => (
  <div className="card">
    <EmptyState icon="clock" title={title} message={message || 'Cette fonctionnalité sera activée après validation avec les opérateurs. Pour toute question, contactez le support.'} />
  </div>
);
export default EmptyState;
