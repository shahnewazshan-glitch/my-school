import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  Search,
  Trash2,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { hasLegacyApkMetadata } from '../lib/apkChunks';
import { getClassLabel, t } from '../lib/i18n';
import {
  formatPhotoSrc,
  getAttendanceDocId,
  getClassSubjectsForMarksheet,
  getTodayDateKey,
  matchesStudentSearch,
  OFFICIAL_EMIS_CODE,
  OFFICIAL_SCHOOL_ID,
  OFFICIAL_SCHOOL_NAME_BN,
  OFFICIAL_SCHOOL_NAME_EN,
} from '../lib/schoolUtils';
import { CLASS_LEVELS } from '../types/school';
import type { NavTab } from './WorkspaceLayout';

interface DashboardViewProps {
  onNavigate: (tab: NavTab) => void;
  onOpenStudentProfile: (studentId: string) => void;
  onOpenApkCleanup?: () => void;
  onOpenSchoolSetup?: (tab: 'setup' | 'update') => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  onNavigate,
  onOpenStudentProfile,
  onOpenApkCleanup,
  onOpenSchoolSetup,
}) => {
  const {
    lang,
    session,
    school,
    students,
    attendanceLogs,
    pendingChanges,
    loadedModules,
    selectedAcademicYear,
    selectedClass,
    setSelectedClass,
  } = useApp();

  const [quickQuery, setQuickQuery] = useState('');
  const [actionMenuValue, setActionMenuValue] = useState('');

  const showLegacyApkCleanupBanner =
    session?.role === 'ADMIN' && hasLegacyApkMetadata(school) && Boolean(onOpenApkCleanup);

  const needsSchoolIdOrEmisUpdate =
    session?.role === 'ADMIN' &&
    Boolean(onOpenSchoolSetup) &&
    (session.schoolId !== OFFICIAL_SCHOOL_ID ||
      (school?.emisCode || '').trim() !== OFFICIAL_EMIS_CODE);

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
  const todayAttendance = loadedModules.attendance
    ? attendanceLogs.find((a) => a.id === todayAttDocId)
    : undefined;

  const presentTodayCount = useMemo(() => {
    if (!todayAttendance?.statuses) return 0;
    return Object.values(todayAttendance.statuses).filter((v) => v === 'P' || v === 'L').length;
  }, [todayAttendance]);

  const attendancePct =
    classStudents.length > 0 && todayAttendance
      ? Math.round((presentTodayCount / classStudents.length) * 100)
      : null;

  const pendingCount = useMemo(
    () =>
      loadedModules.pending
        ? pendingChanges.filter((c) => c.status === 'PENDING').length
        : null,
    [loadedModules.pending, pendingChanges]
  );

  const classSubjects = useMemo(
    () => getClassSubjectsForMarksheet(school?.examConfigs || [], selectedClass),
    [school?.examConfigs, selectedClass]
  );

  const quickSearchResults = useMemo(() => {
    const q = quickQuery.trim();
    if (!q) return [];
    return yearStudents.filter((s) => matchesStudentSearch(s, q)).slice(0, 10);
  }, [quickQuery, yearStudents]);

  const classDistribution = useMemo(() => {
    return CLASS_LEVELS.map((cls) => {
      const count = yearStudents.filter((s) => s.classLevel === cls).length;
      const docId = getAttendanceDocId(selectedAcademicYear, cls, todayKey);
      const log = loadedModules.attendance
        ? attendanceLogs.find((a) => a.id === docId)
        : undefined;
      const present = log?.statuses
        ? Object.values(log.statuses).filter((v) => v === 'P' || v === 'L').length
        : null;
      return { classLevel: cls, count, present };
    });
  }, [yearStudents, attendanceLogs, loadedModules.attendance, selectedAcademicYear, todayKey]);

  const schoolDisplayName =
    school?.schoolName?.trim() ||
    (lang === 'bn' ? OFFICIAL_SCHOOL_NAME_BN : OFFICIAL_SCHOOL_NAME_EN);
  const emisDisplay = school?.emisCode?.trim() || OFFICIAL_EMIS_CODE;

  const handleDropdownNavigate = (tab: string) => {
    if (!tab) return;
    setActionMenuValue('');
    onNavigate(tab as NavTab);
  };

  return (
    <div className="space-y-6">
      {/* Clean Minimal School Banner with Dropdown Menus */}
      <section className="bg-white border border-stone-200 rounded-xl p-5 sm:p-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="text-center md:text-left">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900">
              {schoolDisplayName}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center justify-center md:justify-start gap-x-3 gap-y-1 text-sm text-slate-600">
              <span>
                {t(lang, 'schoolIdLabel')}:{' '}
                <span className="font-mono font-semibold text-emerald-800">
                  {session?.schoolId}
                </span>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {t(lang, 'emisCode')}:{' '}
                <span className="font-mono tabular-nums font-medium text-slate-800">
                  {emisDisplay}
                </span>
              </span>
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

          {/* Clean Dropdown Menu instead of cluttered buttons */}
          <div className="flex flex-wrap items-center justify-center md:justify-end gap-2.5">
            <div className="relative min-w-[200px]">
              <select
                aria-label={t(lang, 'quickActions')}
                value={actionMenuValue}
                onChange={(e) => handleDropdownNavigate(e.target.value)}
                className="w-full appearance-none pl-3.5 pr-9 py-2 text-xs font-semibold bg-emerald-700 text-white rounded-lg cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <option value="">{t(lang, 'quickActions')} ▾</option>
                <option value="students">{t(lang, 'navStudents')}</option>
                <option value="attendance">{t(lang, 'navAttendance')}</option>
                <option value="batch-marks">{t(lang, 'navBatchMarks')}</option>
                <option value="marksheet">{t(lang, 'navMarksheet')}</option>
                <option value="analytics">{t(lang, 'navAnalytics')}</option>
                <option value="promotion">{t(lang, 'navPromotion')}</option>
                <option value="batch-fields">{t(lang, 'navBatchFields')}</option>
                <option value="comms">{t(lang, 'navComms')}</option>
                {session?.role === 'ADMIN' && (
                  <option value="admin">{t(lang, 'navAdmin')}</option>
                )}
              </select>
              <ChevronDown className="w-4 h-4 text-emerald-100 pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" />
            </div>
          </div>
        </div>
      </section>

      {needsSchoolIdOrEmisUpdate && (
        <section className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold text-emerald-950">
              {lang === 'bn'
                ? `স্কুল আইডি (${OFFICIAL_SCHOOL_ID}) ও EMIS (${OFFICIAL_EMIS_CODE}) আপডেট করুন`
                : `Update School ID to ${OFFICIAL_SCHOOL_ID} & EMIS to ${OFFICIAL_EMIS_CODE}`}
            </h3>
            <p className="text-xs text-emerald-900/90">
              {lang === 'bn'
                ? `বর্তমান আইডি: ${session?.schoolId} · EMIS: ${emisDisplay}। কোনো তথ্য না হারিয়ে নিরাপদে পরিবর্তন করুন।`
                : `Currently connected as ID ${session?.schoolId} · EMIS ${emisDisplay}. Update safely with zero data loss.`}
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              onOpenSchoolSetup?.(
                session?.schoolId !== OFFICIAL_SCHOOL_ID ? 'update' : 'setup'
              )
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg cursor-pointer whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            <span>
              {session?.schoolId !== OFFICIAL_SCHOOL_ID
                ? lang === 'bn'
                  ? `আইডি ${OFFICIAL_SCHOOL_ID}-এ যান`
                  : `Migrate to ${OFFICIAL_SCHOOL_ID}`
                : lang === 'bn'
                ? 'EMIS সেট করুন'
                : 'Set Official EMIS'}
            </span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </section>
      )}

      {/* One-time Admin Notice when legacy APK metadata/chunks remain on server */}
      {showLegacyApkCleanupBanner && (
        <section className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-amber-950">{t(lang, 'deleteApkTitle')}</h3>
            <p className="text-xs text-amber-900/90 leading-relaxed">
              {lang === 'bn'
                ? 'সার্ভারে পুরোনো আপলোড করা APK ফাইল/মেটাডেটা রয়েছে। শিক্ষার্থী বা নম্বরের কোনো ক্ষতি না করেই এগুলো মুছে ফেলা যাবে।'
                : 'Previously uploaded APK update chunks/metadata exist on the server. Remove them safely without affecting students or marks.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenApkCleanup}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-amber-700 hover:bg-amber-800 text-white rounded-lg cursor-pointer whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t(lang, 'deleteApkBtn')}</span>
          </button>
        </section>
      )}

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

        <div
          onClick={() => onNavigate('attendance')}
          className="bg-white border border-stone-200 rounded-xl p-5 cursor-pointer hover:border-emerald-300 transition-colors"
        >
          <div className="text-xs font-medium text-slate-500">
            {t(lang, 'todayAttendance')} ({getClassLabel(selectedClass, lang)})
          </div>
          <div className="mt-2 text-3xl font-bold text-emerald-700 tabular-nums">
            {attendancePct !== null ? `${attendancePct}%` : '—'}
          </div>
          <div className="mt-1 text-xs text-slate-500 tabular-nums">
            {todayAttendance
              ? `${presentTodayCount} / ${classStudents.length} ${t(lang, 'present')}`
              : loadedModules.attendance
              ? todayKey
              : lang === 'bn'
              ? 'উপস্থিতি দেখতে ক্লিক করুন'
              : 'Click to open register'}
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
          <div className="mt-2 text-3xl font-bold text-amber-700 tabular-nums">
            {session?.role === 'ADMIN'
              ? pendingCount !== null
                ? pendingCount
                : '—'
              : classSubjects.length}
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
            <h3 className="text-base font-bold text-slate-900">
              {t(lang, 'classBreakdown')} ({selectedAcademicYear})
            </h3>
            <button
              type="button"
              onClick={() => onNavigate('students')}
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
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
                        isSelected ? 'bg-emerald-50/80' : 'hover:bg-stone-50'
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
          {/* Quick Student Search (supports 04/01, 00/01 path search) */}
          <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
            <h3 className="text-base font-bold text-slate-900">
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
                        className="w-full flex items-center justify-between gap-3 p-2.5 text-left hover:bg-emerald-50/40 cursor-pointer"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {photo ? (
                            <img
                              src={photo}
                              alt={st.studentNameEn || st.studentNameBn}
                              loading="lazy"
                              decoding="async"
                              referrerPolicy="no-referrer"
                              className="w-8 h-8 rounded-full object-cover border border-stone-200 shrink-0"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center text-xs font-semibold shrink-0">
                              {(st.studentNameEn || st.studentNameBn || '?')
                                .charAt(0)
                                .toUpperCase()}
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

          {/* Clean Dropdown Menu for Academic & Analytics Shortcuts */}
          <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
            <h3 className="text-base font-bold text-slate-900">
              {lang === 'bn' ? 'মডিউল নির্বাচন করুন' : 'Jump to Module'}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="relative">
                <select
                  aria-label="Academic Modules"
                  defaultValue=""
                  onChange={(e) => handleDropdownNavigate(e.target.value)}
                  className="w-full appearance-none px-3 py-2.5 pr-8 text-xs font-semibold text-slate-800 bg-stone-50 hover:bg-emerald-50 border border-stone-200 rounded-lg cursor-pointer"
                >
                  <option value="">
                    {lang === 'bn' ? 'একাডেমিক ও উপস্থিতি ▾' : 'Academics & Attendance ▾'}
                  </option>
                  <option value="students">{t(lang, 'navStudents')}</option>
                  <option value="attendance">{t(lang, 'navAttendance')}</option>
                  <option value="batch-marks">{t(lang, 'navBatchMarks')}</option>
                  <option value="batch-fields">{t(lang, 'navBatchFields')}</option>
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-slate-500 pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" />
              </div>

              <div className="relative">
                <select
                  aria-label="Reports and Promotion"
                  defaultValue=""
                  onChange={(e) => handleDropdownNavigate(e.target.value)}
                  className="w-full appearance-none px-3 py-2.5 pr-8 text-xs font-semibold text-slate-800 bg-stone-50 hover:bg-emerald-50 border border-stone-200 rounded-lg cursor-pointer"
                >
                  <option value="">
                    {lang === 'bn' ? 'ফলাফল, বিশ্লেষণ ও উত্তীর্ণ ▾' : 'Results, Analytics & Rolls ▾'}
                  </option>
                  <option value="marksheet">{t(lang, 'navMarksheet')}</option>
                  <option value="analytics">{t(lang, 'navAnalytics')}</option>
                  <option value="promotion">{t(lang, 'navPromotion')}</option>
                  <option value="comms">{t(lang, 'navComms')}</option>
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-slate-500 pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
