import React, { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useCashSummary } from '../../hooks/useCashSummary';
import { Button, Card, PageHeader, AmountInput, Select, Segmented, Badge, KVList, Notice, Table, SkeletonCard, ErrorState } from '../../components';
import { fmtMoney } from '../../utils/format';

// Grille indicative des commissions d'encaissement (cohérente avec
// backend/src/services/assistant/knowledge.js). Les frais affichés au moment
// de la confirmation d'une opération font foi.
const COLLECT_RATES = { mobile_money: [1.5, 1.2, 1.0], card: [2.5, 2.0, 1.8] };
const LEVELS = [0, 1, 2];
const LEVEL_LIMITS = [100000, 500000, 2000000];
const LEVEL_NAMES = ['Niveau 0 — compte créé', 'Niveau 1 — documents validés', 'Niveau 2 — contrat signé'];
const pct = (v) => `${Number(v).toFixed(1).replace('.', ',')} %`;

export const Tarifs = () => {
  const { user } = useAuth();
  const { summary, state, reload } = useCashSummary();
  const currency = summary?.currency || user?.currency || 'XAF';
  const level = Math.min(2, Math.max(0, Number(summary?.profile?.kybLevel ?? user?.kybLevel ?? 0)));
  const [simAmount, setSimAmount] = useState('25000');
  const [simMethod, setSimMethod] = useState('mobile_money');
  const [simLevel, setSimLevel] = useState(String(level));
  const amt = Number(simAmount) || 0;
  const rate = COLLECT_RATES[simMethod][Number(simLevel)];
  const fee = Math.round(amt * rate) / 100;
  const limits = summary?.limits || {}; const fees = summary?.fees || {};
  const feeRule = (r) => (r ? `${pct(r.percent ?? 0)}${r.fixed ? ` + ${fmtMoney(r.fixed, currency)}` : ''}${r.min ? ` (min. ${fmtMoney(r.min, currency)})` : ''}` : 'affichés à la confirmation');
  const gridCols = [
    { key: 'm', label: 'Moyen d’encaissement', mobile: 'title', render: r => <strong>{r.label}</strong> },
    ...LEVELS.map(l => ({ key: `l${l}`, label: `Niveau ${l}`, num: true, mobile: l === level ? 'right' : 'meta', render: r => r.rates ? <span className={l === level ? 'strong' : ''}>{pct(r.rates[l])}</span> : <span className="muted">{r.note}</span> })),
  ];
  const gridRows = [
    { label: 'Mobile Money (encaissement direct, QR, lien)', rates: COLLECT_RATES.mobile_money },
    { label: 'Carte (lien de paiement, QR)', rates: COLLECT_RATES.card },
    { label: 'Carte sans contact Tap-to-Phone', note: 'bientôt, après certification' },
  ];

  return (
    <div className="stack-lg">
      <PageHeader title="Tarifs & frais" subtitle="Votre grille tarifaire selon votre niveau KYB. Aucun abonnement ni frais d’installation : vous payez uniquement une commission sur les opérations." />
      <Notice tone="info"><strong>Les frais affichés au moment de la confirmation de chaque opération font foi.</strong> Les taux ci-dessous sont indicatifs ; les frais prélevés par l’opérateur Mobile Money côté payeur ne dépendent pas de C-Pay et ne sont pas inclus.</Notice>
      {state === 'loading' ? <SkeletonCard lines={4} /> : state === 'error' ? <Card><ErrorState error={undefined} onRetry={reload} /></Card> : (
        <div className="grid-2">
          <Card title="Mon niveau et mes conditions" actions={<Badge tone={level >= 2 ? 'success' : 'warn'}>Niveau KYB {level}</Badge>}>
            <KVList rows={[
              ['Statut', LEVEL_NAMES[level]],
              ['Commission Mobile Money', pct(COLLECT_RATES.mobile_money[level]) + ' (indicatif)'],
              ['Commission carte', pct(COLLECT_RATES.card[level]) + ' (indicatif)'],
              ['Frais de retrait vers wallet', feeRule(fees.withdraw || (limits.withdrawFeePercent != null ? { percent: limits.withdrawFeePercent, fixed: limits.withdrawFeeFixed, min: limits.withdrawFeeMin } : null))],
              ['Frais de transfert vers banque', feeRule(fees.transfer)],
              ['Plafond de retrait journalier', fmtMoney(limits.withdrawDailyMax ?? LEVEL_LIMITS[level], currency)],
              limits.withdrawDailyRemaining != null && ['Restant aujourd’hui', fmtMoney(limits.withdrawDailyRemaining, currency)],
              limits.transferMin != null && ['Montant minimum retrait / transfert', fmtMoney(limits.transferMin, currency)],
              ['Règlement des encaissements', 'en règle générale à J+1 ouvré'],
              ['Abonnement, installation', 'aucun'],
            ]} />
            {level < 2 && <Button className="mt-4" to="/compte/profil" icon="file">Relever mon niveau KYB</Button>}
          </Card>
          <Card title="Simulateur de frais" subtitle="Estimation d’une commission d’encaissement">
            <AmountInput label="Montant encaissé" value={simAmount} onChange={setSimAmount} currency={currency} />
            <Segmented compact value={simMethod} onChange={setSimMethod} ariaLabel="Moyen" options={[{ value: 'mobile_money', icon: 'smartphone', label: 'Mobile Money' }, { value: 'card', icon: 'card', label: 'Carte' }]} />
            <Select label="Niveau KYB" value={simLevel} onChange={setSimLevel} options={LEVELS.map(l => ({ value: String(l), label: `Niveau ${l}${l === level ? ' (le vôtre)' : ''}` }))} />
            <KVList boxed rows={[['Taux appliqué', pct(rate)], ['Commission C-Pay', fmtMoney(fee, currency)], ['Net crédité', fmtMoney(Math.max(0, amt - fee), currency), { tone: 'success' }]]} />
            <p className="xs muted mt-3">Estimation indicative, hors frais de l’opérateur côté payeur. Le montant exact est affiché avant chaque confirmation.</p>
          </Card>
        </div>
      )}
      <Card title="Grille indicative des commissions d’encaissement" flush>
        <Table columns={gridCols} rows={gridRows} rowKey={r => r.label} />
        <p className="xs muted" style={{ padding: 'var(--s3) var(--s4)' }}>Niveau 0 à la création du compte ; niveau 1 après validation du RCCM, du NIF et de la pièce d’identité du dirigeant ; niveau 2 après signature du contrat.</p>
      </Card>
      <Card title="Plafonds de retrait journaliers par niveau">
        <KVList rows={LEVELS.map(l => [LEVEL_NAMES[l], fmtMoney(LEVEL_LIMITS[l], currency) + ' / jour', l === level ? { tone: 'success' } : undefined])} />
        <p className="xs muted mt-3">Le plafond réellement appliqué à votre compte est celui indiqué dans « Mon niveau et mes conditions ». Questions tarifaires : <a href="mailto:sales@c-pay.global">sales@c-pay.global</a>.</p>
      </Card>
    </div>
  );
};
export default Tarifs;
