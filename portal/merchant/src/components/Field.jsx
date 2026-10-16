import React, { useId, useState } from 'react';
import Icon from './Icon';
import { fmtMoney, isIntegerCurrency } from '../utils/format';

export const Field = ({ label, hint, error, required, children, className = '', id }) => (
  <div className={`field ${className}`}>
    {label && <label htmlFor={id}>{label}{required && <span aria-hidden="true" className="error"> *</span>}</label>}
    {children}
    {error ? <span className="err" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
  </div>
);

export const Input = ({ label, hint, error, required, onChange, className = '', mono, ...rest }) => {
  const auto = useId(); const id = rest.id || auto;
  return (
    <Field label={label} hint={hint} error={error} required={required} id={id} className={className}>
      <input id={id} className={`input${mono ? ' mono' : ''}`} aria-invalid={error ? 'true' : undefined} aria-required={required || undefined}
        onChange={e => onChange && onChange(e.target.value)} {...rest} />
    </Field>
  );
};

export const PasswordInput = ({ label, hint, error, required, onChange, ...rest }) => {
  const auto = useId(); const id = rest.id || auto;
  const [show, setShow] = useState(false);
  return (
    <Field label={label} hint={hint} error={error} required={required} id={id}>
      <div className="input-group">
        <input id={id} className="input" type={show ? 'text' : 'password'} aria-invalid={error ? 'true' : undefined} onChange={e => onChange && onChange(e.target.value)} {...rest} />
        <button type="button" className="addon" onClick={() => setShow(s => !s)} aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'} aria-pressed={show}>
          <Icon name={show ? 'eyeOff' : 'eye'} size={18} />
        </button>
      </div>
    </Field>
  );
};

export const Select = ({ label, hint, error, required, onChange, options, placeholder, children, ...rest }) => {
  const auto = useId(); const id = rest.id || auto;
  return (
    <Field label={label} hint={hint} error={error} required={required} id={id}>
      <select id={id} className="select" aria-invalid={error ? 'true' : undefined} onChange={e => onChange && onChange(e.target.value)} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options ? options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>) : children}
      </select>
    </Field>
  );
};

export const Textarea = ({ label, hint, error, required, onChange, ...rest }) => {
  const auto = useId(); const id = rest.id || auto;
  return (
    <Field label={label} hint={hint} error={error} required={required} id={id}>
      <textarea id={id} className="textarea" aria-invalid={error ? 'true' : undefined} onChange={e => onChange && onChange(e.target.value)} {...rest} />
    </Field>
  );
};

export const Checkbox = ({ checked, onChange, children, ...rest }) => (
  <label className="check">
    <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} {...rest} />
    <span>{children}</span>
  </label>
);

// Saisie de montant : clavier numérique, devise en lecture seule, aperçu formaté.
export const AmountInput = ({ label = 'Montant', value, onChange, currency, hint, error, autoFocus, id: idProp }) => {
  const auto = useId(); const id = idProp || auto;
  const integer = isIntegerCurrency(currency);
  const clean = (v) => {
    let s = String(v || '').replace(/\s/g, '').replace(',', '.');
    s = integer ? s.replace(/[^0-9]/g, '') : s.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
    return s.replace(/^0+(?=\d)/, '');
  };
  const preview = value ? fmtMoney(value, currency) : null;
  return (
    <Field label={label} id={id} error={error} hint={error ? undefined : [preview, hint].filter(Boolean).join(' · ') || undefined} className="amount-input">
      <div className="input-group">
        <input id={id} className="input" type="text" inputMode={integer ? 'numeric' : 'decimal'} autoComplete="off" autoFocus={autoFocus}
          value={value || ''} onChange={e => onChange(clean(e.target.value))} placeholder="0" aria-invalid={error ? 'true' : undefined} />
        <span className="addon" aria-label="Devise">{currency || '—'}</span>
      </div>
    </Field>
  );
};

// Saisie d'un code à 6 chiffres (TOTP).
export const OtpInput = ({ label = 'Code à 6 chiffres', value, onChange, error, autoFocus, id: idProp }) => {
  const auto = useId(); const id = idProp || auto;
  return (
    <Field label={label} id={id} error={error}>
      <input id={id} className="input otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="••••••" autoFocus={autoFocus}
        value={value} onChange={e => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} aria-invalid={error ? 'true' : undefined} />
    </Field>
  );
};
