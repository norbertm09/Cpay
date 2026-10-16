import React from 'react';

export default function Badge({ tone = '', dot, children, className = '' }) {
  return <span className={`badge ${tone} ${dot ? 'badge-dot' : ''} ${className}`.trim()}>{children}</span>;
}
