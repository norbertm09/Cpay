import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { integrationsApi } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, PageHeader, Input, Checkbox, Table, Badge, Modal, ConfirmDialog, Notice, CopyRow } from '../../components';
import { fmtDateTime, fmtRelative } from '../../utils/format';
import { errorMessage } from '../../utils/errors';

const PERMS = [['collect', 'Encaissement'], ['disburse', 'Décaissement'], ['transactions', 'Transactions'], ['pay_links', 'Liens de paiement']];
const permLabel = (p) => (PERMS.find(x => x[0] === p) || [p, p])[1];

// Clés API : la clé et le secret sont affichés UNE SEULE FOIS à la création.
export const ClesApi = () => {
  const list = useAsync(() => integrationsApi.apiKeys(), []);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ keyName: '', permissions: ['collect', 'transactions', 'pay_links'] });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState(null);
  const [confirm, setConfirm] = useState(null); // { key, action: 'revoke' | 'delete' }
  const [busy, setBusy] = useState(false);
  const rows = list.data?.data || [];

  const create = async (e) => {
    e?.preventDefault();
    if (form.keyName.trim().length < 2) { setError('Nom de la clé requis.'); return; }
    if (!form.permissions.length) { setError('Choisissez au moins une permission.'); return; }
    setSaving(true);
    try { const { data } = await integrationsApi.createApiKey({ keyName: form.keyName.trim(), permissions: form.permissions }); setCreated(data.key); setCreating(false); setForm({ keyName: '', permissions: ['collect', 'transactions', 'pay_links'] }); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setSaving(false); }
  };
  const doConfirm = async () => {
    setBusy(true);
    try {
      if (confirm.action === 'revoke') { await integrationsApi.revokeApiKey(confirm.key.key_id); toast.success('Clé révoquée'); }
      else { await integrationsApi.deleteApiKey(confirm.key.key_id); toast.success('Clé supprimée'); }
      setConfirm(null); list.reload();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const columns = [
    { key: 'name', label: 'Clé', mobile: 'title', render: k => <><strong>{k.key_name}</strong><div className="xs muted mono">{(k.key_prefix || '').replace(/\*+$/, '')}••••••••</div></> },
    { key: 'perms', label: 'Permissions', render: k => <span className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{(k.permissions || []).map(p => <Badge key={p} tone="info">{permLabel(p)}</Badge>)}</span> },
    { key: 'used', label: 'Dernière utilisation', render: k => k.last_used_at ? <span title={fmtDateTime(k.last_used_at)}>{fmtRelative(k.last_used_at)}</span> : 'Jamais' },
    { key: 'created', label: 'Créée', render: k => fmtDateTime(k.created_at) },
    { key: 'status', label: 'Statut', mobile: 'right', render: k => <span className="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}><Badge tone={k.is_active ? 'success' : 'neutral'} dot>{k.is_active ? 'Active' : 'Révoquée'}</Badge>{k.legacy_plaintext && <Badge tone="warn" title="Clé créée avant le hachage : révoquez-la et créez-en une nouvelle.">À renouveler</Badge>}</span> },
    { key: 'act', label: '', mobile: 'actions', render: k => k.is_active ? <Button size="sm" variant="danger" onClick={() => setConfirm({ key: k, action: 'revoke' })}>Révoquer</Button> : <Button size="sm" icon="trash" onClick={() => setConfirm({ key: k, action: 'delete' })}>Supprimer</Button> },
  ];
  return (
    <div className="stack-lg">
      <PageHeader title="Clés API" subtitle="Authentifiez vos applications et plugins auprès de l’API C-Pay. La clé et le secret ne sont affichés qu’une seule fois, à la création."
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Nouvelle clé</Button>} />
      <Card title="Utilisation" subtitle="En-têtes à joindre à chaque appel de l’API publique">
        <pre className="code-block">{`curl https://api.c-pay.global/api/v1/merchant/public/transactions \\
  -H "X-API-Key: sk_live_…" \\
  -H "X-API-Secret: sk_secret_…"`}</pre>
        <p className="xs muted mt-2">Documentation complète : <a href="https://c-pay.global/developers" target="_blank" rel="noreferrer">c-pay.global/developers</a>. Le secret ne doit jamais être exposé dans une application mobile ou un navigateur.</p>
      </Card>
      <Card flush>
        <Table columns={columns} rows={rows} rowKey={k => k.key_id} state={list.state} error={list.error} onRetry={list.reload}
          empty={{ title: 'Aucune clé API', message: 'Créez une clé pour connecter votre site, votre application ou le plugin WooCommerce.' }} emptyIcon="key"
          emptyAction={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Nouvelle clé</Button>} />
      </Card>
      {creating && (
        <Modal title="Nouvelle clé API" onClose={() => setCreating(false)} footer={<><Button onClick={() => setCreating(false)}>Annuler</Button><Button variant="primary" onClick={create} loading={saving}>Créer la clé</Button></>}>
          <form onSubmit={create} noValidate>
            <Input label="Nom de la clé" value={form.keyName} onChange={v => { setForm(p => ({ ...p, keyName: v })); setError(null); }} placeholder="Site WooCommerce" error={error} required autoFocus />
            <p className="field-label mb-2">Permissions</p>
            <div className="stack mb-4">{PERMS.map(([v, l]) => <Checkbox key={v} checked={form.permissions.includes(v)} onChange={on => setForm(p => ({ ...p, permissions: on ? [...p.permissions, v] : p.permissions.filter(x => x !== v) }))}>{l}</Checkbox>)}</div>
            <button type="submit" className="sr-only">Créer</button>
          </form>
        </Modal>
      )}
      {created && (
        <Modal title="Clé créée" onClose={() => setCreated(null)} locked footer={<Button variant="primary" block onClick={() => setCreated(null)}>J’ai enregistré ces identifiants</Button>}>
          <Notice tone="warn" className="mb-4">Enregistrez ces informations maintenant : elles ne seront plus jamais affichées.</Notice>
          <div className="kv-box"><CopyRow label="Clé API (X-API-Key)" value={created.api_key} /><CopyRow label="Secret (X-API-Secret)" value={created.api_secret} /></div>
        </Modal>
      )}
      {confirm && <ConfirmDialog title={confirm.action === 'revoke' ? 'Révoquer la clé' : 'Supprimer la clé'} message={confirm.action === 'revoke' ? `Les applications utilisant « ${confirm.key.key_name} » cesseront immédiatement de fonctionner.` : `La clé révoquée « ${confirm.key.key_name} » sera définitivement supprimée de la liste.`} confirmLabel={confirm.action === 'revoke' ? 'Révoquer' : 'Supprimer'} busy={busy} onConfirm={doConfirm} onClose={() => setConfirm(null)} />}
    </div>
  );
};
export default ClesApi;
