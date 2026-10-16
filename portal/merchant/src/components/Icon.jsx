import React from 'react';

// Icônes vectorielles (trait 2 px, grille 24). Un seul composant, ~30 symboles.
const PATHS = {
  home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  cash: 'M3 7h18v10H3zM7 7v10M17 7v10M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  tag: 'M3 12V4h8l9 9-8 8zM7.5 8.5h.01',
  plug: 'M9 2v6M15 2v6M5 8h14v3a7 7 0 0 1-14 0zM12 18v4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  arrowDown: 'M12 4v16M5 13l7 7 7-7',
  arrowUp: 'M12 20V4M5 11l7-7 7 7',
  swap: 'M4 7h13l-3-3M20 17H7l3 3',
  book: 'M4 4h12a3 3 0 0 1 3 3v13H7a3 3 0 0 0-3 3zM4 4v16M8 8h7M8 12h7',
  bank: 'M3 10 12 4l9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
  contactless: 'M8.5 8.5a5 5 0 0 1 0 7M11.5 6a9 9 0 0 1 0 12M5.5 11a2 2 0 0 1 0 2',
  key: 'M14 3a7 7 0 0 0-6.7 9L3 16.3V21h4.7l1.5-1.5v-2.3h2.3l1.5-1.5A7 7 0 1 0 14 3zM15.5 8.5h.01',
  webhook: 'M12 3a4 4 0 0 1 3.5 6L12 15M5 21a4 4 0 0 1 2-7.5L12 15M19 21a4 4 0 0 0-2-7.5L12 15',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  shield: 'M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5zM9 12l2 2 4-4',
  lifebuoy: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12l5 5L20 7',
  checkCircle: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8 12l3 3 5-6',
  alert: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 11v5M12 8h.01',
  xCircle: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM9 9l6 6M15 9l-6 6',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 7v5l3 2',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronDown: 'M6 9l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  share: 'M4 12v8h16v-8M12 3v12M8 7l4-4 4 4',
  print: 'M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M6 14h12v7H6z',
  download: 'M12 3v12M6 11l6 6 6-6M4 21h16',
  upload: 'M12 15V3M6 7l6-6 6 6M4 21h16',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7L20 8M20 3v5h-5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  logout: 'M10 17l5-5-5-5M15 12H3M13 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 10.6A3 3 0 0 0 13.4 13.4M9.9 5.2A10 10 0 0 1 22 12a16 16 0 0 1-3.2 3.9M6.6 6.6A16 16 0 0 0 2 12s4 7 10 7a9 9 0 0 0 4-1',
  mail: 'M3 5h18v14H3zM3 6l9 7 9-7',
  message: 'M4 4h16v12H8l-4 4z',
  paperclip: 'M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3l8-8',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6',
  edit: 'M4 20h4l11-11-4-4L4 16zM13 7l4 4',
  qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM19 14h2v2h-2zM14 19h2v2h-2zM18 18h3v3h-3z',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  smartphone: 'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM12 18h.01',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2zM16 14h.01',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v2',
  file: 'M6 2h8l6 6v14H6zM14 2v6h6M9 13h6M9 17h6',
  external: 'M14 4h6v6M20 4l-9 9M19 14v6H5V6h6',
  zap: 'M13 2 4 14h7l-1 8 9-12h-7z',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  grid: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',
  inbox: 'M3 13l2-8h14l2 8v7H3zM3 13h5l1 3h6l1-3h5',
};

export const Icon = ({ name, size = 20, className = '', title, style }) => (
  <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined} style={{ flexShrink: 0, ...style }} focusable="false">
    {title && <title>{title}</title>}
    <path d={PATHS[name] || PATHS.info} />
  </svg>
);
export default Icon;
