import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './styles/index.css';
import { AuthProvider, useAuth } from './hooks/useAuth';
import Toaster from './components/Toaster';
import AppShell from './layout/AppShell';
import { RequireAuth, RequireRole, Legacy } from './layout/guards';
import { LEGACY_REDIRECTS } from './layout/nav';
import { PERMS } from './utils/roles';

import LoginPage from './pages/auth/LoginPage';
import ForcePasswordPage from './pages/auth/ForcePasswordPage';
import DashboardPage from './pages/dashboard/DashboardPage';
import MerchantsPage from './pages/merchants/MerchantsPage';
import MerchantDetailPage from './pages/merchants/MerchantDetailPage';
import MerchantUsersPage from './pages/merchants/MerchantUsersPage';
import CardholdersPage from './pages/cardholders/CardholdersPage';
import TransactionsPage from './pages/operations/TransactionsPage';
import CashPage from './pages/operations/CashPage';
import SettlementsPage from './pages/operations/SettlementsPage';
import FraudPage from './pages/operations/FraudPage';
import RailsPage from './pages/operations/RailsPage';
import TicketsPage from './pages/support/TicketsPage';
import { LeadsPage, ClaimsPage, ConversationsPage } from './pages/support/CrmPages';
import { BanksPage, BankDetailPage, AgenciesPage, AgentsPage, TenantsPage } from './pages/partners/PartnersPages';
import ConnectorsPage from './pages/settings/ConnectorsPage';
import NotificationsPage from './pages/settings/NotificationsPage';
import { TerminalsPage, FeaturesPage, AdminsPage, AuditPage, MonitoringPage } from './pages/settings/SettingsPages';
import CapabilitiesPage from './pages/settings/CapabilitiesPage';
import AccountPage from './pages/account/AccountPage';

// Mot de passe temporaire (mustChangePassword) : changement forcé avant d'entrer dans le back-office.
const Protected = () => {
  const { admin } = useAuth();
  if (admin?.mustChangePassword) return <ForcePasswordPage />;
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/marchands" element={<MerchantsPage />} />
        <Route path="/marchands/utilisateurs" element={<MerchantUsersPage />} />
        <Route path="/marchands/:id" element={<MerchantDetailPage />} />
        <Route path="/porteurs" element={<CardholdersPage />} />
        <Route path="/operations/transactions" element={<TransactionsPage />} />
        <Route path="/operations/caisse" element={<RequireRole roles={PERMS.ops}><CashPage /></RequireRole>} />
        <Route path="/operations/reglements" element={<RequireRole roles={PERMS.finance}><SettlementsPage /></RequireRole>} />
        <Route path="/operations/fraude" element={<FraudPage />} />
        <Route path="/operations/rails" element={<RequireRole roles={PERMS.ops}><RailsPage /></RequireRole>} />
        <Route path="/support/tickets" element={<TicketsPage />} />
        <Route path="/support/reclamations" element={<RequireRole roles={PERMS.crm}><ClaimsPage /></RequireRole>} />
        <Route path="/support/leads" element={<RequireRole roles={PERMS.crm}><LeadsPage /></RequireRole>} />
        <Route path="/support/conversations" element={<RequireRole roles={PERMS.crm}><ConversationsPage /></RequireRole>} />
        <Route path="/partenaires/banques" element={<RequireRole roles={PERMS.ops}><BanksPage /></RequireRole>} />
        <Route path="/partenaires/banques/:id" element={<RequireRole roles={PERMS.ops}><BankDetailPage /></RequireRole>} />
        <Route path="/partenaires/agences" element={<RequireRole roles={PERMS.ops}><AgenciesPage /></RequireRole>} />
        <Route path="/partenaires/agents" element={<RequireRole roles={PERMS.ops}><AgentsPage /></RequireRole>} />
        <Route path="/partenaires/tenants" element={<RequireRole roles={PERMS.ops}><TenantsPage /></RequireRole>} />
        <Route path="/configuration/connecteurs" element={<RequireRole roles={PERMS.ops}><ConnectorsPage /></RequireRole>} />
        <Route path="/configuration/notifications" element={<RequireRole roles={PERMS.ops}><NotificationsPage /></RequireRole>} />
        <Route path="/configuration/terminaux" element={<TerminalsPage />} />
        <Route path="/configuration/fonctionnalites" element={<RequireRole roles={PERMS.ops}><FeaturesPage /></RequireRole>} />
        <Route path="/configuration/capacites" element={<CapabilitiesPage />} />
        <Route path="/configuration/administrateurs" element={<RequireRole roles={PERMS.superOnly}><AdminsPage /></RequireRole>} />
        <Route path="/configuration/audit" element={<RequireRole roles={PERMS.superOnly}><AuditPage /></RequireRole>} />
        <Route path="/configuration/monitoring" element={<MonitoringPage />} />
        <Route path="/compte" element={<AccountPage />} />
        {LEGACY_REDIRECTS.map(([from, to]) => <Route key={from} path={from} element={<Legacy to={to} />} />)}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
};

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toaster />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/*" element={<RequireAuth><Protected /></RequireAuth>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
