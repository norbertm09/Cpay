import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { useAsync } from '../../hooks/useAsync';
import { Card, Button, Badge, Select, Alert, SkeletonList, ErrorState, EmptyState, Icon } from '../../components';
import { kyc as kycApi } from '../../services/profile';
import { errorMessage } from '../../utils/errors';
import { formatDate } from '../../utils/format';

const DOC_TYPES = [
  { value: 'id_card', label: 'Pièce d’identité (CNI ou passeport)' },
  { value: 'selfie', label: 'Selfie avec la pièce d’identité' },
  { value: 'address_proof', label: 'Justificatif de domicile' },
  { value: 'income_proof', label: 'Justificatif de revenus' },
];
const DOC_STATUS = { pending: { label: 'En vérification', tone: 'badge-warn' }, approved: { label: 'Approuvé', tone: 'badge-success' }, rejected: { label: 'Refusé', tone: 'badge-error' } };
const MAX_BYTES = 5 * 1024 * 1024;

export default function KycTab() {
  const kyc = useAsync(kycApi.get, []);
  const [docType, setDocType] = useState('id_card');
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [busy, setBusy] = useState(false);

  const docs = kyc.data?.documents || [];
  const approved = docs.filter((d) => d.status === 'approved').length;
  const level = kyc.data?.kyc_level ?? 0;

  const onFile = (e) => {
    const f = e.target.files?.[0];
    setFileError('');
    if (!f) { setFile(null); return; }
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(f.type)) { setFileError('Formats acceptés : PDF, JPG, PNG.'); setFile(null); return; }
    if (f.size > MAX_BYTES) { setFileError('Fichier trop volumineux (5 Mo maximum).'); setFile(null); return; }
    setFile(f);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file) { setFileError('Sélectionnez un fichier.'); return; }
    setBusy(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
      await kycApi.submit({ docType, docLabel: DOC_TYPES.find((d) => d.value === docType)?.label, fileUrl: dataUrl, fileName: file.name, mimeType: file.type });
      toast.success('Document transmis. Il sera vérifié sous 48 h ouvrées.');
      setFile(null);
      const input = document.getElementById('kyc-file'); if (input) input.value = '';
      kyc.reload();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="help-grid">
      <div className="stack">
        <Card title="Niveau de vérification">
          <div className="row-between wrap" style={{ marginBottom: 12 }}>
            <span className="small text-2">{approved} document{approved > 1 ? 's' : ''} approuvé{approved > 1 ? 's' : ''} sur {DOC_TYPES.length}</span>
            <Badge tone={level >= 1 ? 'badge-success' : 'badge-warn'} dot>Niveau {level}</Badge>
          </div>
          <div style={{ height: 8, background: 'var(--surface-3)', borderRadius: 4, overflow: 'hidden' }} role="progressbar" aria-valuemin={0} aria-valuemax={DOC_TYPES.length} aria-valuenow={approved} aria-label="Documents approuvés">
            <div style={{ width: `${(approved / DOC_TYPES.length) * 100}%`, height: '100%', background: 'var(--success)', transition: 'width .4s' }} />
          </div>
          <div className="grid-2" style={{ marginTop: 16 }}>
            {[[1, 'Niveau 1', 'Compte ouvert, plafonds standards'], [2, 'Niveau 2', 'Identité vérifiée, plafonds relevés']].map(([l, t, d]) => (
              <div className="limit" key={l} style={{ borderColor: level >= l ? 'var(--success)' : undefined }}>
                <div className="row"><span className="lm-value">{t}</span>{level >= l ? <Icon name="check-circle" size={16} style={{ color: 'var(--success)' }} /> : null}</div>
                <div className="lm-label">{d}</div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Transmettre un document">
          <form onSubmit={submit} noValidate className="stack">
            <Select label="Type de document" value={docType} onChange={(e) => setDocType(e.target.value)} options={DOC_TYPES} />
            <div className="field">
              <label className="field-label" htmlFor="kyc-file">Fichier (PDF, JPG ou PNG, 5 Mo max.)</label>
              <input id="kyc-file" className="input" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={onFile} aria-invalid={fileError ? 'true' : undefined} />
              {fileError ? <div className="field-error" role="alert">{fileError}</div> : file ? <div className="field-hint">{file.name} · {(file.size / 1024).toFixed(0)} Ko</div> : null}
            </div>
            <Button type="submit" variant="primary" icon="upload" loading={busy} disabled={!file}>Transmettre</Button>
          </form>
        </Card>
      </div>
      <Card flush title="Documents transmis">
        {kyc.loading ? <SkeletonList rows={3} />
          : kyc.error ? <ErrorState error={kyc.error} onRetry={kyc.reload} />
            : !docs.length ? <EmptyState icon="file-text" title="Aucun document">Transmettez une pièce d’identité pour débloquer l’ensemble des plafonds.</EmptyState>
              : docs.map((d) => {
                const s = DOC_STATUS[d.status] || { label: d.status, tone: '' };
                return (
                  <div className="list-item" key={d.doc_id}>
                    <span className="li-icon icon-neutral"><Icon name="file-text" size={18} /></span>
                    <span className="li-main">
                      <span className="li-title">{DOC_TYPES.find((t) => t.value === d.doc_type)?.label || d.doc_label || d.doc_type}</span>
                      <span className="li-sub">{d.file_name ? `${d.file_name} · ` : ''}transmis le {formatDate(d.uploaded_at)}</span>
                      {d.rejection_reason ? <span className="li-sub" style={{ color: 'var(--error)' }}>Motif : {d.rejection_reason}</span> : null}
                    </span>
                    <span className="li-end"><Badge tone={s.tone}>{s.label}</Badge></span>
                  </div>
                );
              })}
      </Card>
    </div>
  );
}
