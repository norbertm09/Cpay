import React, { useRef, useState } from 'react';
import { Button, Card, Select, Modal, Field, Input, Textarea, StatusBadge, EmptyState, Skeleton, Callout } from '../../components/ui';
import { useAuth } from '../../hooks/useAuth';
import { useQuery } from '../../hooks/useQuery';
import { cashApi } from '../../services/api';
import { fmtDateTime } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';

const METHODS = [{ value: 'document', label: 'Document bancaire' }, { value: 'micro_deposit', label: 'Micro-dépôt' }, { value: 'manual', label: 'Contrôle manuel' }];
const pending = (account) => ['pending', 'pending_verification'].includes(account.status);

export default function MerchantBankAccountsTab() {
  const { admin } = useAuth();
  const allowed = ['ops_admin', 'super_admin'].includes(admin?.role);
  const [denied, setDenied] = useState(false);
  const [status, setStatus] = useState('pending_verification');
  const list = useQuery(() => cashApi.bankAccounts({ status }).then(r => r.data.data || []), [status], { enabled: allowed && !denied });
  const [decision, setDecision] = useState(null);
  const [form, setForm] = useState({ method: '', reference: '', note: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const open = (account, action) => {
    setDecision({ account, action });
    setForm({ method: '', reference: '', note: '', reason: '' });
    setError(''); setNotice('');
  };
  const field = (key) => (value) => setForm(f => ({ ...f, [key]: value }));
  const verifying = decision?.action === 'verify';
  const valid = verifying ? METHODS.some(m => m.value === form.method) && form.reference.trim().length >= 1 && form.reference.trim().length <= 128 && form.note.trim().length <= 1000 : form.reason.trim().length >= 5 && form.reason.trim().length <= 500;
  const submit = async () => {
    if (!allowed || denied || list.forbidden || !decision || !pending(decision.account) || !valid || sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try {
      if (verifying) await cashApi.verifyBankAccount(decision.account.accountId, { method: form.method, reference: form.reference.trim(), ...(form.note.trim() ? { note: form.note.trim() } : {}) });
      else await cashApi.rejectBankAccount(decision.account.accountId, form.reason.trim());
      setDecision(null);
      toast.success(verifying ? 'Compte bancaire vérifié' : 'Compte bancaire rejeté');
      await list.reload();
    } catch (e) {
      if (e.response?.status === 403) {
        setDecision(null); setNotice(errorMessage(e)); setDenied(true);
      } else if (e.response?.status === 409) {
        setDecision(null); setNotice(errorMessage(e)); await list.reload();
      } else setError(errorMessage(e));
    } finally { sending.current = false; setBusy(false); }
  };
  if (denied) return <div role="alert"><Callout tone="warn">{notice}</Callout></div>;
  if (!allowed) return <Callout tone="warn">Vos droits ne permettent pas de consulter les comptes bancaires marchands.</Callout>;
  return <div className="stack-lg">
    <Callout tone="info">Contrôlez les justificatifs existants avant de décider. Seuls les comptes vérifiés peuvent servir aux virements vers la banque.</Callout>
    {notice && <div role="alert"><Callout tone="warn">{notice}</Callout></div>}
    <Card title="Comptes bancaires marchands" actions={<div className="row-wrap"><Select aria-label="Statut des comptes marchands" value={status} onChange={setStatus} disabled={busy || list.forbidden} options={[{ value: 'pending_verification', label: 'En attente' }, { value: 'verified', label: 'Vérifiés' }, { value: 'rejected', label: 'Rejetés' }]} /><Button onClick={list.reload} disabled={busy || list.loading || list.forbidden}>Actualiser les comptes</Button></div>}>
      {list.loading ? <div role="status" aria-label="Chargement des comptes"><Skeleton lines={4} /></div> : list.error ? <div role="alert"><Callout tone="error">{errorMessage(list.error)}</Callout>{!list.forbidden && <Button onClick={list.reload}>Réessayer</Button>}</div> : !list.data?.length ? <EmptyState icon="bank" title="Aucun compte marchand" description="Aucun compte ne correspond à ce statut." /> : <div className="stack-lg">{list.data.map(account => <article key={account.accountId} className="queue-item">
        <div><div className="strong">{account.merchant || account.merchantId}</div><div className="small muted">{account.merchantEmail}</div><div>{account.bankName} · <span className="mono">{account.accountMasked}</span></div><div>{account.accountName}</div><div className="xs muted">Ajouté le {fmtDateTime(account.createdAt)}</div><StatusBadge status={account.status} map={{ pending_verification: { label: 'En attente de vérification', tone: 'warn' } }} />{account.verifiedAt && <div className="xs muted">Vérifié le {fmtDateTime(account.verifiedAt)} · {account.verificationMethod} · {account.verificationReference}</div>}{account.rejectionReason && <div className="small">Motif : {account.rejectionReason}</div>}</div>
        {pending(account) && !list.forbidden && <div className="row-actions"><Button size="sm" variant="primary" disabled={busy} onClick={() => open(account, 'verify')}>Vérifier</Button><Button size="sm" variant="danger-outline" disabled={busy} onClick={() => open(account, 'reject')}>Rejeter</Button></div>}
      </article>)}</div>}
    </Card>
    {decision && !list.forbidden && <Modal title={verifying ? 'Vérifier le compte marchand' : 'Rejeter le compte marchand'} onClose={() => { if (!sending.current) setDecision(null); }} footer={<><Button disabled={busy} onClick={() => setDecision(null)}>Annuler</Button><Button variant={verifying ? 'primary' : 'danger-outline'} disabled={busy || !valid} loading={busy} onClick={submit}>{verifying ? 'Confirmer la vérification' : 'Confirmer le rejet'}</Button></>}>
      <div className="stack-lg"><Callout tone="info"><b>{decision.account.merchant || decision.account.merchantId}</b><div>{decision.account.bankName} · {decision.account.accountMasked}</div><div>{decision.account.accountName}</div></Callout>
        {error && <div role="alert"><Callout tone="danger">{error}</Callout></div>}
        {verifying ? <><Field label="Méthode de vérification" required><Select aria-label="Méthode de vérification" placeholder="Choisir une méthode" options={METHODS} value={form.method} onChange={field('method')} disabled={busy} /></Field><Field label="Référence de vérification" required><Input aria-label="Référence de vérification" maxLength={128} value={form.reference} onChange={field('reference')} disabled={busy} /></Field><Field label="Note interne (facultative)"><Textarea aria-label="Note de vérification" maxLength={1000} value={form.note} onChange={field('note')} disabled={busy} /></Field></> : <Field label="Motif du rejet" required hint="Entre 5 et 500 caractères."><Textarea aria-label="Motif du rejet" value={form.reason} onChange={field('reason')} disabled={busy} maxLength={500} /></Field>}
      </div>
    </Modal>}
  </div>;
}
