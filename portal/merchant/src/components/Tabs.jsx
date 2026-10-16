import React from 'react';

export const Tabs = ({ tabs, value, onChange, ariaLabel = 'Onglets' }) => (
  <div className="tabs" role="tablist" aria-label={ariaLabel}>
    {tabs.map(t => (
      <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)} id={`tab-${t.value}`}>{t.label}{t.count != null && <span className="badge" style={{ marginLeft: 6 }}>{t.count}</span>}</button>
    ))}
  </div>
);
export default Tabs;
