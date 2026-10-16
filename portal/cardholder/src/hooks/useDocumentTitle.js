import { useEffect } from 'react';

export const useDocumentTitle = (title) => {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} — C-Pay` : 'C-Pay — Carte virtuelle';
    return () => { document.title = prev; };
  }, [title]);
};
