import React from 'react';

export const Skeleton = ({ width = '100%', height = 16, style, className = '' }) => (
  <span className={`skeleton ${className}`} style={{ width, height, ...style }} aria-hidden="true" />
);
export const SkeletonCard = ({ lines = 3 }) => (
  <div className="card" aria-busy="true"><div className="stack">{Array.from({ length: lines }).map((_, i) => <Skeleton key={i} height={i === 0 ? 24 : 14} width={i === 0 ? '40%' : `${60 + (i * 13) % 35}%`} />)}</div></div>
);
export default Skeleton;
