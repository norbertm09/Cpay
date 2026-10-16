import React from 'react';
import { Skeleton } from './Skeleton';
import { EmptyState, ErrorState } from './EmptyState';

// Tableau responsive : table sur grand écran, cartes empilées sur mobile.
// columns : [{ key, label, render(row), className, num, mobile: 'title'|'right'|'meta'|'actions'|false }]
// Sur mobile, la colonne `title` et la colonne `right` forment l'en-tête de la
// carte, les colonnes `meta` passent en ligne de détails, `actions` en bas.
export const Table = ({ columns, rows, rowKey, onRowClick, state = 'ok', error, onRetry, empty, emptyIcon, emptyAction, skeletonRows = 5, footer }) => {
  if (state === 'loading') return <div className="skeleton-rows" aria-busy="true" aria-live="polite">{Array.from({ length: skeletonRows }).map((_, i) => <Skeleton key={i} height={18} width={`${70 + (i * 7) % 30}%`} />)}</div>;
  if (state === 'error') return <ErrorState error={error} onRetry={onRetry} />;
  if (state === 'unavailable') return <EmptyState icon="clock" title="Fonctionnalité en cours d’intégration" message="Cette liste sera disponible après l’intégration des opérateurs." />;
  if (!rows || rows.length === 0) return <EmptyState icon={emptyIcon} title={empty?.title || 'Aucun élément'} message={empty?.message} action={emptyAction} />;
  const cols = columns.filter(c => !c.hidden);
  const cell = (c, r) => (c.render ? c.render(r) : r[c.key]);
  const clickable = !!onRowClick;
  const title = cols.find(c => c.mobile === 'title');
  const right = cols.find(c => c.mobile === 'right');
  const metas = cols.filter(c => c.mobile === 'meta' || (c.mobile === undefined && c !== title && c !== right));
  const actions = cols.find(c => c.mobile === 'actions');
  return (
    <div className="table-responsive">
      <div className="table-wrap">
        <table className="table">
          <thead><tr>{cols.map(c => <th key={c.key} className={[c.num ? 'num' : '', c.className || ''].join(' ')}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={rowKey ? rowKey(r) : i} className={clickable ? 'clickable' : ''} onClick={clickable ? () => onRowClick(r) : undefined}
                tabIndex={clickable ? 0 : undefined} onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}>
                {cols.map(c => <td key={c.key} className={[c.num ? 'num' : '', c.mobile === 'actions' ? 'actions' : '', c.className || ''].join(' ')} onClick={c.mobile === 'actions' ? (e) => e.stopPropagation() : undefined}>{cell(c, r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {footer}
      </div>
      <div className="table-cards">
        {rows.map((r, i) => (
          <div key={rowKey ? rowKey(r) : i} className={`tcard${clickable ? ' clickable' : ''}`} onClick={clickable ? () => onRowClick(r) : undefined} role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
            onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}>
            <div className="tc-title">{title ? cell(title, r) : null}</div>
            <div className="tc-right">{right ? cell(right, r) : null}</div>
            {metas.length > 0 && <div className="tc-meta">{metas.map(c => { const v = cell(c, r); return v == null || v === '' || v === '—' ? null : <span key={c.key}>{c.label ? <span className="muted">{c.label} : </span> : null}{v}</span>; })}</div>}
            {actions && <div className="tc-actions" onClick={e => e.stopPropagation()}>{cell(actions, r)}</div>}
          </div>
        ))}
        {footer}
      </div>
    </div>
  );
};
export default Table;
