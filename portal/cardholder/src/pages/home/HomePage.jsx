import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useAsync } from '../../hooks/useAsync';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { Card, Stat, Alert, Button, Icon, VirtualCard, TxnList, SkeletonList, Skeleton, EmptyState, ErrorState, Badge } from '../../components';
import * as ops from '../../services/operations';
import * as cardsApi from '../../services/cards';
import { kyc as kycApi } from '../../services/profile';
import { formatMoney, greeting } from '../../utils/format';
import { FEATURES } from '../../utils/features';
import { cardStatus } from '../../utils/txn';

const QuickAction = ({ to, icon, label, accent, off }) => (
  <Link to={to} className={`quick-action ${accent ? 'qa-accent' : ''} ${off ? 'qa-off' : ''}`} aria-label={off ? `${label} (en cours d’intégration)` : label}>
    <span className="qa-icon"><Icon name={icon} size={22} /></span>
    <span>{label}</span>
  </Link>
);

export default function HomePage() {
  useDocumentTitle('Accueil');
  const { user } = useAuth();
  const navigate = useNavigate();
  const dash = useAsync(ops.dashboard, []);
  const created = useAsync(cardsApi.listCreated, []);
  const kyc = useAsync(kycApi.get, []);

  const card = user?.card;
  const mainStatus = cardStatus(card?.status);
  const kycApproved = (kyc.data?.documents || []).some((d) => d.status === 'approved');
  const kycPending = (kyc.data?.documents || []).some((d) => d.status === 'pending');
  const cards = created.data?.data || [];
  const recent = dash.data?.recentTransactions || [];

  const alerts = [];
  if (user?.mustChangePassword) alerts.push({ tone: 'error', title: 'Mot de passe temporaire', text: 'Choisissez un mot de passe personnel pour sécuriser votre compte.', to: '/profil/securite', cta: 'Changer le mot de passe' });
  if (card && card.status === 'frozen') alerts.push({ tone: 'warn', title: 'Votre carte est gelée', text: 'Les paiements sont bloqués tant que la carte n’est pas réactivée.', to: '/cartes', cta: 'Gérer ma carte' });
  if (user && user._source === 'me' && !user.mfaEnabled) alerts.push({ tone: 'info', title: 'Protégez votre compte', text: 'Activez la double authentification (2FA) pour sécuriser vos connexions.', to: '/profil/securite', cta: 'Activer la 2FA' });
  if (kyc.data && !kycApproved && !kycPending) alerts.push({ tone: 'info', title: 'Vérification d’identité', text: 'Transmettez une pièce d’identité pour débloquer l’ensemble des plafonds.', to: '/profil/verification', cta: 'Compléter mon profil' });

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div>
        <p className="muted small">{greeting()}{user?.firstName ? `, ${user.firstName}` : ''}</p>
        <h1>Votre espace C-Pay</h1>
      </div>

      {alerts.length ? (
        <div className="alerts">
          {alerts.map((a) => (
            <Alert key={a.title} tone={a.tone} title={a.title} action={<Button size="sm" variant="outline" to={a.to}>{a.cta}</Button>}>{a.text}</Alert>
          ))}
        </div>
      ) : null}

      <Card>
        <div className="home-hero">
          <div className="stack">
            <div className="balance-hero">
              <span className="bh-label">Solde disponible</span>
              {card ? <span className="bh-value">{formatMoney(card.balance, card.currency)}</span> : <Skeleton h={38} w={220} />}
              {card ? <span className="small muted row">{card.cardMasked} <Badge tone={mainStatus.tone} dot>{mainStatus.label}</Badge></span> : null}
            </div>
            <div className="quick-actions">
              <QuickAction to="/payer" icon="send" label="Payer" accent />
              <QuickAction to="/operations/recharger" icon="arrow-down-left" label="Recharger" off={!FEATURES.topup} />
              <QuickAction to="/cartes" icon="credit-card" label="Mes cartes" />
              <QuickAction to="/aide/reclamations" icon="life-buoy" label="Signaler" />
            </div>
          </div>
          {card ? <VirtualCard card={card} /> : <Skeleton h={220} style={{ borderRadius: 18, maxWidth: 420, justifySelf: 'end', width: '100%' }} />}
        </div>
      </Card>

      <div className="grid-3 stats">
        <Stat label="Dépenses 30 jours" icon="shopping-bag" loading={dash.loading} value={formatMoney(dash.data?.stats?.monthSpent ?? 0, card?.currency)} />
        <Stat label="Opérations 30 jours" icon="list" loading={dash.loading} value={dash.data?.stats?.monthCount ?? 0} hint={dash.data ? `${dash.data.stats?.todayCount ?? 0} aujourd’hui` : undefined} />
        <Stat label="Rechargements 30 jours" icon="arrow-down-left" loading={dash.loading} value={formatMoney(dash.data?.stats?.monthTopup ?? 0, card?.currency)} />
      </div>

      <div className="home-grid">
        <Card flush title="Opérations récentes" actions={<Button size="sm" variant="ghost" to="/operations" iconRight="chevron-right">Tout voir</Button>}>
          {dash.loading ? <SkeletonList rows={5} />
            : dash.error ? <ErrorState error={dash.error} onRetry={dash.reload} />
              : recent.length ? <TxnList txns={recent} onSelect={(t) => navigate(`/operations?op=${t.txn_id}`)} />
                : <EmptyState icon="receipt" title="Aucune opération pour le moment">Vos paiements et rechargements apparaîtront ici.</EmptyState>}
        </Card>

        <div className="stack">
          <Card flush title="Mes cartes" actions={<Button size="sm" variant="ghost" to="/cartes" iconRight="chevron-right">Gérer</Button>}>
            {created.loading ? <SkeletonList rows={2} />
              : created.error ? <ErrorState error={created.error} onRetry={created.reload} />
                : (cards.length ? cards : card ? [card] : []).map((c) => {
                  const st = cardStatus(c.status);
                  return (
                    <Link key={c.cardId} to="/cartes" className="list-item">
                      <span className="li-icon icon-pay"><Icon name="credit-card" size={18} /></span>
                      <span className="li-main">
                        <span className="li-title">{c.label || 'Carte virtuelle'} <span className="muted mono xs">{String(c.cardMasked || '').slice(-4)}</span></span>
                        <span className="li-sub"><Badge tone={st.tone}>{st.label}</Badge></span>
                      </span>
                      <span className="li-end"><span className="li-amount">{formatMoney(c.balance, c.currency)}</span></span>
                    </Link>
                  );
                })}
          </Card>
          <Card>
            <div className="contact-card">
              <span className="cc-icon"><Icon name="life-buoy" size={20} /></span>
              <div>
                <h3>Besoin d’aide ?</h3>
                <p className="small text-2" style={{ margin: '4px 0 10px' }}>Une opération inconnue, une carte bloquée ? Notre équipe vous répond.</p>
                <div className="row wrap">
                  <Button size="sm" variant="outline" to="/aide/reclamations">Déposer une réclamation</Button>
                  <Button size="sm" variant="ghost" to="/aide">Consulter l’aide</Button>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
