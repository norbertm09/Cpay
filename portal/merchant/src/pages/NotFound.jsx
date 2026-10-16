import React from 'react';
import { Button, EmptyState } from '../components';

export const NotFound = () => (
  <div className="card medium" style={{ margin: '0 auto' }}>
    <EmptyState icon="search" title="Page introuvable" message="L’adresse demandée n’existe pas ou a été déplacée." action={<Button variant="primary" to="/">Retour à l’accueil</Button>} />
  </div>
);
export default NotFound;
