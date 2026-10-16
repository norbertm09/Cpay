import React from 'react';

export const PageHeader = ({ title, subtitle, actions, children }) => (
  <header className="page-header">
    <div><h1>{title}</h1>{subtitle && <p className="sub">{subtitle}</p>}{children}</div>
    {actions && <div className="ph-actions">{actions}</div>}
  </header>
);
export default PageHeader;
