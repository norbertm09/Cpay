import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../components/Icon';
import { Button, Card, Stat, StatusBadge, PageHeader, Skeleton, EmptyState, Badge } from '../../components/ui';
import { AreaChart, BarChart, Donut } from '../../components/charts';
import { useQuery } from '../../hooks/useQuery';
import { useAuth } from '../../hooks/useAuth';
import { monitorApi, cashApi, crmApi, financeApi, supportApi, fraudApi, configApi } from '../../services/api';
import { fmtNumber, fmtMoney, fmtPct, fmtTime, fmtDateTime, fmtDuration, countryName, methodLabel, fmtAgo } from '../../utils/format';
import { PERMS } from '../../utils/roles';

// Agrégats calculés sur le flux GET /activity/live (transactions des 24 dernières heures, 100 max)
const aggregate = (txns) => {
  const byHour = new Map(); const byMethod = new Map(); const byCountry = new Map(); const byCurrency = new Map(); const byStatus = { authorized: 0, pending: 0, failed: 0 };
  const now = Date.now();
  for (let i = 23; i >= 0; i -= 1) { const d = new Date(now - i * 3600000); byHour.set(`${String(d.getHours()).padStart(2, '0')}h`, 0); }
  txns.forEach((t) => {
    const amt = Number(t.amount) || 0; const ok = t.status === 'authorized';
    const d = new Date(t.initiated_at); const k = `${String(d.getHours()).padStart(2, '0')}h`;
    if (byHour.has(k) && ok) byHour.set(k, byHour.get(k) + amt);
    if (ok) {
      byMethod.set(t.payment_method, (byMethod.get(t.payment_method) || 0) + amt);
      const c = t.country || t.detected_country || '—'; byCountry.set(c, (byCountry.get(c) || 0) + amt);
      byCurrency.set(t.currency || '—', (byCurrency.get(t.currency || '—') || 0) + amt);
    }
    if (byStatus[t.status] !== undefined) byStatus[t.status] += 1; else byStatus.failed += 0;
  });
  const sortMap = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    hours: [...byHour.entries()].map(([label, value]) => ({ label, value })),
    methods: sortMap(byMethod).map(([k, v]) => ({ label: methodLabel(k), value: v })),
    countries: sortMap(byCountry).map(([k, v]) => ({ label: countryName(k), value: v })),
    currencies: sortMap(byCurrency),
    status: byStatus,
  };
};

export default function DashboardPage() {
  const { admin, hasRole, isSuperAdmin } = useAuth();
  const ops = hasRole(PERMS.ops), crm = hasRole(PERMS.crm), fin = hasRole(PERMS.finance);

  const stats = useQuery(() => monitorApi.stats().then((r) => r.data), [], { interval: 60000 });
  const live = useQuery(() => monitorApi.live().then((r) => r.data.data || []), [], { interval: 30000 });
  const cash = useQuery(() => cashApi.stats().then((r) => r.data), [], { enabled: ops, interval: 60000 });
  const crmStats = useQuery(() => crmApi.stats().then((r) => r.data), [], { enabled: crm, interval: 60000 });
  const payouts = useQuery(() => financeApi.payoutsSummary().then((r) => r.data), [], { enabled: fin });
  const tickets = useQuery(() => supportApi.tickets({ status: 'open', limit: 1 }).then((r) => r.data.total), [], { interval: 60000 });
  const alerts = useQuery(() => fraudApi.alerts({ resolved: false, limit: 1 }).then((r) => r.data.total), []);
  const health = useQuery(() => monitorApi.health().then((r) => r.data).catch((e) => e.response?.data || { status: 'unreachable' }), [], { interval: 60000 });
  const lastReconcile = useQuery(() => configApi.auditLogs({ limit: 100 }).then((r) => (r.data.data || []).find((l) => l.action === 'RECONCILE_RUN') || null), [], { enabled: isSuperAdmin });

  const agg = useMemo(() => aggregate(live.data || []), [live.data]);
  const s = stats.data || {};
  const today = s.today || {};
  const mainCurrency = agg.currencies[0]?.[0];
  const reload = () => { stats.reload(); live.reload(); cash.reload(); crmStats.reload(); payouts.reload(); tickets.reload(); alerts.reload(); health.reload(); };

  const queues = [
    ops && { label: 'Virements à exécuter', value: cash.data?.queues?.pendingManual?.count, sub: cash.data ? fmtMoney(cash.data.queues?.pendingManual?.amount) : null, to: '/operations/caisse?tab=files', icon: 'banknote', tone: 'warn' },
    ops && { label: 'Approvisionnements à confirmer', value: cash.data?.queues?.awaitingFunds?.count, sub: cash.data ? fmtMoney(cash.data.queues?.awaitingFunds?.amount) : null, to: '/operations/caisse?tab=files&queue=awaiting_funds', icon: 'wallet', tone: 'warn' },
    fin && { label: 'Retraits bancaires en attente', value: payouts.data?.pending, sub: payouts.data ? fmtMoney(payouts.data.pendingAmount) : null, to: '/operations/reglements?tab=virements', icon: 'receipt', tone: 'accent' },
    crm && { label: 'Réclamations ouvertes', value: crmStats.data?.claims?.open, sub: crmStats.data ? `${crmStats.data.claims?.last7d ?? 0} sur 7 j` : null, to: '/support/reclamations?status=open', icon: 'flag', tone: 'error' },
    { label: 'Tickets ouverts', value: tickets.data, to: '/support/tickets?status=open', icon: 'lifebuoy', tone: 'error' },
    crm && { label: 'Nouveaux leads', value: crmStats.data?.leads?.new, sub: crmStats.data ? `${crmStats.data.leads?.last7d ?? 0} sur 7 j` : null, to: '/support/leads?status=new', icon: 'target', tone: 'cyan' },
    { label: 'Alertes AML ouvertes', value: alerts.forbidden ? '—' : alerts.data, to: '/operations/fraude?tab=alertes', icon: 'shield', tone: 'warn' },
  ].filter(Boolean);

  const h = health.data;
  const healthTone = h?.status === 'ok' ? 'success' : h?.status === 'degraded' ? 'warn' : 'error';
  const hello = admin?.firstName ? `Bonjour ${admin.firstName}` : 'Tableau de bord';

  return (
    <div className="page">
      <PageHeader title={hello} subtitle={`Vue d’ensemble de la plateforme · ${fmtDateTime(new Date())}`}
        actions={<><Button icon="refresh" onClick={reload} loading={stats.loading && !!stats.data}>Actualiser</Button>{ops && <Button variant="primary" icon="banknote" to="/operations/caisse?tab=files">Traiter la caisse</Button>}</>} />

      {/* KPI du jour */}
      <div className="grid grid-4">
        <Stat label="Transactions aujourd’hui" value={stats.loading && !stats.data ? '…' : fmtNumber(today.total)} sub={`${fmtNumber(today.approved)} autorisées · ${fmtNumber(today.failed)} échouées`} icon="swap" />
        <Stat label="Volume autorisé aujourd’hui" value={stats.loading && !stats.data ? '…' : fmtMoney(today.volume, agg.currencies.length === 1 ? mainCurrency : undefined)} sub={agg.currencies.length > 1 ? `somme toutes devises · 24 h : ${agg.currencies.map(([c, v]) => fmtMoney(v, c)).join(' · ')}` : 'montants autorisés du jour'} icon="trending" tone="accent" />
        <Stat label="Taux d’autorisation" value={stats.loading && !stats.data ? '…' : fmtPct(today.approved, today.total)} sub="sur les transactions du jour" icon="gauge" tone="success" />
        <Stat label="Marchands actifs" value={stats.loading && !stats.data ? '…' : fmtNumber(s.merchants?.active)} sub={`${fmtNumber(s.merchants?.total)} au total`} icon="store" tone="cyan" to="/marchands?status=active" />
      </div>

      {/* Files d'attente */}
      <Card title="Files d’attente" sub="Ce qui attend une action des équipes C-Pay" dense>
        <div className="grid grid-auto" style={{ gap: 12 }}>
          {queues.map((q) => (
            <Link key={q.label} to={q.to} className="stat-link">
              <div className="card stat" style={{ boxShadow: 'none' }}>
                <div className={`stat-icon ${q.value > 0 ? q.tone : ''}`}><Icon name={q.icon} size={18} /></div>
                <div><div className="stat-label">{q.label}</div><div className="stat-value sm" style={{ color: q.value > 0 ? 'var(--text)' : 'var(--text-3)' }}>{q.value === undefined || q.value === null ? '…' : fmtNumber(q.value)}</div>{q.sub && <div className="stat-sub">{q.sub}</div>}</div>
              </div>
            </Link>
          ))}
        </div>
      </Card>

      <div className="grid grid-main">
        <div className="stack-lg">
          <Card title="Volume autorisé — 24 dernières heures" sub={`Par heure, d’après les ${fmtNumber((live.data || []).length)} dernières transactions (flux live)`}>
            {live.loading && !live.data ? <Skeleton lines={4} /> : <AreaChart data={agg.hours} format={(v) => fmtMoney(v, mainCurrency)} id="h24" />}
          </Card>
          <div className="grid grid-2">
            <Card title="Par méthode de paiement" sub="24 h, montants autorisés">
              {live.loading && !live.data ? <Skeleton /> : <BarChart data={agg.methods} format={(v) => fmtMoney(v, mainCurrency)} color="var(--series-2)" />}
            </Card>
            <Card title="Par pays" sub="24 h, montants autorisés">
              {live.loading && !live.data ? <Skeleton /> : <BarChart data={agg.countries} format={(v) => fmtMoney(v, mainCurrency)} color="var(--series-3)" />}
            </Card>
            <Card title="Opérateurs les plus utilisés" sub="7 derniers jours, nombre de transactions">
              {stats.loading && !stats.data ? <Skeleton /> : <BarChart data={(s.topOperators || []).map((o) => ({ label: o.operator, value: o.count }))} />}
            </Card>
            <Card title="Statuts des transactions" sub="24 dernières heures">
              {live.loading && !live.data ? <Skeleton /> : (
                <Donut data={[
                  { label: 'Autorisées', value: agg.status.authorized, color: 'var(--success)' },
                  { label: 'En attente', value: agg.status.pending, color: 'var(--warn)' },
                  { label: 'Échouées', value: agg.status.failed, color: 'var(--error)' },
                ]} />
              )}
            </Card>
          </div>
          {ops && cash.data && (
            <Card title="Caisse marchande" sub="Encaissements, retraits et transferts" actions={<Button size="sm" to="/operations/caisse" icon="arrowRight">Ouvrir la caisse</Button>}>
              <div className="grid grid-4" style={{ gap: 12 }}>
                {[['Encaissé aujourd’hui', cash.data.today?.collected], ['Retiré (wallet)', cash.data.today?.withdrawn], ['Wallet → banque', cash.data.today?.transfersOut], ['Banque → wallet', cash.data.today?.transfersIn]].map(([l, v]) => (
                  <div key={l} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px' }}>
                    <div className="xs muted">{l}</div>
                    <div className="strong num" style={{ fontSize: 18 }}>{fmtMoney(v?.amount)}</div>
                    <div className="xs muted">{fmtNumber(v?.count)} opération(s) · 7 j : {fmtMoney(cash.data.last7Days?.[l.includes('Encaiss') ? 'collected' : l.includes('Retir') ? 'withdrawn' : l.includes('Wallet →') ? 'transfersOut' : 'transfersIn']?.amount)}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="stack-lg">
          <Card title="Santé du système" dense actions={<Badge tone={healthTone} dot>{h?.status === 'ok' ? 'Opérationnel' : h?.status === 'degraded' ? 'Dégradé' : 'Injoignable'}</Badge>}>
            <div className="kv">
              <div>API</div><div>{h?.version ? `v${h.version}` : '—'}{h?.env ? <span className="muted"> · {h.env}</span> : null}</div>
              <div>Base de données</div><div>{h?.db === 'connected' ? <span className="success">connectée</span> : <span className="error">{h?.db || 'inconnue'}</span>}</div>
              <div>Disponibilité</div><div>{fmtDuration(h?.uptime)}</div>
              <div>Passerelles actives (7 j)</div><div>{(s.gateways || []).length ? s.gateways.map((g) => g.gateway).join(', ') : '—'}</div>
              <div>Dernière réconciliation</div><div>{isSuperAdmin ? (lastReconcile.data ? <>{fmtAgo(lastReconcile.data.created_at)} <span className="muted">· {lastReconcile.data.actor_email}</span></> : lastReconcile.loading ? '…' : 'aucune trace récente') : <span className="muted">journal réservé au super administrateur</span>}</div>
            </div>
            {ops && <div className="mt-3"><Button size="sm" to="/operations/transactions?status=pending" icon="refresh">Réconcilier les transactions en attente</Button></div>}
          </Card>

          <Card title="Activité en direct" sub="Dernières transactions (actualisation 30 s)" dense actions={<Button size="sm" variant="ghost" to="/configuration/monitoring">Tout voir</Button>}>
            {live.loading && !live.data ? <Skeleton lines={6} /> : !(live.data || []).length ? <EmptyState icon="activity" title="Aucune transaction sur 24 h" /> : (
              <div>
                {(live.data || []).slice(0, 12).map((t) => (
                  <div key={t.transaction_id} className="list-item" style={{ padding: '8px 0' }}>
                    <span className="cell-date" style={{ width: 42 }}>{fmtTime(t.initiated_at)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="truncate small strong">{t.business_name}</div>
                      <div className="xs muted truncate">{methodLabel(t.payment_method)} · {t.detected_operator || t.detected_network || countryName(t.country)}</div>
                    </div>
                    <span className="amount small">{fmtMoney(t.amount, t.currency)}</span>
                    <StatusBadge status={t.status} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          {crm && crmStats.data && (
            <Card title="CRM" sub="Leads, réclamations, assistant" dense actions={<Button size="sm" variant="ghost" to="/support/leads">Ouvrir</Button>}>
              <div className="kv">
                <div>Leads</div><div>{fmtNumber(crmStats.data.leads?.new)} nouveaux <span className="muted">· {fmtNumber(crmStats.data.leads?.total)} au total</span></div>
                <div>Réclamations</div><div>{fmtNumber(crmStats.data.claims?.open)} ouvertes <span className="muted">· {fmtNumber(crmStats.data.claims?.total)} au total</span></div>
                <div>Conversations (7 j)</div><div>{fmtNumber(crmStats.data.conversations?.last7d)} <span className="muted">· {fmtNumber(crmStats.data.conversations?.handoffs)} transferts humain</span></div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
