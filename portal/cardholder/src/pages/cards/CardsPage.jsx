import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { PageHeader, Tabs } from '../../components';
import VirtualCardsTab from './VirtualCardsTab';
import GtpCardsTab from './GtpCardsTab';
import ExternalCardsTab from './ExternalCardsTab';

const TABS = [
  { key: 'virtuelles', label: 'Cartes C-Pay', to: '/cartes', end: true },
  { key: 'gtp', label: 'Carte réseau', to: '/cartes/gtp' },
  { key: 'externes', label: 'Cartes externes', to: '/cartes/externes' },
];

export default function CardsPage() {
  useDocumentTitle('Mes cartes');
  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader title="Mes cartes" subtitle="Soldes, plafonds, code PIN et sécurité de vos cartes." />
      <Tabs items={TABS} ariaLabel="Types de cartes" />
      <Routes>
        <Route index element={<VirtualCardsTab />} />
        <Route path="gtp" element={<GtpCardsTab />} />
        <Route path="externes" element={<ExternalCardsTab />} />
        <Route path="*" element={<Navigate to="/cartes" replace />} />
      </Routes>
    </div>
  );
}
