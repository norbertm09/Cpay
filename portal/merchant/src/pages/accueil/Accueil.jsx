import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { cashApi, activityApi, authApi, integrationsApi } from '../../services/api';
import { Card, Stat, Button, Icon, Notice, StatusBadge, Skeleton, SkeletonCard, ErrorState, FeatureUnavailable, BarChart, Sparkline } from '../../components';
import { fmtMoney, fmtDateTime, fmtRelative, fmtDayShort, fmtDate, daysAgo, isoDay, pluralize } from '../../utils/format';
import { CASH_IN_TYPES, typeLabel, CARD_ACCEPTANCE } from '../../utils/labels';
import { TransactionDrawer } from '../activite/TransactionDrawer';

const CARD_METHODS = ['card', 'card_nfc', 'pay_link'];
const OK = ['authorized', 'completed'];

// Séries journalières (7 ou 30 jours) calculées depuis GET /transactions.
const buildSeries = (txns, days) => {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = daysAgo(i); const key = isoDay(d);
    out.push({ key, label: days > 7 ? fmtDate(d).slice(0, 5) : fmtDayShort(d), full: fmtDayShort(d), values: [0, 0], count: 0, today: i === 0 });
  }
  const idx = Object.fromEntries(out.map((d, i) => [d.key, i]));
  (txns || []).forEach(t => {
    if (t.type !== 'collect' || !OK.includes(t.status)) return;
    const k = isoDay(t.initiated_at); const i = idx[k];
    if (i == null) return;
    const amt = Number(t.amount) || 0;
    if (CARD_METHODS.includes(t.payment_method)) out[i].values[1] += amt; else out[i].values[0] += amt;
    out[i].count += 1;
  });
  return out;
};

export const Accueil = () => {
  const { user } = useAuth();
  const [range, setRange] = useState(7);
  const [detail, setDetail] = useState(null);
  const sum = useAsync(() => cashApi.summary(), []);
  const txns = useAsync(() => activityApi.transactions({ limit: 100, dateFrom: isoDay(daysAgo(30)), type: 'collect' }), []);
  const recent = useAsync(() => cashApi.history({ limit: 10, offset: 0 }), []);
  const dash = useAsync(() => activityApi.dashboard(), []);
  const twoFa = useAsync(() => authApi.twoFaStatus(), []);
  const webhook = useAsync(() => integrationsApi.webhookConfig(), []);

  const summary = sum.data || {};
  const currency = summary.currency || user?.currency || 'XAF';
  const bal = summary.balance || {}; const today = summary.today || {}; const profile = summary.profile || {}; const limits = summary.limits || {};
  const series = useMemo(() => buildSeries(txns.data?.data, range), [txns.data, range]);
  const week = useMemo(() => buildSeries(txns.data?.data, 7), [txns.data]);
  const weekTotal = week.reduce((a, d) => a + d.values[0] + d.values[1], 0);
  const weekCount = week.reduce((a, d) => a + d.count, 0);
  const weekMm = week.reduce((a, d) => a + d.values[0], 0);
  const weekCard = week.reduce((a, d) => a + d.values[1], 0);
  const truncated = (txns.data?.total || 0) > 100;

  const checklist = sum.state === 'ok' ? [
    { ok: (profile.kybLevel || 0) >= 2, to: '/compte/profil', label: (profile.kybLevel || 0) >= 2 ? `Niveau KYB ${profile.kybLevel} validé` : `Niveau KYB ${profile.kybLevel ?? 0} — complétez vos documents pour relever vos plafonds` },
    { ok: !!profile.wallet?.phone, to: '/compte/comptes', label: profile.wallet?.phone ? 'Wallet de retrait enregistré' : 'Enregistrer le wallet Mobile Money qui recevra vos retraits' },
    { ok: (profile.bankAccounts || 0) > 0, to: '/compte/comptes', label: (profile.bankAccounts || 0) > 0 ? `${profile.bankAccounts} ${pluralize(profile.bankAccounts, 'compte bancaire vérifié', 'comptes bancaires vérifiés')}` : 'Ajouter un compte bancaire pour les transferts' },
    { ok: twoFa.data?.mfaEnabled === true, to: '/compte/securite', label: twoFa.data?.mfaEnabled ? 'Double authentification activée' : 'Activer la double authentification (2FA)', pending: twoFa.state === 'loading' },
    { ok: !!webhook.data?.webhook_url, to: '/integrations/webhooks', label: webhook.data?.webhook_url ? 'Webhook configuré' : 'Configurer un webhook (facultatif, pour vos intégrations)', optional: true, pending: webhook.state === 'loading' },
  ] : [];
  const todo = checklist.filter(c => !c.ok && !c.optional).length;
  const ca = CARD_ACCEPTANCE[profile.cardAcceptance];
  const hour = new Date().getHours();
  const greet = hour < 18 ? 'Bonjour' : 'Bonsoir';

  return (
    <div className="stack-lg">
      <header className="row-between">
        <div><h1>{greet}{user?.firstName ? `, ${user.firstName}` : ''}</h1><p className="muted small">{user?.businessName} · {fmtDayShort(new Date())}</p></div>
        <div className="row"><Button to="/activite/journal" icon="book">Journal</Button><Button variant="primary" to="/caisse/encaisser" icon="arrowDown">Encaisser</Button></div>
      </header>

      {sum.state === 'unavailable' && <FeatureUnavailable title="Résumé de caisse indisponible" />}
      {sum.state === 'error' && <Card><ErrorState error={sum.error} onRetry={sum.reload} /></Card>}

      {sum.state === 'loading' ? <div className="grid-3"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div> : sum.state === 'ok' && (
        <div className="grid-3">
          <Card hero>
            <Stat label="Solde disponible" value={fmtMoney(bal.available, currency)} large />
            <div className="row-between mt-3 small" style={{ color: 'rgba(255,255,255,.85)' }}>
              <span>En attente : <strong>{fmtMoney(bal.pending, currency)}</strong></span>
              {bal.reserved > 0 && <span>Réservé : <strong>{fmtMoney(bal.reserved, currency)}</strong></span>}
            </div>
            <div className="row hero-actions" style={{ gap: 8 }}>
              <Button size="sm" variant="secondary" to="/caisse/retirer" icon="arrowUp">Retirer</Button>
              <Button size="sm" variant="secondary" to="/caisse/transferer" icon="swap">Transférer</Button>
            </div>
          </Card>
          <Card>
            <Stat label="Encaissé aujourd’hui" value={fmtMoney(today.collected, currency)} tone="success" hint={`${today.collectedCount || 0} ${pluralize(today.collectedCount, 'opération')}`} />
            <div className="kv-box mt-3 small">
              <div className="kv"><span className="k">Mobile Money</span><span className="v">{fmtMoney(today.byMethod?.mobile_money, currency)}</span></div>
              <div className="kv"><span className="k">Carte</span><span className="v">{fmtMoney(today.byMethod?.card, currency)}</span></div>
              <div className="kv"><span className="k">Retiré</span><span className="v">{fmtMoney(today.withdrawn, currency)}</span></div>
            </div>
          </Card>
          <Card>
            <div className="row-between">
              <Stat label="7 derniers jours" value={fmtMoney(weekTotal, currency)} tone="primary" hint={`${weekCount} ${pluralize(weekCount, 'encaissement')} confirmés`} />
              <Sparkline values={week.map(d => d.values[0] + d.values[1])} width={110} height={40} title="Encaissements des 7 derniers jours" />
            </div>
            <div className="kv-box mt-3 small">
              <div className="kv"><span className="k">Mobile Money</span><span className="v">{fmtMoney(weekMm, currency)}</span></div>
              <div className="kv"><span className="k">Carte</span><span className="v">{fmtMoney(weekCard, currency)}</span></div>
              <div className="kv"><span className="k">Règlement à venir</span><span className="v">{dash.state === 'ok' ? fmtMoney(dash.data?.settlingTomorrow, currency) : dash.state === 'loading' ? <Skeleton width={70} height={14} /> : '—'}</span></div>
            </div>
          </Card>
        </div>
      )}

      <section>
        <h2 className="mb-3" style={{ fontSize: 'var(--fs-md)' }}>Actions rapides</h2>
        <div className="quick-actions">
          <Link to="/caisse/encaisser" className="qa-accent"><span className="qa-ic"><Icon name="arrowDown" /></span>Encaisser</Link>
          <Link to="/caisse/retirer" className="qa-primary"><span className="qa-ic"><Icon name="arrowUp" /></span>Retirer</Link>
          <Link to="/caisse/transferer" className="qa-cyan"><span className="qa-ic"><Icon name="swap" /></span>Transférer</Link>
          <Link to="/ventes/liens?nouveau=1" className="qa-success"><span className="qa-ic"><Icon name="link" /></span>Créer un lien</Link>
        </div>
      </section>

      <div className="grid-2 grid-chart">
        <Card title="Encaissements par jour" subtitle="Montants confirmés, par moyen de paiement"
          actions={<div className="pill-select" role="group" aria-label="Période">{[7, 30].map(r => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r} j</button>)}</div>}>
          {txns.state === 'loading' ? <Skeleton height={160} /> : txns.state === 'error' ? <ErrorState error={txns.error} onRetry={txns.reload} /> : (
            <>
              <BarChart data={series} currency={currency} title={`Encaissements des ${range} derniers jours`} series={[{ name: 'Mobile Money', color: 'var(--primary)' }, { name: 'Carte', color: 'var(--cyan)' }]} />
              {truncated && <p className="xs muted mt-2">Graphique établi sur les 100 derniers encaissements des 30 derniers jours ; consultez le journal pour l’exhaustivité.</p>}
            </>
          )}
        </Card>
        <Card title="Mise en route" subtitle={sum.state === 'ok' ? (todo === 0 ? 'Votre compte est prêt.' : `${todo} ${pluralize(todo, 'action restante', 'actions restantes')}`) : undefined}>
          {sum.state === 'loading' ? <div className="stack"><Skeleton /><Skeleton /><Skeleton /></div> : (
            <div className="checklist">
              {checklist.map(c => (
                <Link key={c.label} to={c.to}>
                  {c.pending ? <Skeleton width={18} height={18} /> : <Icon name={c.ok ? 'checkCircle' : 'clock'} className={c.ok ? 'ok' : 'todo'} size={18} />}
                  <span>{c.label}</span><Icon name="chevronRight" size={16} className="arrow" />
                </Link>
              ))}
            </div>
          )}
          {ca && sum.state === 'ok' && <Notice tone={ca.tone} className="mt-4">{ca.text}</Notice>}
          {limits.withdrawDailyMax != null && <p className="xs muted mt-3">Plafond de retrait : {fmtMoney(limits.withdrawDailyMax, currency)} / jour · restant aujourd’hui {fmtMoney(limits.withdrawDailyRemaining, currency)} · <Link to="/compte/tarifs">Tarifs & frais</Link></p>}
        </Card>
      </div>

      <Card title="Dernières opérations" flush actions={<Button size="sm" variant="ghost" to="/activite/journal" iconRight="chevronRight">Tout le journal</Button>}>
        {recent.state === 'loading' && <div className="skeleton-rows">{[1, 2, 3, 4].map(i => <Skeleton key={i} height={18} />)}</div>}
        {recent.state === 'error' && <ErrorState error={recent.error} onRetry={recent.reload} />}
        {recent.state === 'unavailable' && <div className="empty"><p className="small">Journal en cours d’intégration.</p></div>}
        {recent.state === 'ok' && (recent.data?.data || []).length === 0 && <div className="empty"><Icon name="inbox" size={36} className="ic" /><h3>Aucune opération pour l’instant</h3><p className="small">Votre premier encaissement apparaîtra ici.</p><Button variant="primary" to="/caisse/encaisser" className="mt-3">Encaisser une vente</Button></div>}
        {recent.state === 'ok' && (recent.data?.data || []).map(r => {
          const inn = CASH_IN_TYPES.includes(r.type);
          return (
            <button key={r.id} className={`op-row ${inn ? 'op-in' : 'op-out'}`} onClick={() => setDetail(r)}>
              <span className="op-ic"><Icon name={inn ? 'arrowDown' : 'arrowUp'} size={18} /></span>
              <span className="op-main"><span className="op-title truncate">{typeLabel(r.type)}{r.counterparty ? ` · ${r.counterparty}` : ''}</span><span className="op-meta truncate">{fmtRelative(r.createdAt)} · {fmtDateTime(r.createdAt)}{r.reference ? ` · ${r.reference}` : ''}</span></span>
              <span className="op-amt"><span className="a">{inn ? '+' : '−'} {fmtMoney(r.amount, r.currency || currency)}</span><br /><StatusBadge status={r.status} /></span>
            </button>
          );
        })}
      </Card>
      {detail && <TransactionDrawer row={detail} currency={currency} onClose={() => setDetail(null)} />}
    </div>
  );
};
export default Accueil;
