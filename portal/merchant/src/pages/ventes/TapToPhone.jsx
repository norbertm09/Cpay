import React from 'react';
import { Button, Card, PageHeader, Icon, Notice } from '../../components';

// Tap-to-Phone : page d'information honnête, la fonction est conditionnée à
// la certification du SDK (aucune simulation).
export const TapToPhone = () => (
  <div className="medium stack-lg">
    <PageHeader title="Tap-to-Phone" subtitle="Encaisser par carte sans contact directement sur votre téléphone Android." />
    <Card>
      <div className="big-status info">
        <span className="ic"><Icon name="contactless" size={30} /></span>
        <h2>Bientôt disponible, après certification</h2>
        <p className="small text-2" style={{ maxWidth: 520, margin: '0 auto' }}>Le paiement par carte sans contact sur téléphone (Tap-to-Phone) nécessite un SDK certifié par les réseaux de cartes. La certification est en cours : la fonction sera activée dans votre espace dès son obtention, sans action de votre part.</p>
      </div>
      <Notice tone="info" className="mt-4">En attendant, vous acceptez déjà la carte via un <strong>lien de paiement</strong> ou un <strong>QR code</strong> : le client paie sur la page sécurisée pay.c-pay.global, sans qu’aucune donnée de carte ne transite par votre appareil.</Notice>
      <div className="form-actions mt-4"><Button variant="primary" to="/caisse/encaisser" icon="arrowDown">Encaisser par lien carte</Button><Button to="/ventes/liens" icon="qr">Créer un QR code</Button></div>
    </Card>
    <Card title="Ce que Tap-to-Phone apportera">
      <ul className="small text-2" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
        <li>Acceptation des cartes Visa et Mastercard sans contact, sans terminal dédié.</li>
        <li>Même journal, mêmes règlements et mêmes frais que les autres encaissements carte (voir Tarifs & frais).</li>
        <li>Compatible avec les terminaux Android déjà déclarés dans « Terminaux ».</li>
      </ul>
      <p className="xs muted mt-3">Pour être informé de l’ouverture, écrivez à <a href="mailto:sales@c-pay.global">sales@c-pay.global</a>.</p>
    </Card>
  </div>
);
export default TapToPhone;
