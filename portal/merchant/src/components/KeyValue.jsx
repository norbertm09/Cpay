import React from 'react';
import Icon from './Icon';
import { copyText } from '../utils/actions';

export const KV = ({ label, value, mono, tone }) => (
  <div className="kv"><span className="k">{label}</span><span className={`v${mono ? ' mono' : ''}${tone ? ' ' + tone : ''}`}>{value ?? '—'}</span></div>
);
export const KVList = ({ rows, boxed }) => (
  <div className={boxed ? 'kv-box' : ''}>{rows.filter(r => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map(([k, v, opts]) => <KV key={k} label={k} value={v} {...(opts || {})} />)}</div>
);
export const CopyRow = ({ label, value, highlight }) => (
  <div className="copy-row">
    <div className="cr-body"><div className="cr-label">{label}</div><div className={`cr-value${highlight ? ' hl' : ''}`}>{value || '—'}</div></div>
    {value && <button type="button" className="btn btn-secondary btn-sm btn-icon" onClick={() => copyText(value, `${label} copié`)} aria-label={`Copier ${label}`}><Icon name="copy" size={16} /></button>}
  </div>
);
