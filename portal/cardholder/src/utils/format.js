const moneyFormatters = new Map();
const moneyFormatter = (currency) => {
  const key = currency || 'XAF';
  if (!moneyFormatters.has(key)) {
    const zeroDecimals = ['XAF', 'XOF', 'CDF', 'GNF', 'RWF', 'UGX', 'KMF'].includes(key);
    const opts = { minimumFractionDigits: 0, maximumFractionDigits: zeroDecimals ? 0 : 2, useGrouping: 'always' };
    let fmt;
    try { fmt = new Intl.NumberFormat('fr-FR', opts); } catch (e) { fmt = new Intl.NumberFormat('fr-FR', { ...opts, useGrouping: true }); }
    moneyFormatters.set(key, fmt);
  }
  return moneyFormatters.get(key);
};

/** 12 500 XAF — separateur de milliers insecable + devise. */
export const formatMoney = (amount, currency = 'XAF', { sign = false } = {}) => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const abs = moneyFormatter(currency).format(Math.abs(n)).replace(/\u202F/g, '\u00A0');
  const s = sign ? (n < 0 ? '− ' : '+ ') : (n < 0 ? '− ' : '');
  return `${s}${abs} ${currency || 'XAF'}`;
};

const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const toDate = (d) => { const x = d instanceof Date ? d : new Date(d); return Number.isNaN(x.getTime()) ? null : x; };
export const formatDate = (d) => { const x = toDate(d); return x ? dateFmt.format(x) : '—'; };
export const formatDateTime = (d) => { const x = toDate(d); return x ? dateTimeFmt.format(x) : '—'; };


/** +237 6 70 00 00 00 — regroupement lisible, sans normalisation agressive. */
export const formatPhone = (p) => {
  if (!p) return '—';
  const raw = String(p).replace(/[^\d+]/g, '');
  const intl = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return raw;
  if (intl && digits.length > 9) {
    const cc = digits.slice(0, digits.length - 9);
    const rest = digits.slice(-9);
    return `+${cc} ${rest[0]} ${rest.slice(1).replace(/(\d{2})(?=\d)/g, '$1 ')}`;
  }
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
};

export const maskCard = (masked, last4) => {
  if (masked) return String(masked).replace(/\*{4}/g, '••••');
  if (last4) return `•••• •••• •••• ${last4}`;
  return '•••• •••• •••• ••••';
};
export const expiry = (m, y) => (m && y ? `${String(m).padStart(2, '0')}/${String(y).slice(-2)}` : '—');
export const initials = (first, last) => `${(first || '').charAt(0)}${(last || '').charAt(0)}`.toUpperCase() || 'C';
export const greeting = () => { const h = new Date().getHours(); return h < 18 ? 'Bonjour' : 'Bonsoir'; };
