import React from 'react';
import Button from './Button';
import { pluralize } from '../utils/format';

export const Pagination = ({ pager, unit = 'élément' }) => {
  if (!pager || pager.total <= pager.pageSize) return null;
  return (
    <div className="pagination">
      <Button size="sm" icon="chevronLeft" onClick={pager.prev} disabled={!pager.hasPrev}>Précédent</Button>
      <span>Page {pager.page + 1} / {pager.pages} · {pager.total} {pluralize(pager.total, unit)}</span>
      <Button size="sm" iconRight="chevronRight" onClick={pager.next} disabled={!pager.hasNext}>Suivant</Button>
    </div>
  );
};
export default Pagination;
