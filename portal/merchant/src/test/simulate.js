// React 19 a retire react-dom/test-utils (Simulate). Les tests emettent desormais de vrais evenements DOM :
// React ecoute input/click/submit sur la racine, et la valeur est posee par le setter natif pour que le
// suivi de valeur de React voie le changement (sinon l'evenement est ignore comme « inchange »).
const setNativeValue = (el, value) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
};
export const Simulate = {
  click: (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
  change: (el, { target } = {}) => {
    if (target && 'value' in target) setNativeValue(el, target.value);
    if (target && 'checked' in target) el.checked = target.checked;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  submit: (form) => {
    if (typeof form.requestSubmit === 'function' && !form.querySelector('button[type="submit"],input[type="submit"]')) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    } else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  },
  keyDown: (el, init = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })),
};
export default Simulate;
