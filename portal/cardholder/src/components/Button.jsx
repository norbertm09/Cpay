import React from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';

/**
 * Bouton du design system. `variant` : primary (CTA orange), secondary (bleu),
 * outline, ghost, danger, danger-outline. `to` rend un lien routeur.
 */
export default function Button({
  variant = 'secondary', size, block, icon, iconRight, loading, children, className = '', to, href, type = 'button', disabled, ...rest
}) {
  const cls = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', block ? 'btn-block' : '', !children ? 'btn-icon' : '', className].filter(Boolean).join(' ');
  const content = (
    <>
      {loading ? <Icon name="loader" size={18} className="spin" /> : icon ? <Icon name={icon} size={18} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={18} /> : null}
    </>
  );
  if (to) return <Link to={to} className={cls} aria-disabled={disabled || undefined} {...rest}>{content}</Link>;
  if (href) return <a href={href} className={cls} {...rest}>{content}</a>;
  return <button type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>{content}</button>;
}
