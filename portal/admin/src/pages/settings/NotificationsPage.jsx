import React, { useEffect, useState } from 'react';
import { Button, Card, PageHeader, Field, Input, Select, Badge, Callout, Skeleton } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useAuth } from '../../hooks/useAuth';
import { configApi } from '../../services/api';
import { fmtDateTime } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import { PERMS } from '../../utils/roles';
import toast from '../../utils/toast';

// GET /notification-configs renvoie les secrets masqués { configured, last4 } ; vide = conserver.
const SECRETS = ['smpp_pass', 'smtp_pass', 'wa_token', 'wa_verify_token'];
const SECTIONS = [
  { key: 'smpp', title: 'SMS — SMPP', icon: 'phone', testPlaceholder: '+242 06 000 0000', fields: [['smpp_host', 'Hôte SMPP', 'smpp.operateur.com'], ['smpp_port', 'Port', '2775'], ['smpp_user', 'Utilisateur', ''], ['smpp_pass', 'Mot de passe', ''], ['smpp_src', 'Nom d’expéditeur', 'C-Pay']] },
  { key: 'smtp', title: 'E-mail — SMTP', icon: 'mail', testPlaceholder: 'destinataire@exemple.com', fields: [['smtp_host', 'Hôte SMTP', 'smtp.exemple.com'], ['smtp_port', 'Port', '587', [['587', '587 (STARTTLS)'], ['465', '465 (SSL)'], ['25', '25']]], ['smtp_user', 'Utilisateur', ''], ['smtp_pass', 'Mot de passe', ''], ['smtp_from', 'Adresse d’expédition', 'noreply@c-pay.global'], ['smtp_secure', 'Sécurité', 'tls', [['tls', 'STARTTLS'], ['ssl', 'SSL/TLS'], ['none', 'Aucune']]]] },
  { key: 'whatsapp', title: 'WhatsApp Business API', icon: 'chat', testPlaceholder: '+242 06 000 0000', fields: [['wa_token', 'Jeton d’accès permanent', ''], ['wa_phone_id', 'Phone Number ID', ''], ['wa_verify_token', 'Verify token', '']] },
];

function Section({ section, data, canWrite, onSaved }) {
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(null);
  const [to, setTo] = useState('');
  useEffect(() => {
    const init = {};
    section.fields.forEach(([k, , def]) => { const v = data?.[k]; init[k] = SECRETS.includes(k) ? '' : (v !== undefined && v !== null && typeof v !== 'object' ? String(v) : def || ''); });
    setForm(init);
  }, [data, section]);
  const save = async () => {
    setBusy('save');
    try {
      const payload = { section: section.key };
      Object.entries(form).forEach(([k, v]) => { if (SECRETS.includes(k) && !v) return; payload[k] = v; });
      await configApi.saveNotifConfig(payload); toast.success('Configuration enregistrée'); onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test');
    try { const { data: r } = await configApi.testNotifConfig(section.key); toast.success(r.message || 'Connexion établie'); onSaved(); }
    catch (e) { toast.error(errorMessage(e, 'Connexion impossible')); } finally { setBusy(null); }
  };
  const send = async () => {
    if (!to.trim()) return toast.error('Indiquez un destinataire');
    setBusy('send');
    try { const { data: r } = await configApi.sendTestNotif(section.key, to.trim()); toast.success(r.message || 'Message de test envoyé'); }
    catch (e) { toast.error(errorMessage(e, 'Envoi impossible')); } finally { setBusy(null); }
    return undefined;
  };
  const lastOk = data?.[`${section.key}_test_ok`], lastAt = data?.[`${section.key}_last_tested`];
  return (
    <Card title={section.title} sub={lastAt ? `Dernier test le ${fmtDateTime(lastAt)}` : 'Jamais testé'} actions={lastOk === true ? <Badge tone="success" dot>connecté</Badge> : lastOk === false ? <Badge tone="error" dot>échec</Badge> : <Badge>non testé</Badge>}>
      <div className="stack">
        <div className="form-grid">
          {section.fields.map(([k, label, placeholder, options]) => {
            const secret = SECRETS.includes(k); const meta = secret ? data?.[k] : null;
            return (
              <Field key={k} label={label} hint={secret ? (meta?.configured ? `configuré ••••${meta.last4 || ''} — vide = conserver` : 'non configuré') : undefined}>
                {options ? <Select value={form[k] || ''} onChange={(v) => setForm((f) => ({ ...f, [k]: v }))} options={options.map(([value, l]) => ({ value, label: l }))} disabled={!canWrite} />
                  : <Input type={secret ? 'password' : 'text'} autoComplete="off" value={form[k] || ''} onChange={(v) => setForm((f) => ({ ...f, [k]: v }))} placeholder={secret && meta?.configured ? 'Laisser vide pour conserver' : placeholder} disabled={!canWrite} />}
              </Field>
            );
          })}
        </div>
        {canWrite && (
          <div className="between">
            <div className="row"><Button variant="primary" size="sm" loading={busy === 'save'} onClick={save}>Enregistrer</Button><Button size="sm" icon="wifi" loading={busy === 'test'} onClick={test}>Tester la connexion</Button></div>
            <div className="row"><Input size="sm" value={to} onChange={setTo} placeholder={section.testPlaceholder} aria-label="Destinataire du test" style={{ width: 220 }} /><Button size="sm" icon="send" loading={busy === 'send'} onClick={send}>Envoyer un test</Button></div>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function NotificationsPage() {
  const { hasRole } = useAuth();
  const canWrite = hasRole(PERMS.ops);
  const q = useQuery(() => configApi.notifConfigs().then((r) => r.data || {}), []);
  return (
    <div className="page">
      <PageHeader title="Canaux de notification" subtitle="SMS (SMPP), e-mail (SMTP) et WhatsApp utilisés pour les notifications marchands et porteurs." />
      <Callout tone="info">Les secrets ne sont jamais renvoyés en clair : un champ secret vide conserve la valeur enregistrée. Enregistrez avant de tester.</Callout>
      {q.loading && !q.data ? <Card><Skeleton lines={5} /></Card> : (
        <div className="grid grid-2">
          {SECTIONS.map((s) => <div key={s.key} style={s.key === 'smtp' ? { gridColumn: '1 / -1' } : undefined}><Section section={s} data={q.data} canWrite={canWrite} onSaved={q.refresh} /></div>)}
        </div>
      )}
    </div>
  );
}
