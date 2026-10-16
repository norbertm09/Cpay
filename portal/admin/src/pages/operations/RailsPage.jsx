import React, { useState } from 'react';
import { Button, Card, PageHeader, Tabs, Field, Input, Callout, Badge, Skeleton, ErrorState, EmptyState } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { useUrlState } from '../../hooks/useParams';
import { railsApi } from '../../services/api';
import { errorMessage } from '../../utils/errors';

// Rails réseau (Visa Direct, Mastercard Developers) — lecture et requêtes de
// statut uniquement ; jamais de PAN en clair (le backend refuse : RAW_PAN_NOT_ALLOWED).
function VisaTab() {
  const [query, setQuery] = useState({ transactionIdentifier: '', referenceNumber: '' });
  const [res, setRes] = useState(null); const [busy, setBusy] = useState(null); const [err, setErr] = useState(null);
  const run = async (what) => {
    setBusy(what); setErr(null);
    try {
      let r;
      if (what === 'query') r = await railsApi.visaQuery(Object.fromEntries(Object.entries(query).filter(([, v]) => v)));
      else if (what === 'balance') r = await railsApi.visaBalance();
      else r = await railsApi.visaPayouts();
      setRes({ what, data: r.data });
    } catch (e) { setErr(errorMessage(e)); setRes(null); }
    finally { setBusy(null); }
  };
  return (
    <div className="grid grid-2">
      <div className="stack-lg">
        <Card title="Interroger une transaction Visa Direct" sub="GET /rails/visa-direct/transaction-query">
          <div className="stack">
            <Field label="Identifiant de transaction"><Input value={query.transactionIdentifier} onChange={(v) => setQuery((q) => ({ ...q, transactionIdentifier: v }))} className="mono" /></Field>
            <Field label="Numéro de référence (RRN)"><Input value={query.referenceNumber} onChange={(v) => setQuery((q) => ({ ...q, referenceNumber: v }))} className="mono" /></Field>
            <Button variant="primary" icon="search" loading={busy === 'query'} onClick={() => run('query')} disabled={!query.transactionIdentifier && !query.referenceNumber}>Interroger</Button>
          </div>
        </Card>
        <Card title="Visa Payouts" sub="Solde du compte de financement et liste des payouts">
          <div className="row-wrap">
            <Button icon="wallet" loading={busy === 'balance'} onClick={() => run('balance')}>Solde du compte</Button>
            <Button icon="list" loading={busy === 'payouts'} onClick={() => run('payouts')}>Lister les payouts</Button>
          </div>
        </Card>
        <Callout tone="warn">Les opérations d’envoi (push / pull funds, création de payout) existent côté API mais ne sont pas exposées ici : elles engagent des fonds et nécessitent des tokens réseau ; elles restent réservées aux procédures d’exploitation outillées.</Callout>
      </div>
      <Card title="Réponse" sub={res ? `Visa · ${res.what}` : 'Aucune requête lancée'}>
        {err ? <Callout tone="error">{err}</Callout> : res ? <div className="code-block" style={{ maxHeight: 520 }}>{JSON.stringify(res.data, null, 2)}</div> : <EmptyState icon="network" title="Lancez une requête" description="La réponse Visa est filtrée par le backend (liste blanche de champs, jamais de PAN)." />}
      </Card>
    </div>
  );
}

function MastercardTab() {
  const services = useQuery(() => railsApi.mcServices().then((r) => r.data), []);
  const projects = useQuery(() => railsApi.mcProjects().then((r) => r.data), []);
  const render = (q, title) => (
    <Card title={title}>
      {q.loading ? <Skeleton /> : q.error ? <ErrorState error={errorMessage(q.error)} onRetry={q.reload} /> : <div className="code-block" style={{ maxHeight: 420 }}>{JSON.stringify(q.data, null, 2)}</div>}
    </Card>
  );
  return (
    <div className="grid grid-2">
      {render(services, 'Services Mastercard Developers')}
      {render(projects, 'Projets')}
      <div className="full" style={{ gridColumn: '1 / -1' }}><Callout tone="info">La création de projets, l’ajout de services et la génération d’identifiants sont réservés au super administrateur et se font via l’API (POST /rails/mastercard-developers/projects…).</Callout></div>
    </div>
  );
}

export default function RailsPage() {
  const { get, set } = useUrlState({ tab: 'visa' });
  const tab = get('tab');
  return (
    <div className="page">
      <PageHeader title="Rails réseau" subtitle="Outils de consultation Visa Direct / Visa Payouts et Mastercard Developers." badge={<Badge tone="info">super_admin · ops_admin</Badge>} />
      <Tabs value={tab} onChange={(v) => set({ tab: v })} items={[{ value: 'visa', label: 'Visa Direct & Payouts', icon: 'card' }, { value: 'mastercard', label: 'Mastercard Developers', icon: 'network' }]} />
      {tab === 'visa' ? <VisaTab /> : <MastercardTab />}
    </div>
  );
}
