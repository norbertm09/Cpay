import React from 'react';
import { NavLink } from 'react-router-dom';

/**
 * Onglets. Soit controles (`value` + `onChange`), soit routes (`items[].to`).
 * items: [{ key, label, to?, count? }]
 */
export default function Tabs({ items, value, onChange, ariaLabel = 'Sections' }) {
  const routed = items.some((i) => i.to);
  if (routed) {
    return (
      <nav className="tabs" aria-label={ariaLabel}>
        {items.map((it) => (
          <NavLink key={it.key} to={it.to} end={it.end} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
            {it.label}{it.count != null ? <span className="count">{it.count}</span> : null}
          </NavLink>
        ))}
      </nav>
    );
  }
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((it) => (
        <button key={it.key} type="button" role="tab" className="tab" aria-selected={value === it.key} onClick={() => onChange(it.key)}>
          {it.label}{it.count != null ? <span className="count">{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
