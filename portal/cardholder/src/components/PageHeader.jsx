import React from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';

export default function PageHeader({ title, subtitle, actions, back }) {
  return (
    <div className="page-header">
      <div>
        {back ? <Link to={back.to} className="page-back"><Icon name="chevron-left" size={16} />{back.label || 'Retour'}</Link> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}
