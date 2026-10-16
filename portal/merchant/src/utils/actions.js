// Actions utilitaires : copier, partager, télécharger, imprimer.
import toast from 'react-hot-toast';

export const copyText = async (value, label = 'Copié') => {
  try { await navigator.clipboard.writeText(String(value ?? '')); toast.success(label); return true; }
  catch (e) { toast.error('Copie indisponible sur ce navigateur'); return false; }
};

export const shareOrCopy = async ({ title, text, url }) => {
  if (navigator.share) { try { await navigator.share({ title, text, url }); return; } catch (e) { /* annulé */ } }
  copyText(url, 'Lien copié');
};

export const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Impression d'un ticket ou bordereau : fenêtre dédiée, texte seul.
export const printDoc = (title, rows, footer) => {
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) { toast.error('Autorisez les fenêtres pop-up pour imprimer'); return; }
  const body = rows.filter(r => r[1] !== undefined && r[1] !== null && r[1] !== '').map(([l, v]) => `<div class="r"><span>${escHtml(l)}</span><strong>${escHtml(v)}</strong></div>`).join('');
  w.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>body{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;padding:20px;max-width:320px;color:#111}.r{display:flex;justify-content:space-between;gap:12px;margin:5px 0}.r strong{text-align:right;word-break:break-all}.sep{border-top:1px dashed #999;margin:10px 0}.c{text-align:center;font-weight:bold}</style></head><body><div class="c">C-PAY — ${escHtml(title.toUpperCase())}</div><div class="sep"></div>${body}<div class="sep"></div>${footer ? `<div>${escHtml(footer)}</div><div class="sep"></div>` : ''}<div class="c">www.c-pay.global</div></body></html>`);
  w.document.close();
  w.focus();
  w.print();
};

// Lecture d'un fichier en data URL (pièces jointes, documents KYB), 5 Mo max.
export const readFileAsDataUrl = (file, maxBytes = 5 * 1024 * 1024) => new Promise((resolve, reject) => {
  if (file.size > maxBytes) { reject(new Error('Fichier trop volumineux (5 Mo maximum)')); return; }
  const reader = new FileReader();
  reader.onload = (ev) => resolve({ name: file.name, url: ev.target.result, type: file.type, size: file.size });
  reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
  reader.readAsDataURL(file);
});
