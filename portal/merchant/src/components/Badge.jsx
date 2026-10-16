import React from 'react';
import { statusLabel, statusTone } from '../utils/labels';

export const Badge = ({ tone = 'neutral', dot, children }) => (
  <span className={`badge badge-${tone}${dot ? ' badge-dot' : ''}`}>{children}</span>
);
export const StatusBadge = ({ status, label }) => <Badge tone={statusTone(status)} dot>{label || statusLabel(status)}</Badge>;
export default Badge;
