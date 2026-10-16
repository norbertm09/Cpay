import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from './Icon';
import { merchantsApi, cashApi, txnApi } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { NAV } from '../layout/nav';
import { fmtMoney } from '../utils/format';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Recherche globale (Ctrl+K) : pages, marchands (GET /merchants?search),
// transferts de caisse par référence (GET /cash/transfers?q), transaction par UUID.
export default function CommandPalette({ onClose }) {
  const navigate = useNavigate();
  const { admin, hasRole } = useAuth();
  const [q, setQ] = useState('');
  const [results, setResults] = useState({ merchants: [], transfers: [], txn: null });
  const [loading, setLoading] = useState(false);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  const pages = useMemo(() => NAV.flatMap((g) => g.items.filter((it) => !it.roles || it.roles.includes(admin?.role)).map((it) => ({ ...it, group: g.label }))), [admin]);
  const pageHits = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? pages.filter((p) => p.label.toLowerCase().includes(s) || p.group.toLowerCase().includes(s)) : pages).slice(0, 6);
  }, [q, pages]);

  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setResults({ merchants: [], transfers: [], txn: null }); return undefined; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      const [m, tr, tx] = await Promise.all([
        merchantsApi.list({ search: s, limit: 5 }).then((r) => r.data.data || []).catch(() => []),
        hasRole(['super_admin', 'ops_admin']) ? cashApi.transfers({ q: s, limit: 5 }).then((r) => r.data.data || []).catch(() => []) : Promise.resolve([]),
        UUID_RE.test(s) ? txnApi.get(s).then((r) => r.data).catch(() => null) : Promise.resolve(null),
      ]);
      if (!cancelled) { setResults({ merchants: m, transfers: tr, txn: tx }); setLoading(false); setIdx(0); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, hasRole]);

  const items = useMemo(() => [
    ...pageHits.map((p) => ({ kind: 'page', label: p.label, meta: p.group, icon: p.icon, go: () => navigate(p.to) })),
    ...results.merchants.map((m) => ({ kind: 'merchant', label: m.business_name, meta: `${m.country || ''} · ${m.email || ''}`, icon: 'store', go: () => navigate(`/marchands/${m.merchant_id}`) })),
    ...results.transfers.map((t) => ({ kind: 'transfer', label: t.reference, meta: `${t.merchant || ''} · ${fmtMoney(t.amount, t.currency)}`, icon: 'banknote', go: () => navigate(`/operations/caisse?tab=transferts&q=${encodeURIComponent(t.reference)}`) })),
    ...(results.txn ? [{ kind: 'txn', label: `Transaction ${results.txn.transaction_id}`, meta: `${results.txn.business_name || ''} · ${fmtMoney(results.txn.amount, results.txn.currency)}`, icon: 'swap', go: () => navigate(`/operations/transactions?id=${results.txn.transaction_id}`) }] : []),
  ], [pageHits, results, navigate]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && items[idx]) { items[idx].go(); onClose(); }
    else if (e.key === 'Escape') onClose();
  };

  let lastKind = null;
  const KIND = { page: 'Pages', merchant: 'Marchands', transfer: 'Transferts de caisse', txn: 'Transaction' };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Recherche globale">
        <div className="palette-input">
          <Icon name="search" size={18} className="muted" />
          <input ref={inputRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Rechercher un marchand, une référence, une page… " aria-label="Recherche" />
          {loading && <span className="spinner muted" />}
        </div>
        <div className="palette-list" role="listbox">
          {items.length === 0 && <div className="empty" style={{ padding: 24 }}><div className="empty-desc">{q.length < 2 ? 'Tapez au moins 2 caractères.' : 'Aucun résultat.'}</div></div>}
          {items.map((it, i) => {
            const head = it.kind !== lastKind ? <div className="palette-group">{KIND[it.kind]}</div> : null;
            lastKind = it.kind;
            return (
              <React.Fragment key={`${it.kind}-${i}`}>
                {head}
                <button type="button" role="option" className="palette-item" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onClick={() => { it.go(); onClose(); }}>
                  <Icon name={it.icon} size={16} /><span className="truncate">{it.label}</span><span className="meta truncate">{it.meta}</span>
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <div className="palette-hint"><span><span className="kbd">↑↓</span> naviguer</span><span><span className="kbd">Entrée</span> ouvrir</span><span><span className="kbd">Échap</span> fermer</span></div>
      </div>
    </div>
  );
}
