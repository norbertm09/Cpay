import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Drawer, Modal, Button, KeyValue, StatusBadge, Badge, Skeleton, ErrorState, Field, Input, Textarea, Callout } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useAuth } from '../../hooks/useAuth';
import { cashApi } from '../../services/api';
import { fmtMoney, fmtDateTime } from '../../utils/format';
import { directionOf } from '../../utils/status';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';
import CashTransferRecovery, { hasUncertainOutcome } from './CashTransferRecovery';

const MANUAL = ['pending_manual', 'pending_settlement'];

// Journal des événements JSONB du transfert ({ at, type|status, by, ...détails })
const Events = ({ events }) => {
  if (!events?.length) return <div className="muted small">Aucun événement enregistré.</div>;
  const HIDDEN = ['at', 'type', 'status', 'by', 'action'];
  return (
    <div className="timeline">
      {events.map((e, i) => {
        const extras = Object.entries(e || {}).filter(([k, v]) => !HIDDEN.includes(k) && v !== null && v !== undefined && v !== '');
        return (
          <div key={i} className="timeline-item">
            <span className="timeline-dot" style={{ background: e.type === 'rejected' || e.status === 'rejected' ? 'var(--error)' : e.type === 'completed' || e.status === 'completed' ? 'var(--success)' : 'var(--border-strong)' }} />
            <div>
              <div><b>{e.action || e.type || e.status || 'événement'}</b>{e.by && <span className="muted"> · {e.by}</span>}</div>
              {extras.length > 0 && <div className="muted" style={{ wordBreak: 'break-word' }}>{extras.map(([k, v]) => `${k} : ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</div>}
              <div className="xs muted">{fmtDateTime(e.at)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// Détail + actions §8 : confirm-funds, mark-executed, reject.
export default function CashTransferDrawer({ id, initial, onClose, onChanged }) {
  const { hasRole } = useAuth();
  const canAct = hasRole(PERMS.ops);
  const { data, loading, error, reload } = useQuery(() => cashApi.transfer(id).then((r) => r.data), [id]);
  const t = data || initial;
  const [action, setAction] = useState(null);
  const [form, setForm] = useState({ amountReceived: '', bankReference: '', reason: '', note: '' });
  const [busy, setBusy] = useState(false);

  if (!t && loading) return <Drawer title="Transfert" onClose={onClose}><Skeleton lines={8} /></Drawer>;
  if (!t) return <Drawer title="Transfert" onClose={onClose}><ErrorState error={error} onRetry={reload} /></Drawer>;

  const dir = directionOf(t);
  const cur = t.currency;
  const openAction = (a) => { setForm({ amountReceived: String(t.amount ?? ''), bankReference: '', reason: '', note: '' }); setAction(a); };
  const run = async () => {
    setBusy(true);
    try {
      if (action === 'confirm') {
        const amt = Number(form.amountReceived);
        if (!(amt > 0)) throw new Error('Montant reçu invalide');
        if (!form.bankReference.trim()) throw new Error('Référence bancaire requise');
        await cashApi.confirmFunds(id, { amountReceived: amt, bankReference: form.bankReference.trim(), note: form.note || undefined });
        toast.success('Réception confirmée : le solde du marchand est crédité.');
      } else if (action === 'execute') {
        if (!form.bankReference.trim()) throw new Error('Référence bancaire requise');
        await cashApi.markExecuted(id, { bankReference: form.bankReference.trim(), note: form.note || undefined });
        toast.success('Virement marqué comme exécuté.');
      } else {
        if (form.reason.trim().length < 3) throw new Error('Indiquez un motif');
        await cashApi.reject(id, form.reason.trim());
        toast.success('Transfert rejeté, fonds libérés.');
      }
      setAction(null); reload(); onChanged?.();
    } catch (e) { toast.error(e.response ? errorMessage(e, 'Action refusée') : e.message); }
    finally { setBusy(false); }
  };

  const TITLES = { confirm: 'Confirmer la réception des fonds', execute: 'Marquer le virement exécuté', reject: 'Rejeter le transfert' };
  const actionable = canAct && !loading && !error && !t.needsReview && (t.status === 'awaiting_funds' || MANUAL.includes(t.status));

  return (
    <Drawer title={`${dir.label} · ${t.reference || ''}`} sub={`${fmtMoney(t.amount, cur)} · créé le ${fmtDateTime(t.createdAt)}`} onClose={onClose}
      footer={actionable ? <>
        <Button variant="danger-outline" icon="x" onClick={() => openAction('reject')}>Rejeter</Button>
        {t.status === 'awaiting_funds' && <Button variant="success" icon="check" onClick={() => openAction('confirm')}>Confirmer la réception</Button>}
        {MANUAL.includes(t.status) && <Button variant="primary" icon="check" onClick={() => openAction('execute')}>Marquer exécuté</Button>}
      </> : null}>
      <div className="stack-lg">
        <div className="row-wrap"><StatusBadge status={t.status} /><Badge tone={dir.tone}>{dir.label}</Badge>{loading && <span className="xs muted">actualisation…</span>}</div>
        {error && <div role="alert"><ErrorState error={errorMessage(error)} onRetry={reload} /></div>}
        <CashTransferRecovery transfer={t} />
        <KeyValue rows={[
          ['Marchand', t.merchantId ? <Link to={`/marchands/${t.merchantId}?tab=caisse`} onClick={onClose}>{t.merchant || t.merchantId}</Link> : t.merchant],
          ['E-mail marchand', t.merchantEmail],
          ['Montant', fmtMoney(t.amount, cur)], ['Frais', fmtMoney(t.fee, cur)], [hasUncertainOutcome(t) ? 'Net prévu' : 'Net', fmtMoney(t.net, cur)],
          t.amountRequested !== undefined ? ['Montant demandé', fmtMoney(t.amountRequested, cur)] : null,
          ['Description', t.description],
          ['Référence bancaire', t.bankReference], ['Référence opérateur', t.gatewayReference],
          ['Exécuté par', t.executedBy], ['Note admin', t.adminNote],
          ['Terminé le', fmtDateTime(t.completedAt)], t.expiresAt ? ['Expire le', fmtDateTime(t.expiresAt)] : null, t.cancelledAt ? ['Annulé le', fmtDateTime(t.cancelledAt)] : null,
          t.errorMessage ? ['Motif / erreur', <span className="error">{t.errorMessage}</span>] : null,
        ]} />
        {t.bankAccount && (<div><h3 className="mb-2">Compte bancaire du marchand</h3><KeyValue rows={[['Banque', t.bankAccount.bankName], ['Intitulé', t.bankAccount.accountName], ['Compte', <span className="mono">{t.bankAccount.accountNumber || t.bankAccount.accountMasked}</span>]]} /></div>)}
        {t.wallet && (<div><h3 className="mb-2">Wallet du marchand</h3><KeyValue rows={[['Opérateur', t.wallet.operator], ['Numéro', t.wallet.phone]]} /></div>)}
        {t.instructions && (<div><h3 className="mb-2">Instructions de virement (ordre d’approvisionnement)</h3>
          <KeyValue rows={[['Banque', t.instructions.bankName], ['Intitulé', t.instructions.accountName], ['Numéro de compte', <span className="mono">{t.instructions.accountNumber}</span>], ['IBAN', t.instructions.iban], ['SWIFT', t.instructions.swift], ['Référence à indiquer', <b>{t.instructions.reference || t.reference}</b>], ['Expire le', fmtDateTime(t.instructions.expiresAt)]]} /></div>)}
        <div><h3 className="mb-2">Journal des changements</h3><Events events={t.events} /></div>
      </div>

      {action && actionable && (
        <Modal title={TITLES[action]} sub={`${t.reference} · ${fmtMoney(t.amount, cur)} · ${t.merchant || ''}`} onClose={busy ? undefined : () => setAction(null)} size="sm"
          footer={<><Button onClick={() => setAction(null)} disabled={busy}>Annuler</Button><Button variant={action === 'reject' ? 'danger' : 'success'} loading={busy} onClick={run}>{action === 'reject' ? 'Confirmer le rejet' : 'Confirmer'}</Button></>}>
          <div className="stack">
            {action === 'confirm' && <>
              <Field label={`Montant reçu (${cur || 'devise du marchand'})`} required><Input type="number" inputMode="decimal" value={form.amountReceived} onChange={(v) => setForm((f) => ({ ...f, amountReceived: v }))} /></Field>
              <Field label="Référence du virement reçu" required><Input value={form.bankReference} onChange={(v) => setForm((f) => ({ ...f, bankReference: v }))} placeholder="Libellé / référence bancaire" /></Field>
              <Field label="Note interne"><Input value={form.note} onChange={(v) => setForm((f) => ({ ...f, note: v }))} /></Field>
              <Callout tone="info">Le solde du marchand est crédité immédiatement du montant reçu. Un écart avec le montant demandé est tracé.</Callout>
            </>}
            {action === 'execute' && <>
              <Field label="Référence du virement émis" required><Input value={form.bankReference} onChange={(v) => setForm((f) => ({ ...f, bankReference: v }))} placeholder="Référence bancaire" /></Field>
              <Field label="Note interne"><Input value={form.note} onChange={(v) => setForm((f) => ({ ...f, note: v }))} /></Field>
              <Callout tone="info">À utiliser une fois le virement réellement émis par la banque de C-Pay. Le marchand est notifié par e-mail.</Callout>
            </>}
            {action === 'reject' && <>
              <Callout tone="error">Action irréversible : le transfert passe en « Rejeté » et les fonds réservés sont libérés sur le solde du marchand, qui reçoit le motif.</Callout>
              <Field label="Motif (visible par le marchand)" required><Textarea value={form.reason} onChange={(v) => setForm((f) => ({ ...f, reason: v }))} placeholder="ex. virement non reçu après expiration" rows={3} /></Field>
            </>}
          </div>
        </Modal>
      )}
    </Drawer>
  );
}
