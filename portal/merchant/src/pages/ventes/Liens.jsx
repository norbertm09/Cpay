import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { QRCodeSVG } from 'qrcode.react';
import { salesApi, newIdempotencyKey } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { usePagination } from '../../hooks/usePagination';
import { Button, Card, PageHeader, Input, Select, AmountInput, Segmented, Table, StatusBadge, Stat, Modal, Drawer, ConfirmDialog, Pagination, Notice, KVList } from '../../components';
import { fmtMoney, fmtDateTime, fmtRelative, fmtPhone, phoneDigits, isIntegerCurrency } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { copyText, shareOrCopy } from '../../utils/actions';

const PAGE = 20;
const FILTERS = [['', 'Tous'], ['pending', 'En attente'], ['paid', 'Payés'], ['expired', 'Expirés'], ['cancelled', 'Annulés']];

// Liens de paiement & QR : création, envoi (SMS / WhatsApp), annulation.
export const Liens = () => {
  const { user } = useAuth();
  const currency = user?.currency || 'XAF';
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(params.get('nouveau') === '1');
  const [form, setForm] = useState({ amount: '', description: '', expiresIn: '24', recipientPhone: '', channel: 'sms', paymentMethod: 'card' });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState(null);
  const [selected, setSelected] = useState(null);
  const [send, setSend] = useState(null);
  const [sendPhone, setSendPhone] = useState('');
  const [sendChannel, setSendChannel] = useState('sms');
  const [sending, setSending] = useState(false);
  const [toCancel, setToCancel] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const pager = usePagination(PAGE);
  const list = useAsync(() => salesApi.payLinks({ page: pager.page + 1, limit: PAGE, status: status || undefined }).then(r => { pager.setTotal(r.data?.total || 0); return r; }), [status, pager.page]);
  const stats = useAsync(() => salesApi.payLinkStats(), []);
  useEffect(() => { if (params.get('nouveau')) { params.delete('nouveau'); setParams(params, { replace: true }); } }, [params, setParams]);

  const f = k => v => { setForm(p => ({ ...p, [k]: v })); setErrors(e => ({ ...e, [k]: undefined })); };
  const create = async (e) => {
    e?.preventDefault();
    const er = {};
    const amt = Number(form.amount);
    if (!(amt > 0)) er.amount = 'Saisissez un montant.';
    else if (isIntegerCurrency(currency) && amt < 100) er.amount = `Montant minimum 100 ${currency}.`;
    const h = parseInt(form.expiresIn, 10);
    if (!(h >= 1 && h <= 720)) er.expiresIn = 'Entre 1 et 720 heures.';
    if (form.recipientPhone && phoneDigits(form.recipientPhone).length < 8) er.recipientPhone = 'Numéro invalide (format international).';
    setErrors(er); if (Object.keys(er).length) return;
    setSaving(true);
    try {
      const { data } = await salesApi.createPayLink({ amount: amt, description: form.description || undefined, expiresIn: h, recipientPhone: form.recipientPhone.replace(/\s/g, '') || undefined, channel: form.channel, payment_method: form.paymentMethod }, newIdempotencyKey());
      setCreated(data.link || data); setCreating(false);
      setForm({ amount: '', description: '', expiresIn: '24', recipientPhone: '', channel: 'sms', paymentMethod: 'card' });
      list.reload(); stats.reload();
      toast.success(form.recipientPhone ? 'Lien créé et envoyé' : 'Lien créé');
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSaving(false); }
  };
  const doSend = async () => {
    if (phoneDigits(sendPhone).length < 8) { toast.error('Numéro invalide'); return; }
    setSending(true);
    try { await salesApi.sendPayLink(send.pay_link_id, { phone: sendPhone.replace(/\s/g, ''), channel: sendChannel }); toast.success(`Lien envoyé par ${sendChannel === 'whatsapp' ? 'WhatsApp' : 'SMS'}`); setSend(null); setSendPhone(''); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setSending(false); }
  };
  const doCancel = async () => {
    setCancelling(true);
    try { await salesApi.cancelPayLink(toCancel.pay_link_id); toast.success('Lien annulé'); setToCancel(null); setSelected(null); list.reload(); stats.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setCancelling(false); }
  };

  const columns = [
    { key: 'desc', label: 'Lien', mobile: 'title', render: l => <><strong>{l.description || 'Paiement'}</strong><div className="xs muted mono">{(l.short_url || '').replace(/^https?:\/\//, '')}</div></> },
    { key: 'amount', label: 'Montant', num: true, mobile: 'right', render: l => <strong>{fmtMoney(l.amount, l.currency || currency)}</strong> },
    { key: 'created', label: 'Créé', render: l => <span title={fmtDateTime(l.created_at)}>{fmtRelative(l.created_at)}</span> },
    { key: 'to', label: 'Destinataire', render: l => l.recipient_phone ? fmtPhone(l.recipient_phone) : '—' },
    { key: 'exp', label: 'Expire', render: l => l.status === 'pending' ? fmtDateTime(l.expires_at) : l.paid_at ? `Payé ${fmtRelative(l.paid_at)}` : '—' },
    { key: 'status', label: 'Statut', render: l => <StatusBadge status={l.status} /> },
  ];
  const s = stats.data || {};
  const QrView = ({ link }) => (
    <div className="center">
      <div className="qr-box mb-3"><QRCodeSVG value={link.short_url || ''} size={200} level="M" /></div>
      <p className="small mono mb-3" style={{ wordBreak: 'break-all' }}><a href={link.short_url} target="_blank" rel="noreferrer">{link.short_url}</a></p>
      <div className="form-actions">
        <Button icon="copy" onClick={() => copyText(link.short_url, 'Lien copié')}>Copier</Button>
        <Button variant="brand" icon="share" onClick={() => shareOrCopy({ title: 'Paiement C-Pay', text: `Payer ${fmtMoney(link.amount, link.currency || currency)}`, url: link.short_url })}>Partager</Button>
        {link.status === 'pending' && <Button icon="send" onClick={() => { setSend(link); setSendPhone(link.recipient_phone || ''); }}>Envoyer</Button>}
      </div>
    </div>
  );

  return (
    <div className="stack-lg">
      <PageHeader title="Liens & QR" subtitle="Créez un lien de paiement sécurisé (pay.c-pay.global) ou un QR code à présenter au client, envoyez-le par SMS ou WhatsApp."
        actions={<Button variant="primary" icon="plus" onClick={() => { setCreating(true); setCreated(null); }}>Créer un lien</Button>} />
      {stats.state === 'ok' && (
        <div className="stat-row">
          <Card><Stat label="En attente" value={s.pending ?? 0} /></Card>
          <Card><Stat label="Payés" value={s.paid ?? 0} tone="success" /></Card>
          <Card><Stat label="Encaissé via liens" value={fmtMoney(s.total_collected, currency)} tone="success" /></Card>
          <Card><Stat label="Expirés / annulés" value={(Number(s.expired) || 0) + (Number(s.cancelled) || 0)} /></Card>
        </div>
      )}
      {created && (
        <Card title="Lien créé" actions={<Button size="sm" variant="ghost" onClick={() => setCreated(null)}>Fermer</Button>}>
          <p className="center strong mb-3">{fmtMoney(created.amount, created.currency || currency)}{created.description ? ` · ${created.description}` : ''}</p>
          <QrView link={created} />
          {created.expires_at && <p className="xs muted center mt-3">Expire le {fmtDateTime(created.expires_at)}</p>}
        </Card>
      )}
      <Card flush>
        <div style={{ padding: 'var(--s4) var(--s4) 0' }}>
          <div className="chips" role="group" aria-label="Filtrer par statut">{FILTERS.map(([v, l]) => <button key={v} type="button" className="chip" aria-pressed={status === v} onClick={() => { setStatus(v); pager.reset(); }}>{l}</button>)}</div>
        </div>
        <div className="mt-3">
          <Table columns={columns} rows={list.data?.data || []} rowKey={l => l.pay_link_id} state={list.state} error={list.error} onRetry={list.reload} onRowClick={setSelected}
            empty={{ title: 'Aucun lien de paiement', message: 'Créez un lien pour encaisser à distance ou présenter un QR code en caisse.' }} emptyIcon="link"
            emptyAction={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Créer un lien</Button>} footer={<Pagination pager={pager} unit="lien" />} />
        </div>
      </Card>

      {creating && (
        <Modal title="Créer un lien de paiement" onClose={() => setCreating(false)} footer={<><Button onClick={() => setCreating(false)}>Annuler</Button><Button variant="primary" onClick={create} loading={saving}>Créer le lien</Button></>}>
          <form onSubmit={create} noValidate>
            <AmountInput label="Montant" value={form.amount} onChange={f('amount')} currency={currency} error={errors.amount} autoFocus />
            <Segmented compact value={form.paymentMethod} onChange={f('paymentMethod')} ariaLabel="Moyen de paiement" options={[{ value: 'card', icon: 'card', label: 'Carte' }, { value: 'mobile_money', icon: 'smartphone', label: 'Mobile Money' }]} />
            <Input label="Description" value={form.description} onChange={f('description')} placeholder="Commande n° 001" hint="Affichée au client sur la page de paiement." />
            <div className="form-grid">
              <Input label="Validité (heures)" type="number" inputMode="numeric" min="1" max="720" value={form.expiresIn} onChange={f('expiresIn')} error={errors.expiresIn} />
              <Select label="Canal d’envoi" value={form.channel} onChange={f('channel')} options={[{ value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }]} />
            </div>
            <Input label="Téléphone du client (facultatif)" type="tel" inputMode="tel" value={form.recipientPhone} onChange={f('recipientPhone')} placeholder="+242 06 123 45 67" error={errors.recipientPhone} hint="Si renseigné, le lien est envoyé immédiatement." />
            <button type="submit" className="sr-only">Créer</button>
          </form>
        </Modal>
      )}
      {selected && (
        <Drawer title={selected.description || 'Lien de paiement'} subtitle={`Créé ${fmtRelative(selected.created_at)} · ${fmtDateTime(selected.created_at)}`} onClose={() => setSelected(null)}
          footer={selected.status === 'pending' ? <Button variant="danger" onClick={() => setToCancel(selected)}>Annuler ce lien</Button> : null}>
          <div className="row-between mb-4"><span style={{ fontSize: 'var(--fs-2xl)', fontWeight: 700 }}>{fmtMoney(selected.amount, selected.currency || currency)}</span><StatusBadge status={selected.status} /></div>
          {selected.status === 'pending' && <QrView link={selected} />}
          <div className="mt-4"><KVList boxed rows={[['Identifiant court', selected.short_id, { mono: true }], ['Adresse', selected.short_url, { mono: true }], ['Moyen', selected.payment_method === 'mobile_money' ? 'Mobile Money' : 'Carte'], ['Expire le', fmtDateTime(selected.expires_at)], selected.paid_at && ['Payé le', fmtDateTime(selected.paid_at)], selected.paid_amount && ['Montant payé', fmtMoney(selected.paid_amount, currency)], selected.recipient_phone && ['Destinataire', fmtPhone(selected.recipient_phone)], selected.send_channel && ['Canal', selected.send_channel === 'whatsapp' ? 'WhatsApp' : 'SMS']]} /></div>
        </Drawer>
      )}
      {send && (
        <Modal title="Envoyer le lien" onClose={() => setSend(null)} footer={<><Button onClick={() => setSend(null)}>Annuler</Button><Button variant="primary" icon="send" onClick={doSend} loading={sending}>Envoyer</Button></>}>
          <Notice tone="info" className="mb-4">Le client recevra un message avec le montant ({fmtMoney(send.amount, currency)}) et le lien de paiement.</Notice>
          <Segmented compact value={sendChannel} onChange={setSendChannel} ariaLabel="Canal" options={[{ value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }]} />
          <Input label="Numéro du client" type="tel" inputMode="tel" value={sendPhone} onChange={setSendPhone} placeholder="+242 06 123 45 67" autoFocus required />
        </Modal>
      )}
      {toCancel && <ConfirmDialog title="Annuler le lien" message={`Le lien de ${fmtMoney(toCancel.amount, currency)} ne pourra plus être payé. Cette action est définitive.`} confirmLabel="Annuler le lien" busy={cancelling} onConfirm={doCancel} onClose={() => setToCancel(null)} />}
    </div>
  );
};
export default Liens;
