import React, { useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import DataTable from '../../components/DataTable';
import { Button, Card, KeyValue, StatusBadge, Badge, EmptyState, Skeleton, ErrorState, Field, Input, Textarea, Callout, Modal, Select, ConfirmDialog, Switch } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { merchantsApi, txnApi, cashApi, financeApi, usersApi, configApi } from '../../services/api';
import { fmtMoney, fmtNumber, fmtDate, fmtDateTime, countryName, methodLabel } from '../../utils/format';
import { KYB_LEVELS, directionOf, kybTone } from '../../utils/status';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';
import TransactionDrawer from '../operations/TransactionDrawer';
import CashTransferDrawer from '../operations/CashTransferDrawer';
import { CreateUserModal, ResetPasswordDialog, userColumns } from './MerchantUsersPage';

// ─── Vue d'ensemble ───────────────────────────────────────────────
export function OverviewTab({ merchant: m }) {
  const pilot = useQuery(() => merchantsApi.pilotState(m.merchant_id).then((r) => r.data).catch(() => null), [m.merchant_id]);
  return (
    <div className="grid grid-2">
      <Card title="Identité">
        <KeyValue rows={[
          ['Raison sociale', m.business_name], ['Pays / devise', `${countryName(m.country)} · ${m.currency}`], ['E-mail', m.email], ['Téléphone', m.phone],
          ['RCCM', m.rccm], ['NIF', m.nif], ['Statut', <StatusBadge status={m.merchant_status} />],
          ['Dossier KYB', <><Badge tone={kybTone(m.kyb_level)}>Niveau {m.kyb_level ?? 0}</Badge> {m.kyb_status && <StatusBadge status={m.kyb_status} />}</>],
          ['Inscrit le', fmtDateTime(m.created_at)], ['Mis à jour le', fmtDateTime(m.updated_at)],
        ]} />
      </Card>
      <div className="stack-lg">
        <Card title="Règlement">
          <KeyValue rows={[['Type', m.settlement_type === 'bank' ? 'Virement bancaire' : 'Mobile Money'], ['Compte', <span className="mono">{m.settlement_account}</span>], ['Opérateur', m.settlement_provider]]} />
        </Card>
        <Card title="Opérateurs assignés" sub="Connecteurs utilisés pour ce marchand (défauts du pays)">
          {!(m.api_assignments || []).length ? <EmptyState icon="plug" title="Aucun opérateur assigné" /> : (
            <div>
              {m.api_assignments.map((a) => (
                <div key={a.provider_key} className="list-item">
                  <div style={{ flex: 1 }}><div className="small strong">{a.display_name || a.provider_key}</div><div className="xs muted">{a.provider_type} · {a.provider_key}</div></div>
                  {a.is_default && <Badge tone="info">par défaut</Badge>}<StatusBadge status={a.status} />
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Programme pilote" sub="Fonctionnalités activées pour ce marchand">
          {pilot.loading ? <Skeleton /> : !pilot.data ? <div className="muted small">Non disponible.</div> : (
            <div className="stack">
              <div className="xs muted">Mode : {pilot.data.mode}</div>
              {(pilot.data.enrollments || []).map((e) => <div key={e.enrollment_id || e.pilot_key} className="row small"><Badge tone="cyan">{e.pilot_key || e.name}</Badge> <StatusBadge status={e.status} /> <span className="muted">{e.rollout_percent} %</span></div>)}
              {(pilot.data.overrides || []).map((o) => <div key={o.flag_key} className="row small"><Badge tone={o.enabled ? 'success' : 'neutral'}>{o.flag_key}</Badge><span className="muted">{o.enabled ? 'forcé actif' : 'forcé inactif'}{o.reason ? ` · ${o.reason}` : ''}</span></div>)}
              {!(pilot.data.enrollments || []).length && !(pilot.data.overrides || []).length && <div className="muted small">Aucune inscription ni dérogation.</div>}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── Tarifs & limites ─────────────────────────────────────────────
const FEE_LABELS = { card_cybersource: 'CyberSource (cartes)', card_migs: 'Mastercard Gateway', mtn_momo: 'MTN MoMo', airtel_money: 'Airtel Money', orange_money: 'Orange Money', mpesa: 'M-Pesa', wave: 'Wave' };
const VELOCITY = [
  ['velocity_max_per_txn', 'Montant maximal par transaction', 'montant'], ['velocity_max_daily_amount', 'Cumul maximal par jour', 'montant'], ['velocity_max_daily_count', 'Nombre maximal par jour', 'txn'],
  ['velocity_max_monthly_amount', 'Cumul maximal par mois', 'montant'], ['velocity_max_monthly_count', 'Nombre maximal par mois', 'txn'],
];
export function PricingTab({ merchant: m, canWrite, onSaved }) {
  const [fees, setFees] = useState(m.fees || []);
  const [vel, setVel] = useState(() => Object.fromEntries(VELOCITY.map(([k]) => [k, m[k] ?? ''])));
  const [busy, setBusy] = useState(null);
  useEffect(() => { setFees(m.fees || []); }, [m.fees]);
  const upd = (i, k, v) => setFees((fs) => fs.map((f, j) => (j === i ? { ...f, [k]: v } : f)));
  const saveFees = async () => {
    setBusy('fees');
    try { await merchantsApi.saveFees(m.merchant_id, fees); toast.success('Frais enregistrés'); onSaved?.(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const saveVel = async () => {
    setBusy('vel');
    try { await merchantsApi.saveVelocity(m.merchant_id, vel); toast.success('Limites enregistrées'); onSaved?.(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const dirs = [['collection', 'Encaissement (frais prélevés au marchand)'], ['disbursement', 'Décaissement (retraits, virements)']];
  return (
    <div className="stack-lg">
      <Card title="Frais et commissions" sub="Par moyen de paiement et par sens. Taux en pourcentage, montants dans la devise du marchand." actions={canWrite && <Button variant="primary" size="sm" loading={busy === 'fees'} onClick={saveFees} disabled={!fees.length}>Enregistrer les frais</Button>} flush>
        {!fees.length ? <EmptyState icon="receipt" title="Aucune grille de frais" description="Les frais sont créés par le backend à l’inscription du marchand." /> : dirs.map(([dir, label]) => {
          const rows = fees.map((f, i) => ({ ...f, i })).filter((f) => f.direction === dir);
          if (!rows.length) return null;
          return (
            <div key={dir}>
              <div className="form-section" style={{ padding: '10px 16px 6px', borderBottom: 'none' }}>{label}</div>
              <div className="table-wrap"><table className="table table-dense">
                <thead><tr><th>Moyen de paiement</th><th className="right">Taux (%)</th><th className="right">Fixe</th><th className="right">Minimum</th><th className="right">Maximum</th><th>Actif</th></tr></thead>
                <tbody>{rows.map((f) => (
                  <tr key={f.fee_id || f.i}>
                    <td className="cell-primary">{FEE_LABELS[f.payment_type] || f.payment_type}</td>
                    <td className="right"><Input size="sm" type="number" step="0.01" min="0" max="100" disabled={!canWrite} style={{ width: 90, textAlign: 'right' }} value={f.fee_rate === '' ? '' : (Number(f.fee_rate || 0) * 100).toFixed(2)} onChange={(v) => upd(f.i, 'fee_rate', v === '' ? '' : Number(v) / 100)} aria-label="Taux" /></td>
                    <td className="right"><Input size="sm" type="number" min="0" disabled={!canWrite} style={{ width: 100, textAlign: 'right' }} value={f.fee_fixed ?? 0} onChange={(v) => upd(f.i, 'fee_fixed', v)} aria-label="Fixe" /></td>
                    <td className="right"><Input size="sm" type="number" min="0" disabled={!canWrite} style={{ width: 100, textAlign: 'right' }} value={f.fee_min ?? 0} onChange={(v) => upd(f.i, 'fee_min', v)} aria-label="Minimum" /></td>
                    <td className="right"><Input size="sm" type="number" min="0" disabled={!canWrite} style={{ width: 110, textAlign: 'right' }} value={f.fee_max ?? ''} placeholder="Illimité" onChange={(v) => upd(f.i, 'fee_max', v === '' ? null : v)} aria-label="Maximum" /></td>
                    <td><Switch checked={f.is_active !== false} disabled={!canWrite} onChange={(v) => upd(f.i, 'is_active', v)} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          );
        })}
      </Card>
      <Card title="Limites de vélocité" sub="Vide = aucune limite. Montants dans la devise du marchand." actions={canWrite && <Button variant="primary" size="sm" loading={busy === 'vel'} onClick={saveVel}>Enregistrer les limites</Button>}>
        <div className="form-grid">
          {VELOCITY.map(([k, label, unit]) => (
            <Field key={k} label={label}><Input type="number" min="0" disabled={!canWrite} value={vel[k] ?? ''} placeholder="Illimité" onChange={(v) => setVel((p) => ({ ...p, [k]: v }))} style={{ textAlign: 'right' }} />
              <span className="field-hint">{unit === 'txn' ? 'nombre de transactions' : m.currency}</span></Field>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── Transactions ─────────────────────────────────────────────────
export function TransactionsTab({ merchantId }) {
  const { get, set, page, setPage } = useUrlState();
  const status = get('status');
  const [sel, setSel] = useState(null);
  const list = useQuery(() => txnApi.list({ page, limit: 25, merchant_id: merchantId, status: status || undefined }).then((r) => r.data), [merchantId, page, status]);
  const cols = [
    { key: 'initiated_at', label: 'Date', render: (t) => <span className="cell-date">{fmtDateTime(t.initiated_at)}</span> },
    { key: 'type', label: 'Type', render: (t) => <Badge tone={t.type === 'collect' ? 'success' : 'info'}>{t.type === 'collect' ? 'Encaissement' : t.type === 'payout' ? 'Retrait' : t.type}</Badge> },
    { key: 'payment_method', label: 'Méthode', render: (t) => <>{methodLabel(t.payment_method)}<div className="cell-sub">{t.detected_operator || t.detected_network || ''}</div></> },
    { key: 'amount', label: 'Montant', align: 'right', render: (t) => <span className="amount">{fmtMoney(t.amount, t.currency)}</span>, sortValue: (t) => Number(t.amount) },
    { key: 'net_amount', label: 'Net', align: 'right', render: (t) => <span className="num">{t.net_amount ? fmtMoney(t.net_amount, t.currency) : '—'}</span> },
    { key: 'status', label: 'Statut', render: (t) => <StatusBadge status={t.status} /> },
    { key: 'settlement_status', label: 'Règlement', render: (t) => <StatusBadge status={t.settlement_status || 'non_regle'} /> },
  ];
  return (
    <Card flush title="Transactions du marchand" actions={<Select size="sm" value={status} onChange={(v) => set({ status: v, page: '' })} placeholder="Tous statuts" options={[{ value: 'authorized', label: 'Autorisées' }, { value: 'pending', label: 'En attente' }, { value: 'failed', label: 'Échouées' }]} aria-label="Statut" />}>
      <DataTable columns={cols} rows={list.data?.data || []} keyField="transaction_id" loading={list.loading} error={list.error} onRetry={list.reload} page={page} limit={25} total={list.data?.total} onPage={setPage} onRowClick={setSel} dense empty="Aucune transaction" emptyIcon="swap" />
      {sel && <TransactionDrawer id={sel.transaction_id} initial={sel} onClose={() => setSel(null)} />}
    </Card>
  );
}

// ─── Caisse ───────────────────────────────────────────────────────
export function CashTab({ merchant: m }) {
  const { hasRole } = useAuth();
  const allowed = hasRole(PERMS.ops);
  const [sel, setSel] = useState(null);
  const list = useQuery(() => cashApi.transfers({ merchantId: m.merchant_id, limit: 20, offset: 0 }).then((r) => r.data), [m.merchant_id], { enabled: allowed });
  const wallet = m.wallet || (m.cash_wallet_phone ? { operator: m.cash_wallet_operator, phone: m.cash_wallet_phone, verifiedAt: m.cash_wallet_verified_at } : null);
  const banks = m.bankAccounts || m.bank_accounts;
  if (!allowed) return <Card><EmptyState icon="lock" title="Réservé aux rôles super administrateur et administrateur opérations" /></Card>;
  const cols = [
    { key: 'createdAt', label: 'Date', render: (t) => <span className="cell-date">{fmtDateTime(t.createdAt)}</span> },
    { key: 'reference', label: 'Référence', render: (t) => <span className="mono strong">{t.reference}</span> },
    { key: 'direction', label: 'Nature', render: (t) => { const d = directionOf(t); return <Badge tone={d.tone}>{d.label}</Badge>; } },
    { key: 'amount', label: 'Montant', align: 'right', render: (t) => <span className="amount">{fmtMoney(t.amount, t.currency)}</span> },
    { key: 'net', label: 'Net', align: 'right', render: (t) => <span className="num">{fmtMoney(t.net, t.currency)}</span> },
    { key: 'dest', label: 'Destination', render: (t) => t.bankAccount ? `${t.bankAccount.bankName || ''} ${t.bankAccount.accountMasked || ''}` : t.wallet ? `${t.wallet.operator || ''} ${t.wallet.phone || ''}` : 'Compte de collecte C-Pay' },
    { key: 'status', label: 'Statut', render: (t) => <StatusBadge status={t.status} /> },
  ];
  return (
    <div className="stack-lg">
      <div className="grid grid-2">
        <Card title="Wallet Mobile Money" sub="Destination des retraits">
          {wallet ? <KeyValue rows={[['Opérateur', wallet.operatorLabel || wallet.operator], ['Numéro', wallet.phone], ['Vérifié', wallet.verifiedAt ? <Badge tone="success">le {fmtDate(wallet.verifiedAt)}</Badge> : <Badge tone="warn">non vérifié</Badge>]]} /> : <div className="muted small">Aucun wallet enregistré par le marchand (ou non renvoyé par la fiche).</div>}
        </Card>
        <Card title="Comptes bancaires" sub="Destinations des virements">
          {Array.isArray(banks) ? (!banks.length ? <div className="muted small">Aucun compte bancaire.</div> : banks.map((b, i) => (
            <div key={b.account_id || i} className="list-item"><span style={{ flex: 1 }}>{b.bankName || b.bank_name || b.inst_name} · <span className="mono">{b.accountMasked || b.account_masked || b.account_number}</span></span><StatusBadge status={b.status === 'verified' || b.verified ? 'verified' : 'pending'} /></div>
          ))) : <div className="muted small">Non renvoyés par la fiche marchand : voir les destinations dans les transferts ci-dessous.</div>}
        </Card>
      </div>
      <Card flush title="Transferts de caisse" sub="20 derniers mouvements" actions={<Button size="sm" to={`/operations/caisse?tab=transferts&merchantId=${m.merchant_id}`} icon="arrowRight">Tous les transferts</Button>}>
        <DataTable columns={cols} rows={list.data?.data || []} keyField="transferId" loading={list.loading} error={list.error} onRetry={list.reload} onRowClick={setSel} dense empty="Aucun transfert de caisse" emptyIcon="banknote" />
      </Card>
      {sel && <CashTransferDrawer id={sel.transferId} initial={sel} onClose={() => setSel(null)} onChanged={list.refresh} />}
    </div>
  );
}

// ─── Règlements ───────────────────────────────────────────────────
export function SettlementsTab({ merchant: m }) {
  const { hasRole } = useAuth();
  const allowed = hasRole(PERMS.finance);
  const list = useQuery(() => financeApi.batches({ merchantId: m.merchant_id, limit: 50 }).then((r) => r.data), [m.merchant_id], { enabled: allowed });
  if (!allowed) return <Card><EmptyState icon="lock" title="Réservé aux rôles super administrateur et finance" description="Les lots de règlement J+1 sont consultables par l’équipe finance." /></Card>;
  const cols = [
    { key: 'batch_date', label: 'Date du lot', render: (s) => fmtDate(s.batch_date) },
    { key: 'txn_count', label: 'Transactions', align: 'right', render: (s) => fmtNumber(s.txn_count) },
    { key: 'total_gross', label: 'Brut', align: 'right', render: (s) => <span className="num">{fmtMoney(s.total_gross, s.currency)}</span> },
    { key: 'total_fees', label: 'Frais', align: 'right', render: (s) => <span className="num">{fmtMoney(s.total_fees, s.currency)}</span> },
    { key: 'total_net', label: 'Net', align: 'right', render: (s) => <span className="amount">{fmtMoney(s.total_net, s.currency)}</span> },
    { key: 'status', label: 'Statut', render: (s) => <StatusBadge status={s.status} /> },
    { key: 'completed_at', label: 'Versé le', render: (s) => <span className="cell-date">{fmtDateTime(s.completed_at)}</span> },
  ];
  return (
    <Card flush title="Lots de règlement" sub={`Règlements J+1 vers ${m.settlement_account || 'le compte de règlement'}`} actions={<Button size="sm" to={`/operations/reglements?merchantId=${m.merchant_id}`} icon="arrowRight">Traiter dans Règlements</Button>}>
      <DataTable columns={cols} rows={list.data?.data || []} keyField="batch_id" loading={list.loading} error={list.error} onRetry={list.reload} dense empty="Aucun lot de règlement" emptyIcon="receipt"
        footerExtra={list.data?.summary ? <span>Total net : <b>{fmtMoney(list.data.summary.total_net, m.currency)}</b></span> : null} />
    </Card>
  );
}

// ─── Webhooks & intégrations ──────────────────────────────────────
export function IntegrationsTab({ merchant: m, canWrite }) {
  const list = useQuery(() => merchantsApi.integrations(m.merchant_id).then((r) => r.data.data || []), [m.merchant_id]);
  const [busy, setBusy] = useState(null);
  const test = async () => {
    setBusy('test');
    try { await merchantsApi.testEvent(m.merchant_id, { eventType: 'integration.test' }); toast.success('Événement de test envoyé aux intégrations actives'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  return (
    <div className="stack-lg">
      <Callout tone="info">Les clés API du marchand sont gérées par le marchand depuis son portail et ne sont pas exposées au back-office. Cet onglet liste ses webhooks et intégrations (secrets masqués).</Callout>
      <Card flush title="Webhooks et intégrations" actions={canWrite && <Button size="sm" icon="send" loading={busy === 'test'} onClick={test} disabled={!(list.data || []).some((i) => i.status === 'active')}>Envoyer un événement de test</Button>}>
        {list.loading ? <div className="card-body"><Skeleton /></div> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !(list.data || []).length ? <EmptyState icon="plug" title="Aucune intégration configurée" /> : (
          <div className="table-wrap"><table className="table table-dense">
            <thead><tr><th>Nom</th><th>Type</th><th>Point de terminaison</th><th>Événements</th><th>Secret</th><th>Statut</th><th>Dernière livraison</th></tr></thead>
            <tbody>{list.data.map((i) => (
              <tr key={i.integration_id}>
                <td className="cell-primary">{i.display_name}<div className="cell-sub">{i.provider}</div></td>
                <td>{i.integration_type}</td>
                <td className="mono small truncate" style={{ maxWidth: 260 }}>{i.endpoint_url || '—'}</td>
                <td className="small">{(i.event_types || []).join(', ')}</td>
                <td className="mono small">{i.signing_secret || '—'} {i.auth_config?.configured && <Badge tone="success">auth configurée</Badge>}</td>
                <td><StatusBadge status={i.status} />{i.last_error && <div className="xs error">{i.last_error}</div>}</td>
                <td className="cell-date">{fmtDateTime(i.last_sync_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

// ─── KYB ──────────────────────────────────────────────────────────
const DOC_TYPES = { rccm: 'RCCM / registre de commerce', nif: 'NIF / identifiant fiscal', id_card: 'Pièce d’identité du dirigeant', bank_details: 'RIB / coordonnées bancaires', address_proof: 'Justificatif d’adresse', contract: 'Contrat signé' };
export function KybTab({ merchant: m, canWrite, onChanged }) {
  const q = useQuery(() => merchantsApi.kyb(m.merchant_id).then((r) => r.data), [m.merchant_id]);
  const [reject, setReject] = useState(null);
  const [add, setAdd] = useState(false);
  const docs = q.data?.documents || [];
  const review = async (doc, status, reason) => {
    try { await merchantsApi.reviewKybDoc(m.merchant_id, doc.doc_id, { status, rejectionReason: reason || undefined }); toast.success(status === 'approved' ? 'Document approuvé' : 'Document rejeté'); q.refresh(); onChanged?.(); }
    catch (e) { toast.error(errorMessage(e)); throw e; }
  };
  const counts = { pending: docs.filter((d) => d.status === 'pending').length, approved: docs.filter((d) => d.status === 'approved').length, rejected: docs.filter((d) => d.status === 'rejected').length };
  return (
    <div className="grid grid-main">
      <Card title="Documents justificatifs" sub={`${counts.pending} à vérifier · ${counts.approved} approuvé(s) · ${counts.rejected} rejeté(s)`} actions={canWrite && <Button size="sm" icon="plus" onClick={() => setAdd(true)}>Ajouter un document</Button>}>
        {q.loading ? <Skeleton lines={4} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !docs.length ? <EmptyState icon="file" title="Aucun document soumis" description="Le marchand dépose ses pièces depuis son portail ; vous pouvez aussi en ajouter manuellement." /> : (
          <div>
            {docs.map((d) => (
              <div key={d.doc_id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <span className="stat-icon" style={{ width: 32, height: 32 }}><Icon name="file" size={16} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="small strong">{d.doc_label || DOC_TYPES[d.doc_type] || d.doc_type}</div>
                  <div className="xs muted">{d.file_name || 'Document'} · déposé le {fmtDateTime(d.uploaded_at)}{d.reviewed_at ? ` · revu le ${fmtDateTime(d.reviewed_at)}` : ''}</div>
                  {d.rejection_reason && <div className="xs error">Motif : {d.rejection_reason}</div>}
                </div>
                <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                  <StatusBadge status={d.status === 'approved' ? 'approved_doc' : d.status} />
                  {d.file_url && <Button size="xs" icon="external" onClick={() => window.open(d.file_url, '_blank', 'noopener')}>Voir</Button>}
                  {canWrite && d.status === 'pending' && <><Button size="xs" variant="success" onClick={() => review(d, 'approved')}>Approuver</Button><Button size="xs" variant="danger-outline" onClick={() => setReject(d)}>Rejeter</Button></>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <div className="stack-lg">
        <Card title="Niveau et plafonds">
          {KYB_LEVELS.map((l) => (
            <div key={l.v} className="list-item">
              <span className="avatar" style={{ background: (m.kyb_level ?? 0) >= l.v ? 'var(--success-100)' : 'var(--surface-3)', color: (m.kyb_level ?? 0) >= l.v ? 'var(--success-700)' : 'var(--text-3)' }}>{l.v}</span>
              <div style={{ flex: 1 }}><div className="small strong">{l.label}</div><div className="xs muted">Plafond : {l.limit}</div></div>
              {(m.kyb_level ?? 0) === l.v && <Badge tone="info">actuel</Badge>}
            </div>
          ))}
          <div className="xs muted mt-3">Le niveau se modifie via le bouton « Niveau KYB » en haut de la fiche.</div>
        </Card>
        <Card title="Dossier">
          <KeyValue rows={[['Statut', q.data?.kyb?.kyb_status ? <StatusBadge status={q.data.kyb.kyb_status} /> : '—'], ['Soumis le', fmtDateTime(q.data?.kyb?.kyb_submitted_at)], ['Revu le', fmtDateTime(q.data?.kyb?.kyb_reviewed_at)], ['Notes', q.data?.kyb?.kyb_notes]]} />
        </Card>
      </div>
      {reject && <ConfirmDialog title="Rejeter le document" tone="danger" confirmLabel="Rejeter" message={`${reject.doc_label || DOC_TYPES[reject.doc_type] || reject.doc_type} — le marchand est informé du motif.`} reason={{ label: 'Motif du rejet', required: true }} onConfirm={(r) => review(reject, 'rejected', r)} onClose={() => setReject(null)} />}
      {add && <AddKybDocModal merchantId={m.merchant_id} onClose={() => setAdd(false)} onAdded={() => { setAdd(false); q.refresh(); }} />}
    </div>
  );
}
function AddKybDocModal({ merchantId, onClose, onAdded }) {
  const [form, setForm] = useState({ docType: 'rccm', docLabel: '', fileUrl: '', fileName: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await merchantsApi.addKybDoc(merchantId, { ...form, docLabel: form.docLabel || DOC_TYPES[form.docType] }); toast.success('Document ajouté'); onAdded(); }
    catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };
  return (
    <Modal title="Ajouter un document KYB" sub="Référence vers un fichier déjà stocké (URL)." onClose={onClose} size="sm" footer={<><Button onClick={onClose}>Annuler</Button><Button variant="primary" type="submit" form="add-doc" loading={busy}>Ajouter</Button></>}>
      <form id="add-doc" className="stack" onSubmit={submit}>
        <Field label="Type" required><Select value={form.docType} onChange={(v) => setForm((f) => ({ ...f, docType: v }))} options={Object.entries(DOC_TYPES).map(([value, label]) => ({ value, label }))} /></Field>
        <Field label="Libellé"><Input value={form.docLabel} onChange={(v) => setForm((f) => ({ ...f, docLabel: v }))} /></Field>
        <Field label="URL du fichier" required><Input type="url" value={form.fileUrl} onChange={(v) => setForm((f) => ({ ...f, fileUrl: v }))} required placeholder="https://…" /></Field>
        <Field label="Nom du fichier"><Input value={form.fileName} onChange={(v) => setForm((f) => ({ ...f, fileName: v }))} /></Field>
      </form>
    </Modal>
  );
}

// ─── Utilisateurs ─────────────────────────────────────────────────
// GET /users n'a pas de filtre par marchand : on charge les 100 derniers comptes
// (recherche sur le nom du marchand sans effet) et on filtre côté client.
export function UsersTab({ merchant: m, canWrite }) {
  const list = useQuery(() => usersApi.list({ limit: 100 }).then((r) => (r.data.data || []).filter((u) => u.merchant_id === m.merchant_id)), [m.merchant_id]);
  const [create, setCreate] = useState(false);
  const [reset, setReset] = useState(null);
  const toggle = async (u) => {
    try { await usersApi.setActive(u.user_id, !u.is_active); toast.success(u.is_active ? 'Compte désactivé' : 'Compte activé'); list.refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <Card flush title="Utilisateurs du portail marchand" sub="Propriétaire, gestionnaires et caissiers. Filtré côté client sur les 100 derniers comptes créés."
      actions={<><Button size="sm" to={`/marchands/utilisateurs?search=${encodeURIComponent(m.email || '')}`}>Recherche globale</Button>{canWrite && <Button size="sm" variant="primary" icon="plus" onClick={() => setCreate(true)}>Ajouter</Button>}</>}>
      <DataTable columns={userColumns({ canWrite, withMerchant: false, onToggle: toggle, onReset: (u) => setReset({ id: u.user_id, label: u.email }) })} rows={list.data || []} keyField="user_id" loading={list.loading} error={list.error} onRetry={list.reload} dense empty="Aucun utilisateur trouvé pour ce marchand" emptyIcon="users" />
      {create && <CreateUserModal merchantId={m.merchant_id} onClose={() => setCreate(false)} onCreated={list.refresh} />}
      {reset && <ResetPasswordDialog user={reset} onClose={() => setReset(null)} />}
    </Card>
  );
}

// ─── Journal d'audit (super_admin) ────────────────────────────────
export function AuditTab({ merchantId }) {
  const list = useQuery(() => configApi.auditLogs({ limit: 100 }).then((r) => (r.data.data || []).filter((l) => l.entity_id === merchantId)), [merchantId]);
  const cols = [
    { key: 'created_at', label: 'Date', render: (l) => <span className="cell-date">{fmtDateTime(l.created_at)}</span> },
    { key: 'actor_email', label: 'Acteur', render: (l) => l.actor_email || l.actor_type || '—' },
    { key: 'action', label: 'Action', render: (l) => <span className="mono small">{l.action}</span> },
    { key: 'new_values', label: 'Détails', render: (l) => <span className="xs muted truncate" style={{ maxWidth: 360, display: 'inline-block' }}>{l.new_values ? JSON.stringify(l.new_values) : '—'}</span> },
  ];
  return (
    <Card flush title="Journal d’audit du marchand" sub="Entrées des 100 derniers événements de la plateforme concernant ce marchand" actions={<Button size="sm" to="/configuration/audit">Journal complet</Button>}>
      <DataTable columns={cols} rows={list.data || []} keyField="log_id" loading={list.loading} error={list.error} onRetry={list.reload} dense empty="Aucune entrée récente pour ce marchand" emptyIcon="list" />
    </Card>
  );
}
