import React, { useId, useState } from 'react';
import Icon from './Icon';

const Wrap = ({ id, label, required, hint, error, children }) => (
  <div className="field">
    {label ? <label className="field-label" htmlFor={id}>{label}{required ? <span className="req" aria-hidden="true">*</span> : null}</label> : null}
    {children}
    {error ? <div className="field-error" id={`${id}-err`} role="alert">{error}</div> : hint ? <div className="field-hint" id={`${id}-hint`}>{hint}</div> : null}
  </div>
);

const describedBy = (id, error, hint) => (error ? `${id}-err` : hint ? `${id}-hint` : undefined);

export function Input({ label, required, hint, error, prefixIcon, suffix, className = '', id: idProp, type = 'text', ...rest }) {
  const auto = useId();
  const id = idProp || auto;
  const hasWrap = prefixIcon || suffix;
  const input = (
    <input
      id={id} type={type} className={`input ${prefixIcon ? 'has-prefix' : ''} ${className}`.trim()}
      aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy(id, error, hint)} aria-required={required || undefined} {...rest}
    />
  );
  return (
    <Wrap id={id} label={label} required={required} hint={hint} error={error}>
      {hasWrap ? (
        <div className="input-wrap">
          {prefixIcon ? <span className="input-prefix"><Icon name={prefixIcon} size={18} /></span> : null}
          {input}
          {suffix ? <span className="input-suffix">{suffix}</span> : null}
        </div>
      ) : input}
    </Wrap>
  );
}

export function PasswordInput({ label, required, hint, error, id: idProp, ...rest }) {
  const auto = useId();
  const id = idProp || auto;
  const [show, setShow] = useState(false);
  return (
    <Wrap id={id} label={label} required={required} hint={hint} error={error}>
      <div className="input-wrap">
        <input id={id} type={show ? 'text' : 'password'} className="input" aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy(id, error, hint)} {...rest} />
        <button type="button" className="input-action" onClick={() => setShow((s) => !s)} aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'} aria-pressed={show}>
          <Icon name={show ? 'eye-off' : 'eye'} size={18} />
        </button>
      </div>
    </Wrap>
  );
}

export function Select({ label, required, hint, error, options = [], placeholder, id: idProp, children, ...rest }) {
  const auto = useId();
  const id = idProp || auto;
  return (
    <Wrap id={id} label={label} required={required} hint={hint} error={error}>
      <select id={id} className="select" aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy(id, error, hint)} {...rest}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        {children}
      </select>
    </Wrap>
  );
}

export function Textarea({ label, required, hint, error, id: idProp, ...rest }) {
  const auto = useId();
  const id = idProp || auto;
  return (
    <Wrap id={id} label={label} required={required} hint={hint} error={error}>
      <textarea id={id} className="textarea" aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy(id, error, hint)} {...rest} />
    </Wrap>
  );
}

export function Checkbox({ label, error, children, ...rest }) {
  return (
    <div className="field">
      <label className="check"><input type="checkbox" {...rest} /><span>{label || children}</span></label>
      {error ? <div className="field-error" role="alert">{error}</div> : null}
    </div>
  );
}

/** Saisie de montant : grand chiffre, devise en suffixe, pave numerique mobile. */
export function AmountInput({ currency = 'XAF', label = 'Montant', ...rest }) {
  return (
    <div className="amount-input">
      <Input label={label} inputMode="decimal" autoComplete="off" placeholder="0" suffix={currency} {...rest} />
    </div>
  );
}
