import React, { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { integrationsApi } from '../../services/api';
import { useAsync } from '../../hooks/useAsync';
import { Button, Card, PageHeader, Input, Notice, CopyRow, ConfirmDialog, SkeletonCard, ErrorState, KVList, Badge } from '../../components';
import { errorMessage } from '../../utils/errors';

// Webhook marchand : URL https publique, secret HMAC affiché une seule fois, test.
export const Webhooks = () => {
  const cfg = useAsync(() => integrationsApi.webhookConfig(), []);
  const [url, setUrl] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [newSecret, setNewSecret] = useState(null);
  const [rotate, setRotate] = useState(false);
  useEffect(() => { if (cfg.data) setUrl(cfg.data.webhook_url || ''); }, [cfg.data]);
  const configured = !!cfg.data?.webhook_secret?.configured;

  const save = async (rotateSecret = false) => {
    if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(url.trim())) { setError('Adresse https:// publique requise.'); return; }
    setSaving(true); setError(null);
    try {
      const { data } = await integrationsApi.saveWebhook({ webhookUrl: url.trim(), rotateSecret });
      if (data.webhook_secret?.value) setNewSecret(data.webhook_secret.value);
      toast.success('Webhook enregistré'); setRotate(false); cfg.reload();
    } catch (err) { setError(errorMessage(err)); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true);
    try { await integrationsApi.testWebhook(); toast.success('Événement de test envoyé (webhook.test)'); }
    catch (err) { toast.error(errorMessage(err)); }
    finally { setTesting(false); }
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Webhooks" subtitle="C-Pay notifie votre serveur à chaque paiement confirmé ou échoué. Chaque livraison est signée en HMAC-SHA256 avec votre secret." />
      {newSecret && (
        <Card title="Secret de signature" subtitle="Affiché une seule fois">
          <Notice tone="warn" className="mb-3">Copiez ce secret maintenant et stockez-le côté serveur. Il ne sera plus jamais affiché ; en cas de perte, il faudra le régénérer.</Notice>
          <div className="kv-box"><CopyRow label="Secret HMAC" value={newSecret} /></div>
          <Button className="mt-3" onClick={() => setNewSecret(null)}>J’ai enregistré le secret</Button>
        </Card>
      )}
      {cfg.state === 'loading' ? <SkeletonCard lines={4} /> : cfg.state === 'error' ? <Card><ErrorState error={cfg.error} onRetry={cfg.reload} /></Card> : (
        <Card title="Configuration">
          <form onSubmit={(e) => { e.preventDefault(); save(false); }} noValidate>
            <Input label="URL de réception" type="url" value={url} onChange={v => { setUrl(v); setError(null); }} placeholder="https://votresite.com/webhooks/c-pay" error={error} hint="https:// obligatoire, hôte public (les adresses privées sont refusées)." required />
            <div className="field"><span className="field-label">Secret de signature</span>
              <div className="row-between kv-box" style={{ padding: 'var(--s3) var(--s4)' }}>
                <span className="small">{configured ? <><Badge tone="success" dot>Configuré</Badge> <span className="muted">jamais affiché après création</span></> : <span className="muted">Aucun secret : il sera généré à la première sauvegarde.</span>}</span>
                {configured && <Button size="sm" icon="refresh" onClick={() => setRotate(true)} disabled={saving}>Régénérer</Button>}
              </div>
            </div>
            <div className="form-actions"><Button type="submit" variant="primary" loading={saving}>Enregistrer</Button><Button icon="zap" onClick={test} loading={testing} disabled={!cfg.data?.webhook_url || !configured}>Envoyer un test</Button></div>
          </form>
        </Card>
      )}
      <div className="grid-2">
        <Card title="Événements envoyés">
          <KVList rows={[['payment.completed', 'Paiement confirmé'], ['payment.failed', 'Paiement échoué'], ['webhook.test', 'Test depuis cet écran']].map(([k, v]) => [k, v])} />
        </Card>
        <Card title="Vérifier la signature">
          <p className="small text-2 mb-3">En-têtes reçus : <code>X-CPay-Event</code>, <code>X-CPay-Signature</code> (<code>sha256=&lt;hex&gt;</code>), <code>X-CPay-Timestamp</code>.</p>
          <pre className="code-block">{`signature = "sha256=" + hex(HMAC_SHA256(secret, corps_brut))
// comparez avec X-CPay-Signature en temps constant
// répondez 2xx dès réception, traitez ensuite (3 tentatives : 5 s, 10 s)`}</pre>
          <p className="xs muted mt-2">Contrat complet sur <a href="https://c-pay.global/developers" target="_blank" rel="noreferrer">c-pay.global/developers</a>.</p>
        </Card>
      </div>
      {rotate && <ConfirmDialog title="Régénérer le secret" message="L’ancien secret cessera de fonctionner immédiatement : vos serveurs devront être mis à jour avec le nouveau." confirmLabel="Régénérer" busy={saving} onConfirm={() => save(true)} onClose={() => setRotate(false)} />}
    </div>
  );
};
export default Webhooks;
