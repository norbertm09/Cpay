import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Card, PageHeader, Tabs, StatusBadge, Badge, Stat, Skeleton, ErrorState, ConfirmDialog, Modal, Select, Field, Callout } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { useAuth } from '../../hooks/useAuth';
import { merchantsApi } from '../../services/api';
import { fmtMoney, fmtNumber, countryName } from '../../utils/format';
import { KYB_LEVELS, kybTone } from '../../utils/status';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';
import { OverviewTab, PricingTab, TransactionsTab, CashTab, SettlementsTab, IntegrationsTab, KybTab, UsersTab, AuditTab } from './tabs';

const TABS = [
  { value: 'apercu', label: 'Vue d’ensemble', icon: 'store' },
  { value: 'transactions', label: 'Transactions', icon: 'swap' },
  { value: 'caisse', label: 'Caisse', icon: 'banknote' },
  { value: 'reglements', label: 'Règlements', icon: 'receipt' },
  { value: 'tarifs', label: 'Tarifs & limites', icon: 'sliders' },
  { value: 'integrations', label: 'Webhooks & intégrations', icon: 'plug' },
  { value: 'kyb', label: 'KYB', icon: 'file' },
  { value: 'utilisateurs', label: 'Utilisateurs', icon: 'users' },
  { value: 'audit', label: 'Journal d’audit', icon: 'list' },
];

export default function MerchantDetailPage() {
  const { id } = useParams();
  const { hasRole, isSuperAdmin } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const { get, set } = useUrlState({ tab: 'apercu' });
  const tab = get('tab');
  const q = useQuery(() => merchantsApi.get(id).then((r) => r.data), [id]);
  const m = q.data;
  const [confirm, setConfirm] = useState(null); // 'suspend' | 'activate' | 'close'
  const [kybModal, setKybModal] = useState(false);

  const setStatus = async (status, reason) => {
    try { await merchantsApi.setStatus(id, { status, reason: reason || undefined }); toast.success('Statut mis à jour'); q.refresh(); }
    catch (e) { toast.error(errorMessage(e)); throw e; }
  };

  if (q.loading && !m) return <div className="page"><Skeleton lines={2} height={20} /><Card><Skeleton lines={6} /></Card></div>;
  if (!m) return <Card><ErrorState error={q.error} onRetry={q.reload} title="Marchand introuvable" /></Card>;

  const crumbs = [{ label: 'Marchands', to: '/marchands' }, { label: m.business_name }];
  const tabs = TABS.filter((t) => (t.value === 'audit' ? isSuperAdmin : true));

  return (
    <div className="page">
      <PageHeader crumbs={crumbs} title={m.business_name}
        badge={<><StatusBadge status={m.merchant_status} /><Badge tone={kybTone(m.kyb_level)}>KYB niveau {m.kyb_level ?? 0}</Badge></>}
        subtitle={<>{countryName(m.country)} · {m.currency} · {m.email} · {m.phone}{m.rccm ? ` · RCCM ${m.rccm}` : ''}</>}
        actions={canWrite && <>
          <Button icon="file" onClick={() => setKybModal(true)}>Niveau KYB</Button>
          <Button icon="key" onClick={() => set({ tab: 'utilisateurs' })}>Réinitialiser un mot de passe</Button>
          {m.merchant_status === 'active'
            ? <Button variant="danger-outline" icon="x" onClick={() => setConfirm('suspend')}>Suspendre</Button>
            : m.merchant_status !== 'closed' && <Button variant="success" icon="check" onClick={() => setConfirm('activate')}>Activer</Button>}
          {m.merchant_status !== 'closed' && <Button variant="ghost" onClick={() => setConfirm('close')}>Fermer le compte</Button>}
        </>} />

      <div className="grid grid-4">
        <Stat label="Transactions" value={fmtNumber(m.total_txn)} icon="swap" small />
        <Stat label="Volume autorisé" value={fmtMoney(m.total_volume, m.currency)} icon="trending" tone="accent" small />
        <Stat label="Terminaux" value={fmtNumber(m.terminal_count)} icon="phone" tone="cyan" small to={`/configuration/terminaux?merchantId=${id}`} />
        <Stat label="Règlement" value={m.settlement_type === 'bank' ? 'Virement' : 'Mobile Money'} sub={m.settlement_account} icon="receipt" tone="success" small />
      </div>

      <Tabs items={tabs} value={tab} onChange={(v) => set({ tab: v, page: '' })} />

      {tab === 'apercu' && <OverviewTab merchant={m} />}
      {tab === 'transactions' && <TransactionsTab merchantId={id} />}
      {tab === 'caisse' && <CashTab merchant={m} />}
      {tab === 'reglements' && <SettlementsTab merchant={m} />}
      {tab === 'tarifs' && <PricingTab merchant={m} canWrite={canWrite} onSaved={q.refresh} />}
      {tab === 'integrations' && <IntegrationsTab merchant={m} canWrite={canWrite} />}
      {tab === 'kyb' && <KybTab merchant={m} canWrite={canWrite} onChanged={q.refresh} />}
      {tab === 'utilisateurs' && <UsersTab merchant={m} canWrite={canWrite} />}
      {tab === 'audit' && isSuperAdmin && <AuditTab merchantId={id} />}

      {confirm === 'suspend' && <ConfirmDialog title={`Suspendre ${m.business_name}`} tone="danger" confirmLabel="Suspendre" message="Le marchand ne pourra plus encaisser ni accéder à son portail. Le motif est tracé dans le journal d’audit." reason={{ label: 'Motif', required: true }} onConfirm={(r) => setStatus('suspended', r)} onClose={() => setConfirm(null)} />}
      {confirm === 'activate' && <ConfirmDialog title={`Activer ${m.business_name}`} tone="success" confirmLabel="Activer" message="Le marchand retrouve l’accès à son portail et aux encaissements." reason={{ label: 'Commentaire (optionnel)' }} onConfirm={(r) => setStatus('active', r)} onClose={() => setConfirm(null)} />}
      {confirm === 'close' && <ConfirmDialog title={`Fermer le compte ${m.business_name}`} tone="danger" confirmLabel="Fermer définitivement" message="La fermeture est définitive : le compte ne pourra plus être réactivé depuis le back-office." reason={{ label: 'Motif', required: true }} onConfirm={(r) => setStatus('closed', r)} onClose={() => setConfirm(null)} />}
      {kybModal && <KybLevelModal merchant={m} onClose={() => setKybModal(false)} onSaved={() => { setKybModal(false); q.refresh(); }} />}
    </div>
  );
}

export function KybLevelModal({ merchant, onClose, onSaved }) {
  const [level, setLevel] = useState(String(merchant.kyb_level ?? 0));
  const [status, setStatus] = useState(merchant.kyb_status || '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await merchantsApi.setKyb(merchant.merchant_id, { kybLevel: parseInt(level, 10), kybStatus: status || undefined });
      toast.success('Niveau KYB mis à jour'); onSaved();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Niveau KYB et plafonds" sub={merchant.business_name} onClose={onClose} size="sm" footer={<><Button onClick={onClose}>Annuler</Button><Button variant="primary" loading={busy} onClick={save}>Appliquer</Button></>}>
      <div className="stack">
        <Field label="Niveau" hint={KYB_LEVELS.find((l) => String(l.v) === level) ? `Plafond : ${KYB_LEVELS.find((l) => String(l.v) === level).limit}` : null}>
          <Select value={level} onChange={setLevel} options={KYB_LEVELS.map((l) => ({ value: String(l.v), label: l.label }))} />
        </Field>
        <Field label="Statut du dossier KYB">
          <Select value={status} onChange={setStatus} placeholder="Inchangé" options={[{ value: 'not_started', label: 'Non démarré' }, { value: 'in_progress', label: 'En cours' }, { value: 'verified', label: 'Vérifié' }, { value: 'rejected', label: 'Rejeté' }]} />
        </Field>
        <Callout tone="info">Le niveau conditionne les plafonds d’encaissement du marchand. Vérifiez les documents dans l’onglet KYB avant de passer au niveau 1 ou 2.</Callout>
      </div>
    </Modal>
  );
}
