import React from 'react';
import Icon from './Icon';
import { expiry, maskCard } from '../utils/format';

/**
 * Carte virtuelle C-Pay (visuel de marque). `card` accepte les formes
 * /card, /cards/created et /gtp/cards (cardMasked, cardholderName, status,
 * expiryMonth/Year, network).
 */
export default function VirtualCard({ card, small, as: Tag = 'div', label, ...rest }) {
  const status = String(card?.status || 'active').toLowerCase();
  const frozen = status === 'frozen' || status === 'blocked';
  const cancelled = status === 'cancelled';
  const cls = ['vcard', small ? 'vcard-sm' : '', frozen ? 'frozen' : '', cancelled ? 'cancelled' : ''].filter(Boolean).join(' ');
  const net = (card?.network || 'visa').toUpperCase();
  return (
    <Tag className={cls} {...rest}>
      <div className="vcard-top">
        <span className="vcard-brand"><img src="/logo-calculus.png" alt="" />C-Pay{label ? <span style={{ fontWeight: 500, opacity: 0.8, fontSize: 12 }}> · {label}</span> : null}</span>
        <span className="vcard-net">{net}</span>
      </div>
      <div>
        <div className="vcard-chip" />
        <div className="vcard-number">{maskCard(card?.cardMasked, card?.last4)}</div>
      </div>
      <div className="vcard-bottom">
        <div className="grow">
          <div className="vcard-label">Titulaire</div>
          <div className="vcard-name truncate">{card?.cardholderName || '—'}</div>
        </div>
        {card?.expiryMonth ? (
          <div>
            <div className="vcard-label">Expire</div>
            <div className="vcard-exp">{expiry(card.expiryMonth, card.expiryYear)}</div>
          </div>
        ) : null}
      </div>
      {frozen ? <div className="vcard-status"><span><Icon name="snowflake" size={16} />CARTE GELÉE</span></div> : null}
      {cancelled ? <div className="vcard-status"><span><Icon name="x" size={16} />CARTE ANNULÉE</span></div> : null}
    </Tag>
  );
}
