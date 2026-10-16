import React from 'react';
import { Outlet } from 'react-router-dom';
import { Icon } from '../components';

const POINTS = [
  { icon: 'credit-card', text: 'Votre carte virtuelle C-Pay, toujours à portée de main' },
  { icon: 'qr-code', text: 'Payez vos marchands en scannant un QR code' },
  { icon: 'shield-check', text: 'Sécurité renforcée : PIN, double authentification, alertes' },
];

export default function AuthLayout() {
  return (
    <div className="auth">
      <aside className="auth-side">
        <div className="as-brand"><img src="/logo-calculus.png" alt="" />C-Pay</div>
        <div>
          <h2>Votre argent, simplement et en toute sécurité.</h2>
          <p>Gérez votre carte prépayée C-Pay, suivez vos opérations et payez vos commerçants depuis votre téléphone.</p>
          <ul>
            {POINTS.map((p) => <li key={p.icon}><span className="as-dot"><Icon name={p.icon} size={16} /></span>{p.text}</li>)}
          </ul>
        </div>
        <div className="as-foot">C-Pay est un produit de Calculus Plus SAS · support@c-pay.global</div>
      </aside>
      <main className="auth-main">
        <div className="auth-box">
          <div className="ab-logo"><img src="/logo-calculus.png" alt="" />C-Pay</div>
          <Outlet />
          <div className="ab-legal">C-Pay est un produit de Calculus Plus SAS</div>
        </div>
      </main>
    </div>
  );
}
