import React from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';
import { Button, Popover } from '../components/ui';
import { useQuery } from '../hooks/useQuery';
import { monitorApi } from '../services/api';
import { fmtAgo } from '../utils/format';

const ICON = { kyb_document_submitted: 'file', kyc_document_submitted: 'idcard', kyc_document_approved: 'check', kyc_document_rejected: 'x', bank_created: 'bank' };
// Cible de navigation selon le type/entité de la notification
const target = (n) => {
  if (n.entity_type === 'merchant' && n.entity_id) return `/marchands/${n.entity_id}?tab=kyb`;
  if (n.entity_type === 'cardholder') return '/porteurs';
  if (n.type === 'bank_created') return '/partenaires/banques';
  return null;
};

export default function NotificationBell() {
  const navigate = useNavigate();
  const { data, refresh } = useQuery(() => monitorApi.notifications().then((r) => r.data), [], { interval: 30000 });
  const list = data?.data || [];
  const unread = data?.unread || 0;

  const open = async (n) => {
    if (!n.is_read) { await monitorApi.markRead(n.notification_id).catch(() => {}); refresh(); }
    const to = target(n);
    if (to) navigate(to);
  };
  const readAll = async () => { await monitorApi.markAllRead().catch(() => {}); refresh(); };

  return (
    <Popover button={({ toggle, open: isOpen }) => (
      <div style={{ position: 'relative' }}>
        <Button variant="ghost" icon="bell" onClick={toggle} aria-label={`Notifications${unread ? ` (${unread} non lues)` : ''}`} aria-expanded={isOpen} />
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </div>
    )}>
      <div className="notif-pop" onClick={(e) => e.stopPropagation()}>
        <div className="notif-head"><span>Notifications{unread > 0 && <span className="muted"> · {unread} non lue(s)</span>}</span>{unread > 0 && <button type="button" className="link-btn xs" onClick={readAll}>Tout marquer lu</button>}</div>
        <div className="notif-list">
          {list.length === 0 && <div className="empty" style={{ padding: 20 }}><div className="empty-desc">Aucune notification</div></div>}
          {list.map((n) => (
            <div key={n.notification_id} className={`notif-item ${n.is_read ? '' : 'unread'}`} onClick={() => open(n)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') open(n); }}>
              <span className="stat-icon" style={{ width: 30, height: 30 }}><Icon name={ICON[n.type] || 'bell'} size={15} /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="small" style={{ fontWeight: n.is_read ? 500 : 700 }}>{n.title}</div>
                <div className="xs muted truncate">{n.message}</div>
                <div className="xs muted">{fmtAgo(n.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Popover>
  );
}
