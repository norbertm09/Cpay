import React from 'react';
import Icon from './Icon';

const ICONS = { info: 'info', success: 'checkCircle', warn: 'alert', error: 'xCircle', neutral: 'info' };
export const Notice = ({ tone = 'info', icon, children, action, className = '' }) => (
  <div className={`notice notice-${tone} ${className}`} role={tone === 'error' ? 'alert' : undefined}>
    <Icon name={icon || ICONS[tone]} size={18} className="ic" />
    <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    {action}
  </div>
);
export default Notice;
