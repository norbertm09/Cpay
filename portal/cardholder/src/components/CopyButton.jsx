import React, { useState } from 'react';
import Button from './Button';

export default function CopyButton({ value, label = 'Copier', size = 'sm', variant = 'outline' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(String(value)); setDone(true); setTimeout(() => setDone(false), 1500); } catch (e) { /* presse-papiers indisponible */ }
  };
  return <Button size={size} variant={variant} icon={done ? 'check' : 'copy'} onClick={copy}>{done ? 'Copié' : label}</Button>;
}
