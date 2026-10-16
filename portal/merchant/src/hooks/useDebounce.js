import { useState, useEffect } from 'react';

export const useDebounce = (value, delay = 400) => {
  const [v, setV] = useState(value);
  useEffect(() => { const h = setTimeout(() => setV(value), delay); return () => clearTimeout(h); }, [value, delay]);
  return v;
};
