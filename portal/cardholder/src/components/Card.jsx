import React from 'react';

export default function Card({ title, actions, children, className = '', flush, footer, as: Tag = 'section', ...rest }) {
  return (
    <Tag className={`card ${flush ? 'card-flush' : ''} ${className}`.trim()} {...rest}>
      {title || actions ? (
        <header className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      <div className="card-body">{children}</div>
      {footer ? <footer className="card-foot">{footer}</footer> : null}
    </Tag>
  );
}
