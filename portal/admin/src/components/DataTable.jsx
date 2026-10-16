import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { Button, EmptyState, ErrorState, SkeletonTable } from './ui';

// Tableau de données : tri client (sortValue), pagination serveur ou client,
// colonnes masquables, repli en cartes sous 768 px (CSS data-label).
// columns: [{ key, label, render(row), sortValue(row), align, width, hidden, className }]
export default function DataTable({
  columns, rows = [], keyField = 'id', loading, error, onRetry, empty, emptyIcon,
  onRowClick, selectedKey, page, limit = 25, total, onPage, dense, sortable = true,
  columnTools = false, storageKey, footerExtra, defaultSort,
}) {
  const [sort, setSort] = useState(defaultSort || null); // { key, dir }
  const [hidden, setHidden] = useState(() => {
    try { return storageKey ? JSON.parse(localStorage.getItem(`cols:${storageKey}`) || '[]') : []; } catch (e) { return []; }
  });
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => { try { if (storageKey) localStorage.setItem(`cols:${storageKey}`, JSON.stringify(hidden)); } catch (e) { /* stockage indisponible */ } }, [hidden, storageKey]);
  useEffect(() => {
    if (!menu) return undefined;
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menu]);

  const visible = columns.filter((c) => !hidden.includes(c.key) && !(c.hidden && !hidden.includes(`show:${c.key}`)));
  const toggleCol = (c) => {
    setHidden((h) => {
      if (c.hidden) return h.includes(`show:${c.key}`) ? h.filter((k) => k !== `show:${c.key}`) : [...h, `show:${c.key}`];
      return h.includes(c.key) ? h.filter((k) => k !== c.key) : [...h, c.key];
    });
  };

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const val = (r) => (col.sortValue ? col.sortValue(r) : r[col.key]);
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return 0;
      if (x === undefined || x === null) return 1;
      if (y === undefined || y === null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'fr', { numeric: true });
      return sort.dir === 'asc' ? c : -c;
    });
  }, [rows, sort, columns]);

  const onSort = (c) => {
    if (!sortable || c.sortable === false) return;
    setSort((s) => (s?.key === c.key ? (s.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' }));
  };

  const pages = total ? Math.max(1, Math.ceil(total / limit)) : null;
  const showPager = onPage && (pages ? pages > 1 : rows.length >= limit || page > 1);
  const from = total ? (page - 1) * limit + 1 : null;
  const to = total ? Math.min(total, page * limit) : null;

  return (
    <div className="table-responsive">
      {columnTools && (
        <div className="table-tools">
          <div className="cols-menu" ref={menuRef}>
            <Button variant="ghost" size="sm" icon="columns" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>Colonnes</Button>
            {menu && (
              <div className="menu">
                {columns.map((c) => (
                  <label key={c.key}><input type="checkbox" checked={visible.includes(c)} onChange={() => toggleCol(c)} /> {c.label}</label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {loading && !rows.length ? <SkeletonTable cols={Math.min(visible.length, 6)} /> : error ? <ErrorState error={error} onRetry={onRetry} /> : !sorted.length ? (
        <EmptyState icon={emptyIcon} title={empty || 'Aucun résultat'} />
      ) : (
        <div className="table-wrap" style={loading ? { opacity: .6 } : undefined} aria-busy={loading || undefined}>
          <table className={`table ${dense ? 'table-dense' : ''}`}>
            <thead>
              <tr>
                {visible.map((c) => {
                  const canSort = sortable && c.sortable !== false;
                  const active = sort?.key === c.key;
                  return (
                    <th key={c.key} className={`${canSort ? 'sortable' : ''} ${c.align === 'right' ? 'right' : ''}`} style={c.width ? { width: c.width } : undefined}
                      onClick={() => onSort(c)} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      {c.label}{active && <Icon name={sort.dir === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} className="sort-ind" />}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const k = r[keyField] ?? i;
                return (
                  <tr key={k} className={`${onRowClick ? 'clickable' : ''} ${selectedKey !== undefined && selectedKey === k ? 'selected' : ''}`}
                    onClick={onRowClick ? () => onRowClick(r) : undefined} tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}>
                    {visible.map((c) => (
                      <td key={c.key} data-label={c.label} className={`${c.align === 'right' ? 'right' : ''} ${c.key === 'actions' ? 'row-actions-cell' : ''} ${c.className || ''}`}
                        onClick={c.key === 'actions' ? (e) => e.stopPropagation() : undefined}>
                        {c.render ? c.render(r) : (r[c.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(showPager || footerExtra || total !== undefined) && !error && (
        <div className="table-footer">
          <div>{total !== undefined && total !== null ? (total ? `${from}–${to} sur ${total}` : '') : ''}{footerExtra}</div>
          {showPager && (
            <div className="row">
              <Button size="sm" icon="chevronLeft" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Page précédente" />
              <span className="num">Page {page}{pages ? ` / ${pages}` : ''}</span>
              <Button size="sm" icon="chevronRight" disabled={pages ? page >= pages : rows.length < limit} onClick={() => onPage(page + 1)} aria-label="Page suivante" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
