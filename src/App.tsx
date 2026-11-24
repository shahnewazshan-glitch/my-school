/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { AdminPanelView } from './components/AdminPanelView';
import { AttendanceView } from './components/AttendanceView';
import { BatchFieldsView } from './components/BatchFieldsView';
import { BatchMarksView } from './components/BatchMarksView';
import { CommsView } from './components/CommsView';
import { ConfigMissingScreen } from './components/ConfigMissingScreen';
import { DashboardView } from './components/DashboardView';
import { LoginScreen } from './components/LoginScreen';
import { MarksheetView } from './components/MarksheetView';
import { PromotionManagerView } from './components/PromotionManagerView';
import { StudentsView } from './components/StudentsView';
import { WorkspaceLayout, type NavTab } from './components/WorkspaceLayout';
import { AppProvider, useApp } from './contexts/AppContext';
import { getFirebaseEnvStatus } from './lib/firebase';

const MainAppShell: React.FC = () => {
  const { session, dataLoading } = useApp();
  const [isUpdateDeepLink] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('update') === '1';
  });
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [adminInitialTab, setAdminInitialTab] = useState<
    'teachers' | 'approvals' | 'setup' | 'update'
  >('teachers');

  // Ensure ?update=1 lands on Dashboard right after sign-in
  useEffect(() => {
    if (session && isUpdateDeepLink) {
      setActiveTab('dashboard');
    }
  }, [session, isUpdateDeepLink]);

  // Ensure non-Admin users never remain on Admin tab if role downgrades live
  useEffect(() => {
    if (session?.role !== 'ADMIN' && activeTab === 'admin') {
      setActiveTab('dashboard');
    }
  }, [session?.role, activeTab]);

  if (!session) {
    return <LoginScreen />;
  }

  const handleSelectTab = (tab: NavTab) => {
    setActiveTab(tab);
    if (tab !== 'students') {
      setSelectedProfileId(null);
    }
    if (tab === 'admin') {
      setAdminInitialTab('teachers');
    }
  };

  const handleOpenStudentProfile = (studentId: string) => {
    setSelectedProfileId(studentId);
    setActiveTab('students');
  };

  const handleOpenAppUpdatePublisher = () => {
    setAdminInitialTab('update');
    setActiveTab('admin');
  };

  return (
    <WorkspaceLayout activeTab={activeTab} onSelectTab={handleSelectTab}>
      {dataLoading && (
        <div className="mb-4 px-4 py-2.5 bg-white border border-stone-200 rounded-lg text-xs text-slate-600 no-print">
          Syncing school records...
        </div>
      )}
      {activeTab === 'dashboard' && (
        <DashboardView
          onNavigate={handleSelectTab}
          onOpenStudentProfile={handleOpenStudentProfile}
          onOpenAppUpdatePublisher={handleOpenAppUpdatePublisher}
          highlightAppUpdate={isUpdateDeepLink}
        />
      )}
      {activeTab === 'students' && (
        <StudentsView
          selectedProfileId={selectedProfileId}
          onSelectProfile={setSelectedProfileId}
        />
      )}
      {activeTab === 'batch-marks' && (
        <BatchMarksView onOpenStudentProfile={handleOpenStudentProfile} />
      )}
      {activeTab === 'attendance' && <AttendanceView />}
      {activeTab === 'promotion' && <PromotionManagerView />}
      {activeTab === 'batch-fields' && <BatchFieldsView />}
      {activeTab === 'marksheet' && <MarksheetView />}
      {activeTab === 'comms' && <CommsView />}
      {activeTab === 'admin' && session.role === 'ADMIN' && (
        <AdminPanelView initialTab={adminInitialTab} />
      )}
    </WorkspaceLayout>
  );
};

export default function App() {
  const envStatus = getFirebaseEnvStatus();

  if (!envStatus.isConfigured) {
    return <ConfigMissingScreen envStatus={envStatus} />;
  }

  return (
    <AppProvider>
      <MainAppShell />
    </AppProvider>
  );
}
