import React, { useState } from 'react';
import { fmtNumber } from '../utils/format';

// Graphiques SVG inline, une seule série par graphique, survol + vue tableau.
// Couleurs : tokens --series-* (palette validée CVD), textes en encre neutre.

const useTip = () => {
  const [tip, setTip] = useState(null); // { x, y, label }
  const show = (e, label) => {
    const r = e.currentTarget.closest('.chart').getBoundingClientRect();
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, label });
  };
  return { tip, show, hide: () => setTip(null) };
};

const TableToggle = ({ open, onToggle }) => (
  <button type="button" className="link-btn xs" onClick={onToggle} aria-expanded={open}>{open ? 'Masquer le tableau' : 'Vue tableau'}</button>
);

// Aire / ligne : data [{ label, value }]
export const AreaChart = ({ data = [], height = 160, format = fmtNumber, color = 'var(--series-1)', id = 'area' }) => {
  const { tip, show, hide } = useTip();
  const [table, setTable] = useState(false);
  const w = 600, h = height, padL = 44, padR = 10, padT = 10, padB = 24;
  const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
  const n = Math.max(1, data.length - 1);
  const x = (i) => padL + (i / n) * (w - padL - padR);
  const y = (v) => padT + (1 - (Number(v) || 0) / max) * (h - padT - padB);
  const pts = data.map((d, i) => `${x(i)},${y(d.value)}`);
  const path = pts.length ? `M${pts.join(' L')}` : '';
  const area = pts.length ? `${path} L${x(data.length - 1)},${h - padB} L${x(0)},${h - padB} Z` : '';
  const ticks = [0, 0.5, 1];
  const step = Math.max(1, Math.ceil(data.length / 6));
  if (!data.length) return <div className="muted small">Aucune donnée sur la période.</div>;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Évolution">
        <defs><linearGradient id={`g-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".25" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={padL} x2={w - padR} y1={y(max * t)} y2={y(max * t)} />
            <text x={padL - 6} y={y(max * t) + 4} textAnchor="end">{fmtNumber(Math.round(max * t))}</text>
          </g>
        ))}
        <path d={area} fill={`url(#g-${id})`} />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {data.map((d, i) => (
          <g key={i}>
            {i % step === 0 && <text x={x(i)} y={h - 6} textAnchor="middle">{d.label}</text>}
            <rect x={x(i) - (w - padL - padR) / n / 2} y={padT} width={(w - padL - padR) / n} height={h - padT - padB} fill="transparent"
              onMouseMove={(e) => show(e, `${d.label} · ${format(d.value)}`)} onMouseLeave={hide} />
            {tip && tip.label.startsWith(`${d.label} ·`) && <circle cx={x(i)} cy={y(d.value)} r="4" fill={color} stroke="#fff" strokeWidth="2" />}
          </g>
        ))}
      </svg>
      {tip && <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>{tip.label}</div>}
      <div className="between"><span className="xs muted">Survolez pour le détail</span><TableToggle open={table} onToggle={() => setTable((t) => !t)} /></div>
      {table && <table className="chart-table"><tbody>{data.map((d, i) => <tr key={i}><td>{d.label}</td><td>{format(d.value)}</td></tr>)}</tbody></table>}
    </div>
  );
};

// Barres horizontales : data [{ label, value, sub }]
export const BarChart = ({ data = [], format = fmtNumber, color = 'var(--series-1)', max: maxProp }) => {
  const [table, setTable] = useState(false);
  if (!data.length) return <div className="muted small">Aucune donnée.</div>;
  const max = Math.max(1, maxProp || 0, ...data.map((d) => Number(d.value) || 0));
  return (
    <div className="chart">
      <div className="stack" style={{ gap: 8 }}>
        {data.map((d, i) => (
          <div key={i} title={`${d.label} · ${format(d.value)}`}>
            <div className="between" style={{ marginBottom: 3 }}>
              <span className="small truncate" style={{ maxWidth: '70%' }}>{d.label}{d.sub && <span className="muted"> · {d.sub}</span>}</span>
              <span className="small strong num">{format(d.value)}</span>
            </div>
            <div className="progress" style={{ height: 8 }}><div style={{ width: `${Math.max(2, ((Number(d.value) || 0) / max) * 100)}%`, background: color }} /></div>
          </div>
        ))}
      </div>
      <div className="right mt-2"><TableToggle open={table} onToggle={() => setTable((t) => !t)} /></div>
      {table && <table className="chart-table"><tbody>{data.map((d, i) => <tr key={i}><td>{d.label}</td><td>{format(d.value)}</td></tr>)}</tbody></table>}
    </div>
  );
};

// Anneau : data [{ label, value, color }] — étiquettes directes + légende.
export const Donut = ({ data = [], size = 150, center, format = fmtNumber }) => {
  const { tip, show, hide } = useTip();
  const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const r = size / 2 - 10, cx = size / 2, cy = size / 2, stroke = 18;
  if (!total) return <div className="muted small">Aucune donnée.</div>;
  let acc = 0;
  const circ = 2 * Math.PI * r;
  return (
    <div className="chart row" style={{ alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ width: size, flexShrink: 0 }} role="img" aria-label="Répartition">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        {data.map((d, i) => {
          const frac = (Number(d.value) || 0) / total;
          const dash = `${Math.max(0, frac * circ - 2)} ${circ}`;
          const off = -acc * circ + circ / 4;
          acc += frac;
          return <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={d.color} strokeWidth={stroke} strokeDasharray={dash} strokeDashoffset={off}
            onMouseMove={(e) => show(e, `${d.label} · ${format(d.value)} (${Math.round(frac * 100)} %)`)} onMouseLeave={hide} />;
        })}
        <text x={cx} y={cy + 6} textAnchor="middle" className="donut-center">{center ?? fmtNumber(total)}</text>
      </svg>
      <div className="stack" style={{ gap: 6, minWidth: 140 }}>
        {data.map((d, i) => (
          <div key={i} className="between small">
            <span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: d.color, display: 'inline-block' }} />{d.label}</span>
            <span className="num strong">{format(d.value)} <span className="muted">({Math.round(((Number(d.value) || 0) / total) * 100)} %)</span></span>
          </div>
        ))}
      </div>
      {tip && <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>{tip.label}</div>}
    </div>
  );
};

export const Sparkline = ({ data = [], color = 'var(--series-1)', width = 120, height = 32 }) => {
  if (data.length < 2) return null;
  const max = Math.max(1, ...data), min = Math.min(...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / (max - min || 1)) * (height - 4) - 2}`).join(' ');
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" /></svg>;
};
