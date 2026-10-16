import React from 'react';
import { Link } from 'react-router-dom';

export const Brand = ({ to = '/', className = '' }) => (
  <Link to={to} className={`brand ${className}`} aria-label="C-Pay, accueil">
    <img src="/logo-calculus.png" alt="" onError={e => { e.target.style.display = 'none'; }} />
    <span className="wordmark">C<em>-</em>Pay</span>
  </Link>
);
export default Brand;
