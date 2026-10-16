import React from 'react';
import { Icon } from '../components';
import Brand from './Brand';

// Mise en page des écrans publics (connexion, inscription, mot de passe).
export const AuthLayout = ({ title, lead, children, footer }) => (
  <div className="auth">
    <aside className="auth-side">
      <Brand to="/login" />
      <div>
        <h1>Encaissez, retirez, transférez.</h1>
        <p>L’espace marchand C-Pay centralise vos encaissements par Mobile Money et par carte, vos retraits et vos transferts bancaires, avec un journal unique.</p>
        <ul>
          <li><Icon name="checkCircle" className="ic" size={18} />Encaissement Mobile Money par simple numéro</li>
          <li><Icon name="checkCircle" className="ic" size={18} />Liens de paiement et QR code par carte</li>
          <li><Icon name="checkCircle" className="ic" size={18} />Retraits vers votre wallet, virements vers votre banque</li>
          <li><Icon name="checkCircle" className="ic" size={18} />Confirmation forte sur chaque sortie de fonds</li>
        </ul>
      </div>
      <div className="foot">C-Pay est un produit de Calculus Plus SAS · c-pay.global</div>
    </aside>
    <div className="auth-main">
      <div className="auth-card">
        <Brand to="/login" />
        {title && <h1>{title}</h1>}
        {lead && <p className="lead">{lead}</p>}
        {children}
        {footer}
        <div className="foot">C-Pay est un produit de Calculus Plus SAS · <a href="https://c-pay.global/legal/cgu.html" target="_blank" rel="noreferrer">CGU</a> · <a href="https://c-pay.global/legal/confidentialite.html" target="_blank" rel="noreferrer">Confidentialité</a></div>
      </div>
    </div>
  </div>
);
export default AuthLayout;
