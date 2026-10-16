import React from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';

// variant : primary (CTA orange) | brand (bleu) | secondary | ghost | danger | danger-solid | success
export const Button = ({ variant = 'secondary', size, block, icon, iconRight, loading, children, className = '', to, href, type = 'button', ...rest }) => {
  const cls = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', block ? 'btn-block' : '', !children ? 'btn-icon' : '', className].filter(Boolean).join(' ');
  const inner = (<>
    {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
    {children}
    {iconRight && !loading && <Icon name={iconRight} size={size === 'sm' ? 16 : 18} />}
  </>);
  if (to) return <Link to={to} className={cls} {...rest}>{inner}</Link>;
  if (href) return <a href={href} className={cls} target="_blank" rel="noreferrer" {...rest}>{inner}</a>;
  return <button type={type} className={cls} disabled={rest.disabled || loading} {...rest}>{inner}</button>;
};
export default Button;
