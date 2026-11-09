// Formatage FR : montants, nombres, dates.
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtNumber = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? nf.format(n) : nf2.format(n);
};

// Montant + devise : « 12 500 XAF ». Sans devise connue, le montant seul.
export const fmtMoney = (v, currency) => {
  if (v === undefined || v === null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${nf.format(n)}${currency ? ` ${currency}` : ''}`;
};

export const fmtPct = (num, den) => {
  const n = Number(num), d = Number(den);
  if (!d || !Number.isFinite(n) || !Number.isFinite(d)) return '—';
  return `${Math.round((n / d) * 100)} %`;
};

const dtf = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const tf = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

export const fmtDateTime = (d) => { if (!d) return '—'; const x = new Date(d); return Number.isNaN(x.getTime()) ? '—' : dtf.format(x); };
export const fmtDate = (d) => { if (!d) return '—'; const x = new Date(d); return Number.isNaN(x.getTime()) ? '—' : df.format(x); };
export const fmtTime = (d) => { if (!d) return '—'; const x = new Date(d); return Number.isNaN(x.getTime()) ? '—' : tf.format(x); };

export const fmtAgo = (d) => {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  if (!Number.isFinite(diff)) return '—';
  if (diff < 60000) return 'à l’instant';
  if (diff < 3600000) return `il y a ${Math.floor(diff / 60000)} min`;
  if (diff < 86400000) return `il y a ${Math.floor(diff / 3600000)} h`;
  return `il y a ${Math.floor(diff / 86400000)} j`;
};

export const fmtDuration = (seconds) => {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
};

export const shortId = (id, n = 8) => (id ? `${String(id).slice(0, n)}…` : '—');
export const initials = (first, last, fallback = '?') => {
  const s = `${(first || '').trim().charAt(0)}${(last || '').trim().charAt(0)}`.toUpperCase();
  return s || String(fallback).charAt(0).toUpperCase();
};
export const maskPhone = (p) => (p ? String(p).replace(/(\d{3})\d+(\d{2})$/, '$1•••$2') : '—');

// Lot 2 (audit 2026-11-02 portails P1-4) : périmètre du registre de capacités — CEMAC (CM, CF, CG, GA, GQ, TD),
// RDC, et les marchands historiques SN / CI. Les pays hors périmètre (BF, ML, TG, BJ, FR) ne sont plus proposés.
export const COUNTRIES = { CM: 'Cameroun', CF: 'Centrafrique', CG: 'Congo', GA: 'Gabon', GQ: 'Guinée équatoriale', TD: 'Tchad', CD: 'RD Congo', SN: 'Sénégal', CI: 'Côte d’Ivoire' };
const COUNTRY_NAMES_EXTRA = { BF: 'Burkina Faso', ML: 'Mali', TG: 'Togo', BJ: 'Bénin', FR: 'France', NE: 'Niger', GN: 'Guinée' };
export const countryName = (c) => (c ? COUNTRIES[String(c).toUpperCase()] || COUNTRY_NAMES_EXTRA[String(c).toUpperCase()] || c : '—');
// Devise de référence par pays (repli si /country-defaults est indisponible)
export const COUNTRY_CURRENCY = { CM: 'XAF', CF: 'XAF', CG: 'XAF', GA: 'XAF', GQ: 'XAF', TD: 'XAF', CD: 'CDF', SN: 'XOF', CI: 'XOF' };

export const METHODS = { mobile_money: 'Mobile Money', card_nfc: 'Carte NFC', card: 'Carte', card_online: 'Carte en ligne', bank_transfer: 'Virement', qr: 'QR code', pay_link: 'Lien de paiement' };
export const methodLabel = (m) => (m ? METHODS[m] || m : '—');
