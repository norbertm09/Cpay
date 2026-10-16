import React from 'react';
import Icon from './Icon';

export default function EmptyState({ icon = 'inbox', title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={26} /></div>
      {title ? <h3>{title}</h3> : null}
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}
