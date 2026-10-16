import React, { useId } from 'react';

// Mini courbe en aire (une série), décorative mais titrée ; les valeurs sont
// toujours affichées en texte à côté.
export const Sparkline = ({ values, color = 'var(--primary)', width = 120, height = 36, title }) => {
  const id = useId();
  const max = Math.max(1, ...values); const min = Math.min(0, ...values);
  const n = values.length;
  const px = (i) => (n > 1 ? (i / (n - 1)) * width : width / 2);
  const py = (v) => height - 2 - ((v - min) / (max - min || 1)) * (height - 4);
  const pts = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  const line = pts.join(' ');
  const area = `M0,${height} L${line.split(' ').join(' L')} L${width},${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-t`} style={{ display: 'block', overflow: 'visible' }}>
      <title id={`${id}-t`}>{title}</title>
      <defs><linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.28" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={area} fill={`url(#${id}-g)`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {n > 0 && <circle cx={px(n - 1)} cy={py(values[n - 1])} r={3} fill={color} stroke="#fff" strokeWidth="1.5" />}
    </svg>
  );
};
export default Sparkline;
