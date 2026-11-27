/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useEffect, useState } from 'react';
import { ConfigMissingScreen } from './components/ConfigMissingScreen';
import { LoginScreen } from './components/LoginScreen';
import { WorkspaceLayout, type NavTab } from './components/WorkspaceLayout';
import { AppProvider, useApp } from './contexts/AppContext';
import { getFirebaseEnvStatus } from './lib/firebase';

const DashboardView = lazy(() =>
  import('./components/DashboardView').then((m) => ({ default: m.DashboardView }))
);
const StudentsView = lazy(() =>
  import('./components/StudentsView').then((m) => ({ default: m.StudentsView }))
);
const BatchMarksView = lazy(() =>
  import('./components/BatchMarksView').then((m) => ({ default: m.BatchMarksView }))
);
const AttendanceView = lazy(() =>
  import('./components/AttendanceView').then((m) => ({ default: m.AttendanceView }))
);
const PromotionManagerView = lazy(() =>
  import('./components/PromotionManagerView').then((m) => ({ default: m.PromotionManagerView }))
);
const BatchFieldsView = lazy(() =>
  import('./components/BatchFieldsView').then((m) => ({ default: m.BatchFieldsView }))
);
const MarksheetView = lazy(() =>
  import('./components/MarksheetView').then((m) => ({ default: m.MarksheetView }))
);
const AnalyticsView = lazy(() =>
  import('./components/AnalyticsView').then((m) => ({ default: m.AnalyticsView }))
);
const CommsView = lazy(() =>
  import('./components/CommsView').then((m) => ({ default: m.CommsView }))
);
const AdminPanelView = lazy(() =>
  import('./components/AdminPanelView').then((m) => ({ default: m.AdminPanelView }))
);

const TabFallback: React.FC = () => (
  <div className="bg-white border border-stone-200 rounded-xl p-8 text-center text-sm text-slate-500">
    Loading...
  </div>
);

const MainAppShell: React.FC = () => {
  const { session, dataLoading, activateModule } = useApp();
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [adminInitialTab, setAdminInitialTab] = useState<
    'teachers' | 'approvals' | 'setup' | 'update'
  >('teachers');

  // Activate lazy Firestore listeners only when their corresponding tab opens
  useEffect(() => {
    if (!session) return;
    if (activeTab === 'attendance' || activeTab === 'marksheet' || activeTab === 'comms') {
      activateModule('attendance');
    }
    if (activeTab === 'comms') {
      activateModule('comms');
    } else if (activeTab === 'admin' && session.role === 'ADMIN') {
      activateModule('pending');
    }
  }, [activeTab, session, activateModule]);

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

  const handleOpenAdminSubTab = (sub: 'teachers' | 'approvals' | 'setup' | 'update') => {
    setAdminInitialTab(sub);
    setActiveTab('admin');
  };

  return (
    <WorkspaceLayout
      activeTab={activeTab}
      onSelectTab={handleSelectTab}
      onOpenAdminSubTab={handleOpenAdminSubTab}
    >
      {dataLoading && (
        <div className="mb-4 px-4 py-2.5 bg-white border border-stone-200 rounded-lg text-xs text-slate-600 no-print">
          Syncing school records...
        </div>
      )}
      <Suspense fallback={<TabFallback />}>
        {activeTab === 'dashboard' && (
          <DashboardView
            onNavigate={handleSelectTab}
            onOpenStudentProfile={handleOpenStudentProfile}
            onOpenApkCleanup={() => handleOpenAdminSubTab('update')}
            onOpenSchoolSetup={(sub) => handleOpenAdminSubTab(sub)}
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
        {activeTab === 'analytics' && (
          <AnalyticsView onOpenStudentProfile={handleOpenStudentProfile} />
        )}
        {activeTab === 'comms' && <CommsView />}
        {activeTab === 'admin' && session.role === 'ADMIN' && (
          <AdminPanelView initialTab={adminInitialTab} />
        )}
      </Suspense>
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
