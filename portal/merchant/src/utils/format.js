// Formatage : montants, dates, numéros de téléphone (français).
const INT_CURRENCIES = ['XOF', 'XAF', 'CDF'];
export const isIntegerCurrency = (cur) => INT_CURRENCIES.includes(String(cur || '').toUpperCase());

export const fmtMoney = (n, cur) => {
  const v = Number(n);
  const num = Number.isFinite(v) ? v : 0;
  const s = num.toLocaleString('fr-FR', { maximumFractionDigits: isIntegerCurrency(cur) ? 0 : 2 });
  return cur ? `${s} ${String(cur).toUpperCase()}` : s;
};
export const fmtNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('fr-FR');
export const fmtCompact = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' k';
  return v.toLocaleString('fr-FR');
};

const asDate = (d) => { const x = d instanceof Date ? d : new Date(d); return Number.isNaN(x.getTime()) ? null : x; };
export const fmtDate = (d) => { const x = asDate(d); return x ? x.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'; };
export const fmtDateTime = (d) => { const x = asDate(d); return x ? x.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; };
export const fmtTime = (d) => { const x = asDate(d); return x ? x.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—'; };
export const fmtDayLong = (d) => { const x = asDate(d); return x ? x.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '—'; };
export const fmtDayShort = (d) => { const x = asDate(d); return x ? x.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) : '—'; };

// Date relative courte (« il y a 5 min », « hier ») ; l'absolu reste affiché à côté.
export const fmtRelative = (d) => {
  const x = asDate(d); if (!x) return '';
  const diff = (Date.now() - x.getTime()) / 1000;
  if (diff < 45) return 'à l’instant';
  if (diff < 3600) return `il y a ${Math.round(diff / 60)} min`;
  if (diff < 86400 * 2 && x.toDateString() === new Date().toDateString()) return `il y a ${Math.round(diff / 3600)} h`;
  const days = Math.round(diff / 86400);
  if (days <= 1) return 'hier';
  if (days < 7) return `il y a ${days} j`;
  if (days < 31) return `il y a ${Math.round(days / 7)} sem.`;
  return fmtDate(x);
};

// Date ISO locale (AAAA-MM-JJ) sans conversion de fuseau.
export const isoDay = (d = new Date()) => {
  const x = asDate(d) || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
export const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d; };

// Téléphone : « +237 6 70 12 34 56 » pour l'affichage, chiffres bruts pour la saisie.
export const fmtPhone = (p) => {
  const s = String(p || '').replace(/[^\d+]/g, '');
  if (!s) return '—';
  const m = s.match(/^(\+\d{1,3})(\d+)$/);
  if (!m) return s;
  // Groupes de deux chiffres ; un premier groupe de trois si le nombre est impair.
  const nat = m[2];
  const head = nat.length % 2 ? nat.slice(0, 3) : nat.slice(0, 2);
  const rest = nat.slice(head.length).replace(/(\d{2})(?=\d)/g, '$1 ');
  return `${m[1]} ${head}${rest ? ' ' + rest : ''}`;
};
export const phoneDigits = (p) => String(p || '').replace(/[^\d]/g, '');
export const maskPhone = (p) => { const s = String(p || ''); return s.length > 6 ? s.slice(0, 4) + '•••' + s.slice(-3) : s; };

export const pluralize = (n, one, many) => (Number(n) === 1 ? one : (many || one + 's'));
