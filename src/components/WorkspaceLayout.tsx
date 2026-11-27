import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BarChart3,
  BookOpenCheck,
  CalendarCheck2,
  Check,
  ClipboardList,
  Copy,
  Download,
  FileSpreadsheet,
  GraduationCap,
  Landmark,
  LayoutDashboard,
  Link2,
  LogOut,
  Menu,
  MessageSquareText,
  MoreVertical,
  RefreshCw,
  Share2,
  ShieldCheck,
  Smartphone,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { getClassLabel, t } from '../lib/i18n';
import {
  getSchoolDisplayMeta,
  OFFICIAL_SCHOOL_NAME_BN,
  OFFICIAL_SCHOOL_NAME_EN,
  resolveDirectApkDownloadInfo,
} from '../lib/schoolUtils';
import { CLASS_LEVELS } from '../types/school';

export type NavTab =
  | 'dashboard'
  | 'students'
  | 'batch-marks'
  | 'attendance'
  | 'promotion'
  | 'batch-fields'
  | 'marksheet'
  | 'analytics'
  | 'comms'
  | 'govt-portal'
  | 'admin';

interface WorkspaceLayoutProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onOpenAdminSubTab?: (sub: 'teachers' | 'approvals' | 'setup' | 'update') => void;
  children: React.ReactNode;
}

export const WorkspaceLayout: React.FC<WorkspaceLayoutProps> = ({
  activeTab,
  onSelectTab,
  onOpenAdminSubTab,
  children,
}) => {
  const {
    lang,
    setLang,
    session,
    school,
    students,
    pendingChanges,
    selectedAcademicYear,
    setSelectedAcademicYear,
    selectedClass,
    setSelectedClass,
    isOnline,
    hasPendingSync,
    syncError,
    clearSyncError,
    logout,
  } = useApp();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [appUpdateModalOpen, setAppUpdateModalOpen] = useState(false);
  const [generatedLinkCopied, setGeneratedLinkCopied] = useState(false);
  const [shareToast, setShareToast] = useState<string | null>(null);
  const overflowRef = useRef<HTMLDivElement | null>(null);

  const pendingCount = pendingChanges.filter((c) => c.status === 'PENDING').length;

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const academicYears = React.useMemo(() => {
    const base = school?.defaultAcademicYear || new Date().getFullYear();
    const years = new Set<number>([base - 2, base - 1, base, base + 1, selectedAcademicYear]);
    for (const s of students) {
      if (s.academicYear) years.add(Number(s.academicYear));
    }
    return Array.from(years).sort((a, b) => b - a);
  }, [school?.defaultAcademicYear, students, selectedAcademicYear]);

  const navItems: Array<{
    id: NavTab;
    label: string;
    icon: React.FC<{ className?: string }>;
    adminOnly?: boolean;
    badge?: number;
  }> = [
    { id: 'dashboard', label: t(lang, 'navDashboard'), icon: LayoutDashboard },
    { id: 'students', label: t(lang, 'navStudents'), icon: Users },
    { id: 'batch-marks', label: t(lang, 'navBatchMarks'), icon: ClipboardList },
    { id: 'attendance', label: t(lang, 'navAttendance'), icon: CalendarCheck2 },
    { id: 'promotion', label: t(lang, 'navPromotion'), icon: ArrowUpRight },
    { id: 'batch-fields', label: t(lang, 'navBatchFields'), icon: BookOpenCheck },
    { id: 'marksheet', label: t(lang, 'navMarksheet'), icon: FileSpreadsheet },
    { id: 'analytics', label: t(lang, 'navAnalytics'), icon: BarChart3 },
    { id: 'comms', label: t(lang, 'navComms'), icon: MessageSquareText },
    { id: 'govt-portal', label: t(lang, 'navGovtPortal'), icon: Landmark },
    {
      id: 'admin',
      label: t(lang, 'navAdmin'),
      icon: ShieldCheck,
      adminOnly: true,
      badge: pendingCount > 0 ? pendingCount : undefined,
    },
  ];

  const visibleNavItems = navItems.filter(
    (item) => !item.adminOnly || session?.role === 'ADMIN'
  );

  const activeNavTitle =
    visibleNavItems.find((i) => i.id === activeTab)?.label || t(lang, 'navDashboard');

  const schoolMeta = useMemo(() => getSchoolDisplayMeta(school, lang), [school, lang]);
  const displaySchoolName = schoolMeta.schoolName;

  const resolvedApkInfo = useMemo(
    () => (school?.appUpdateUrl ? resolveDirectApkDownloadInfo(school.appUpdateUrl) : null),
    [school?.appUpdateUrl]
  );

  const handleNavClick = (id: NavTab) => {
    onSelectTab(id);
    setMobileMenuOpen(false);
    setOverflowOpen(false);
  };

  const handleShareWebsite = async () => {
    setOverflowOpen(false);
    const shareUrl = typeof window !== 'undefined' ? window.location.origin : '';
    const text =
      lang === 'bn'
        ? `${OFFICIAL_SCHOOL_NAME_BN} (স্কুল কোড: ${schoolMeta.displaySchoolCode}, EMIS: ${schoolMeta.emisCode}) — ওয়েব সঙ্গী: ${shareUrl}`
        : `${OFFICIAL_SCHOOL_NAME_EN} (School Code: ${schoolMeta.displaySchoolCode}, EMIS: ${schoolMeta.emisCode}) — Web Companion: ${shareUrl}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: displaySchoolName, text, url: shareUrl });
      } else {
        await navigator.clipboard.writeText(text);
        setShareToast(
          lang === 'bn' ? 'শেয়ার লিংক কপি হয়েছে!' : 'Share link copied to clipboard!'
        );
        setTimeout(() => setShareToast(null), 2600);
      }
    } catch {
      try {
        await navigator.clipboard.writeText(shareUrl);
        setShareToast(
          lang === 'bn' ? 'লিংক কপি হয়েছে!' : 'Link copied to clipboard!'
        );
        setTimeout(() => setShareToast(null), 2600);
      } catch {
        // ignore clipboard denial
      }
    }
  };

  const handleGenerateUpdateLink = async () => {
    if (!resolvedApkInfo?.directDownloadUrl) return;
    try {
      await navigator.clipboard.writeText(resolvedApkInfo.directDownloadUrl);
      setGeneratedLinkCopied(true);
      setTimeout(() => setGeneratedLinkCopied(false), 2600);
    } catch {
      // ignore
    }
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full bg-white border-r border-stone-200">
      <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-2 bg-emerald-800 text-white">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-amber-400 text-emerald-950 flex items-center justify-center shrink-0">
            <GraduationCap className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-white truncate">
              {displaySchoolName}
            </div>
            <div className="text-[11px] text-emerald-100 font-mono tabular-nums leading-snug">
              <div>Code: {schoolMeta.displaySchoolCode}</div>
              <div>EMIS: {schoolMeta.emisCode}</div>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMobileMenuOpen(false)}
          className="lg:hidden p-1.5 text-emerald-100 hover:text-white cursor-pointer"
          aria-label="Close navigation"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Global Academic Year & Class Selectors */}
      <div className="px-4 py-3.5 border-b border-stone-200 space-y-2.5 bg-emerald-50/40">
        <div>
          <label
            htmlFor="global-year-select"
            className="block text-xs font-medium text-slate-600 mb-1"
          >
            {t(lang, 'academicYear')}
          </label>
          <select
            id="global-year-select"
            value={selectedAcademicYear}
            onChange={(e) => setSelectedAcademicYear(Number(e.target.value))}
            className="w-full px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded-lg text-slate-900 font-medium tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-600"
          >
            {academicYears.map((yr) => (
              <option key={yr} value={yr}>
                {yr}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="global-class-select"
            className="block text-xs font-medium text-slate-600 mb-1"
          >
            {t(lang, 'classSelector')}
          </label>
          <select
            id="global-class-select"
            value={selectedClass}
            onChange={(e) => setSelectedClass(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded-lg text-slate-900 font-medium focus:outline-none focus:ring-2 focus:ring-emerald-600"
          >
            {CLASS_LEVELS.map((cls) => (
              <option key={cls} value={cls}>
                {getClassLabel(cls, lang)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto">
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleNavClick(item.id)}
              className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                isActive
                  ? 'bg-emerald-700 text-white shadow-xs'
                  : 'text-slate-700 hover:bg-emerald-50/70 hover:text-emerald-900'
              }`}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    isActive ? 'text-amber-300' : 'text-slate-400'
                  }`}
                />
                <span className="truncate">{item.label}</span>
              </span>
              {item.badge !== undefined && (
                <span
                  className={`text-xs font-semibold tabular-nums px-1.5 py-0.5 rounded ${
                    isActive
                      ? 'bg-amber-400 text-emerald-950'
                      : 'text-amber-800 bg-amber-100'
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Signed-in Teacher Info */}
      <div className="p-4 border-t border-stone-200 bg-stone-50/80 space-y-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900 truncate">
            {session?.name}
          </div>
          <div className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
            <span>
              {session?.role === 'ADMIN' ? t(lang, 'roleAdmin') : t(lang, 'roleUser')}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums truncate">{session?.phoneNumber}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={logout}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-100 transition-colors cursor-pointer whitespace-nowrap"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>{t(lang, 'logout')}</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: 'var(--school-canvas)' }}>
      {/* Desktop Fixed Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-0 h-screen no-print">
        <SidebarContent />
      </aside>

      {/* Mobile Slide-Over Sidebar */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-72 max-w-[85vw] h-full z-10">
            <SidebarContent />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar: Left menu/context, CENTER BOLD PAGE TITLE, Right controls + 3-dot overflow */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-stone-200 px-3 sm:px-6 py-2.5 flex items-center justify-between gap-2 no-print">
          {/* Left Zone */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-1 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-stone-100 cursor-pointer"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="hidden sm:flex items-center gap-1.5 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-lg whitespace-nowrap">
              <span>{getClassLabel(selectedClass, lang)}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums font-mono">{selectedAcademicYear}</span>
            </div>
          </div>

          {/* Center Zone: Bold Centered Page Title + School Code & EMIS */}
          <div className="flex-1 min-w-0 text-center px-2">
            <h1 className="text-base sm:text-lg font-bold text-slate-900 truncate tracking-tight leading-tight">
              {activeNavTitle}
            </h1>
            <div className="text-[10px] sm:text-[11px] text-slate-500 font-mono tabular-nums whitespace-nowrap overflow-x-auto">
              Code: {schoolMeta.displaySchoolCode} · EMIS: {schoolMeta.emisCode}
            </div>
          </div>

          {/* Right Zone: Sync + Language + 3-dot Overflow Menu */}
          <div className="flex items-center gap-2 shrink-0">
            <div
              className="hidden md:flex items-center gap-1.5 text-xs font-medium text-slate-700 px-2.5 py-1.5 rounded-lg border border-stone-200 bg-stone-50 whitespace-nowrap"
              title={
                hasPendingSync
                  ? t(lang, 'pendingSync')
                  : isOnline
                  ? t(lang, 'online')
                  : t(lang, 'offline')
              }
            >
              {hasPendingSync ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 text-amber-600 animate-spin" />
                  <span className="text-amber-700">{t(lang, 'pendingSync')}</span>
                </>
              ) : isOnline ? (
                <>
                  <Wifi className="w-3.5 h-3.5 text-emerald-700" />
                  <span className="text-emerald-800">{t(lang, 'online')}</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5 text-amber-700" />
                  <span className="text-amber-800">{t(lang, 'offline')}</span>
                </>
              )}
            </div>

            {/* Language Toggle */}
            <div className="flex items-center gap-0.5 p-0.5 bg-stone-100 border border-stone-200 rounded-lg shrink-0">
              <button
                type="button"
                onClick={() => setLang('en')}
                className={`px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  lang === 'en'
                    ? 'bg-emerald-700 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => setLang('bn')}
                className={`px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  lang === 'bn'
                    ? 'bg-emerald-700 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                বাংলা
              </button>
            </div>

            {/* 3-Dot Overflow Menu */}
            <div className="relative" ref={overflowRef}>
              <button
                type="button"
                onClick={() => setOverflowOpen((p) => !p)}
                aria-label="More options"
                className="p-2 text-slate-700 hover:text-emerald-900 bg-white hover:bg-emerald-50 border border-stone-200 rounded-lg cursor-pointer relative"
              >
                <MoreVertical className="w-4 h-4" />
                {session?.role === 'ADMIN' && pendingCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-500 border border-white" />
                )}
              </button>

              {overflowOpen && (
                <div className="absolute right-0 mt-2 w-64 bg-white border border-stone-200 rounded-xl shadow-lg py-1.5 z-50">
                  <button
                    type="button"
                    onClick={() => handleNavClick('comms')}
                    className="w-full px-4 py-2.5 text-left text-xs font-medium text-slate-800 hover:bg-emerald-50 flex items-center gap-2.5 cursor-pointer"
                  >
                    <MessageSquareText className="w-4 h-4 text-emerald-700 shrink-0" />
                    <span>
                      {lang === 'bn'
                        ? 'চ্যাট ও অভিভাবক বার্তা'
                        : 'Chat / Parent Messaging'}
                    </span>
                  </button>

                  {session?.role === 'ADMIN' && (
                    <button
                      type="button"
                      onClick={() => {
                        setOverflowOpen(false);
                        onOpenAdminSubTab?.('approvals');
                      }}
                      className="w-full px-4 py-2.5 text-left text-xs font-medium text-slate-800 hover:bg-emerald-50 flex items-center justify-between gap-2 cursor-pointer"
                    >
                      <span className="flex items-center gap-2.5">
                        <ShieldCheck className="w-4 h-4 text-amber-600 shrink-0" />
                        <span>
                          {lang === 'bn' ? 'অ্যাডমিন অনুমোদন' : 'Admin Approvals'}
                        </span>
                      </span>
                      {pendingCount > 0 && (
                        <span className="px-1.5 py-0.5 text-[11px] font-bold bg-amber-100 text-amber-900 rounded tabular-nums">
                          {pendingCount}
                        </span>
                      )}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      setOverflowOpen(false);
                      setAppUpdateModalOpen(true);
                    }}
                    className="w-full px-4 py-2.5 text-left text-xs font-medium text-slate-800 hover:bg-emerald-50 flex items-center gap-2.5 cursor-pointer"
                  >
                    <Smartphone className="w-4 h-4 text-emerald-700 shrink-0" />
                    <span>{lang === 'bn' ? 'অ্যান্ড্রয়েড অ্যাপ আপডেট' : 'App Update'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleShareWebsite}
                    className="w-full px-4 py-2.5 text-left text-xs font-medium text-slate-800 hover:bg-emerald-50 flex items-center gap-2.5 cursor-pointer"
                  >
                    <Share2 className="w-4 h-4 text-slate-600 shrink-0" />
                    <span>{lang === 'bn' ? 'ওয়েবসাইট শেয়ার করুন' : 'Share'}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {shareToast && (
          <div className="mx-4 sm:mx-6 mt-3 px-4 py-2.5 rounded-lg bg-emerald-700 text-white text-xs font-medium text-center no-print">
            {shareToast}
          </div>
        )}

        {syncError && (
          <div
            role="alert"
            className="mx-4 sm:mx-6 mt-3 px-4 py-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-900 text-xs sm:text-sm flex items-center justify-between gap-3 no-print"
          >
            <span>{syncError}</span>
            <button
              type="button"
              onClick={clearSyncError}
              className="p-1 text-rose-700 hover:text-rose-950 cursor-pointer shrink-0"
              aria-label="Dismiss sync error"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {children}
        </main>
      </div>

      {/* App Update Modal (Opened from 3-Dot Overflow Menu) */}
      {appUpdateModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 no-print">
          <div className="bg-white border border-stone-200 rounded-xl w-full max-w-lg overflow-hidden shadow-xl">
            <div className="px-5 py-4 bg-emerald-800 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-amber-300" />
                <h3 className="text-sm font-bold">
                  {lang === 'bn' ? 'অ্যান্ড্রয়েড অ্যাপ আপডেট' : 'Android App Update'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setAppUpdateModalOpen(false)}
                className="p-1 text-emerald-100 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-sm">
              {resolvedApkInfo ? (
                <div className="space-y-3">
                  <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200">
                    <div className="text-xs font-semibold text-emerald-900">
                      {lang === 'bn' ? 'সর্বশেষ সংস্করণ' : 'Latest Version'}:{' '}
                      <span className="font-mono">
                        v{school?.latestAppVersionName || '—'} (#
                        {school?.latestAppVersionCode || 0})
                      </span>
                    </div>
                    {school?.appUpdateNotes && (
                      <p className="text-xs text-slate-700 mt-1.5 whitespace-pre-line">
                        {school.appUpdateNotes}
                      </p>
                    )}
                    <div className="mt-2 text-[11px] font-mono text-slate-500 break-all">
                      {resolvedApkInfo.directDownloadUrl}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    <a
                      href={resolvedApkInfo.directDownloadUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>
                        {lang === 'bn'
                          ? 'অ্যান্ড্রয়েড অ্যাপ ডাউনলোড'
                          : 'Download Android App'}
                      </span>
                    </a>

                    <button
                      type="button"
                      onClick={handleGenerateUpdateLink}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded-lg cursor-pointer"
                    >
                      {generatedLinkCopied ? (
                        <Check className="w-3.5 h-3.5 text-emerald-700" />
                      ) : (
                        <Link2 className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {generatedLinkCopied
                          ? lang === 'bn'
                            ? 'লিংক কপি হয়েছে!'
                            : 'Update Link Copied!'
                          : lang === 'bn'
                          ? 'আপডেট লিংক তৈরি ও কপি'
                          : 'Generate Update Link'}
                      </span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-lg bg-stone-50 border border-stone-200 text-xs text-slate-600">
                  {lang === 'bn'
                    ? 'এখনো কোনো নতুন APK আপডেট লিংক প্রকাশ করা হয়নি।'
                    : 'No Android APK update URL is currently configured.'}
                </div>
              )}

              {session?.role === 'ADMIN' && (
                <div className="pt-3 border-t border-stone-200 flex items-center justify-between gap-3">
                  <span className="text-xs text-slate-500">
                    {lang === 'bn'
                      ? 'নতুন APK লিংক প্রকাশ বা পুরোনো চাঙ্ক মুছতে অ্যাডমিন প্যানেলে যান।'
                      : 'Configure APK URL / version or clean up legacy chunks in Admin Panel.'}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setAppUpdateModalOpen(false);
                      onOpenAdminSubTab?.('update');
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>
                      {lang === 'bn' ? 'অ্যাডমিন সেটআপ' : 'Configure Update'}
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
