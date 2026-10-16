import React from 'react';
import Icon from './Icon';

const ICONS = { info: 'info', warn: 'alert-triangle', error: 'alert-circle', success: 'check-circle' };

export default function Alert({ tone = 'info', title, children, action, className = '' }) {
  return (
    <div className={`alert alert-${tone} ${className}`.trim()} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="alert-icon"><Icon name={ICONS[tone]} size={18} /></span>
      <div className="alert-body">
        {title ? <div className="alert-title">{title}</div> : null}
        {children ? <div>{children}</div> : null}
        {action}
      </div>
    </div>
  );
}
