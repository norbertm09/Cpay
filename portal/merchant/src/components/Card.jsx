import React from 'react';

export const Card = ({ title, subtitle, actions, flush, hero, className = '', children, ...rest }) => (
  <section className={['card', flush ? 'card-flush' : '', hero ? 'card-hero' : '', className].filter(Boolean).join(' ')} {...rest}>
    {(title || actions) && (
      <div className={`card-title${flush ? ' card-title-flush' : ''}`} style={flush ? { padding: 'var(--s4) var(--s4) 0', marginBottom: 'var(--s3)' } : undefined}>
        <div>{title && <h2>{title}</h2>}{subtitle && <div className="card-sub">{subtitle}</div>}</div>
        {actions && <div className="row">{actions}</div>}
      </div>
    )}
    {children}
  </section>
);
export default Card;
