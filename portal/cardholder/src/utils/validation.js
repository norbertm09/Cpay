export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
export const isPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 8 && d.length <= 15; };
export const isPin = (v) => /^[0-9]{4}$/.test(String(v || ''));
export const isEmailOrPhone = (v) => isEmail(v) || isPhone(v);

/** Regles backend : 8 caracteres, majuscule, minuscule, chiffre. */
export const passwordIssues = (pwd) => {
  const p = String(pwd || '');
  const issues = [];
  if (p.length < 8) issues.push('8 caractères minimum');
  if (!/[A-Z]/.test(p)) issues.push('une majuscule');
  if (!/[a-z]/.test(p)) issues.push('une minuscule');
  if (!/[0-9]/.test(p)) issues.push('un chiffre');
  return issues;
};
export const passwordScore = (pwd) => {
  const p = String(pwd || '');
  if (!p) return 0;
  const issues = passwordIssues(p).length;
  if (issues >= 3) return 1;
  if (issues > 0) return 2;
  return 3;
};

export const parseAmount = (v) => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
export const amountIssue = (v, { min = 100, max } = {}) => {
  const n = parseAmount(v);
  if (!Number.isFinite(n) || n <= 0) return 'Montant invalide';
  if (n < min) return `Montant minimum ${min.toLocaleString('fr-FR')} XAF`;
  if (max != null && n > max) return `Montant maximum ${max.toLocaleString('fr-FR')} XAF`;
  return '';
};
