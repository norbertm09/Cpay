import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { salesApi } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, PageHeader, Input, Table, StatusBadge, Modal, Drawer, ConfirmDialog, KVList, Notice } from '../../components';
import { fmtDateTime, fmtRelative } from '../../utils/format';
import { errorMessage } from '../../utils/errors';

// Terminaux (app Android C-Pay) : création avec code d'appairage à 6 chiffres,
// régénération du code, renommage, désactivation.
export const Terminaux = () => {
  const list = useAsync(() => salesApi.terminals(), []);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ terminalName: '', siteName: '', deviceModel: '' });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pairing, setPairing] = useState(null);
  const [selected, setSelected] = useState(null);
  const [rename, setRename] = useState(null);
  const [toDisable, setToDisable] = useState(null);
  const [busy, setBusy] = useState(false);
  const rows = list.data?.data || [];

  const create = async (e) => {
    e?.preventDefault();
    if (form.terminalName.trim().length < 2) { setError('Nom du terminal requis.'); return; }
    setSaving(true);
    try {
      const { data } = await salesApi.createTerminal({ terminalName: form.terminalName.trim(), siteName: form.siteName.trim() || undefined, deviceModel: form.deviceModel.trim() || undefined });
      setCreating(false); setForm({ terminalName: '', siteName: '', deviceModel: '' }); setError(null);
      setPairing({ code: data.pairing_code, name: data.terminal_name, site: data.site_name });
      list.reload();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setSaving(false); }
  };
  const regenerate = async (t) => {
    setBusy(true);
    try { const { data } = await salesApi.regenerateCode(t.terminal_id); setPairing({ code: data.pairingCode, name: t.terminal_name, site: t.site_name }); setSelected(null); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const saveRename = async () => {
    if (rename.terminalName.trim().length < 2) { toast.error('Nom requis'); return; }
    setBusy(true);
    try { await salesApi.updateTerminal(rename.terminal_id, { terminalName: rename.terminalName.trim(), deviceModel: rename.deviceModel?.trim() || undefined }); toast.success('Terminal mis à jour'); setRename(null); setSelected(null); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try { await salesApi.deleteTerminal(toDisable.terminal_id); toast.success('Terminal désactivé'); setToDisable(null); setSelected(null); list.reload(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const columns = [
    { key: 'name', label: 'Terminal', mobile: 'title', render: t => <><strong>{t.terminal_name}</strong><div className="xs muted">{t.site_name || '—'} · <span className="mono">{t.terminal_code}</span></div></> },
    { key: 'pair', label: 'Appairage', render: t => t.paired_at ? <span className="success small">Appairé {fmtRelative(t.paired_at)}</span> : t.pairing_code ? <span className="badge badge-info mono">{t.pairing_code}</span> : '—' },
    { key: 'model', label: 'Appareil', render: t => [t.device_model, t.app_version && `v${t.app_version}`].filter(Boolean).join(' · ') || '—' },
    { key: 'seen', label: 'Dernière activité', render: t => t.last_seen_at ? <span title={fmtDateTime(t.last_seen_at)}>{fmtRelative(t.last_seen_at)}</span> : 'Jamais' },
    { key: 'status', label: 'Statut', mobile: 'right', render: t => <StatusBadge status={t.status} /> },
  ];

  return (
    <div className="stack-lg">
      <PageHeader title="Terminaux" subtitle="Déclarez chaque téléphone ou TPE Android équipé de l’application C-Pay et appairez-le avec son code à usage unique."
        actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Nouveau terminal</Button>} />
      <Notice tone="info">Un terminal appairé encaisse au nom de votre entreprise ; ses opérations sont identifiées dans le journal. Désactivez immédiatement un appareil perdu ou volé.</Notice>
      <Card flush>
        <Table columns={columns} rows={rows} rowKey={t => t.terminal_id} state={list.state} error={list.error} onRetry={list.reload} onRowClick={setSelected}
          empty={{ title: 'Aucun terminal déclaré', message: 'Créez un terminal pour obtenir un code d’appairage à saisir dans l’application Android.' }} emptyIcon="smartphone"
          emptyAction={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Nouveau terminal</Button>} />
      </Card>

      {creating && (
        <Modal title="Nouveau terminal" onClose={() => setCreating(false)} footer={<><Button onClick={() => setCreating(false)}>Annuler</Button><Button variant="primary" onClick={create} loading={saving}>Créer</Button></>}>
          <form onSubmit={create} noValidate>
            <Input label="Nom du terminal" value={form.terminalName} onChange={v => { setForm(p => ({ ...p, terminalName: v })); setError(null); }} placeholder="Caisse 1" error={error} required autoFocus />
            <Input label="Site / agence" value={form.siteName} onChange={v => setForm(p => ({ ...p, siteName: v }))} placeholder="Boutique Poto-Poto" />
            <Input label="Modèle de l’appareil" value={form.deviceModel} onChange={v => setForm(p => ({ ...p, deviceModel: v }))} placeholder="Samsung A14" />
            <button type="submit" className="sr-only">Créer</button>
          </form>
        </Modal>
      )}
      {pairing && (
        <Modal title="Code d’appairage" onClose={() => setPairing(null)} footer={<Button variant="primary" block onClick={() => setPairing(null)}>J’ai saisi le code</Button>}>
          <p className="small text-2 mb-3">Terminal <strong>{pairing.name}</strong>{pairing.site ? ` · ${pairing.site}` : ''}. Dans l’application C-Pay, ouvrez « Appairer ce terminal » et saisissez :</p>
          <div className="pairing-code mb-3" aria-label={`Code ${pairing.code}`}>{pairing.code}</div>
          <p className="xs muted">Ce code n’est valable qu’une fois, jusqu’à l’appairage. Vous pourrez en générer un nouveau à tout moment.</p>
        </Modal>
      )}
      {selected && (
        <Drawer title={selected.terminal_name} subtitle={selected.terminal_code} onClose={() => setSelected(null)}
          footer={<>{selected.status === 'active' && <Button variant="danger" onClick={() => setToDisable(selected)}>Désactiver</Button>}<Button icon="edit" onClick={() => setRename({ ...selected, terminalName: selected.terminal_name, deviceModel: selected.device_model || '' })}>Renommer</Button><Button variant="brand" icon="refresh" onClick={() => regenerate(selected)} loading={busy}>Nouveau code</Button></>}>
          <div className="mb-4"><StatusBadge status={selected.status} /></div>
          {!selected.paired_at && selected.pairing_code && <div className="mb-4"><p className="field-label mb-2">Code d’appairage en attente</p><div className="pairing-code">{selected.pairing_code}</div></div>}
          <KVList boxed rows={[['Site', selected.site_name], ['Appareil', selected.device_model], ['Version de l’app', selected.app_version], ['Appairé le', selected.paired_at ? fmtDateTime(selected.paired_at) : 'Non appairé'], ['Dernière activité', selected.last_seen_at ? fmtDateTime(selected.last_seen_at) : 'Jamais'], ['Créé le', fmtDateTime(selected.created_at)], ['Identifiant', selected.terminal_id, { mono: true }]]} />
          <p className="xs muted mt-3">Générer un nouveau code dissocie l’appareil actuellement appairé.</p>
        </Drawer>
      )}
      {rename && (
        <Modal title="Modifier le terminal" onClose={() => setRename(null)} footer={<><Button onClick={() => setRename(null)}>Annuler</Button><Button variant="primary" onClick={saveRename} loading={busy}>Enregistrer</Button></>}>
          <Input label="Nom du terminal" value={rename.terminalName} onChange={v => setRename(r => ({ ...r, terminalName: v }))} required autoFocus />
          <Input label="Modèle de l’appareil" value={rename.deviceModel} onChange={v => setRename(r => ({ ...r, deviceModel: v }))} />
        </Modal>
      )}
      {toDisable && <ConfirmDialog title="Désactiver le terminal" message={`Le terminal « ${toDisable.terminal_name} » ne pourra plus encaisser. Cette action est immédiate.`} confirmLabel="Désactiver" busy={busy} onConfirm={disable} onClose={() => setToDisable(null)} />}
    </div>
  );
};
export default Terminaux;
