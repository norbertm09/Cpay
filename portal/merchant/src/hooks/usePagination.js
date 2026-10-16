import { useState, useMemo } from 'react';

// Pagination par offset (journal, transferts) ou par page (transactions, liens).
export const usePagination = (pageSize = 25) => {
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return useMemo(() => ({
    page, pages, total, pageSize, offset: page * pageSize,
    setTotal, reset: () => setPage(0),
    next: () => setPage(p => Math.min(pages - 1, p + 1)),
    prev: () => setPage(p => Math.max(0, p - 1)),
    hasPrev: page > 0, hasNext: page + 1 < pages,
  }), [page, pages, total, pageSize]);
};
