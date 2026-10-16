import React from 'react';

export const Stat = ({ label, value, hint, tone, large, className = '' }) => (
  <div className={['stat', tone ? `stat-tone-${tone}` : '', className].filter(Boolean).join(' ')}>
    <span className="label">{label}</span>
    <span className={`value${large ? ' lg' : ''}`}>{value}</span>
    {hint && <span className="hint">{hint}</span>}
  </div>
);
export default Stat;
