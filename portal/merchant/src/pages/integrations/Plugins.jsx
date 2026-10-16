import React from 'react';
import { Button, Card, PageHeader, Badge, Icon, Notice } from '../../components';

const VERSION = '2.7.0';
const ITEMS = [
  { id: 'woocommerce', name: 'Extension WooCommerce', icon: 'box', version: VERSION, requires: 'WooCommerce 6.0+ · PHP 7.4+', tags: ['Mobile Money', 'Carte'], download: `https://c-pay.global/downloads/cpay-payment-gateway-v${VERSION}.zip`,
    desc: 'Acceptez le Mobile Money et la carte sur votre boutique WordPress / WooCommerce.',
    steps: ['Téléchargez l’archive ZIP ci-contre.', 'WordPress → Extensions → Ajouter → Téléverser l’extension, puis activez « C-Pay Payment Gateway ».', 'WooCommerce → Réglages → Paiements → C-Pay : saisissez votre clé API et votre secret (page Clés API).', 'Dans C-Pay → Intégrations → Webhooks, renseignez l’URL indiquée par l’extension (https://votresite.com/wc-api/cpay_webhook) et enregistrez le secret affiché.', 'Passez une commande de test : le statut est mis à jour dès confirmation du paiement.'] },
  { id: 'android-sdk', name: 'SDK Android', icon: 'smartphone', version: VERSION, requires: 'Android 5.0+ · Kotlin 1.8+ ou Java 11+', tags: ['Kotlin', 'Java'], download: `https://c-pay.global/downloads/cpay-android-sdk-v${VERSION}.zip`,
    desc: 'Intégrez l’encaissement C-Pay (Mobile Money, lien de paiement, QR) dans votre application Android.',
    steps: ['Téléchargez le SDK (ZIP) et copiez le fichier .aar dans app/libs/.', 'Ajoutez la dépendance dans build.gradle.', 'Initialisez le SDK avec votre clé API dans Application.onCreate().', 'Appelez CPay.collect() pour encaisser ; écoutez le résultat via le callback.'] },
];

// Plugins & SDK : liens de téléchargement de la vitrine et guides d'installation.
export const Plugins = () => (
  <div className="stack-lg">
    <PageHeader title="Plugins & SDK" subtitle={`Connectez C-Pay à votre site ou votre application. Version courante : ${VERSION}.`} />
    <div className="tile-list">
      {ITEMS.map(p => (
        <Card key={p.id}>
          <div className="row mb-3" style={{ alignItems: 'flex-start' }}>
            <span className="qa-ic" style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--primary-50)', color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name={p.icon} size={22} /></span>
            <div style={{ minWidth: 0 }}><h2 style={{ fontSize: 'var(--fs-md)' }}>{p.name}</h2><div className="xs muted">v{p.version} · {p.requires}</div><div className="row mt-2" style={{ gap: 4, flexWrap: 'wrap' }}>{p.tags.map(t => <Badge key={t} tone="cyan">{t}</Badge>)}</div></div>
          </div>
          <p className="small text-2 mb-4">{p.desc}</p>
          <div className="form-actions mb-4"><Button variant="primary" icon="download" href={p.download}>Télécharger</Button><Button icon="external" href="https://c-pay.global/developers">Documentation</Button></div>
          <p className="field-label mb-2">Installation</p>
          <ol className="step-list">{p.steps.map((s, i) => <li key={i}><span>{s}</span></li>)}</ol>
        </Card>
      ))}
    </div>
    <Card title="API REST et autres plateformes">
      <p className="small text-2">L’API REST (clés API, webhooks) couvre tout besoin d’intégration sur mesure : <a href="https://c-pay.global/developers" target="_blank" rel="noreferrer">c-pay.global/developers</a>. Des extensions PrestaShop, Shopify et Magento sont à l’étude ; signalez votre besoin à <a href="mailto:sales@c-pay.global">sales@c-pay.global</a>.</p>
      <Notice tone="neutral" className="mt-3">L’application mobile C-Pay pour vos terminaux (Android) est distribuée par l’équipe C-Pay : voir la page Terminaux.</Notice>
    </Card>
  </div>
);
export default Plugins;
