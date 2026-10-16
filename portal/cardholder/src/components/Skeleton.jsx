import React from 'react';

export function Skeleton({ w = '100%', h = 14, style, className = '' }) {
  return <div className={`skeleton ${className}`.trim()} style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

export function SkeletonList({ rows = 4 }) {
  return (
    <div className="list" aria-busy="true" aria-label="Chargement">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="list-item" key={i}>
          <Skeleton w={40} h={40} style={{ borderRadius: 12 }} />
          <div className="li-main stack-sm"><Skeleton w="55%" /><Skeleton w="35%" h={10} /></div>
          <Skeleton w={70} h={16} />
        </div>
      ))}
    </div>
  );
}
