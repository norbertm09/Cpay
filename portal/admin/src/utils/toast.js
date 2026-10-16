// Mini-magasin de notifications éphémères (sans dépendance). Rendu par components/Toaster.
const listeners = new Set();
let seq = 0;
const items = [];

const emit = () => listeners.forEach((fn) => fn([...items]));
const push = (type, message, duration = 4200) => {
  const id = ++seq;
  items.push({ id, type, message });
  emit();
  setTimeout(() => dismiss(id), duration);
  return id;
};
export const dismiss = (id) => {
  const i = items.findIndex((t) => t.id === id);
  if (i >= 0) { items.splice(i, 1); emit(); }
};
export const subscribe = (fn) => { listeners.add(fn); fn([...items]); return () => listeners.delete(fn); };

const toast = {
  success: (m, d) => push('success', m, d),
  error: (m, d) => push('error', m, d || 6000),
  info: (m, d) => push('info', m, d),
  warn: (m, d) => push('warn', m, d || 6000),
};
export default toast;
