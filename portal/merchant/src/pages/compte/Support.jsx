import React, { useState, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import { accountApi } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, PageHeader, Input, Select, Textarea, Table, Badge, StatusBadge, Modal, Drawer, ConfirmDialog, Notice, Skeleton, Icon } from '../../components';
import { fmtDateTime, fmtRelative } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { readFileAsDataUrl } from '../../utils/actions';

const PRIORITY = { high: ['Critique', 'error'], normal: ['Normale', 'info'], low: ['Faible', 'neutral'] };

// Support : tickets (création, fil de messages, pièces jointes, clôture).
export const Support = () => {
  const list = useAsync(() => accountApi.tickets(), []);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ subject: '', priority: 'normal', message: '' });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(null);
  const detail = useAsync(() => accountApi.ticket(selected.ticket_id), [selected?.ticket_id], { enabled: !!selected });
  const [reply, setReply] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [confirmResolve, setConfirmResolve] = useState(false);
  const endRef = useRef(null);
  const tickets = list.data?.data || [];
  const ticket = detail.data?.ticket || detail.data || selected;
  const messages = detail.data?.messages || [];
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);

  const create = async (e) => {
    e?.preventDefault();
    const er = {};
    if (form.subject.trim().length < 3) er.subject = 'Sujet requis.';
    if (form.message.trim().length < 10) er.message = 'Décrivez le problème (10 caractères minimum).';
    setErrors(er); if (Object.keys(er).length) return;
    setSaving(true);
    try { await accountApi.createTicket({ subject: form.subject.trim(), priority: form.priority, message: form.message.trim(), category: 'general' }); toast.success('Demande envoyée au support'); setCreating(false); setForm({ subject: '', priority: 'normal', message: '' }); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setSaving(false); }
  };
  const attach = async (e) => {
    const picked = Array.from(e.target.files || []); e.target.value = '';
    for (const f of picked) { try { const read = await readFileAsDataUrl(f); setFiles(x => [...x, read]); } catch (err) { toast.error(err.message); } }
  };
  const sendReply = async () => {
    if (!reply.trim() && !files.length) return;
    setSending(true);
    try { await accountApi.replyTicket(ticket.ticket_id, { message: reply.trim() || '[Pièce jointe]', attachments: files }); setReply(''); setFiles([]); detail.reload(); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setSending(false); }
  };
  const resolve = async () => {
    setResolving(true);
    try { await accountApi.resolveTicket(ticket.ticket_id); toast.success('Demande clôturée'); setConfirmResolve(false); setSelected(null); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setResolving(false); }
  };
  const parseAtt = (a) => { try { return typeof a === 'string' ? JSON.parse(a || '[]') : (a || []); } catch (e) { return []; } };
  const columns = [
    { key: 'subject', label: 'Demande', mobile: 'title', render: t => <><strong>{t.subject}</strong><div className="xs muted mono">{t.ticket_number}</div></> },
    { key: 'prio', label: 'Priorité', render: t => <Badge tone={(PRIORITY[t.priority] || PRIORITY.normal)[1]}>{(PRIORITY[t.priority] || [t.priority])[0]}</Badge> },
    { key: 'date', label: 'Ouverte', render: t => <span title={fmtDateTime(t.created_at)}>{fmtRelative(t.created_at)}</span> },
    { key: 'upd', label: 'Dernier message', render: t => t.last_message_at ? fmtRelative(t.last_message_at) : '—' },
    { key: 'status', label: 'Statut', mobile: 'right', render: t => <StatusBadge status={t.status} /> },
  ];
  const open = tickets.filter(t => !['resolved', 'closed'].includes(t.status)).length;
  const waiting = tickets.filter(t => t.status === 'pending_merchant').length;

  return (
    <div className="stack-lg">
      <PageHeader title="Support" subtitle="Une question, un incident sur une opération ? Ouvrez une demande : notre équipe vous répond dans ce fil."
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Nouvelle demande</Button>} />
      {waiting > 0 && <Notice tone="warn">{waiting} demande(s) attendent votre réponse.</Notice>}
      <Card flush title={list.state === 'ok' ? `${open} demande(s) en cours` : 'Mes demandes'}>
        <Table columns={columns} rows={tickets} rowKey={t => t.ticket_id} state={list.state} error={list.error} onRetry={list.reload} onRowClick={setSelected}
          empty={{ title: 'Aucune demande', message: 'Vous n’avez pas encore contacté le support.' }} emptyIcon="lifebuoy" />
      </Card>
      <Card title="Autres moyens de contact"><p className="small text-2">E-mail : <a href="mailto:support@c-pay.global">support@c-pay.global</a> · Pour une opération précise, indiquez sa référence (visible dans le journal).</p></Card>
      {creating && (
        <Modal title="Nouvelle demande" onClose={() => setCreating(false)} footer={<><Button onClick={() => setCreating(false)}>Annuler</Button><Button variant="primary" onClick={create} loading={saving}>Envoyer</Button></>}>
          <form onSubmit={create} noValidate>
            <Input label="Sujet" value={form.subject} onChange={v => { setForm(p => ({ ...p, subject: v })); setErrors(e => ({ ...e, subject: undefined })); }} placeholder="Encaissement non crédité" error={errors.subject} required autoFocus />
            <Select label="Priorité" value={form.priority} onChange={v => setForm(p => ({ ...p, priority: v }))} options={[{ value: 'low', label: 'Faible' }, { value: 'normal', label: 'Normale' }, { value: 'high', label: 'Critique (fonds bloqués, fraude)' }]} />
            <Textarea label="Description" rows={5} value={form.message} onChange={v => { setForm(p => ({ ...p, message: v })); setErrors(e => ({ ...e, message: undefined })); }} placeholder="Décrivez le problème, avec la référence de l’opération concernée." error={errors.message} required />
            <button type="submit" className="sr-only">Envoyer</button>
          </form>
        </Modal>
      )}
      {selected && (
        <Drawer title={ticket.subject} subtitle={`${ticket.ticket_number} · ouverte ${fmtRelative(ticket.created_at)}`} onClose={() => setSelected(null)}
          footer={!['resolved', 'closed'].includes(ticket.status) ? <><Button variant="success" icon="check" onClick={() => setConfirmResolve(true)}>Problème résolu</Button></> : null}>
          <div className="row mb-4" style={{ gap: 6 }}><StatusBadge status={ticket.status} /><Badge tone={(PRIORITY[ticket.priority] || PRIORITY.normal)[1]}>{(PRIORITY[ticket.priority] || [ticket.priority])[0]}</Badge></div>
          {ticket.resolution && <Notice tone="success" className="mb-4"><strong>Résolution proposée :</strong> {ticket.resolution}</Notice>}
          {detail.state === 'loading' ? <div className="stack"><Skeleton height={48} /><Skeleton height={48} width="70%" /></div> : (
            <div className="thread">
              {messages.length === 0 && <p className="small muted center">Votre demande est en attente de traitement par notre équipe.</p>}
              {messages.map(m => (
                <div key={m.message_id} className={`msg ${m.sender_type === 'merchant' ? 'msg-me' : 'msg-them'}`}>
                  <div className="msg-meta">{m.sender_type === 'merchant' ? 'Vous' : (m.sender_name || 'Support C-Pay')} · {fmtDateTime(m.created_at)}</div>
                  <div>{m.message}</div>
                  {parseAtt(m.attachments).length > 0 && <div className="row mt-2" style={{ flexWrap: 'wrap', gap: 6 }}>{parseAtt(m.attachments).map((a, i) => a.type?.startsWith('image') ? <img key={i} src={a.url} alt={a.name} style={{ maxWidth: 180, maxHeight: 140, borderRadius: 6 }} /> : <a key={i} href={a.url} download={a.name} className="badge badge-info"><Icon name="paperclip" size={12} />{a.name}</a>)}</div>}
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
          {!['resolved', 'closed'].includes(ticket.status) && (
            <div className="mt-4">
              <Textarea label="Votre réponse" rows={3} value={reply} onChange={setReply} placeholder="Votre message…" />
              {files.length > 0 && <div className="row mb-3" style={{ flexWrap: 'wrap', gap: 6 }}>{files.map((a, i) => <span key={i} className="badge"><Icon name="paperclip" size={12} />{a.name}<button type="button" className="link-btn" onClick={() => setFiles(x => x.filter((_, j) => j !== i))} aria-label={`Retirer ${a.name}`}><Icon name="close" size={12} /></button></span>)}</div>}
              <div className="row">
                <label className="btn btn-secondary btn-icon" aria-label="Joindre un fichier"><Icon name="paperclip" size={18} /><input type="file" multiple accept="image/*,.pdf,.doc,.docx" onChange={attach} className="sr-only" /></label>
                <Button variant="primary" icon="send" onClick={sendReply} loading={sending} disabled={!reply.trim() && !files.length} style={{ flex: 1 }}>Envoyer</Button>
              </div>
            </div>
          )}
        </Drawer>
      )}
      {confirmResolve && <ConfirmDialog title="Clôturer la demande" message="Confirmez-vous que votre problème est résolu ? La demande sera marquée comme résolue." confirmLabel="Clôturer" danger={false} busy={resolving} onConfirm={resolve} onClose={() => setConfirmResolve(false)} />}
    </div>
  );
};
export default Support;
