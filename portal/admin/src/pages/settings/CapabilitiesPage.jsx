import React, { useMemo, useState } from 'react';
import { Button, Card, PageHeader, Badge, Callout, Skeleton, ErrorState, Chips, KeyValue } from '../../components/ui';
import { useQuery } from '../../hooks/useQuery';
import { capabilitiesApi } from '../../services/api';
import { fmtDateTime } from '../../utils/format';
import { errorMessage } from '../../utils/errors';
import toast from '../../utils/toast';

// ─── Capacités pays (vague 6, lot 2) — lecture seule ───────────────
// Matrice pays × opération × famille/opérateur calculée par le serveur
// (services/capabilities/registry.js) : rien n'est modifiable ici, les statuts
// découlent du code présent et de la configuration (env / api_configurations).

const STATUS = {
  active:      { label: 'Disponible',              tone: 'success' },
  pilot:       { label: 'Pilote',                  tone: 'warn' },
  planned:     { label: 'En cours d’intégration',  tone: 'info' },
  unavailable: { label: 'Non disponible',          tone: 'neutral' },
};
const OPS = [['collect', 'Encaisser'], ['withdraw', 'Retirer'], ['transfer', 'Transférer']];
const METHODS = {
  collect:  [['mobile_money', 'Mobile Money'], ['card', 'Carte'], ['gimac', 'GIMAC']],
  withdraw: [['mobile_money', 'Mobile Money'], ['card', 'Carte'], ['gimac', 'GIMAC']],
  transfer: [['wallet_to_bank', 'Wallet → banque'], ['bank_to_wallet', 'Banque → wallet'], ['card', 'Carte'], ['gimac', 'GIMAC']],
};

const StatusBadge = ({ status }) => { const s = STATUS[status] || STATUS.unavailable; return <Badge tone={s.tone}>{s.label}</Badge>; };

const Requires = ({ items }) => (items && items.length ? (
  <ul className="small muted" style={{ margin: '4px 0 0', paddingLeft: 16 }}>{items.map((r, i) => <li key={i} className="mono" style={{ fontSize: 11 }}>{r}</li>)}</ul>
) : null);

const Cell = ({ cell, showRequires }) => {
  if (!cell) return <span className="muted">—</span>;
  return (
    <div>
      <StatusBadge status={cell.status} />
      {cell.gateway && <span className="cell-sub mono"> {cell.gateway}</span>}
      {cell.note && <div className="cell-sub" style={{ maxWidth: 260 }}>{cell.note}</div>}
      {showRequires && cell.status !== 'active' && <Requires items={cell.requires} />}
    </div>
  );
};

const OperatorRows = ({ ops, showRequires }) => (
  <div style={{ display: 'grid', gap: 6 }}>
    {(ops || []).map((o) => (
      <div key={o.operator} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <StatusBadge status={o.status} />
        <div style={{ minWidth: 0 }}>
          <div className="cell-primary">{o.brand} <span className="cell-sub mono">{o.gateway}</span>{o.verified === false && <Badge tone="warn">préfixes à confirmer</Badge>}{o.alternative && <Badge tone="cyan">au choix du client</Badge>}</div>
          <div className="cell-sub">{o.note}{o.since ? ` · code depuis ${o.since}` : ''}</div>
          {showRequires && o.status !== 'active' && <Requires items={o.requires} />}
        </div>
      </div>
    ))}
  </div>
);

export default function CapabilitiesPage() {
  const q = useQuery(() => capabilitiesApi.matrix().then((r) => r.data), []);
  const [showRequires, setShowRequires] = useState(true);
  const [scope, setScope] = useState('launch');
  const [busy, setBusy] = useState(false);
  const data = q.data;
  const countries = useMemo(() => {
    if (!data?.countries) return [];
    const all = Object.values(data.countries);
    const order = [...(data.launchCountries || []), ...all.map((c) => c.code).filter((c) => !(data.launchCountries || []).includes(c))];
    return order.map((cc) => data.countries[cc]).filter(Boolean).filter((c) => scope === 'all' || c.launch);
  }, [data, scope]);
  const refresh = async () => {
    setBusy(true);
    try { await capabilitiesApi.refresh(); toast.success('Faits base rechargés'); q.refresh(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const pilotFlags = data?.env?.pilotFlags || [];
  const counts = useMemo(() => {
    const n = { active: 0, pilot: 0, planned: 0, unavailable: 0 };
    countries.forEach((c) => OPS.forEach(([op]) => METHODS[op].forEach(([m]) => {
      const cell = c.operations?.[op]?.[m];
      if (!cell) return;
      if (cell.operators) cell.operators.forEach((o) => { n[o.status] = (n[o.status] || 0) + 1; });
      else n[cell.status] = (n[cell.status] || 0) + 1;
    })));
    return n;
  }, [countries]);

  return (
    <div className="page">
      <PageHeader title="Capacités pays" subtitle="Ce que C-Pay sait réellement faire, pays par pays : statuts calculés par le serveur à partir du code présent et de la configuration. Lecture seule — rien ne s’active ici."
        badge={data?.generatedAt ? <Badge>calculé le {fmtDateTime(data.generatedAt)}</Badge> : null}
        actions={<>
          <Button size="sm" onClick={() => setShowRequires((v) => !v)}>{showRequires ? 'Masquer les prérequis' : 'Afficher les prérequis'}</Button>
          <Button size="sm" variant="primary" loading={busy} onClick={refresh}>Recharger les faits base</Button>
        </>} />

      <Callout tone="info">
        <strong>Statuts :</strong> <Badge tone="success">Disponible</Badge> code + configuration présents · <Badge tone="warn">Pilote</Badge> idem, avec <span className="mono">CAPABILITY_PILOT_&lt;CC&gt;=true</span> · <Badge tone="info">En cours d’intégration</Badge> dans le périmètre de lancement, pas de code · <Badge tone="neutral">Non disponible</Badge> code sans configuration, retrait / transfert carte, hors périmètre.
        {' '}Les portails et la vitrine lisent le même registre (<span className="mono">GET /api/v1/public/capabilities</span>) ; l’API refuse les opérations non actives (<span className="mono">403 CAPABILITY_NOT_ACTIVE</span>) et ferme l’inscription des pays sans encaissement actif (<span className="mono">422 COUNTRY_NOT_OPEN</span>).
      </Callout>

      {q.loading && <Card><Skeleton lines={6} /></Card>}
      {q.error && <ErrorState error={q.error} onRetry={q.refresh} />}
      {data && (<>
        <div className="grid-4" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
          <Card dense title="Pilotes actifs">
            {pilotFlags.length ? pilotFlags.map((f) => <Badge key={f} tone="warn">{f}</Badge>) : <span className="muted small">Aucun drapeau CAPABILITY_PILOT_* positionné</span>}
          </Card>
          <Card dense title="Réglages">
            <KeyValue rows={[
              ['Marchands SN / CI existants', data.env?.legacyAllowed ? 'tolérés (CAPABILITY_LEGACY_ALLOW)' : 'bloqués'],
              ['Contrôle pays à l’inscription', data.env?.registrationGuard ? 'actif' : 'désactivé (CAPABILITY_REGISTRATION_GUARD=off)'],
              ['Faits base', `${data.facts?.source || '—'}${data.facts?.loadedAt ? ` · ${fmtDateTime(data.facts.loadedAt)}` : ''}`],
            ]} />
          </Card>
          <Card dense title="Cellules (périmètre affiché)">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{Object.entries(counts).map(([s, n]) => <span key={s}><StatusBadge status={s} /> <strong>{n}</strong></span>)}</div>
          </Card>
        </div>
        <div style={{ marginBottom: 12 }}>
          <Chips items={[{ value: 'launch', label: 'Périmètre de lancement (7 pays)' }, { value: 'all', label: 'Tous, y compris historiques SN / CI' }]} value={scope} onChange={setScope} />
        </div>
        {countries.map((c) => (
          <Card key={c.code} title={<span>{c.name} <span className="mono muted">{c.code} · +{c.callingCode} · {c.currency} · {c.region}</span></span>}
            sub={c.legacy ? 'Connecteur historique hors périmètre de lancement : aucune nouvelle activation, inscription fermée.' : c.pilot ? `Pilote : CAPABILITY_PILOT_${c.code}=true` : null}
            actions={<>{c.pilot && <Badge tone="warn">pilote</Badge>}{c.legacy && <Badge tone="neutral">historique</Badge>}</>} flush>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th style={{ width: 140 }}>Opération</th>{['Mobile Money (par opérateur)', 'Carte', 'GIMAC / GIMACPAY', 'Transferts'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {OPS.map(([op, label]) => {
                    const o = c.operations?.[op] || {};
                    return (
                      <tr key={op}>
                        <td className="cell-primary">{label}</td>
                        <td>{o.mobile_money ? <OperatorRows ops={o.mobile_money.operators} showRequires={showRequires} /> : <span className="muted">—</span>}</td>
                        <td><Cell cell={o.card} showRequires={showRequires} /></td>
                        <td><Cell cell={o.gimac} showRequires={showRequires} /></td>
                        <td>{op === 'transfer' ? (
                          <div style={{ display: 'grid', gap: 8 }}>
                            <div><div className="cell-sub">Wallet → banque</div><Cell cell={o.wallet_to_bank} showRequires={showRequires} /></div>
                            <div><div className="cell-sub">Banque → wallet</div><Cell cell={o.bank_to_wallet} showRequires={showRequires} /></div>
                          </div>
                        ) : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </>)}
    </div>
  );
}
