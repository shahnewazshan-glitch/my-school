import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarCheck2,
  ClipboardList,
  Download,
  FileSpreadsheet,
  Search,
  Settings2,
  Smartphone,
  Users,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import {
  type ApkDownloadProgress,
  downloadPrivateApkRelease,
  NoApkChunksError,
} from '../lib/apkChunks';
import { getFirebaseInstances } from '../lib/firebase';
import { getClassLabel, t } from '../lib/i18n';
import {
  formatPhotoSrc,
  getAttendanceDocId,
  getClassSubjectsForMarksheet,
  getTodayDateKey,
} from '../lib/schoolUtils';
import { CLASS_LEVELS } from '../types/school';
import type { NavTab } from './WorkspaceLayout';

interface DashboardViewProps {
  onNavigate: (tab: NavTab) => void;
  onOpenStudentProfile: (studentId: string) => void;
  onOpenAppUpdatePublisher?: () => void;
  highlightAppUpdate?: boolean;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  onNavigate,
  onOpenStudentProfile,
  onOpenAppUpdatePublisher,
  highlightAppUpdate = false,
}) => {
  const {
    lang,
    session,
    school,
    students,
    attendanceLogs,
    pendingChanges,
    selectedAcademicYear,
    selectedClass,
    setSelectedClass,
  } = useApp();

  const [quickQuery, setQuickQuery] = useState('');
  const [downloadingApk, setDownloadingApk] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<ApkDownloadProgress | null>(null);
  const [apkDownloadError, setApkDownloadError] = useState<string | null>(null);
  const [noChunksFound, setNoChunksFound] = useState(false);

  const hasPublishedUpdateMeta = Boolean(
    school?.latestAppVersionCode !== undefined || school?.appUpdateUrl
  );

  const handleDownloadPrivateApk = async () => {
    const instances = getFirebaseInstances();
    if (!instances || !session?.schoolId) return;

    setDownloadingApk(true);
    setApkDownloadError(null);
    setNoChunksFound(false);
    setDownloadProgress({ phase: 'fetching', currentChunk: 0, totalChunks: 1, percent: 5 });

    try {
      await downloadPrivateApkRelease({
        db: instances.db,
        schoolId: session.schoolId,
        latestAppVersionCode: school?.latestAppVersionCode,
        latestAppVersionName: school?.latestAppVersionName,
        onProgress: setDownloadProgress,
      });
    } catch (err: unknown) {
      if (err instanceof NoApkChunksError) {
        setNoChunksFound(true);
      } else {
        const fbErr = err as { code?: string; message?: string };
        setApkDownloadError(
          fbErr?.code
            ? `${fbErr.code}: ${fbErr.message || String(err)}`
            : err instanceof Error
            ? err.message
            : String(err)
        );
      }
    } finally {
      setDownloadingApk(false);
      setDownloadProgress(null);
    }
  };

  const yearStudents = useMemo(
    () => students.filter((s) => Number(s.academicYear) === Number(selectedAcademicYear)),
    [students, selectedAcademicYear]
  );

  const classStudents = useMemo(
    () => yearStudents.filter((s) => s.classLevel === selectedClass),
    [yearStudents, selectedClass]
  );

  const todayKey = getTodayDateKey();
  const todayAttDocId = getAttendanceDocId(selectedAcademicYear, selectedClass, todayKey);
  const todayAttendance = attendanceLogs.find((a) => a.id === todayAttDocId);

  const presentTodayCount = useMemo(() => {
    if (!todayAttendance?.statuses) return 0;
    return Object.values(todayAttendance.statuses).filter((v) => v === 'P' || v === 'L').length;
  }, [todayAttendance]);

  const attendancePct =
    classStudents.length > 0 && todayAttendance
      ? Math.round((presentTodayCount / classStudents.length) * 100)
      : null;

  const pendingCount = useMemo(
    () => pendingChanges.filter((c) => c.status === 'PENDING').length,
    [pendingChanges]
  );

  const classSubjects = useMemo(
    () => getClassSubjectsForMarksheet(school?.examConfigs || [], selectedClass),
    [school?.examConfigs, selectedClass]
  );

  const quickSearchResults = useMemo(() => {
    const q = quickQuery.trim().toLowerCase();
    if (!q) return [];
    return yearStudents
      .filter((s) => {
        const nameEn = (s.studentNameEn || '').toLowerCase();
        const nameBn = (s.studentNameBn || '').toLowerCase();
        const roll = String(s.rollNumber || '').toLowerCase();
        const phone = (s.guardianPhone || '').toLowerCase();
        return nameEn.includes(q) || nameBn.includes(q) || roll.includes(q) || phone.includes(q);
      })
      .slice(0, 8);
  }, [quickQuery, yearStudents]);

  const classDistribution = useMemo(() => {
    return CLASS_LEVELS.map((cls) => {
      const count = yearStudents.filter((s) => s.classLevel === cls).length;
      const docId = getAttendanceDocId(selectedAcademicYear, cls, todayKey);
      const log = attendanceLogs.find((a) => a.id === docId);
      const present = log?.statuses
        ? Object.values(log.statuses).filter((v) => v === 'P' || v === 'L').length
        : null;
      return { classLevel: cls, count, present };
    });
  }, [yearStudents, attendanceLogs, selectedAcademicYear, todayKey]);

  const showAppUpdateCard =
    hasPublishedUpdateMeta || session?.role === 'ADMIN' || highlightAppUpdate;

  const renderAppUpdateCard = () => {
    if (!showAppUpdateCard) return null;
    return (
      <section
        className={`border rounded-xl p-5 ${
          highlightAppUpdate
            ? 'bg-emerald-50 border-emerald-300 ring-2 ring-emerald-600 shadow-xs'
            : 'bg-emerald-50/70 border-emerald-200'
        }`}
      >
        {hasPublishedUpdateMeta ? (
          <div className="space-y-3">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="flex items-start gap-3.5 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-emerald-700 text-white flex items-center justify-center shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-slate-900">
                      {t(lang, 'androidAppUpdateTitle')}
                    </h3>
                    <span className="text-xs font-mono font-semibold tabular-nums text-emerald-900 bg-white border border-emerald-200 px-2 py-0.5 rounded">
                      {school?.latestAppVersionName
                        ? `v${school.latestAppVersionName}`
                        : 'v—'}{' '}
                      {school?.latestAppVersionCode !== undefined
                        ? `(#${school.latestAppVersionCode})`
                        : ''}
                    </span>
                  </div>
                  {school?.appUpdateNotes && (
                    <p className="text-sm text-slate-700">{school.appUpdateNotes}</p>
                  )}
                  <p className="text-xs text-slate-700 leading-relaxed">
                    {t(lang, 'appUpdateMobileHint')}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  type="button"
                  disabled={downloadingApk}
                  onClick={handleDownloadPrivateApk}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Download className="w-4 h-4 shrink-0" />
                  <span>
                    {downloadingApk && downloadProgress
                      ? `${t(lang, 'downloadingApkProgress')} ${downloadProgress.percent}%`
                      : t(lang, 'downloadAndroidApp')}
                  </span>
                </button>
                {session?.role === 'ADMIN' && onOpenAppUpdatePublisher && (
                  <button
                    type="button"
                    onClick={onOpenAppUpdatePublisher}
                    className="inline-flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium text-slate-700 bg-white hover:bg-stone-50 border border-stone-300 rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    <Settings2 className="w-3.5 h-3.5 text-emerald-700" />
                    <span>{t(lang, 'configureAppUpdate')}</span>
                  </button>
                )}
              </div>
            </div>

            {downloadingApk && downloadProgress && (
              <div className="p-3 bg-white border border-emerald-200 rounded-lg space-y-1.5">
                <div className="flex items-center justify-between text-xs font-medium text-emerald-900">
                  <span>
                    {downloadProgress.phase === 'fetching'
                      ? t(lang, 'downloadingApkProgress')
                      : `${t(lang, 'downloadingApkProgress')} (${downloadProgress.currentChunk}/${downloadProgress.totalChunks})`}
                  </span>
                  <span className="font-mono tabular-nums">{downloadProgress.percent}%</span>
                </div>
                <div className="w-full h-2 bg-emerald-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-700 transition-all duration-150"
                    style={{ width: `${downloadProgress.percent}%` }}
                  />
                </div>
              </div>
            )}

            {noChunksFound && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg bg-amber-50 border border-amber-200">
                <div className="flex items-start gap-2.5 text-xs text-amber-900">
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <span>{t(lang, 'noChunksUploadedNotice')}</span>
                </div>
                {session?.role === 'ADMIN' && onOpenAppUpdatePublisher && (
                  <button
                    type="button"
                    onClick={onOpenAppUpdatePublisher}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-amber-700 hover:bg-amber-800 text-white rounded-lg cursor-pointer whitespace-nowrap shrink-0 self-start sm:self-auto"
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    <span>{t(lang, 'uploadNewApkBtn')}</span>
                  </button>
                )}
              </div>
            )}

            {apkDownloadError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800"
              >
                {t(lang, 'errorPrefix')} {apkDownloadError}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-white border border-emerald-200 text-emerald-700 flex items-center justify-center shrink-0">
                <Smartphone className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  {t(lang, 'androidAppUpdateTitle')}
                </h3>
                <p className="text-xs text-slate-600">{t(lang, 'appUpdateNotConfigured')}</p>
              </div>
            </div>
            {session?.role === 'ADMIN' && onOpenAppUpdatePublisher && (
              <button
                type="button"
                onClick={onOpenAppUpdatePublisher}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg cursor-pointer whitespace-nowrap self-start sm:self-auto"
              >
                <Settings2 className="w-3.5 h-3.5" />
                <span>{t(lang, 'publishAppUpdate')}</span>
              </button>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="space-y-6">
      {/* Highlighted at top when arriving from ?update=1 */}
      {highlightAppUpdate && renderAppUpdateCard()}

      {/* School Identity Banner */}
      <section className="bg-white border border-stone-200 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
              {school?.schoolName || session?.schoolId}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
              <span>
                {t(lang, 'schoolIdLabel')}: <span className="font-mono font-medium text-slate-800">{session?.schoolId}</span>
              </span>
              {school?.emisCode && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t(lang, 'emisCode')}: <span className="font-mono tabular-nums text-slate-800">{school.emisCode}</span>
                  </span>
                </>
              )}
              {school?.upazilaDistrict && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{school.upazilaDistrict}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>
                {school?.teachers?.length || 0} {lang === 'bn' ? 'জন শিক্ষক' : 'Teachers'}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => onNavigate('attendance')}
              className="px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {t(lang, 'navAttendance')}
            </button>
            <button
              type="button"
              onClick={() => onNavigate('batch-marks')}
              className="px-4 py-2 text-xs font-semibold bg-white hover:bg-stone-50 text-slate-800 border border-stone-300 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {t(lang, 'navBatchMarks')}
            </button>
          </div>
        </div>
      </section>

      {/* Default position when not deep-linked with ?update=1 */}
      {!highlightAppUpdate && renderAppUpdateCard()}

      {/* 4 Summary Stat Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">
            {t(lang, 'totalStudentsClass')} ({getClassLabel(selectedClass, lang)})
          </div>
          <div className="mt-2 text-3xl font-bold text-slate-900 tabular-nums">
            {classStudents.length}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            {t(lang, 'academicYear')} {selectedAcademicYear}
          </div>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">
            {t(lang, 'totalStudentsSchool')}
          </div>
          <div className="mt-2 text-3xl font-bold text-slate-900 tabular-nums">
            {yearStudents.length}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {CLASS_LEVELS.length} {lang === 'bn' ? 'টি শ্রেণি' : 'Grade Levels'}
          </div>
        </div>

        <div className="bg-white border border-stone-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">
            {t(lang, 'todayAttendance')} ({getClassLabel(selectedClass, lang)})
          </div>
          <div className="mt-2 text-3xl font-bold text-emerald-700 tabular-nums">
            {attendancePct !== null ? `${attendancePct}%` : '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            {todayAttendance
              ? `${presentTodayCount} / ${classStudents.length} ${t(lang, 'present')}`
              : todayKey}
          </div>
        </div>

        <div
          onClick={() => session?.role === 'ADMIN' && onNavigate('admin')}
          className={`bg-white border border-stone-200 rounded-xl p-5 ${
            session?.role === 'ADMIN' ? 'cursor-pointer hover:border-emerald-300 transition-colors' : ''
          }`}
        >
          <div className="text-xs font-medium text-slate-500">
            {session?.role === 'ADMIN'
              ? t(lang, 'pendingApprovals')
              : t(lang, 'activeSubjects')}
          </div>
          <div className="mt-2 text-3xl font-bold text-slate-900 tabular-nums">
            {session?.role === 'ADMIN' ? pendingCount : classSubjects.length}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {session?.role === 'ADMIN'
              ? lang === 'bn'
                ? 'অ্যাডমিন প্যানেলে পর্যালোচনা করুন'
                : 'Review in Admin Panel'
              : getClassLabel(selectedClass, lang)}
          </div>
        </div>
      </section>

      {/* Quick Search + Class Distribution */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white border border-stone-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-slate-900">
              {t(lang, 'classBreakdown')} ({selectedAcademicYear})
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('students')}
              className="text-xs font-medium text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
            >
              <span>{t(lang, 'navStudents')}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-stone-200 text-xs font-semibold text-slate-500">
                  <th className="py-2.5 pr-4">{t(lang, 'classSelector')}</th>
                  <th className="py-2.5 px-4 text-right">{t(lang, 'navStudents')}</th>
                  <th className="py-2.5 pl-4 text-right">{t(lang, 'todayAttendance')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {classDistribution.map((row) => {
                  const isSelected = row.classLevel === selectedClass;
                  return (
                    <tr
                      key={row.classLevel}
                      onClick={() => setSelectedClass(row.classLevel)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-emerald-50/70' : 'hover:bg-stone-50'
                      }`}
                    >
                      <td className="py-2.5 pr-4 font-medium text-slate-900">
                        {getClassLabel(row.classLevel, lang)}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums font-mono text-slate-800">
                        {row.count}
                      </td>
                      <td className="py-2.5 pl-4 text-right tabular-nums text-slate-600">
                        {row.present !== null ? `${row.present} / ${row.count}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:col-span-5 space-y-6">
          {/* Quick Student Search */}
          <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
            <h3 className="text-base font-semibold text-slate-900">
              {lang === 'bn' ? 'দ্রুত শিক্ষার্থী অনুসন্ধান' : 'Quick Student Lookup'}
            </h3>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={quickQuery}
                onChange={(e) => setQuickQuery(e.target.value)}
                placeholder={t(lang, 'quickSearchPlaceholder')}
                className="w-full pl-9 pr-3 py-2 text-sm bg-stone-50 border border-stone-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white"
              />
            </div>

            {quickQuery.trim() !== '' && (
              <div className="divide-y divide-stone-100 border border-stone-200 rounded-lg overflow-hidden">
                {quickSearchResults.length === 0 ? (
                  <div className="p-3 text-xs text-slate-500 text-center">
                    {t(lang, 'noStudentsFound')}
                  </div>
                ) : (
                  quickSearchResults.map((st) => {
                    const photo = formatPhotoSrc(st.photoBase64);
                    return (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => {
                          setSelectedClass(st.classLevel);
                          onOpenStudentProfile(st.id);
                        }}
                        className="w-full flex items-center justify-between gap-3 p-2.5 text-left hover:bg-stone-50 cursor-pointer"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {photo ? (
                            <img
                              src={photo}
                              alt={st.studentNameEn || st.studentNameBn}
                              referrerPolicy="no-referrer"
                              className="w-8 h-8 rounded-full object-cover border border-stone-200 shrink-0"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center text-xs font-semibold shrink-0">
                              {(st.studentNameEn || st.studentNameBn || '?').charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-900 truncate">
                              {st.studentNameBn || st.studentNameEn}
                            </div>
                            <div className="text-xs text-slate-500 truncate">
                              {getClassLabel(st.classLevel, lang)} · Roll {st.rollNumber}
                            </div>
                          </div>
                        </div>
                        <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Quick Action Links */}
          <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
            <h3 className="text-base font-semibold text-slate-900">
              {t(lang, 'quickActions')}
            </h3>
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => onNavigate('students')}
                className="flex items-center gap-2 p-3 text-left text-xs font-medium text-slate-700 bg-stone-50 hover:bg-emerald-50 hover:text-emerald-900 border border-stone-200 rounded-lg transition-colors cursor-pointer"
              >
                <Users className="w-4 h-4 text-emerald-700 shrink-0" />
                <span className="truncate">{t(lang, 'navStudents')}</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('batch-marks')}
                className="flex items-center gap-2 p-3 text-left text-xs font-medium text-slate-700 bg-stone-50 hover:bg-emerald-50 hover:text-emerald-900 border border-stone-200 rounded-lg transition-colors cursor-pointer"
              >
                <ClipboardList className="w-4 h-4 text-emerald-700 shrink-0" />
                <span className="truncate">{t(lang, 'navBatchMarks')}</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('attendance')}
                className="flex items-center gap-2 p-3 text-left text-xs font-medium text-slate-700 bg-stone-50 hover:bg-emerald-50 hover:text-emerald-900 border border-stone-200 rounded-lg transition-colors cursor-pointer"
              >
                <CalendarCheck2 className="w-4 h-4 text-emerald-700 shrink-0" />
                <span className="truncate">{t(lang, 'navAttendance')}</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('marksheet')}
                className="flex items-center gap-2 p-3 text-left text-xs font-medium text-slate-700 bg-stone-50 hover:bg-emerald-50 hover:text-emerald-900 border border-stone-200 rounded-lg transition-colors cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-700 shrink-0" />
                <span className="truncate">{t(lang, 'navMarksheet')}</span>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
