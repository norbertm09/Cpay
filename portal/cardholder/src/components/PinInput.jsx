import React, { useRef } from 'react';

/** Saisie de code PIN (4 chiffres) ou code TOTP (6 chiffres), case par case. */
export default function PinInput({ value = '', onChange, length = 4, label = 'Code PIN', autoFocus, disabled, secret = true, name = 'pin' }) {
  const refs = useRef([]);
  const digits = Array.from({ length }, (_, i) => value[i] || '');

  const setAt = (i, d) => {
    const arr = [...digits];
    arr[i] = d;
    const next = arr.join('').slice(0, length);
    onChange(next);
  };
  const onKey = (i, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (digits[i]) setAt(i, ''); else if (i > 0) { setAt(i - 1, ''); refs.current[i - 1]?.focus(); }
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < length - 1) refs.current[i + 1]?.focus();
  };
  const onInput = (i, e) => {
    const v = e.target.value.replace(/\D/g, '');
    if (!v) { setAt(i, ''); return; }
    if (v.length > 1) { // collage
      onChange((value.slice(0, i) + v).slice(0, length));
      refs.current[Math.min(length - 1, i + v.length)]?.focus();
      return;
    }
    setAt(i, v);
    if (i < length - 1) refs.current[i + 1]?.focus();
  };

  return (
    <div className="pin" role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i} ref={(el) => { refs.current[i] = el; }} value={d} onChange={(e) => onInput(i, e)} onKeyDown={(e) => onKey(i, e)}
          type={secret ? 'password' : 'text'} inputMode="numeric" pattern="[0-9]*" maxLength={length} autoComplete={secret ? 'off' : 'one-time-code'}
          aria-label={`${label}, chiffre ${i + 1}`} autoFocus={autoFocus && i === 0} disabled={disabled} name={`${name}-${i}`}
        />
      ))}
    </div>
  );
}
