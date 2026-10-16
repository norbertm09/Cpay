import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { accountApi } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, PageHeader, Input, Select, KVList, Badge, StatusBadge, SkeletonCard, ErrorState, Notice, Table, Icon } from '../../components';
import { fmtDateTime, fmtPhone } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { countryName, statusLabel } from '../../utils/labels';
import { readFileAsDataUrl } from '../../utils/actions';

const DOC_TYPES = [
  ['rccm', 'RCCM / Registre de commerce'], ['nif', 'NIF / Identifiant fiscal'], ['id_card', 'Pièce d’identité du dirigeant'],
  ['bank_details', 'RIB / Coordonnées bancaires'], ['address_proof', 'Justificatif d’adresse'], ['contract', 'Contrat signé'],
];
const docLabel = (t) => (DOC_TYPES.find(d => d[0] === t) || [t, t])[1];

// Profil & KYB : informations de l'entreprise (GET /account), coordonnées du
// responsable (PUT /account), documents KYB (GET /kyb, POST /kyb/documents).
export const Profil = () => {
  const { reloadUser } = useAuth();
  const account = useAsync(() => accountApi.get(), []);
  const docs = useAsync(() => accountApi.kyb(), []);
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [upload, setUpload] = useState({ docType: 'rccm', file: null });
  const [uploading, setUploading] = useState(false);
  const a = account.data || {};
  useEffect(() => { if (account.data) setForm({ firstName: account.data.first_name || '', lastName: account.data.last_name || '', phone: account.data.phone || '' }); }, [account.data]);

  const save = async (e) => {
    e.preventDefault();
    if (form.phone && !/^\+?[0-9 ]{8,16}$/.test(form.phone.trim())) { toast.error('Numéro de téléphone invalide'); return; }
    setSaving(true);
    try { await accountApi.update({ firstName: form.firstName.trim() || undefined, lastName: form.lastName.trim() || undefined, phone: form.phone.replace(/\s/g, '') || undefined }); toast.success('Profil enregistré'); account.reload(); reloadUser(); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setSaving(false); }
  };
  const onFile = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    try { const read = await readFileAsDataUrl(file); setUpload(u => ({ ...u, file: read })); } catch (err) { toast.error(err.message); }
  };
  const submitDoc = async () => {
    if (!upload.file) { toast.error('Sélectionnez un fichier'); return; }
    setUploading(true);
    try {
      await accountApi.uploadKybDocument({ docType: upload.docType, docLabel: docLabel(upload.docType), fileUrl: upload.file.url, fileName: upload.file.name, fileSize: upload.file.size, mimeType: upload.file.type });
      toast.success('Document transmis à l’équipe conformité'); setUpload({ docType: 'rccm', file: null }); docs.reload();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setUploading(false); }
  };
  const list = docs.data?.documents || [];
  const approved = list.filter(d => d.status === 'approved').length;
  const docCols = [
    { key: 'type', label: 'Document', mobile: 'title', render: d => <><strong>{docLabel(d.doc_type)}</strong><div className="xs muted">{d.file_name}</div></> },
    { key: 'date', label: 'Transmis le', render: d => fmtDateTime(d.uploaded_at) },
    { key: 'review', label: 'Examiné le', render: d => d.reviewed_at ? fmtDateTime(d.reviewed_at) : '—' },
    { key: 'status', label: 'Statut', mobile: 'right', render: d => <><StatusBadge status={d.status} />{d.rejection_reason && <div className="xs error mt-2">{d.rejection_reason}</div>}</> },
  ];

  return (
    <div className="stack-lg">
      <PageHeader title="Profil & KYB" subtitle="Informations de votre entreprise, coordonnées du responsable et dossier de conformité (KYB)." />
      {account.state === 'loading' ? <SkeletonCard lines={5} /> : account.state === 'error' ? <Card><ErrorState error={account.error} onRetry={account.reload} /></Card> : (
        <div className="grid-2">
          <Card title="Entreprise" subtitle="Modifiable par le support uniquement">
            <KVList rows={[['Nom commercial', a.business_name], ['Identifiant marchand', String(a.merchant_id || '').slice(-8).toUpperCase(), { mono: true }], ['Pays', countryName(a.country)], ['Devise', a.currency], ['RCCM', a.rccm || 'Non renseigné'], ['NIF', a.nif || 'Non renseigné'], ['Statut du compte', <StatusBadge status={a.merchant_status} />], ['Niveau KYB', <Badge tone={(a.kyb_level || 0) >= 2 ? 'success' : 'warn'}>Niveau {a.kyb_level ?? 0}</Badge>], a.kyb_status && ['Dossier KYB', statusLabel(a.kyb_status)], ['Membre depuis', fmtDateTime(a.created_at)]]} />
            <p className="xs muted mt-3">Pour modifier le nom, le RCCM ou le NIF, contactez le support avec un justificatif.</p>
          </Card>
          <Card title="Responsable du compte">
            <form onSubmit={save} noValidate>
              <div className="form-grid"><Input label="Prénom" value={form.firstName} onChange={v => setForm(p => ({ ...p, firstName: v }))} autoComplete="given-name" /><Input label="Nom" value={form.lastName} onChange={v => setForm(p => ({ ...p, lastName: v }))} autoComplete="family-name" /></div>
              <Input label="Adresse e-mail" value={a.email || ''} disabled hint="L’e-mail de connexion ne peut pas être modifié ici." />
              <Input label="Téléphone" type="tel" value={form.phone} onChange={v => setForm(p => ({ ...p, phone: v }))} autoComplete="tel" placeholder="+242 06 123 45 67" hint={form.phone ? fmtPhone(form.phone) : undefined} />
              <Button type="submit" variant="primary" loading={saving}>Enregistrer</Button>
            </form>
          </Card>
        </div>
      )}
      <Card title="Conformité KYB" subtitle="Relevez vos plafonds en complétant votre dossier">
        {docs.state === 'ok' && (<>
          <div className="row-between mb-2"><span className="small text-2">{approved} / {DOC_TYPES.length} documents approuvés</span><span className="xs muted">Niveau 0 → 1 : RCCM, NIF, pièce d’identité · Niveau 2 : contrat signé</span></div>
          <div className="progress mb-4"><span style={{ width: `${(approved / DOC_TYPES.length) * 100}%` }} /></div>
          <div className="grid-3 keep mb-4" style={{ gap: 'var(--s2)' }}>
            {DOC_TYPES.map(([v, l]) => { const d = list.find(x => x.doc_type === v); const tone = d ? (d.status === 'approved' ? 'success' : d.status === 'rejected' ? 'error' : 'warn') : 'muted'; return <span key={v} className={`row small ${tone}`}><Icon name={d ? (d.status === 'approved' ? 'checkCircle' : d.status === 'rejected' ? 'xCircle' : 'clock') : 'file'} size={16} />{l.split('/')[0].trim()}</span>; })}
          </div>
        </>)}
        <div className="kv-box" style={{ padding: 'var(--s4)' }}>
          <p className="field-label mb-3">Transmettre un document (PDF, JPG ou PNG, 5 Mo maximum)</p>
          <div className="form-grid">
            <Select label="Type de document" value={upload.docType} onChange={v => setUpload(u => ({ ...u, docType: v }))} options={DOC_TYPES.map(([v, l]) => ({ value: v, label: l }))} />
            <div className="field"><label htmlFor="kyb-file">Fichier</label><input id="kyb-file" className="input" type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={onFile} />{upload.file && <span className="hint success">{upload.file.name}</span>}</div>
          </div>
          <Button variant="primary" icon="upload" onClick={submitDoc} loading={uploading} disabled={!upload.file}>Transmettre</Button>
        </div>
        <div className="mt-4"><Table columns={docCols} rows={list} rowKey={d => d.doc_id} state={docs.state} error={docs.error} onRetry={docs.reload} empty={{ title: 'Aucun document transmis', message: 'Commencez par le RCCM, le NIF et la pièce d’identité du dirigeant.' }} emptyIcon="file" /></div>
        <Notice tone="neutral" className="mt-4">Les documents sont examinés par l’équipe conformité sous 2 jours ouvrés. Vous êtes informé par e-mail de la décision.</Notice>
      </Card>
    </div>
  );
};
export default Profil;
