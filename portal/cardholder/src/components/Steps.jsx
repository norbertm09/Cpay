import React from 'react';
import Icon from './Icon';

export default function Steps({ steps, current }) {
  return (
    <ol className="steps" aria-label="Étapes">
      {steps.map((s, i) => (
        <React.Fragment key={s}>
          <li className={`step ${i < current ? 'done' : ''} ${i === current ? 'on' : ''}`} aria-current={i === current ? 'step' : undefined}>
            <i>{i < current ? <Icon name="check" size={12} /> : i + 1}</i><span>{s}</span>
          </li>
          {i < steps.length - 1 ? <span className="sep" aria-hidden="true" /> : null}
        </React.Fragment>
      ))}
    </ol>
  );
}
