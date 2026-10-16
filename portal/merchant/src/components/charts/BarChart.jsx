import React, { useId, useState } from 'react';
import { fmtMoney, fmtCompact } from '../../utils/format';

// Histogramme groupé à 1 ou 2 séries, SVG fait main, accessible (title/desc,
// légende, tableau de données masqué pour les lecteurs d'écran, survol).
// data : [{ label, values: [n, n] }] ; series : [{ name, color }]
export const BarChart = ({ data, series, currency, title, height = 160 }) => {
  const id = useId();
  const [hover, setHover] = useState(null);
  const W = 600, H = height, padL = 8, padR = 8, padT = 22, padB = 24;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(1, ...data.flatMap(d => d.values));
  const n = data.length || 1;
  const slot = innerW / n;
  const gap = 2;
  const barW = Math.max(3, Math.min(28, (slot - 8) / series.length - gap));
  const y = (v) => padT + innerH - (v / max) * innerH;
  const total = data.reduce((a, d) => a + d.values.reduce((x, v) => x + v, 0), 0);
  const labelEvery = n > 14 ? Math.ceil(n / 7) : 1;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-labelledby={`${id}-t ${id}-d`} style={{ display: 'block', overflow: 'visible' }} onMouseLeave={() => setHover(null)}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{`Total ${fmtMoney(total, currency)} sur ${n} jours. ${series.map((s, si) => `${s.name} : ${fmtMoney(data.reduce((a, d) => a + (d.values[si] || 0), 0), currency)}`).join(', ')}.`}</desc>
        {[0.5, 1].map(f => <line key={f} x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} stroke="var(--n200)" strokeDasharray="3 4" />)}
        <text x={padL} y={y(max) - 6} fontSize="10" fill="var(--muted)">{fmtCompact(max)}</text>
        <line x1={padL} x2={W - padR} y1={padT + innerH} y2={padT + innerH} stroke="var(--n300)" />
        {data.map((d, i) => {
          const x0 = padL + i * slot + (slot - (barW + gap) * series.length) / 2;
          const isHover = hover === i;
          return (
            <g key={d.key || i} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1}>
              <rect x={padL + i * slot} y={padT} width={slot} height={innerH} fill={isHover ? 'var(--n100)' : 'transparent'} />
              {series.map((s, si) => {
                const v = d.values[si] || 0; const h = v > 0 ? Math.max(2, (v / max) * innerH) : 0;
                return <rect key={s.name} x={x0 + si * (barW + gap)} y={padT + innerH - h} width={barW} height={h} rx={3} fill={s.color} opacity={hover == null || isHover ? 1 : 0.55} />;
              })}
              {(i % labelEvery === 0 || i === n - 1) && <text x={padL + i * slot + slot / 2} y={H - 8} fontSize="10" textAnchor="middle" fill={isHover ? 'var(--text)' : 'var(--muted)'} fontWeight={d.today ? 700 : 400}>{d.label}</text>}
            </g>
          );
        })}
        {hover != null && data[hover] && (() => {
          const d = data[hover]; const cx = padL + hover * slot + slot / 2; const left = cx > W / 2;
          const bw = 170, bx = left ? cx - bw - 6 : cx + 6;
          return (
            <g pointerEvents="none">
              <rect x={bx} y={padT} width={bw} height={16 + 16 * series.length + 6} rx={6} fill="var(--n900)" opacity={0.95} />
              <text x={bx + 10} y={padT + 14} fontSize="11" fill="#fff" fontWeight="700">{d.full || d.label}</text>
              {series.map((s, si) => <text key={s.name} x={bx + 10} y={padT + 30 + si * 16} fontSize="11" fill="#dfe4ec"><tspan fill={s.color}>■</tspan> {s.name} : {fmtMoney(d.values[si] || 0, currency)}</text>)}
            </g>
          );
        })()}
      </svg>
      {series.length > 1 && (
        <figcaption className="row" style={{ gap: 16, marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-2)', flexWrap: 'wrap' }}>
          {series.map((s, si) => <span key={s.name} className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: s.color }} />{s.name} · <strong>{fmtMoney(data.reduce((a, d) => a + (d.values[si] || 0), 0), currency)}</strong></span>)}
        </figcaption>
      )}
      <table className="sr-only"><caption>{title}</caption><thead><tr><th>Jour</th>{series.map(s => <th key={s.name}>{s.name}</th>)}</tr></thead>
        <tbody>{data.map((d, i) => <tr key={i}><td>{d.full || d.label}</td>{d.values.map((v, j) => <td key={j}>{fmtMoney(v, currency)}</td>)}</tr>)}</tbody></table>
    </figure>
  );
};
export default BarChart;
