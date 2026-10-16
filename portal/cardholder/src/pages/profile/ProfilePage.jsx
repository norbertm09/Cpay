import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { PageHeader, Tabs, Badge } from '../../components';
import InfoTab from './InfoTab';
import SecurityTab from './SecurityTab';
import KycTab from './KycTab';
import { initials } from '../../utils/format';

const TABS = [
  { key: 'infos', label: 'Informations', to: '/profil', end: true },
  { key: 'securite', label: 'Sécurité', to: '/profil/securite' },
  { key: 'verification', label: 'Vérification', to: '/profil/verification' },
];

export default function ProfilePage() {
  useDocumentTitle('Profil');
  const { user } = useAuth();
  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader title={(
        <span className="profile-head">
          <span className="avatar avatar-lg">{initials(user?.firstName, user?.lastName)}</span>
          <span>
            <span style={{ display: 'block' }}>{[user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Mon profil'}</span>
            <span className="row small muted" style={{ fontWeight: 400 }}>{user?.email}{user?.kycLevel != null ? <Badge tone="badge-info">KYC niveau {user.kycLevel}</Badge> : null}</span>
          </span>
        </span>
      )} />
      <Tabs items={TABS} ariaLabel="Sections du profil" />
      <Routes>
        <Route index element={<InfoTab />} />
        <Route path="securite" element={<SecurityTab />} />
        <Route path="verification" element={<KycTab />} />
        <Route path="*" element={<Navigate to="/profil" replace />} />
      </Routes>
    </div>
  );
}
