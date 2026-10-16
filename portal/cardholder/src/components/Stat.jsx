import React from 'react';
import Icon from './Icon';

export default function Stat({ label, value, hint, icon, loading }) {
  return (
    <div className="stat">
      {icon ? <div className="stat-icon"><Icon name={icon} size={18} /></div> : null}
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        {loading ? <div className="skeleton" style={{ height: 26, width: '70%' }} /> : <div className="stat-value">{value}</div>}
        {hint ? <div className="stat-hint">{hint}</div> : null}
      </div>
    </div>
  );
}
