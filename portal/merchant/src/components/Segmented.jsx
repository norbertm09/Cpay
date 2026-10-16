import React from 'react';
import Icon from './Icon';

// Bascule à n choix, grands boutons tactiles.
export const Segmented = ({ options, value, onChange, compact, ariaLabel }) => (
  <div className={`segmented${compact ? ' compact' : ''}`} role="group" aria-label={ariaLabel} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
    {options.map(o => (
      <button key={o.value} type="button" aria-pressed={value === o.value} disabled={o.disabled} onClick={() => onChange(o.value)}>
        {o.icon && <Icon name={o.icon} size={compact ? 16 : 22} />}
        <span>{o.label}</span>
        {o.sub && <span className="sub">{o.sub}</span>}
      </button>
    ))}
  </div>
);
export default Segmented;
