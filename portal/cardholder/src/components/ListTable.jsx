import React from 'react';

/**
 * Liste responsive : tableau sur grand ecran, liste empilee sur mobile.
 * columns: [{ key, label, render?(row), align?, className? }]
 * mobileRender(row) : rendu compact ; par defaut, les deux premieres colonnes.
 */
export default function ListTable({ columns, rows, keyField, onRowClick, mobileRender, isMobile, emptyMessage = 'Aucun élément' }) {
  if (!rows?.length) return <div className="empty"><p>{emptyMessage}</p></div>;
  if (isMobile && mobileRender) {
    return (
      <div className="list">
        {rows.map((r) => {
          const Tag = onRowClick ? 'button' : 'div';
          return (
            <Tag key={r[keyField]} className="list-item" type={onRowClick ? 'button' : undefined} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {mobileRender(r)}
            </Tag>
          );
        })}
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.align === 'right' ? 'right' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[keyField]} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(r) : undefined} tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(r); } } : undefined}>
              {columns.map((c) => <td key={c.key} className={`${c.align === 'right' ? 'td-amount' : ''} ${c.className || ''}`.trim()}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
