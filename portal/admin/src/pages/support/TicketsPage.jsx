import React, { useEffect, useRef, useState } from 'react';
import { Button, Card, PageHeader, Chips, Select, StatusBadge, Badge, Modal, Field, Textarea, Input, EmptyState, Skeleton, Callout } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { supportApi } from '../../services/api';
import { fmtDateTime, fmtAgo, fmtNumber } from '../../utils/format';
import { priorityOf, statusOf } from '../../utils/status';
import { errorMessage } from '../../utils/errors';
import { roleLabel } from '../../utils/roles';
import toast from '../../utils/toast';
import { MerchantLink } from '../merchants/MerchantsPage';

const STATUSES = [['open', 'Ouverts'], ['pending_admin', 'En cours'], ['pending_merchant', 'Attente marchand'], ['resolved', 'Résolus'], ['closed', 'Fermés']];
const LEVELS = { 2: 'N2 — Administrateur opérations', 3: 'N3 — Finance', 4: 'N4 — Super administrateur' };
const LEVEL_ROLES = { 2: ['ops_admin', 'super_admin'], 3: ['finance_admin', 'super_admin'], 4: ['super_admin'] };

function TicketDetail({ id, onChanged }) {
  const q = useQuery(() => supportApi.ticket(id).then((r) => r.data), [id]);
  const ticket = q.data?.ticket || (q.data && !q.data.ticket ? q.data : null);
  const messages = q.data?.messages || [];
  const [reply, setReply] = useState(''); const [internal, setInternal] = useState(false);
  const [form, setForm] = useState({ status: '', resolution: '', adminNotes: '' });
  const [busy, setBusy] = useState(null);
  const [escalate, setEscalate] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { if (ticket) setForm({ status: ticket.status, resolution: ticket.resolution || '', adminNotes: ticket.admin_notes || '' }); }, [ticket?.ticket_id, ticket?.status, ticket?.resolution, ticket?.admin_notes]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length]);

  const send = async () => {
    if (!reply.trim()) return;
    setBusy('reply');
    try { await supportApi.reply(id, { message: reply.trim(), isInternal: internal }); setReply(''); q.refresh(); toast.success(internal ? 'Note interne ajoutée' : 'Réponse envoyée'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const assign = async () => {
    setBusy('assign');
    try { await supportApi.assignMe(id); toast.success('Ticket pris en charge'); q.refresh(); onChanged(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const update = async () => {
    setBusy('status');
    try { await supportApi.setStatus(id, { status: form.status, resolution: form.resolution || undefined, adminNotes: form.adminNotes || undefined }); toast.success('Ticket mis à jour'); q.refresh(); onChanged(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };

  if (q.loading && !q.data) return <Card><Skeleton lines={8} /></Card>;
  if (!ticket) return <Card><EmptyState icon="alert" title="Ticket introuvable" description={q.error ? errorMessage(q.error) : 'Les tickets de porteurs de carte ne sont pas consultables en détail (jointure marchand).'} /></Card>;
  const pr = priorityOf(ticket.priority);
  const closed = ['resolved', 'closed'].includes(ticket.status);
  return (
    <Card flush>
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="row-wrap"><span className="mono small muted">{ticket.ticket_number}</span><StatusBadge status={ticket.status} /><Badge tone={pr.tone}>{pr.label}</Badge>{ticket.category && <Badge>{ticket.category}</Badge>}{ticket.escalation_level > 1 && <Badge tone="violet">{LEVELS[ticket.escalation_level] || `N${ticket.escalation_level}`}</Badge>}</div>
          <div className="card-title mt-2">{ticket.subject}</div>
          <div className="small muted"><MerchantLink id={ticket.merchant_id} name={ticket.business_name} /> · {ticket.merchant_email} · ouvert le {fmtDateTime(ticket.created_at)}{ticket.assigned_admin_id ? ' · pris en charge' : ''}</div>
        </div>
        <div className="row-wrap">
          {!ticket.assigned_admin_id && !closed && <Button size="sm" variant="primary" icon="user" loading={busy === 'assign'} onClick={assign}>Prendre en charge</Button>}
          {!closed && <Button size="sm" icon="arrowUp" onClick={() => setEscalate(true)}>Escalader</Button>}
        </div>
      </div>
      <div className="card-body" style={{ maxHeight: 380, overflowY: 'auto', background: 'var(--surface-2)' }}>
        {!messages.length ? <div className="muted small center">Aucun message.</div> : messages.map((m) => {
          const me = m.sender_type === 'admin';
          return (
            <div key={m.message_id} style={{ display: 'flex', flexDirection: 'column', alignItems: me ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
              <div className="bubble-meta">{me ? 'C-Pay' : 'Marchand'} · {m.sender_name} · {fmtDateTime(m.created_at)}{m.is_internal && <Badge tone="warn"> note interne</Badge>}</div>
              <div className={`bubble ${me ? 'bubble-me' : 'bubble-them'}`}>{m.message}</div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="card-body">
        <div className="stack">
          <Field label={internal ? 'Note interne (invisible pour le marchand)' : 'Répondre au marchand'}><Textarea value={reply} onChange={setReply} rows={3} placeholder={internal ? 'Note pour l’équipe…' : 'Votre réponse…'} disabled={closed} /></Field>
          <div className="between">
            <label className="check small"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Note interne</label>
            <Button variant="primary" icon="send" size="sm" loading={busy === 'reply'} disabled={!reply.trim() || closed} onClick={send}>{internal ? 'Ajouter la note' : 'Envoyer'}</Button>
          </div>
        </div>
        <div className="hr" />
        <div className="form-grid">
          <Field label="Statut"><Select value={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v }))} options={STATUSES.map(([value]) => ({ value, label: statusOf(value).label }))} /></Field>
          <Field label="Résolution (visible du marchand)"><Input value={form.resolution} onChange={(v) => setForm((f) => ({ ...f, resolution: v }))} placeholder="Résumé de la résolution" /></Field>
          <Field label="Notes internes" className="full"><Textarea rows={2} value={form.adminNotes} onChange={(v) => setForm((f) => ({ ...f, adminNotes: v }))} /></Field>
          <div className="full right"><Button variant="navy" size="sm" loading={busy === 'status'} onClick={update}>Appliquer</Button></div>
        </div>
      </div>
      {escalate && <EscalateModal ticket={ticket} onClose={() => setEscalate(false)} onDone={() => { setEscalate(false); q.refresh(); onChanged(); }} />}
    </Card>
  );
}

function EscalateModal({ ticket, onClose, onDone }) {
  const agents = useQuery(() => supportApi.agents().then((r) => r.data.data || []), []);
  const [form, setForm] = useState({ escalationLevel: '2', escalateTo: '', escalationNotes: '' });
  const [busy, setBusy] = useState(false);
  const options = (agents.data || []).filter((a) => LEVEL_ROLES[form.escalationLevel]?.includes(a.role));
  const run = async () => {
    setBusy(true);
    try { await supportApi.escalate(ticket.ticket_id, form); toast.success('Ticket escaladé'); onDone(); }
    catch (e) { toast.error(errorMessage(e)); setBusy(false); }
  };
  return (
    <Modal title="Escalader le ticket" sub={`${ticket.ticket_number} · ${ticket.subject}`} onClose={onClose} size="sm" footer={<><Button onClick={onClose}>Annuler</Button><Button variant="primary" loading={busy} disabled={!form.escalateTo} onClick={run}>Escalader</Button></>}>
      <div className="stack">
        <Field label="Niveau"><Select value={form.escalationLevel} onChange={(v) => setForm({ ...form, escalationLevel: v, escalateTo: '' })} options={Object.entries(LEVELS).map(([value, label]) => ({ value, label }))} /></Field>
        <Field label="Assigner à" required><Select value={form.escalateTo} onChange={(v) => setForm({ ...form, escalateTo: v })} placeholder="Choisir un destinataire" options={options.map((a) => ({ value: a.admin_id, label: `${a.first_name || ''} ${a.last_name || ''} (${roleLabel(a.role)})`.trim() }))} /></Field>
        <Field label="Note d’escalade"><Textarea rows={3} value={form.escalationNotes} onChange={(v) => setForm({ ...form, escalationNotes: v })} placeholder="Raison et informations collectées…" /></Field>
        <Callout tone="info">Le ticket passe « En cours » et un message système trace l’escalade dans l’historique.</Callout>
      </div>
    </Modal>
  );
}

export default function TicketsPage() {
  const { get, set, page, setPage } = useUrlState();
  const status = get('status'), priority = get('priority'), selected = get('id');
  const list = useQuery(() => supportApi.tickets({ status: status || undefined, priority: priority || undefined, page, limit: 30 }).then((r) => r.data), [status, priority, page], { interval: 60000 });
  const counts = useQuery(async () => {
    const r = await Promise.all(STATUSES.map(([s]) => supportApi.tickets({ status: s, limit: 1 }).then((x) => [s, x.data.total]).catch(() => [s, null])));
    return Object.fromEntries(r);
  }, [], { interval: 60000 });
  const tickets = list.data?.data || [];
  const total = list.data?.total || 0;

  return (
    <div className="page">
      <PageHeader title="Tickets de support" subtitle="Incidents déclarés par les marchands et porteurs. Prenez en charge, répondez, escaladez." badge={<Badge>{fmtNumber(total)}</Badge>} />
      <Chips value={status} onChange={(v) => set({ status: v, page: '' })} items={STATUSES.map(([value, label]) => ({ value, label, count: counts.data?.[value] ?? undefined }))} />
      <div className="master-detail">
        <div className="stack">
          <div className="between">
            <Select size="sm" value={priority} onChange={(v) => set({ priority: v, page: '' })} placeholder="Toutes priorités" options={[{ value: 'urgent', label: 'Urgente' }, { value: 'high', label: 'Haute' }, { value: 'normal', label: 'Normale' }, { value: 'low', label: 'Faible' }]} aria-label="Priorité" />
            <span className="xs muted">{fmtNumber(total)} ticket(s)</span>
          </div>
          <div className="master-list">
            {list.loading && !tickets.length ? <Skeleton lines={6} height={40} /> : !tickets.length ? <Card><EmptyState icon="lifebuoy" title="Aucun ticket" /></Card> : tickets.map((t) => {
              const pr = priorityOf(t.priority);
              return (
                <button type="button" key={t.ticket_id} className={`ticket-item ${selected === t.ticket_id ? 'selected' : ''}`} style={{ borderLeftColor: `var(--${pr.tone === 'neutral' ? 'border-strong' : pr.tone})` }} onClick={() => set({ id: t.ticket_id })}>
                  <div className="between"><span className="mono xs muted">{t.ticket_number}</span><Badge tone={pr.tone}>{pr.label}</Badge></div>
                  <div className="small strong mt-2 truncate">{t.subject}</div>
                  <div className="between mt-2"><span className="xs muted truncate">{t.business_name}{t.ticket_source === 'cardholder' ? ' · porteur' : ''} · {fmtAgo(t.updated_at || t.created_at)}</span><StatusBadge status={t.status} /></div>
                </button>
              );
            })}
          </div>
          {total > 30 && <div className="between"><Button size="sm" icon="chevronLeft" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Page précédente" /><span className="xs muted">Page {page}</span><Button size="sm" icon="chevronRight" disabled={page * 30 >= total} onClick={() => setPage(page + 1)} aria-label="Page suivante" /></div>}
        </div>
        {selected ? <TicketDetail id={selected} onChanged={() => { list.refresh(); counts.refresh(); }} /> : (
          <Card><EmptyState icon="lifebuoy" title="Sélectionnez un ticket" description="Le détail, l’historique des échanges et les actions apparaissent ici." /></Card>
        )}
      </div>
    </div>
  );
}
