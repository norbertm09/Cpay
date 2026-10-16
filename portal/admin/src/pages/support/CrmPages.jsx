import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, Tabs, FiltersBar, SearchInput, Select, Chips, StatusBadge, Badge, Drawer, Field, Textarea, KeyValue, Skeleton, EmptyState, Callout } from '../../components/ui';
import { useQuery, useDebounce } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { configApi, crmApi, supportApi } from '../../services/api';
import { fmtDateTime, fmtNumber, fmtMoney, shortId, countryName } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';

// Contrat : backend/src/routes/crm-admin.routes.js (docs/ASSISTANT-API.md §3). Vague 3 : assignedTo null = désassigner.
const LIMIT = 25;
const LEAD_STATUSES = [['new', 'Nouveau'], ['contacted', 'Contacté'], ['qualified', 'Qualifié'], ['converted', 'Converti'], ['lost', 'Perdu']];
const CLAIM_STATUSES = [['open', 'Ouverte'], ['in_progress', 'En cours'], ['resolved', 'Résolue'], ['closed', 'Fermée']];
const CLAIM_CATEGORIES = [['payment', 'Paiement'], ['settlement', 'Règlement'], ['account', 'Compte'], ['fraud', 'Fraude'], ['other', 'Autre']];
const INTERESTS = { merchant: 'Marchand', partner: 'Partenaire', developer: 'Développeur', other: 'Autre' };
const CLAIM_MAP = { open: { label: 'Ouverte', tone: 'error' }, in_progress: { label: 'En cours', tone: 'warn' }, resolved: { label: 'Résolue', tone: 'success' }, closed: { label: 'Fermée', tone: 'neutral' } };

const useAdmins = () => {
  const q = useQuery(() => configApi.adminUsers().then((r) => r.data.data || []), []);
  const users = q.data || [];
  const label = (id) => { const u = users.find((x) => x.admin_id === id); return u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email : null; };
  return { users, label };
};
const AssigneeSelect = ({ value, onChange, users }) => (
  <Field label="Assigné à"><Select value={value || ''} onChange={(v) => onChange(v || null)} placeholder="Non assigné" options={users.map((u) => ({ value: u.admin_id, label: `${u.first_name || ''} ${u.last_name || ''} (${u.email})`.trim() }))} /></Field>
);

// ─── Leads ────────────────────────────────────────────────────────
export function LeadsPage() {
  const { get, set, page, setPage } = useUrlState();
  const status = get('status');
  const [search, setSearch] = useState(get('q')); const q = useDebounce(search);
  const [sel, setSel] = useState(null); const [notes, setNotes] = useState(''); const [busy, setBusy] = useState(false);
  const { users, label } = useAdmins();
  const list = useQuery(() => crmApi.leads({ page, limit: LIMIT, status: status || undefined, q: q || undefined }).then((r) => r.data), [page, status, q]);
  const open = (l) => { setSel(l); setNotes(l.notes || ''); };
  const patch = async (fields, msg) => {
    setBusy(true);
    try {
      const { data } = await crmApi.updateLead(sel.lead_id, fields);
      const upd = data?.lead_id ? data : { ...sel, ...fields }; setSel(upd); setNotes(upd.notes || '');
      list.setData((d) => d ? { ...d, data: d.data.map((x) => (x.lead_id === upd.lead_id ? upd : x)) } : d);
      toast.success(msg || 'Lead mis à jour');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const cols = [
    { key: 'created_at', label: 'Date', render: (l) => <span className="cell-date">{fmtDateTime(l.created_at)}</span>, sortValue: (l) => l.created_at },
    { key: 'name', label: 'Contact', render: (l) => <div><div className="cell-primary">{l.name || '—'}</div><div className="cell-sub">{l.email}{l.phone ? ` · ${l.phone}` : ''}</div></div> },
    { key: 'company', label: 'Société', render: (l) => <>{l.company || '—'}{l.country && <span className="muted small"> · {countryName(l.country)}</span>}</> },
    { key: 'interest', label: 'Intérêt', render: (l) => INTERESTS[l.interest] || l.interest || '—' },
    { key: 'source', label: 'Source', render: (l) => <span className="small muted">{l.source || '—'}</span> },
    { key: 'status', label: 'Statut', render: (l) => <StatusBadge status={l.status} /> },
    { key: 'assigned_to', label: 'Assigné', render: (l) => label(l.assigned_to) || (l.assigned_to ? shortId(l.assigned_to) : <span className="muted">—</span>) },
  ];
  return (
    <div className="page">
      <PageHeader title="Leads" subtitle="Demandes entrantes (site, assistant). Qualifiez, assignez et suivez la conversion." badge={<Badge>{fmtNumber(list.data?.total)}</Badge>} />
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <FiltersBar hasActive={!!(status || q)} onReset={() => { setSearch(''); set({ status: '', q: '', page: '' }); }}>
            <div className="grow"><SearchInput value={search} onChange={(v) => { setSearch(v); set({ q: v, page: '' }); }} placeholder="Nom, e-mail, société…" /></div>
            <Chips value={status} onChange={(v) => set({ status: v, page: '' })} items={LEAD_STATUSES.map(([value, lbl]) => ({ value, label: lbl }))} />
          </FiltersBar>
        </div>
        <DataTable columns={cols} rows={list.data?.data || []} keyField="lead_id" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} total={list.data?.total} onPage={setPage} onRowClick={open} empty="Aucun lead" emptyIcon="target" />
      </Card>
      {sel && (
        <Drawer title={sel.name || sel.email || 'Lead'} sub={`${sel.company || ''}${sel.country ? ` · ${countryName(sel.country)}` : ''} · créé le ${fmtDateTime(sel.created_at)}`} onClose={() => setSel(null)}
          footer={<>{LEAD_STATUSES.filter(([v]) => v !== 'new' && v !== sel.status).map(([v, l]) => <Button key={v} size="sm" variant={v === 'lost' ? 'danger-outline' : v === 'converted' ? 'success' : 'secondary'} disabled={busy} onClick={() => patch({ status: v }, `Lead marqué « ${l} »`)}>{l}</Button>)}</>}>
          <div className="stack-lg">
            <div className="row-wrap"><StatusBadge status={sel.status} />{sel.interest && <Badge tone="info">{INTERESTS[sel.interest] || sel.interest}</Badge>}{sel.source && <Badge>{sel.source}</Badge>}</div>
            <div className="form-grid">
              <Field label="Statut"><Select value={sel.status || 'new'} onChange={(v) => patch({ status: v })} options={LEAD_STATUSES.map(([value, lbl]) => ({ value, label: lbl }))} /></Field>
              <AssigneeSelect value={sel.assigned_to} users={users} onChange={(v) => patch({ assignedTo: v }, v ? 'Lead assigné' : 'Lead désassigné')} />
            </div>
            <KeyValue rows={[['E-mail', sel.email], ['Téléphone', sel.phone], ['Société', sel.company], ['Pays', countryName(sel.country)], ['Conversation', sel.conversation_id ? <Link to={`/support/conversations?id=${sel.conversation_id}`}>{shortId(sel.conversation_id)}</Link> : null], ['Consentement', fmtDateTime(sel.consent_at)], ['Mis à jour', fmtDateTime(sel.updated_at)]]} />
            {sel.message && <div><h3 className="mb-2">Message</h3><div className="bubble bubble-them" style={{ maxWidth: '100%' }}>{sel.message}</div></div>}
            <Field label="Notes internes" hint="Visibles par l’équipe uniquement."><Textarea rows={5} value={notes} onChange={setNotes} /></Field>
            <div className="right"><Button size="sm" variant="primary" disabled={busy || notes === (sel.notes || '')} onClick={() => patch({ notes }, 'Notes enregistrées')}>Enregistrer les notes</Button></div>
          </div>
        </Drawer>
      )}
    </div>
  );
}

// ─── Réclamations ─────────────────────────────────────────────────
function CrmClaimsTab() {
  const { get, set, page, setPage } = useUrlState();
  const status = get('status'), category = get('category');
  const [search, setSearch] = useState(get('q')); const q = useDebounce(search);
  const [sel, setSel] = useState(null); const [resolution, setResolution] = useState(''); const [busy, setBusy] = useState(false);
  const { users, label } = useAdmins();
  const list = useQuery(() => crmApi.claims({ page, limit: LIMIT, status: status || undefined, category: category || undefined, q: q || undefined }).then((r) => r.data), [page, status, category, q]);
  const open = (c) => { setSel(c); setResolution(c.resolution || ''); };
  const save = async (fields, msg) => {
    setBusy(true);
    try {
      const { data } = await crmApi.updateClaim(sel.claim_id, fields);
      const upd = data?.claim_id ? data : { ...sel, ...fields }; setSel(upd); setResolution(upd.resolution || '');
      list.setData((d) => d ? { ...d, data: d.data.map((x) => (x.claim_id === upd.claim_id ? upd : x)) } : d);
      toast.success(msg || 'Réclamation mise à jour');
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const catLabel = (c) => (CLAIM_CATEGORIES.find(([v]) => v === c) || [c, c || '—'])[1];
  const cols = [
    { key: 'reference', label: 'Référence', render: (c) => <span className="mono strong">{c.reference}</span> },
    { key: 'created_at', label: 'Date', render: (c) => <span className="cell-date">{fmtDateTime(c.created_at)}</span>, sortValue: (c) => c.created_at },
    { key: 'category', label: 'Catégorie', render: (c) => <Badge tone={c.category === 'fraud' ? 'error' : 'info'}>{catLabel(c.category)}</Badge> },
    { key: 'name', label: 'Plaignant', render: (c) => <div><div className="cell-primary">{c.name}</div><div className="cell-sub">{c.email || c.phone}</div></div> },
    { key: 'description', label: 'Description', render: (c) => <span className="small truncate" style={{ maxWidth: 320, display: 'inline-block' }}>{c.description}</span> },
    { key: 'status', label: 'Statut', render: (c) => <StatusBadge status={c.status} map={CLAIM_MAP} /> },
    { key: 'assigned_to', label: 'Assigné', render: (c) => label(c.assigned_to) || (c.assigned_to ? shortId(c.assigned_to) : <span className="muted">—</span>) },
  ];
  return (
    <>
      <Card flush>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <FiltersBar hasActive={!!(status || category || q)} onReset={() => { setSearch(''); set({ status: '', category: '', q: '', page: '' }); }}>
            <div className="grow"><SearchInput value={search} onChange={(v) => { setSearch(v); set({ q: v, page: '' }); }} placeholder="Référence REC-…, nom, e-mail, réf. transaction" /></div>
            <Select value={category} onChange={(v) => set({ category: v, page: '' })} placeholder="Toutes catégories" options={CLAIM_CATEGORIES.map(([value, lbl]) => ({ value, label: lbl }))} aria-label="Catégorie" />
            <Chips value={status} onChange={(v) => set({ status: v, page: '' })} items={CLAIM_STATUSES.map(([value, lbl]) => ({ value, label: lbl }))} />
          </FiltersBar>
        </div>
        <DataTable columns={cols} rows={list.data?.data || []} keyField="claim_id" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} total={list.data?.total} onPage={setPage} onRowClick={open} empty="Aucune réclamation" emptyIcon="flag" />
      </Card>
      {sel && (
        <Drawer title={`Réclamation ${sel.reference}`} sub={`${sel.name} · créée le ${fmtDateTime(sel.created_at)}${sel.resolved_at ? ` · résolue le ${fmtDateTime(sel.resolved_at)}` : ''}`} onClose={() => setSel(null)}
          footer={<><Button size="sm" disabled={busy || !resolution.trim()} onClick={() => save({ resolution }, 'Résolution enregistrée')}>Enregistrer la résolution</Button><Button size="sm" variant="success" icon="check" disabled={busy || !resolution.trim() || sel.status === 'resolved'} onClick={() => save({ resolution, status: 'resolved' }, 'Réclamation résolue')}>Résoudre</Button></>}>
          <div className="stack-lg">
            <div className="row-wrap"><StatusBadge status={sel.status} map={CLAIM_MAP} /><Badge tone={sel.category === 'fraud' ? 'error' : 'info'}>{catLabel(sel.category)}</Badge>{sel.source && <Badge>{sel.source}</Badge>}</div>
            <div className="form-grid">
              <Field label="Statut"><Select value={sel.status || 'open'} onChange={(v) => save({ status: v })} options={CLAIM_STATUSES.map(([value, lbl]) => ({ value, label: lbl }))} /></Field>
              <AssigneeSelect value={sel.assigned_to} users={users} onChange={(v) => save({ assignedTo: v }, v ? 'Réclamation assignée' : 'Réclamation désassignée')} />
            </div>
            <KeyValue rows={[['E-mail', sel.email], ['Téléphone', sel.phone], ['Réf. marchand', sel.merchant_ref], ['Réf. transaction', sel.transaction_ref ? <span className="mono">{sel.transaction_ref}</span> : null], ['Conversation', sel.conversation_id ? <Link to={`/support/conversations?id=${sel.conversation_id}`}>{shortId(sel.conversation_id)}</Link> : null]]} />
            <div><h3 className="mb-2">Description</h3><div className="bubble bubble-them" style={{ maxWidth: '100%' }}>{sel.description || '—'}</div></div>
            <Field label="Résolution" hint="Communiquée au plaignant."><Textarea rows={4} value={resolution} onChange={setResolution} placeholder="Décrivez la résolution apportée…" /></Field>
          </div>
        </Drawer>
      )}
    </>
  );
}

// Réclamations des porteurs de carte (GET /admin/claims, lecture seule) et incidents.
function CardholderClaimsTab() {
  const list = useQuery(() => supportApi.cardholderClaims().then((r) => r.data.data || []), []);
  const cols = [
    { key: 'claim_ref', label: 'Référence', render: (c) => <span className="mono strong">{c.claim_ref}</span> },
    { key: 'opened_at', label: 'Ouverte le', render: (c) => <span className="cell-date">{fmtDateTime(c.opened_at)}</span>, sortValue: (c) => c.opened_at },
    { key: 'holder', label: 'Porteur', render: (c) => <div><div className="cell-primary">{`${c.first_name || ''} ${c.last_name || ''}`.trim() || '—'}</div><div className="cell-sub">{c.email}</div></div> },
    { key: 'claim_type', label: 'Type', render: (c) => <Badge tone="info">{c.claim_type}</Badge> },
    { key: 'txn_amount', label: 'Montant', align: 'right', render: (c) => <span className="num">{c.txn_amount ? fmtMoney(c.txn_amount) : '—'}</span> },
    { key: 'description', label: 'Description', render: (c) => <span className="small">{c.description}</span> },
    { key: 'priority', label: 'Priorité', render: (c) => c.priority || '—' },
    { key: 'status', label: 'Statut', render: (c) => <StatusBadge status={c.status} /> },
  ];
  return (
    <div className="stack">
      <Callout tone="info">Réclamations déposées depuis l’application porteur. Aucune action de traitement n’est exposée par l’API pour ces réclamations : utilisez un ticket de support pour le suivi.</Callout>
      <Card flush title="Réclamations porteurs" sub="50 dernières">
        <DataTable columns={cols} rows={list.data || []} keyField="claim_id" loading={list.loading} error={list.error} onRetry={list.reload} dense empty="Aucune réclamation porteur" emptyIcon="idcard" />
      </Card>
    </div>
  );
}

export function ClaimsPage() {
  const { get, set } = useUrlState({ tab: 'crm' });
  const tab = get('tab');
  return (
    <div className="page">
      <PageHeader title="Réclamations" subtitle="Réclamations publiques (site, assistant) à traiter par l’équipe, et réclamations des porteurs de carte." />
      <Tabs value={tab} onChange={(v) => set({ tab: v, page: '', status: '' })} items={[{ value: 'crm', label: 'Réclamations CRM', icon: 'flag' }, { value: 'porteurs', label: 'Réclamations porteurs', icon: 'idcard' }]} />
      {tab === 'crm' ? <CrmClaimsTab /> : <CardholderClaimsTab />}
    </div>
  );
}

// ─── Conversations de l'assistant ─────────────────────────────────
export function ConversationsPage() {
  const { get, set, page, setPage } = useUrlState();
  const selectedId = get('id');
  const list = useQuery(() => crmApi.conversations({ page, limit: LIMIT }).then((r) => r.data), [page]);
  const conv = useQuery(() => crmApi.conversation(selectedId).then((r) => r.data), [selectedId], { enabled: !!selectedId });
  const text = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => b?.text || '').join('\n') : JSON.stringify(m.content || ''));
  const cols = [
    { key: 'last_message_at', label: 'Dernier message', render: (c) => <span className="cell-date">{fmtDateTime(c.last_message_at || c.created_at)}</span>, sortValue: (c) => c.last_message_at || c.created_at },
    { key: 'page', label: 'Page', render: (c) => <span className="small">{c.page || '—'}</span> },
    { key: 'locale', label: 'Langue', render: (c) => <Badge>{(c.locale || 'fr').toUpperCase()}</Badge> },
    { key: 'message_count', label: 'Messages', align: 'right', render: (c) => fmtNumber(c.message_count) },
    { key: 'handoff_requested', label: 'Transfert humain', render: (c) => (c.handoff_requested ? <Badge tone="warn">Oui{c.handoff_team ? ` · ${c.handoff_team}` : ''}</Badge> : <span className="muted">—</span>) },
    { key: 'links', label: 'Lead / réclamation', render: (c) => <>{c.lead_id && <Badge tone="info">Lead</Badge>} {c.claim_id && <Badge tone="error">Réclamation</Badge>}{!c.lead_id && !c.claim_id && <span className="muted">—</span>}</> },
  ];
  const c = conv.data;
  return (
    <div className="page">
      <PageHeader title="Conversations de l’assistant" subtitle="Transcriptions en lecture seule de l’assistant du site public." />
      <Card flush>
        <DataTable columns={cols} rows={list.data?.data || []} keyField="conversation_id" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} onPage={setPage} onRowClick={(r) => set({ id: r.conversation_id })} selectedKey={selectedId} empty="Aucune conversation" emptyIcon="chat" />
      </Card>
      {selectedId && (
        <Drawer title={`Conversation ${shortId(selectedId)}`} sub={c ? `${c.locale || 'fr'} · page ${c.page || '—'} · ${fmtDateTime(c.created_at)}${c.handoff_requested ? ` · transfert humain demandé${c.handoff_team ? ` (${c.handoff_team})` : ''}` : ''}` : null} onClose={() => set({ id: '' })} size="lg">
          {conv.loading && !c ? <Skeleton lines={6} /> : !c ? <EmptyState icon="chat" title="Conversation introuvable" /> : !(c.messages || []).length ? <EmptyState icon="chat" title="Transcription vide" /> : (
            <div>
              {c.messages.map((m) => { const user = (m.role || '').toLowerCase() === 'user'; return (
                <div key={m.message_id} style={{ display: 'flex', flexDirection: 'column', alignItems: user ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
                  <div className="bubble-meta">{user ? 'Visiteur' : m.role || 'assistant'} · {fmtDateTime(m.created_at)}</div>
                  <div className={`bubble ${user ? 'bubble-me' : 'bubble-them'}`}>{text(m)}{Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && <div className="xs muted mt-2">Outils : {m.tool_calls.map((tc) => tc.name || tc.function?.name || 'outil').join(', ')}</div>}</div>
                </div>
              ); })}
            </div>
          )}
        </Drawer>
      )}
    </div>
  );
}
