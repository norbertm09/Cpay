import React, { useState } from 'react';
import DataTable from '../../components/DataTable';
import { Button, Card, PageHeader, Tabs, Stat, FiltersBar, SearchInput, Select, Chips, StatusBadge, Badge, Modal, Field, Input, Switch, EmptyState, Skeleton, Callout } from '../../components/ui';
import { useQuery, useDebounce } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { cashApi } from '../../services/api';
import { fmtMoney, fmtNumber, fmtDateTime, fmtAgo } from '../../utils/format';
import { directionOf } from '../../utils/status';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';
import CashTransferDrawer from './CashTransferDrawer';
import MerchantBankAccountsTab from './MerchantBankAccountsTab';
import { MerchantLink } from '../merchants/MerchantsPage';

const LIMIT = 25;
const STATUSES = [['awaiting_funds', 'Fonds attendus'], ['pending_manual', 'À exécuter'], ['pending', 'En attente'], ['processing', 'En cours'], ['completed', 'Terminé'], ['failed', 'Échoué'], ['cancelled', 'Annulé'], ['rejected', 'Rejeté']];
const DIRECTIONS = [['wallet_to_bank', 'Wallet → banque'], ['bank_to_wallet', 'Banque → wallet'], ['withdraw', 'Retrait wallet']];

const dest = (t) => (t.bankAccount ? `${t.bankAccount.bankName || ''} ${t.bankAccount.accountMasked || ''}`.trim() : t.wallet ? `${t.wallet.operator || ''} ${t.wallet.phone || ''}`.trim() : t.direction === 'bank_to_wallet' ? 'Compte de collecte C-Pay' : '—');

// ─── Onglet files d'attente ───────────────────────────────────────
function QueuesTab({ stats, onOpen, tick }) {
  const { get, set } = useUrlState({ queue: 'pending_manual' });
  const queue = get('queue');
  const list = useQuery(() => cashApi.transfers({ status: queue, limit: 50, offset: 0 }).then((r) => r.data), [queue, tick]);
  const q = stats?.queues || {};
  return (
    <div className="stack-lg">
      <div className="grid grid-3">
        <Stat label="Virements wallet → banque à exécuter" value={fmtNumber(q.pendingManual?.count)} sub={fmtMoney(q.pendingManual?.amount)} icon="banknote" tone={q.pendingManual?.count ? 'warn' : ''} small />
        <Stat label="Approvisionnements en attente de fonds" value={fmtNumber(q.awaitingFunds?.count)} sub={fmtMoney(q.awaitingFunds?.amount)} icon="wallet" tone={q.awaitingFunds?.count ? 'warn' : ''} small />
        <Stat label="En cours sur rail bancaire / opérateur" value={fmtNumber(q.processing?.count)} sub="suivi automatique" icon="clock" tone="cyan" small />
      </div>
      <Card flush title={queue === 'pending_manual' ? 'Virements à exécuter' : 'Ordres d’approvisionnement à confirmer'}
        sub={queue === 'pending_manual' ? 'Le marchand a demandé un virement vers sa banque : émettez-le depuis la banque de C-Pay puis marquez-le exécuté avec la référence.' : 'Le marchand annonce un virement vers le compte de collecte C-Pay : confirmez la réception (montant + référence) pour créditer son solde.'}
        actions={<Chips value={queue} onChange={(v) => set({ queue: v || 'pending_manual' })} items={[{ value: 'pending_manual', label: 'À exécuter', count: q.pendingManual?.count }, { value: 'awaiting_funds', label: 'Fonds attendus', count: q.awaitingFunds?.count }, { value: 'processing', label: 'En cours', count: q.processing?.count }]} />}>
        {list.loading && !list.data ? <div className="card-body"><Skeleton lines={4} /></div> : !(list.data?.data || []).length ? <EmptyState icon="check" title="File vide" description="Aucune opération n’attend d’action pour cette file." /> : (
          <div style={{ padding: '0 16px' }}>
            {list.data.data.map((t) => { const d = directionOf(t); return (
              <div key={t.transferId} className="queue-item">
                <div className="row" style={{ gap: 14, minWidth: 0 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row-wrap"><span className="mono strong">{t.reference}</span><Badge tone={d.tone}>{d.label}</Badge><StatusBadge status={t.status} /></div>
                    <div className="small mt-2"><MerchantLink id={t.merchantId} name={t.merchant} /> <span className="muted">· {dest(t)}</span></div>
                    <div className="xs muted">créé {fmtAgo(t.createdAt)} · {fmtDateTime(t.createdAt)}{t.expiresAt ? ` · expire le ${fmtDateTime(t.expiresAt)}` : ''}</div>
                  </div>
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <div className="right"><div className="amount">{fmtMoney(t.amount, t.currency)}</div>{t.fee ? <div className="xs muted">net {fmtMoney(t.net, t.currency)}</div> : null}</div>
                  <Button variant="primary" size="sm" onClick={() => onOpen(t)}>Traiter</Button>
                </div>
              </div>
            ); })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Onglet transferts ────────────────────────────────────────────
function TransfersTab({ onOpen, tick }) {
  const { get, set, page, setPage } = useUrlState();
  const status = get('status'), direction = get('direction'), merchantId = get('merchantId');
  const [search, setSearch] = useState(get('q'));
  const q = useDebounce(search);
  const list = useQuery(() => cashApi.transfers({ status: status || undefined, direction: direction || undefined, merchantId: merchantId || undefined, q: q || undefined, limit: LIMIT, offset: (page - 1) * LIMIT }).then((r) => r.data), [status, direction, merchantId, q, page, tick]);
  const cols = [
    { key: 'createdAt', label: 'Date', render: (t) => <span className="cell-date">{fmtDateTime(t.createdAt)}</span>, sortValue: (t) => t.createdAt },
    { key: 'reference', label: 'Référence', render: (t) => <span className="mono strong">{t.reference}</span> },
    { key: 'direction', label: 'Nature', render: (t) => { const d = directionOf(t); return <Badge tone={d.tone}>{d.label}</Badge>; } },
    { key: 'merchant', label: 'Marchand', render: (t) => <MerchantLink id={t.merchantId} name={t.merchant} /> },
    { key: 'amount', label: 'Montant', align: 'right', render: (t) => <span className="amount">{fmtMoney(t.amount, t.currency)}</span>, sortValue: (t) => Number(t.amount) },
    { key: 'fee', label: 'Frais', align: 'right', hidden: true, render: (t) => <span className="num">{fmtMoney(t.fee, t.currency)}</span> },
    { key: 'net', label: 'Net', align: 'right', render: (t) => <span className="num">{fmtMoney(t.net, t.currency)}</span> },
    { key: 'dest', label: 'Destination', render: (t) => <span className="small">{dest(t)}</span> },
    { key: 'bankReference', label: 'Réf. bancaire', hidden: true, render: (t) => <span className="mono small">{t.bankReference || '—'}</span> },
    { key: 'status', label: 'Statut', render: (t) => <StatusBadge status={t.status} /> },
  ];
  const hasActive = !!(status || direction || merchantId || q);
  return (
    <Card flush>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <FiltersBar hasActive={hasActive} onReset={() => { setSearch(''); set({ status: '', direction: '', merchantId: '', q: '', page: '' }); }}>
          <div className="grow"><SearchInput value={search} onChange={(v) => { setSearch(v); set({ q: v, page: '' }); }} placeholder="Référence TRF-, FND-, PAY-, marchand, référence bancaire…" /></div>
          <Select value={status} onChange={(v) => set({ status: v, page: '' })} placeholder="Tous statuts" options={STATUSES.map(([value, label]) => ({ value, label }))} aria-label="Statut" />
          <Select value={direction} onChange={(v) => set({ direction: v, page: '' })} placeholder="Toutes natures" options={DIRECTIONS.map(([value, label]) => ({ value, label }))} aria-label="Nature" />
          {merchantId && <Button size="sm" icon="x" onClick={() => set({ merchantId: '', page: '' })}>Marchand : {merchantId.slice(0, 8)}…</Button>}
        </FiltersBar>
      </div>
      <DataTable columns={cols} rows={list.data?.data || []} keyField="transferId" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={LIMIT} total={list.data?.total} onPage={setPage} onRowClick={onOpen} columnTools storageKey="cash" empty="Aucun transfert" emptyIcon="banknote" />
    </Card>
  );
}

// ─── Onglet comptes de collecte ───────────────────────────────────
const EMPTY_PA = { currency: 'XAF', bankName: '', accountName: '', accountNumber: '', iban: '', swift: '', notes: '', active: true };
function AccountsTab() {
  const { isSuperAdmin } = useAuth();
  const list = useQuery(() => cashApi.platformAccounts().then((r) => r.data.data || []), []);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const f = edit.form;
    if (!/^[A-Z]{3}$/.test(f.currency)) return toast.error('Devise sur 3 lettres (XAF, XOF, CDF…)');
    if (!f.bankName.trim() || !f.accountName.trim() || !f.accountNumber.trim()) return toast.error('Banque, intitulé et numéro de compte sont requis');
    setBusy(true);
    try {
      const body = { ...f, iban: f.iban || null, swift: f.swift || null, notes: f.notes || null };
      if (edit.id) await cashApi.updatePlatformAccount(edit.id, body); else await cashApi.createPlatformAccount(body);
      toast.success(edit.id ? 'Compte mis à jour' : 'Compte créé'); setEdit(null); list.refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
    return undefined;
  };
  const toggle = async (a) => {
    try { await cashApi.updatePlatformAccount(a.accountId, { active: !a.active }); toast.success(a.active ? 'Compte désactivé' : 'Compte activé'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const setF = (k, v) => setEdit((e) => ({ ...e, form: { ...e.form, [k]: v } }));
  const cols = [
    { key: 'currency', label: 'Devise', render: (a) => <b>{a.currency}</b> },
    { key: 'bankName', label: 'Banque' }, { key: 'accountName', label: 'Intitulé' },
    { key: 'accountNumber', label: 'Numéro de compte', render: (a) => <span className="mono">{a.accountNumber}</span> },
    { key: 'iban', label: 'IBAN', render: (a) => <span className="mono small">{a.iban || '—'}</span> }, { key: 'swift', label: 'SWIFT', render: (a) => <span className="mono small">{a.swift || '—'}</span> },
    { key: 'notes', label: 'Notes', render: (a) => <span className="small muted">{a.notes || '—'}</span> },
    { key: 'active', label: 'Statut', render: (a) => <StatusBadge status={a.active ? 'active' : 'inactive'} /> },
    ...(isSuperAdmin ? [{ key: 'actions', label: '', sortable: false, render: (a) => <div className="row-actions"><Button size="xs" onClick={() => setEdit({ id: a.accountId, form: { ...EMPTY_PA, ...a, iban: a.iban || '', swift: a.swift || '', notes: a.notes || '' } })}>Modifier</Button><Button size="xs" variant={a.active ? 'danger-outline' : 'success'} onClick={() => toggle(a)}>{a.active ? 'Désactiver' : 'Activer'}</Button></div> }] : []),
  ];
  return (
    <div className="stack-lg">
      <Callout tone="info">Un compte actif par devise : il figure dans les instructions des ordres d’approvisionnement (banque → wallet). Sans compte actif pour la devise, le marchand reçoit <span className="mono">409 FUNDING_UNAVAILABLE</span>.{!isSuperAdmin && ' Lecture seule : la création et la modification sont réservées au super administrateur.'}</Callout>
      <Card flush title="Comptes de collecte C-Pay" actions={isSuperAdmin && <Button size="sm" variant="primary" icon="plus" onClick={() => setEdit({ id: null, form: { ...EMPTY_PA } })}>Nouveau compte</Button>}>
        <DataTable columns={cols} rows={list.data || []} keyField="accountId" loading={list.loading} error={list.error} onRetry={list.reload} dense empty="Aucun compte de collecte configuré" emptyIcon="bank" />
      </Card>
      {edit && (
        <Modal title={edit.id ? 'Modifier le compte de collecte' : 'Nouveau compte de collecte'} onClose={() => !busy && setEdit(null)} footer={<><Button onClick={() => setEdit(null)} disabled={busy}>Annuler</Button><Button variant="primary" loading={busy} onClick={save}>Enregistrer</Button></>}>
          <div className="form-grid">
            <Field label="Devise (ISO 4217)" required><Input value={edit.form.currency} onChange={(v) => setF('currency', v.toUpperCase().slice(0, 3))} placeholder="XAF" /></Field>
            <Field label="Banque" required><Input value={edit.form.bankName} onChange={(v) => setF('bankName', v)} placeholder="ex. Afriland First Bank" /></Field>
            <Field label="Intitulé du compte" required className="full"><Input value={edit.form.accountName} onChange={(v) => setF('accountName', v)} placeholder="Calculus Plus SAS — collecte C-Pay" /></Field>
            <Field label="Numéro de compte" required className="full"><Input value={edit.form.accountNumber} onChange={(v) => setF('accountNumber', v)} className="mono" /></Field>
            <Field label="IBAN"><Input value={edit.form.iban} onChange={(v) => setF('iban', v)} className="mono" /></Field>
            <Field label="SWIFT / BIC"><Input value={edit.form.swift} onChange={(v) => setF('swift', v)} className="mono" /></Field>
            <Field label="Notes internes" className="full"><Input value={edit.form.notes} onChange={(v) => setF('notes', v)} placeholder="ex. compte principal XAF, agence Douala" /></Field>
            <div className="full"><Switch checked={!!edit.form.active} onChange={(v) => setF('active', v)} label="Compte actif (proposé dans les ordres d’approvisionnement)" /></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function CashPage() {
  const { get, set } = useUrlState({ tab: 'files' });
  const tab = get('tab');
  const stats = useQuery(() => cashApi.stats().then((r) => r.data), [], { interval: 60000 });
  const [sel, setSel] = useState(null);
  const [tick, setTick] = useState(0);
  const s = stats.data;
  const vol = (k) => `${fmtMoney(s?.today?.[k]?.amount)} · 7 j ${fmtMoney(s?.last7Days?.[k]?.amount)}`;
  return (
    <div className="page">
      <PageHeader title="Caisse" subtitle="Encaisser, retirer, transférer : files d’attente à traiter par les opérations C-Pay, journal des transferts et comptes de collecte."
        actions={<Button icon="refresh" onClick={stats.refresh} loading={stats.loading && !!s}>Actualiser</Button>} />
      <div className="grid grid-4">
        <Stat label="Encaissé aujourd’hui" value={fmtMoney(s?.today?.collected?.amount)} sub={`${fmtNumber(s?.today?.collected?.count)} op. · 7 j ${fmtMoney(s?.last7Days?.collected?.amount)}`} icon="trending" tone="accent" small />
        <Stat label="Retiré (wallet)" value={fmtMoney(s?.today?.withdrawn?.amount)} sub={vol('withdrawn')} icon="wallet" tone="success" small />
        <Stat label="Wallet → banque" value={fmtMoney(s?.today?.transfersOut?.amount)} sub={vol('transfersOut')} icon="bank" small />
        <Stat label="Banque → wallet" value={fmtMoney(s?.today?.transfersIn?.amount)} sub={vol('transfersIn')} icon="arrowDown" tone="cyan" small />
      </div>
      <Tabs value={tab} onChange={(v) => set({ tab: v, page: '', status: '', queue: '' })} items={[
        { value: 'files', label: 'Files d’attente', icon: 'inbox', count: s ? (s.queues?.pendingManual?.count || 0) + (s.queues?.awaitingFunds?.count || 0) : null },
        { value: 'transferts', label: 'Tous les transferts', icon: 'swap' },
        { value: 'comptes', label: 'Comptes de collecte', icon: 'bank' },
        { value: 'comptes-marchands', label: 'Comptes marchands', icon: 'bank' },
      ]} />
      {tab === 'files' && <QueuesTab stats={s} onOpen={setSel} tick={tick} />}
      {tab === 'transferts' && <TransfersTab onOpen={setSel} tick={tick} />}
      {tab === 'comptes' && <AccountsTab />}
      {tab === 'comptes-marchands' && <MerchantBankAccountsTab />}
      {sel && <CashTransferDrawer id={sel.transferId} initial={sel} onClose={() => setSel(null)} onChanged={() => { stats.refresh(); setTick((t) => t + 1); }} />}
    </div>
  );
}
