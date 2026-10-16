import React, { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';
import toast from '../utils/toast';
import { statusOf } from '../utils/status';

// ─── Bouton ───────────────────────────────────────────────────────
export const Button = React.forwardRef(({ variant = 'secondary', size = 'md', icon, loading, children, className = '', type = 'button', block, to, ...rest }, ref) => {
  const cls = `btn btn-${variant} ${size === 'sm' ? 'btn-sm' : size === 'xs' ? 'btn-xs' : ''} ${!children ? 'btn-icon' : ''} ${block ? 'btn-block' : ''} ${className}`;
  const inner = <>{loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'md' ? 16 : 14} /> : null}{children}</>;
  if (to) return <Link to={to} className={cls} ref={ref} {...rest}>{inner}</Link>;
  return <button ref={ref} type={type} className={cls} disabled={rest.disabled || loading} {...rest}>{inner}</button>;
});

// ─── Carte ────────────────────────────────────────────────────────
export const Card = ({ title, sub, actions, children, footer, dense, flush, className = '', style }) => (
  <section className={`card ${flush ? 'card-flush' : ''} ${className}`} style={style}>
    {(title || actions) && (
      <header className="card-header">
        <div><div className="card-title">{title}</div>{sub && <div className="card-sub">{sub}</div>}</div>
        {actions && <div className="row-wrap">{actions}</div>}
      </header>
    )}
    <div className={`card-body ${dense ? 'dense' : ''}`}>{children}</div>
    {footer && <footer className="card-footer">{footer}</footer>}
  </section>
);

// ─── Stat ─────────────────────────────────────────────────────────
export const Stat = ({ label, value, sub, icon, tone = '', to, small }) => {
  const body = (
    <div className="card stat">
      {icon && <div className={`stat-icon ${tone}`}><Icon name={icon} size={18} /></div>}
      <div style={{ minWidth: 0 }}>
        <div className="stat-label">{label}</div>
        <div className={`stat-value ${small ? 'sm' : ''}`}>{value ?? '—'}</div>
        {sub && <div className="stat-sub">{sub}</div>}
      </div>
    </div>
  );
  return to ? <Link to={to} className="stat-link">{body}</Link> : body;
};

// ─── Badge ────────────────────────────────────────────────────────
export const Badge = ({ tone = 'neutral', children, dot }) => (
  <span className={`badge badge-${tone}`}>{dot && <span className="badge-dot" />}{children}</span>
);
export const StatusBadge = ({ status, map }) => {
  const s = map?.[status] || statusOf(status);
  return <Badge tone={s.tone} dot>{s.label}</Badge>;
};

// ─── Formulaires ──────────────────────────────────────────────────
export const Field = ({ label, hint, error, required, children, className = '' }) => {
  const id = useId();
  const child = React.isValidElement(children) ? React.cloneElement(children, { id: children.props.id || id, 'aria-invalid': error ? 'true' : undefined }) : children;
  return (
    <div className={`field ${className}`}>
      {label && <label className="field-label" htmlFor={children?.props?.id || id}>{label}{required && <span className="req" aria-hidden="true">*</span>}</label>}
      {child}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
};
export const Input = React.forwardRef(({ size, className = '', onChange, ...rest }, ref) => (
  <input ref={ref} className={`input ${size === 'sm' ? 'input-sm' : ''} ${className}`} onChange={(e) => onChange?.(e.target.value, e)} {...rest} />
));
export const Select = ({ options = [], size, className = '', onChange, value, placeholder, ...rest }) => (
  <select className={`select ${size === 'sm' ? 'select-sm' : ''} ${className}`} value={value ?? ''} onChange={(e) => onChange?.(e.target.value, e)} {...rest}>
    {placeholder !== undefined && <option value="">{placeholder}</option>}
    {options.map((o) => { const v = typeof o === 'object' ? o.value : o; const l = typeof o === 'object' ? o.label : o; return <option key={String(v)} value={v}>{l}</option>; })}
  </select>
);
export const Textarea = ({ className = '', onChange, ...rest }) => (
  <textarea className={`textarea ${className}`} onChange={(e) => onChange?.(e.target.value, e)} {...rest} />
);
export const Switch = ({ checked, onChange, label, disabled }) => (
  <label className="check" style={{ opacity: disabled ? .6 : 1 }}>
    <button type="button" role="switch" aria-checked={!!checked} className="switch" disabled={disabled} onClick={() => onChange?.(!checked)} />
    {label && <span>{label}</span>}
  </label>
);
export const PasswordInput = (props) => {
  const [show, setShow] = useState(false);
  return (
    <div className="input-group has-right" style={{ position: 'relative' }}>
      <Input {...props} type={show ? 'text' : 'password'} style={{ paddingLeft: 10 }} />
      <Button variant="ghost" size="sm" className="btn-eye" icon={show ? 'eyeOff' : 'eye'} aria-label={show ? 'Masquer' : 'Afficher'} onClick={() => setShow((s) => !s)} />
    </div>
  );
};
export const SearchInput = ({ value, onChange, placeholder = 'Rechercher…', size, ...rest }) => (
  <div className="input-group">
    <Icon name="search" size={15} className="icon-left" />
    <Input type="search" value={value} onChange={onChange} placeholder={placeholder} size={size} aria-label={placeholder} {...rest} />
  </div>
);
export const DateRange = ({ from, to, onChange, size = 'sm' }) => (
  <div className="row">
    <Input type="date" size={size} value={from || ''} onChange={(v) => onChange({ from: v, to })} aria-label="Du" style={{ width: 'auto' }} />
    <span className="muted small">au</span>
    <Input type="date" size={size} value={to || ''} onChange={(v) => onChange({ from, to: v })} aria-label="Au" style={{ width: 'auto' }} />
  </div>
);

// ─── Filtres ──────────────────────────────────────────────────────
export const FiltersBar = ({ children, onReset, hasActive }) => (
  <div className="filters">
    {children}
    {hasActive && onReset && <Button variant="ghost" size="sm" icon="x" onClick={onReset}>Réinitialiser</Button>}
  </div>
);
export const Chips = ({ items, value, onChange }) => (
  <div className="chips" role="group">
    {items.map((it) => (
      <button key={String(it.value)} type="button" className="chip" aria-pressed={value === it.value} onClick={() => onChange(value === it.value ? '' : it.value)}>
        {it.label}{it.count !== undefined && <span className="count">{it.count}</span>}
      </button>
    ))}
  </div>
);
export const Segmented = ({ items, value, onChange }) => (
  <div className="seg" role="group">
    {items.map((it) => <button key={it.value} type="button" aria-pressed={value === it.value} onClick={() => onChange(it.value)}>{it.label}</button>)}
  </div>
);

// ─── Onglets ──────────────────────────────────────────────────────
export const Tabs = ({ items, value, onChange }) => (
  <div className="tabs" role="tablist">
    {items.filter((t) => !t.hidden).map((t) => (
      <button key={t.value} type="button" role="tab" className="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
        {t.icon && <Icon name={t.icon} size={15} />}{t.label}{t.count !== undefined && t.count !== null && <span className="count">{t.count}</span>}
      </button>
    ))}
  </div>
);

// ─── En-tête de page ──────────────────────────────────────────────
export const PageHeader = ({ title, subtitle, crumbs, actions, badge }) => (
  <div>
    {crumbs && (
      <nav className="breadcrumbs" aria-label="Fil d’Ariane">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
          </React.Fragment>
        ))}
      </nav>
    )}
    <div className="page-header">
      <div style={{ minWidth: 0 }}>
        <h1 className="page-title">{title}{badge}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  </div>
);

// ─── États ────────────────────────────────────────────────────────
export const EmptyState = ({ icon = 'inbox', title = 'Aucune donnée', description, action }) => (
  <div className="empty">
    <div className="empty-icon"><Icon name={icon} size={22} /></div>
    <div className="empty-title">{title}</div>
    {description && <div className="empty-desc">{description}</div>}
    {action}
  </div>
);
export const ErrorState = ({ error, onRetry, title = 'Chargement impossible' }) => (
  <div className="empty">
    <div className="empty-icon" style={{ background: 'var(--error-100)', color: 'var(--error)' }}><Icon name="alert" size={22} /></div>
    <div className="empty-title">{title}</div>
    {error && <div className="empty-desc">{typeof error === 'string' ? error : error.message}</div>}
    {onRetry && <Button size="sm" icon="refresh" onClick={onRetry}>Réessayer</Button>}
  </div>
);
export const ForbiddenState = ({ roles }) => (
  <EmptyState icon="lock" title="Accès réservé" description={`Cette section est réservée aux rôles : ${(roles || []).join(', ')}.`} />
);
export const Skeleton = ({ lines = 3, height = 12 }) => (
  <div className="stack" aria-busy="true" aria-live="polite">
    {Array.from({ length: lines }).map((_, i) => <div key={i} className="skeleton" style={{ height, width: `${90 - (i % 3) * 18}%` }} />)}
  </div>
);
export const SkeletonTable = ({ rows = 6, cols = 5 }) => (
  <div aria-busy="true">
    {Array.from({ length: rows }).map((_, r) => (
      <div key={r} className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', gap: 16 }}>
        {Array.from({ length: cols }).map((__, c) => <div key={c} className="skeleton" style={{ flex: c === 0 ? 2 : 1, height: 12 }} />)}
      </div>
    ))}
  </div>
);
export const Callout = ({ tone = 'info', children, icon }) => (
  <div className={`callout callout-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
    <Icon name={icon || (tone === 'warn' || tone === 'error' ? 'alert' : tone === 'success' ? 'check' : 'info')} size={16} />
    <div>{children}</div>
  </div>
);

// ─── Clé / valeur ─────────────────────────────────────────────────
export const KeyValue = ({ rows }) => (
  <div className="kv">
    {rows.filter(Boolean).map(([k, v], i) => (
      <React.Fragment key={i}><div>{k}</div><div>{v === undefined || v === null || v === '' ? '—' : v}</div></React.Fragment>
    ))}
  </div>
);

// ─── Copie ────────────────────────────────────────────────────────
export const CopyButton = ({ value, label = 'Copier', size = 'xs' }) => {
  const copy = async () => {
    try { await navigator.clipboard.writeText(String(value)); toast.success('Copié dans le presse-papiers'); }
    catch (e) { toast.error('Copie impossible'); }
  };
  return <Button variant="ghost" size={size} icon="copy" onClick={copy} className="copy-btn" aria-label={label}>{label}</Button>;
};

// ─── Secret affiché une seule fois ────────────────────────────────
export const SecretOnce = ({ label = 'Mot de passe temporaire', value, note }) => (
  <div className="secret-box">
    <div className="row" style={{ color: 'var(--warn-700)', fontWeight: 700, fontSize: 'var(--fs-sm)' }}><Icon name="alert" size={15} /> {label} — affiché une seule fois</div>
    <div className="secret-value"><span>{value}</span><CopyButton value={value} size="sm" /></div>
    <div className="small mt-2" style={{ color: 'var(--warn-700)' }}>{note || 'Transmettez-le par un canal sûr (appel, remise en main propre). Il ne sera plus affiché ; l’utilisateur devra le changer à sa prochaine connexion.'}</div>
  </div>
);

// ─── Modale / tiroir ──────────────────────────────────────────────
const useEscape = (onClose) => {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
};
const useFocusTrap = (ref) => {
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    const first = el?.querySelector('input, select, textarea, button:not([aria-label="Fermer"]), [tabindex]:not([tabindex="-1"])');
    (first || el)?.focus?.();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; prev?.focus?.(); };
  }, [ref]);
};

export const Modal = ({ title, sub, onClose, children, footer, size = '' }) => {
  const ref = useRef(null);
  useEscape(onClose); useFocusTrap(ref);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${size ? `modal-${size}` : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref} tabIndex={-1}>
        <div className="modal-header">
          <div><div className="modal-title">{title}</div>{sub && <div className="card-sub">{sub}</div>}</div>
          <Button variant="ghost" size="sm" icon="x" aria-label="Fermer" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
};

export const Drawer = ({ title, sub, onClose, children, footer, size = '' }) => {
  const ref = useRef(null);
  useEscape(onClose); useFocusTrap(ref);
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className={`drawer ${size === 'lg' ? 'drawer-lg' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref} tabIndex={-1}>
        <div className="drawer-header">
          <div style={{ minWidth: 0 }}><div className="drawer-title">{title}</div>{sub && <div className="drawer-sub">{sub}</div>}</div>
          <Button variant="ghost" size="sm" icon="x" aria-label="Fermer" onClick={onClose} />
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </aside>
    </>
  );
};

// Confirmation d'action sensible, avec motif optionnel/obligatoire.
export const ConfirmDialog = ({ title, message, confirmLabel = 'Confirmer', tone = 'primary', reason, onConfirm, onClose, extra }) => {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const needReason = reason && reason.required && text.trim().length < (reason.min || 3);
  const run = async () => {
    setBusy(true);
    try { await onConfirm(text.trim()); onClose(); }
    catch (e) { /* le message d'erreur est affiché par l'appelant */ }
    finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={busy ? undefined : onClose} size="sm" footer={<>
      <Button onClick={onClose} disabled={busy}>Annuler</Button>
      <Button variant={tone === 'danger' ? 'danger' : tone === 'success' ? 'success' : 'primary'} loading={busy} disabled={needReason} onClick={run}>{confirmLabel}</Button>
    </>}>
      {message && <div className="text-2" style={{ marginBottom: 12 }}>{message}</div>}
      {extra}
      {reason && (
        <Field label={reason.label || 'Motif'} required={reason.required} hint={reason.hint}>
          <Textarea value={text} onChange={setText} placeholder={reason.placeholder || 'Expliquez la raison de cette action…'} rows={3} />
        </Field>
      )}
    </Modal>
  );
};

// ─── Menu déroulant léger ─────────────────────────────────────────
export const Popover = ({ button, children, align = 'right', className = '' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }} className={className}>
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open && <div className="menu-pop" style={align === 'left' ? { left: 0, right: 'auto' } : undefined} onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
};
