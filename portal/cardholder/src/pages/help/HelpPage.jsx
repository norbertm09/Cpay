import React, { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAsync } from '../../hooks/useAsync';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Card, Button, Badge, Drawer, Modal, Input, Select, Textarea, Alert, PageHeader, Tabs, SkeletonList, ErrorState, EmptyState, Icon } from '../../components';
import { claims as claimsApi, tickets as ticketsApi } from '../../services/support';
import { formatDateTime, formatMoney } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { SUPPORT_EMAIL } from '../../utils/features';

const TABS = [
  { key: 'aide', label: 'Aide', to: '/aide', end: true },
  { key: 'reclamations', label: 'Réclamations', to: '/aide/reclamations' },
  { key: 'tickets', label: 'Mes demandes', to: '/aide/tickets' },
];

const CLAIM_TYPES = [
  { value: 'unrecognized_transaction', label: 'Opération non reconnue' },
  { value: 'double_debit', label: 'Double débit' },
  { value: 'failed_payment', label: 'Paiement échoué mais débité' },
  { value: 'refund_request', label: 'Demande de remboursement' },
  { value: 'card_issue', label: 'Problème de carte (blocage, PIN)' },
  { value: 'other', label: 'Autre' },
];
const claimTypeLabel = (v) => CLAIM_TYPES.find((c) => c.value === v)?.label || v;
const STATUS = {
  open: { label: 'Ouverte', tone: 'badge-info' }, in_progress: { label: 'En cours', tone: 'badge-warn' }, pending_admin: { label: 'En attente de réponse', tone: 'badge-warn' },
  pending_customer: { label: 'Réponse attendue', tone: 'badge-accent' }, resolved: { label: 'Résolue', tone: 'badge-success' }, closed: { label: 'Fermée', tone: '' }, rejected: { label: 'Rejetée', tone: 'badge-error' },
};
const statusOf = (s) => STATUS[s] || { label: s || '—', tone: '' };

const FAQ = [
  ['Comment payer un commerçant ?', 'Depuis « Payer », scannez le QR code du commerçant ou saisissez son code, indiquez le montant puis confirmez avec votre code PIN. Des frais de 0,5 % s’appliquent.'],
  ['Comment recharger ma carte ?', 'Le rechargement par Mobile Money est en cours d’intégration avec les opérateurs. Vous serez informé dès son ouverture.'],
  ['J’ai oublié mon code PIN', 'Rendez-vous dans « Mes cartes », ouvrez votre carte puis « Code PIN ». Si vous ne connaissez plus le PIN actuel, déposez une réclamation « Problème de carte ».'],
  ['Comment geler ma carte ?', 'Dans « Mes cartes », ouvrez votre carte principale et choisissez « Geler la carte ». Tous les paiements sont alors refusés ; vous pouvez la réactiver à tout moment.'],
  ['Une opération m’est inconnue', 'Ouvrez l’opération depuis « Opérations » puis « Signaler un problème » : une réclamation pré-remplie est créée et traitée par notre équipe.'],
  ['Comment sécuriser mon compte ?', 'Activez la double authentification dans « Profil » > « Sécurité » et choisissez un mot de passe unique.'],
];

const Overview = () => (
  <div className="help-grid">
    <Card title="Questions fréquentes">
      <div className="faq">
        {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><div className="faq-a">{a}</div></details>)}
      </div>
    </Card>
    <div className="stack">
      <Card>
        <div className="contact-card">
          <span className="cc-icon"><Icon name="life-buoy" size={20} /></span>
          <div className="grow">
            <h3>Déposer une réclamation</h3>
            <p className="small text-2" style={{ margin: '4px 0 10px' }}>Opération contestée, double débit, carte bloquée : nous traitons votre dossier sous 48 h ouvrées.</p>
            <Button variant="primary" size="sm" to="/aide/reclamations">Nouvelle réclamation</Button>
          </div>
        </div>
      </Card>
      <Card>
        <div className="contact-card">
          <span className="cc-icon"><Icon name="mail" size={20} /></span>
          <div className="grow">
            <h3>Contacter le support</h3>
            <p className="small text-2" style={{ margin: '4px 0 10px' }}>Par e-mail à <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, ou en ouvrant une demande suivie depuis « Mes demandes ».</p>
            <div className="row wrap">
              <Button variant="outline" size="sm" href={`mailto:${SUPPORT_EMAIL}`} icon="mail">Écrire au support</Button>
              <Button variant="ghost" size="sm" to="/aide/tickets">Mes demandes</Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  </div>
);

const ClaimsTab = () => {
  const [params, setParams] = useSearchParams();
  const list = useAsync(claimsApi.list, []);
  const [open, setOpen] = useState(!!params.get('txn'));
  const [f, setF] = useState({ claimType: params.get('txn') ? 'unrecognized_transaction' : '', description: '', txnId: params.get('txn') || '', txnAmount: params.get('amount') || '', txnDate: params.get('date') ? params.get('date').slice(0, 10) : '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setErrors({ ...errors, [k]: undefined }); };

  const submit = async () => {
    const er = {};
    if (!f.claimType) er.claimType = 'Choisissez un motif';
    if (f.description.trim().length < 20) er.description = 'Décrivez le problème en au moins 20 caractères';
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true); setFormError('');
    try {
      const r = await claimsApi.create({ claimType: f.claimType, description: f.description.trim(), txnId: f.txnId || undefined, txnAmount: f.txnAmount ? Number(f.txnAmount) : undefined, txnDate: f.txnDate || undefined });
      toast.success(`Réclamation ${r.claim_ref || ''} enregistrée`.trim());
      setOpen(false); setF({ claimType: '', description: '', txnId: '', txnAmount: '', txnDate: '' });
      if (params.get('txn')) setParams({}, { replace: true });
      list.reload();
    } catch (err) { setFormError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row-between wrap">
        <p className="small text-2">Chaque réclamation reçoit une référence et est suivie par notre équipe conformité.</p>
        <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Nouvelle réclamation</Button>
      </div>
      <Card flush>
        {list.loading ? <SkeletonList rows={3} />
          : list.error ? <ErrorState error={list.error} onRetry={list.reload} />
            : !list.data?.length ? <EmptyState icon="life-buoy" title="Aucune réclamation">Vous n’avez déposé aucune réclamation pour le moment.</EmptyState>
              : list.data.map((c) => {
                const s = statusOf(c.status);
                return (
                  <div className="list-item" key={c.claim_id}>
                    <span className="li-icon icon-neutral"><Icon name="file-text" size={18} /></span>
                    <span className="li-main">
                      <span className="li-title">{claimTypeLabel(c.claim_type)} <span className="mono xs muted">{c.claim_ref}</span></span>
                      <span className="li-sub truncate" style={{ display: 'block' }}>{c.description}</span>
                      <span className="li-sub">Ouverte le {formatDateTime(c.opened_at)}{c.txn_amount ? ` · ${formatMoney(c.txn_amount)}` : ''}</span>
                    </span>
                    <span className="li-end"><Badge tone={s.tone}>{s.label}</Badge></span>
                  </div>
                );
              })}
      </Card>
      <Modal open={open} title="Nouvelle réclamation" onClose={busy ? undefined : () => setOpen(false)}
        footer={<><Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Annuler</Button><Button variant="primary" onClick={submit} loading={busy}>Envoyer</Button></>}>
        <div className="stack">
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <Select label="Motif" required value={f.claimType} onChange={set('claimType')} options={CLAIM_TYPES} placeholder="Choisir un motif" error={errors.claimType} />
          <Textarea label="Description" required value={f.description} onChange={set('description')} error={errors.description} placeholder="Décrivez ce qui s’est passé, avec la date et le montant si possible." maxLength={2000} />
          <div className="grid-2">
            <Input label="Montant concerné" inputMode="decimal" value={f.txnAmount} onChange={set('txnAmount')} suffix="XAF" />
            <Input label="Date de l’opération" type="date" value={f.txnDate} onChange={set('txnDate')} />
          </div>
          <Input label="Référence de l’opération" value={f.txnId} onChange={set('txnId')} hint="Visible dans le détail d’une opération." className="mono" />
        </div>
      </Modal>
    </div>
  );
};

const CATEGORIES = [
  { value: 'general', label: 'Question générale' }, { value: 'card', label: 'Carte' }, { value: 'payment', label: 'Paiement' },
  { value: 'account', label: 'Compte et sécurité' }, { value: 'technical', label: 'Problème technique' },
];

const TicketsTab = () => {
  const list = useAsync(ticketsApi.list, []);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [thread, setThread] = useState(null);
  const [threadError, setThreadError] = useState(null);
  const [reply, setReply] = useState('');
  const [f, setF] = useState({ subject: '', message: '', category: 'general' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const loadThread = async (t) => {
    setSelected(t); setThread(null); setThreadError(null);
    try { setThread(await ticketsApi.get(t.ticket_id)); } catch (err) { setThreadError(err); }
  };
  useEffect(() => { if (thread) { const el = document.getElementById('thread-end'); el?.scrollIntoView?.({ block: 'end' }); } }, [thread]);

  const create = async () => {
    const er = {};
    if (f.subject.trim().length < 4) er.subject = 'Indiquez un objet';
    if (f.message.trim().length < 10) er.message = 'Décrivez votre demande (10 caractères minimum)';
    setErrors(er);
    if (Object.keys(er).length) return;
    setBusy(true); setFormError('');
    try { await ticketsApi.create({ subject: f.subject.trim(), message: f.message.trim(), category: f.category, priority: 'normal' }); toast.success('Demande envoyée'); setOpen(false); setF({ subject: '', message: '', category: 'general' }); list.reload(); }
    catch (err) { setFormError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (reply.trim().length < 2) return;
    setBusy(true);
    try { await ticketsApi.reply(selected.ticket_id, reply.trim()); setReply(''); setThread(await ticketsApi.get(selected.ticket_id)); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row-between wrap">
        <p className="small text-2">Posez une question à notre support et suivez la conversation ici.</p>
        <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Nouvelle demande</Button>
      </div>
      <Card flush>
        {list.loading ? <SkeletonList rows={3} />
          : list.error ? <ErrorState error={list.error} onRetry={list.reload} />
            : !list.data?.length ? <EmptyState icon="message-circle" title="Aucune demande">Vous n’avez pas encore contacté le support depuis votre espace.</EmptyState>
              : list.data.map((t) => {
                const s = statusOf(t.status);
                return (
                  <button type="button" className="list-item" key={t.ticket_id} onClick={() => loadThread(t)}>
                    <span className="li-icon icon-pay"><Icon name="message-circle" size={18} /></span>
                    <span className="li-main">
                      <span className="li-title">{t.subject} <span className="mono xs muted">{t.ticket_number}</span></span>
                      <span className="li-sub truncate" style={{ display: 'block' }}>{t.last_message || t.description}</span>
                      <span className="li-sub">{formatDateTime(t.updated_at || t.created_at)}</span>
                    </span>
                    <span className="li-end"><Badge tone={s.tone}>{s.label}</Badge><Icon name="chevron-right" size={16} className="muted" /></span>
                  </button>
                );
              })}
      </Card>

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected?.subject || 'Demande'}
        footer={selected && !['closed', 'resolved'].includes(selected.status) ? (
          <form className="row grow" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input className="input grow" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Votre réponse…" aria-label="Votre réponse" maxLength={2000} />
            <Button type="submit" variant="primary" icon="send" loading={busy} aria-label="Envoyer" />
          </form>
        ) : null}>
        {selected ? (
          <div className="stack">
            <div className="row wrap small muted"><span className="mono">{selected.ticket_number}</span><Badge tone={statusOf(selected.status).tone}>{statusOf(selected.status).label}</Badge><span>{formatDateTime(selected.created_at)}</span></div>
            {threadError ? <ErrorState error={threadError} onRetry={() => loadThread(selected)} title="Conversation indisponible" />
              : !thread ? <SkeletonList rows={3} />
                : (
                  <div className="thread">
                    {(thread.messages || []).map((m) => {
                      const mine = m.sender_type !== 'admin' && m.sender_type !== 'support';
                      return (
                        <div className={`msg ${mine ? 'me' : 'them'}`} key={m.message_id}>
                          <div>{m.message}</div>
                          <div className="msg-meta">{mine ? 'Vous' : m.sender_name || 'Support C-Pay'} · {formatDateTime(m.created_at)}</div>
                        </div>
                      );
                    })}
                    <div id="thread-end" />
                  </div>
                )}
          </div>
        ) : null}
      </Drawer>

      <Modal open={open} title="Nouvelle demande au support" onClose={busy ? undefined : () => setOpen(false)}
        footer={<><Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Annuler</Button><Button variant="primary" onClick={create} loading={busy}>Envoyer</Button></>}>
        <div className="stack">
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <Select label="Catégorie" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={CATEGORIES} />
          <Input label="Objet" required value={f.subject} onChange={(e) => { setF({ ...f, subject: e.target.value }); setErrors({}); }} error={errors.subject} maxLength={120} />
          <Textarea label="Message" required value={f.message} onChange={(e) => { setF({ ...f, message: e.target.value }); setErrors({}); }} error={errors.message} maxLength={2000} />
        </div>
      </Modal>
    </div>
  );
};

export default function HelpPage() {
  useDocumentTitle('Aide');
  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader title="Aide et réclamations" subtitle="Réponses rapides, réclamations suivies et contact du support." />
      <Tabs items={TABS} ariaLabel="Rubriques d’aide" />
      <Routes>
        <Route index element={<Overview />} />
        <Route path="reclamations" element={<ClaimsTab />} />
        <Route path="tickets" element={<TicketsTab />} />
        <Route path="*" element={<Navigate to="/aide" replace />} />
      </Routes>
    </div>
  );
}
