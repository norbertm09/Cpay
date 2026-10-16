import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { integrationsApi } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, PageHeader, Input, Select, Checkbox, Table, Badge, Modal, Notice } from '../../components';
import { fmtDateTime } from '../../utils/format';
import { errorMessage } from '../../utils/errors';

const TYPES = [['accounting', 'Comptabilité'], ['crm', 'CRM'], ['erp', 'ERP'], ['webhook', 'Webhook dédié']];
const EVENTS = [['transaction.authorized', 'Transaction confirmée'], ['transaction.failed', 'Transaction échouée'], ['transaction.pending', 'Transaction en attente'], ['settlement.completed', 'Règlement effectué']];
const AUTH = [['none', 'Aucune'], ['bearer', 'Jeton Bearer'], ['basic', 'Identifiant / mot de passe'], ['api_key', 'Clé API (en-tête)']];
const typeLabel = (t) => (TYPES.find(x => x[0] === t) || [t, t])[1];
const EMPTY = { integrationType: 'accounting', provider: '', displayName: '', endpointUrl: '', authType: 'none', authConfig: { token: '', username: '', password: '', header: '', value: '' }, eventTypes: ['transaction.authorized', 'transaction.failed', 'settlement.completed'], status: 'active' };

// Connecteurs CRM / comptabilité / ERP (GET|POST|PUT /integrations) : C-Pay
// pousse les événements choisis vers l'URL du connecteur, signés avec son secret.
export const Connecteurs = () => {
  const list = useAsync(() => integrationsApi.connectors(), []);
  const [editing, setEditing] = useState(null); // objet formulaire ; .integration_id si modification
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const rows = list.data?.data || [];
  const f = k => v => { setEditing(e => ({ ...e, [k]: v })); setErrors(er => ({ ...er, [k]: undefined })); };
  const fa = k => v => setEditing(e => ({ ...e, authConfig: { ...e.authConfig, [k]: v } }));
  const open = (c) => setEditing(c ? { ...EMPTY, ...c, authConfig: { ...EMPTY.authConfig }, integrationType: c.integration_type, displayName: c.display_name, endpointUrl: c.endpoint_url || '', authType: c.auth_type || 'none', eventTypes: c.event_types || EMPTY.eventTypes } : { ...EMPTY });

  const save = async (e) => {
    e?.preventDefault();
    const er = {};
    if (editing.displayName.trim().length < 2) er.displayName = 'Nom requis.';
    if (editing.provider.trim().length < 2) er.provider = 'Fournisseur requis (ex. Sage, Odoo, HubSpot).';
    if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(editing.endpointUrl.trim())) er.endpointUrl = 'Adresse https:// requise.';
    if (!editing.eventTypes.length) er.eventTypes = 'Choisissez au moins un événement.';
    setErrors(er); if (Object.keys(er).length) return;
    setSaving(true);
    const ac = editing.authConfig;
    const authConfig = editing.authType === 'bearer' ? { token: ac.token } : editing.authType === 'basic' ? { username: ac.username, password: ac.password } : editing.authType === 'api_key' ? { header: ac.header, value: ac.value } : {};
    const body = { integrationType: editing.integrationType, provider: editing.provider.trim(), displayName: editing.displayName.trim(), endpointUrl: editing.endpointUrl.trim(), authType: editing.authType, authConfig, eventTypes: editing.eventTypes, status: editing.status };
    try {
      if (editing.integration_id) await integrationsApi.updateConnector(editing.integration_id, body); else await integrationsApi.createConnector(body);
      toast.success(editing.integration_id ? 'Connecteur mis à jour' : 'Connecteur créé'); setEditing(null); list.reload();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSaving(false); }
  };
  const toggle = async (c) => {
    try { await integrationsApi.updateConnector(c.integration_id, { integrationType: c.integration_type, provider: c.provider, displayName: c.display_name, endpointUrl: c.endpoint_url, authType: c.auth_type, eventTypes: c.event_types, status: c.status === 'active' ? 'inactive' : 'active' }); toast.success(c.status === 'active' ? 'Connecteur désactivé' : 'Connecteur activé'); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
  };
  const columns = [
    { key: 'name', label: 'Connecteur', mobile: 'title', render: c => <><strong>{c.display_name}</strong><div className="xs muted">{typeLabel(c.integration_type)} · {c.provider}</div></> },
    { key: 'url', label: 'Destination', className: 'mono', render: c => <span className="xs" style={{ wordBreak: 'break-all' }}>{c.endpoint_url || '—'}</span> },
    { key: 'ev', label: 'Événements', render: c => (c.event_types || []).length },
    { key: 'sig', label: 'Secret de signature', className: 'mono', render: c => <span className="xs">{c.signing_secret || '—'}</span> },
    { key: 'upd', label: 'Mis à jour', render: c => fmtDateTime(c.updated_at || c.created_at) },
    { key: 'status', label: 'Statut', mobile: 'right', render: c => <Badge tone={c.status === 'active' ? 'success' : 'neutral'} dot>{c.status === 'active' ? 'Actif' : 'Inactif'}</Badge> },
    { key: 'act', label: '', mobile: 'actions', render: c => <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}><Button size="sm" onClick={() => open(c)}>Modifier</Button><Button size="sm" variant={c.status === 'active' ? 'danger' : 'brand'} onClick={() => toggle(c)}>{c.status === 'active' ? 'Désactiver' : 'Activer'}</Button></span> },
  ];
  return (
    <div className="stack-lg">
      <PageHeader title="Connecteurs" subtitle="Envoyez automatiquement vos transactions et règlements à votre logiciel de comptabilité, votre CRM ou votre ERP."
        actions={<Button variant="primary" icon="plus" onClick={() => open(null)}>Nouveau connecteur</Button>} />
      <Notice tone="neutral">Chaque livraison porte l’en-tête <code>X-CPay-Signature</code> (HMAC-SHA256). Le secret de signature d’un connecteur n’est pas consultable depuis le portail (seul son préfixe est affiché) : il vous est remis par le support lors de la mise en service.</Notice>
      <Card flush>
        <Table columns={columns} rows={rows} rowKey={c => c.integration_id} state={list.state} error={list.error} onRetry={list.reload}
          empty={{ title: 'Aucun connecteur', message: 'Créez un connecteur pour synchroniser vos encaissements avec vos outils métier.' }} emptyIcon="grid"
          emptyAction={<Button variant="primary" icon="plus" onClick={() => open(null)}>Nouveau connecteur</Button>} />
      </Card>
      {editing && (
        <Modal title={editing.integration_id ? 'Modifier le connecteur' : 'Nouveau connecteur'} onClose={() => setEditing(null)} size="lg"
          footer={<><Button onClick={() => setEditing(null)}>Annuler</Button><Button variant="primary" onClick={save} loading={saving}>Enregistrer</Button></>}>
          <form onSubmit={save} noValidate>
            <div className="form-grid">
              <Select label="Type" value={editing.integrationType} onChange={f('integrationType')} options={TYPES.map(([v, l]) => ({ value: v, label: l }))} required />
              <Input label="Fournisseur" value={editing.provider} onChange={f('provider')} placeholder="Sage, Odoo, HubSpot…" error={errors.provider} required />
            </div>
            <Input label="Nom affiché" value={editing.displayName} onChange={f('displayName')} placeholder="Compta Sage – boutique" error={errors.displayName} required autoFocus />
            <Input label="URL de réception" type="url" value={editing.endpointUrl} onChange={f('endpointUrl')} placeholder="https://…" error={errors.endpointUrl} required />
            <Select label="Authentification" value={editing.authType} onChange={f('authType')} options={AUTH.map(([v, l]) => ({ value: v, label: l }))} />
            {editing.authType === 'bearer' && <Input label="Jeton" value={editing.authConfig.token} onChange={fa('token')} mono hint={editing.integration_id ? 'Laissez vide pour conserver le jeton actuel.' : undefined} />}
            {editing.authType === 'basic' && <div className="form-grid"><Input label="Identifiant" value={editing.authConfig.username} onChange={fa('username')} /><Input label="Mot de passe" type="password" value={editing.authConfig.password} onChange={fa('password')} /></div>}
            {editing.authType === 'api_key' && <div className="form-grid"><Input label="Nom de l’en-tête" value={editing.authConfig.header} onChange={fa('header')} placeholder="X-Api-Key" /><Input label="Valeur" value={editing.authConfig.value} onChange={fa('value')} mono /></div>}
            <p className="field-label mb-2">Événements à envoyer</p>
            <div className="stack mb-3">{EVENTS.map(([v, l]) => <Checkbox key={v} checked={editing.eventTypes.includes(v)} onChange={on => setEditing(e => ({ ...e, eventTypes: on ? [...e.eventTypes, v] : e.eventTypes.filter(x => x !== v) }))}>{l} <span className="muted mono xs">{v}</span></Checkbox>)}</div>
            {errors.eventTypes && <p className="err small mb-3" role="alert">{errors.eventTypes}</p>}
            <Checkbox checked={editing.status === 'active'} onChange={on => f('status')(on ? 'active' : 'inactive')}>Connecteur actif</Checkbox>
            <button type="submit" className="sr-only">Enregistrer</button>
          </form>
        </Modal>
      )}
    </div>
  );
};
export default Connecteurs;
