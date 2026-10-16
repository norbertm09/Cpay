import React from 'react';
import Icon from './Icon';
import Button from './Button';
import { FEATURE_DISABLED_MESSAGE } from '../utils/errors';

/** Etat honnete pour les fonctions desactivees cote backend (410 FEATURE_DISABLED). */
export default function FeatureDisabled({ title = 'En cours d’intégration', message = FEATURE_DISABLED_MESSAGE, icon = 'wrench', backTo, backLabel = 'Retour aux opérations' }) {
  return (
    <div className="feature-off" role="status">
      <div className="fo-icon"><Icon name={icon} size={30} /></div>
      <h3>{title}</h3>
      <p>{message}</p>
      {backTo ? <Button variant="outline" to={backTo} icon="arrow-left">{backLabel}</Button> : null}
    </div>
  );
}
