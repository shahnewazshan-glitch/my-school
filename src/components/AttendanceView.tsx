import React, { useEffect, useMemo, useState } from 'react';
import { doc, setDoc, writeBatch } from 'firebase/firestore';
import { CheckCheck, Download, Save, X } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useApp } from '../contexts/AppContext';
import { getFirebaseInstances } from '../lib/firebase';
import { buildAttendancePayload } from '../lib/firestoreValidation';
import { getClassLabel, t } from '../lib/i18n';
import { getAttendanceDocId, getTodayDateKey } from '../lib/schoolUtils';
import type { AttendanceStatus } from '../types/school';

type AttendanceViewMode = 'daily' | 'weekly' | 'monthly' | 'yearly';

function cycleStatus(cur?: AttendanceStatus): AttendanceStatus | undefined {
  if (!cur) return 'P';
  if (cur === 'P') return 'A';
  if (cur === 'A') return 'L';
  return undefined;
}

function getWeekDates(anchorDateStr: string): string[] {
  const [y, m, d] = anchorDateStr.split('-').map(Number);
  const anchor = new Date(y, (m || 1) - 1, d || 1);
  // Start week on Sunday (standard Bangladesh school week Sun-Thu + Fri/Sat)
  const dayOfWeek = anchor.getDay();
  const sunday = new Date(anchor);
  sunday.setDate(anchor.getDate() - dayOfWeek);
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(sunday);
    dt.setDate(sunday.getDate() + i);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    days.push(`${yy}-${mm}-${dd}`);
  }
  return days;
}

function getMonthDates(monthKey: string): string[] {
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return [];
  const totalDays = new Date(y, m, 0).getDate();
  const list: string[] = [];
  for (let d = 1; d <= totalDays; d++) {
    list.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return list;
}

export const AttendanceView: React.FC = () => {
  const {
    lang,
    session,
    students,
    attendanceLogs,
    selectedAcademicYear,
    selectedClass,
  } = useApp();

  const [viewMode, setViewMode] = useState<AttendanceViewMode>('daily');
  const [dateKey, setDateKey] = useState<string>(() => getTodayDateKey());
  const [monthKey, setMonthKey] = useState<string>(() => getTodayDateKey().slice(0, 7));
  const [statuses, setStatuses] = useState<Record<string, AttendanceStatus>>({});

  // Multi-date draft overrides for Weekly & Monthly tap-cycling sheets: dateKey -> { studentId -> status }
  const [matrixDrafts, setMatrixDrafts] = useState<
    Record<string, Record<string, AttendanceStatus>>
  >({});
  const [dirtyDates, setDirtyDates] = useState<Set<string>>(new Set());

  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const classStudents = useMemo(
    () =>
      students.filter(
        (s) =>
          Number(s.academicYear) === Number(selectedAcademicYear) &&
          s.classLevel === selectedClass
      ),
    [students, selectedAcademicYear, selectedClass]
  );

  // Daily active doc
  const activeDocId = useMemo(
    () => getAttendanceDocId(selectedAcademicYear, selectedClass, dateKey),
    [selectedAcademicYear, selectedClass, dateKey]
  );

  const existingLog = useMemo(
    () => attendanceLogs.find((l) => l.id === activeDocId),
    [attendanceLogs, activeDocId]
  );

  useEffect(() => {
    setStatuses(existingLog?.statuses ? { ...existingLog.statuses } : {});
  }, [existingLog, activeDocId]);

  const counts = useMemo(() => {
    let p = 0;
    let a = 0;
    let l = 0;
    for (const st of classStudents) {
      const val = statuses[st.id];
      if (val === 'P') p += 1;
      else if (val === 'A') a += 1;
      else if (val === 'L') l += 1;
    }
    return { p, a, l };
  }, [classStudents, statuses]);

  // Lookup map for existing attendanceLogs by dateKey for selected class & year
  const logsByDate = useMemo(() => {
    const map = new Map<string, (typeof attendanceLogs)[number]>();
    for (const log of attendanceLogs) {
      if (
        Number(log.academicYear) === Number(selectedAcademicYear) &&
        log.classLevel === selectedClass
      ) {
        map.set(log.dateKey, log);
      }
    }
    return map;
  }, [attendanceLogs, selectedAcademicYear, selectedClass]);

  // Reset multi-date drafts when class/year/view changes
  useEffect(() => {
    setMatrixDrafts({});
    setDirtyDates(new Set());
  }, [selectedAcademicYear, selectedClass, viewMode, dateKey, monthKey]);

  const getCellStatus = (dKey: string, studentId: string): AttendanceStatus | undefined => {
    if (matrixDrafts[dKey] && studentId in matrixDrafts[dKey]) {
      return matrixDrafts[dKey][studentId];
    }
    if (matrixDrafts[dKey] && !(studentId in matrixDrafts[dKey])) {
      return undefined;
    }
    return logsByDate.get(dKey)?.statuses?.[studentId];
  };

  const handleCycleMatrixCell = (dKey: string, studentId: string) => {
    const baseStatuses = matrixDrafts[dKey]
      ? { ...matrixDrafts[dKey] }
      : { ...(logsByDate.get(dKey)?.statuses || {}) };

    const next = cycleStatus(baseStatuses[studentId]);
    if (next) {
      baseStatuses[studentId] = next;
    } else {
      delete baseStatuses[studentId];
    }

    setMatrixDrafts((prev) => ({ ...prev, [dKey]: baseStatuses }));
    setDirtyDates((prev) => new Set(prev).add(dKey));
  };

  const handleMarkAllPresentDaily = () => {
    const next: Record<string, AttendanceStatus> = { ...statuses };
    for (const st of classStudents) {
      next[st.id] = 'P';
    }
    setStatuses(next);
  };

  const handleSaveDaily = async () => {
    if (!session || !dateKey) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setBanner(null);
    try {
      const payload = buildAttendancePayload({
        schoolId: session.schoolId,
        academicYear: selectedAcademicYear,
        classLevel: selectedClass,
        dateKey,
        statuses,
        markedByName: session.name,
        existingCreatedAt: existingLog?.createdAt,
      });

      await setDoc(
        doc(instances.db, 'schools', session.schoolId, 'attendanceLogs', activeDocId),
        payload,
        { merge: true }
      );
      setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMatrixDates = async () => {
    if (!session || dirtyDates.size === 0) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setBanner(null);

    try {
      const datesList = Array.from(dirtyDates);
      for (let i = 0; i < datesList.length; i += 400) {
        const chunk = datesList.slice(i, i + 400);
        const batch = writeBatch(instances.db);
        for (const dKey of chunk) {
          const docId = getAttendanceDocId(selectedAcademicYear, selectedClass, dKey);
          const existing = logsByDate.get(dKey);
          const payload = buildAttendancePayload({
            schoolId: session.schoolId,
            academicYear: selectedAcademicYear,
            classLevel: selectedClass,
            dateKey: dKey,
            statuses: matrixDrafts[dKey] || {},
            markedByName: session.name,
            existingCreatedAt: existing?.createdAt,
          });
          batch.set(
            doc(instances.db, 'schools', session.schoolId, 'attendanceLogs', docId),
            payload,
            { merge: true }
          );
        }
        await batch.commit();
      }
      setDirtyDates(new Set());
      setMatrixDrafts({});
      setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const weekDates = useMemo(() => getWeekDates(dateKey), [dateKey]);
  const monthDates = useMemo(() => getMonthDates(monthKey), [monthKey]);

  const yearlyBreakdown = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, idx) => {
      const mm = String(idx + 1).padStart(2, '0');
      return `${selectedAcademicYear}-${mm}`;
    });

    const classLogs = attendanceLogs.filter(
      (l) =>
        Number(l.academicYear) === Number(selectedAcademicYear) &&
        l.classLevel === selectedClass
    );

    const rows = classStudents.map((st) => {
      let totalP = 0;
      let totalA = 0;
      let totalL = 0;
      const byMonth: Record<string, { p: number; a: number; l: number }> = {};
      for (const m of months) byMonth[m] = { p: 0, a: 0, l: 0 };

      for (const log of classLogs) {
        const mk = log.monthKey || log.dateKey.slice(0, 7);
        const status = log.statuses?.[st.id];
        if (!status || !byMonth[mk]) continue;
        if (status === 'P') {
          byMonth[mk].p += 1;
          totalP += 1;
        } else if (status === 'A') {
          byMonth[mk].a += 1;
          totalA += 1;
        } else if (status === 'L') {
          byMonth[mk].l += 1;
          totalL += 1;
        }
      }

      const logged = totalP + totalA + totalL;
      const pct = logged > 0 ? Math.round(((totalP + totalL) / logged) * 100) : 0;
      return { st, byMonth, totalP, totalA, totalL, pct };
    });

    return { months, rows };
  }, [attendanceLogs, classStudents, selectedAcademicYear, selectedClass]);

  const exportYearlyAttendance = () => {
    const data = yearlyBreakdown.rows.map((r) => {
      const row: Record<string, string | number> = {
        Roll: r.st.rollNumber,
        Name: r.st.studentNameBn || r.st.studentNameEn,
        TotalPresent: r.totalP,
        TotalAbsent: r.totalA,
        TotalLate: r.totalL,
        AttendancePct: `${r.pct}%`,
      };
      for (const m of yearlyBreakdown.months) {
        const stat = r.byMonth[m];
        row[m] = stat.p + stat.a + stat.l > 0 ? `P:${stat.p} A:${stat.a} L:${stat.l}` : '';
      }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Yearly Attendance');
    XLSX.writeFile(
      wb,
      `Attendance_${selectedClass.replace(/\s+/g, '_')}_${selectedAcademicYear}.xlsx`
    );
  };

  return (
    <div className="space-y-5">
      {banner && (
        <div
          className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border text-sm ${
            banner.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-rose-50 border-rose-200 text-rose-900'
          }`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="p-1 hover:opacity-70 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* View Mode Tabs: Daily / Weekly / Monthly / Yearly */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-stone-200/70 rounded-lg w-fit">
          {(
            [
              { id: 'daily', label: t(lang, 'viewDaily') },
              { id: 'weekly', label: t(lang, 'viewWeekly') },
              { id: 'monthly', label: t(lang, 'viewMonthly') },
              { id: 'yearly', label: t(lang, 'viewYearly') },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setViewMode(tab.id)}
              className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                viewMode === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <span className="text-xs text-slate-500">
          {getClassLabel(selectedClass, lang)} · {selectedAcademicYear}
        </span>
      </div>

      {/* DAILY VIEW */}
      {viewMode === 'daily' && (
        <>
          <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label
                  htmlFor="attendance-date"
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  {t(lang, 'attendanceDate')}
                </label>
                <input
                  id="attendance-date"
                  type="date"
                  value={dateKey}
                  onChange={(e) => setDateKey(e.target.value)}
                  className="px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="text-xs text-slate-600 flex items-center gap-3 pb-2">
                <span>
                  {t(lang, 'present')}:{' '}
                  <strong className="font-mono tabular-nums text-emerald-700">{counts.p}</strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {t(lang, 'absent')}:{' '}
                  <strong className="font-mono tabular-nums text-rose-600">{counts.a}</strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {t(lang, 'late')}:{' '}
                  <strong className="font-mono tabular-nums text-amber-600">{counts.l}</strong>
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleMarkAllPresentDaily}
                disabled={classStudents.length === 0}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <CheckCheck className="w-4 h-4 text-emerald-700" />
                <span>{t(lang, 'markAllPresent')}</span>
              </button>

              <button
                type="button"
                onClick={handleSaveDaily}
                disabled={saving || classStudents.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg cursor-pointer whitespace-nowrap"
              >
                <Save className="w-4 h-4" />
                <span>{saving ? t(lang, 'loading') : t(lang, 'saveAttendance')}</span>
              </button>
            </div>
          </div>

          <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            {classStudents.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {t(lang, 'noStudentsFound')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 w-20">{t(lang, 'rollNumber')}</th>
                      <th className="py-3 px-4">
                        {lang === 'bn' ? 'শিক্ষার্থীর নাম' : 'Student Name'}
                      </th>
                      <th className="py-3 px-4 text-center">{dateKey}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {classStudents.map((st) => {
                      const current = statuses[st.id];
                      return (
                        <tr key={st.id} className="hover:bg-stone-50/60">
                          <td className="py-2.5 px-4 font-mono tabular-nums font-semibold text-slate-900">
                            {st.rollNumber}
                          </td>
                          <td className="py-2.5 px-4">
                            <div className="font-medium text-slate-900">
                              {st.studentNameBn || st.studentNameEn}
                            </div>
                          </td>
                          <td className="py-2 px-4">
                            <div className="flex items-center justify-center gap-1.5">
                              {(
                                [
                                  {
                                    code: 'P',
                                    label: t(lang, 'present'),
                                    activeCls: 'bg-emerald-700 text-white border-emerald-700',
                                  },
                                  {
                                    code: 'A',
                                    label: t(lang, 'absent'),
                                    activeCls: 'bg-rose-600 text-white border-rose-600',
                                  },
                                  {
                                    code: 'L',
                                    label: t(lang, 'late'),
                                    activeCls: 'bg-amber-600 text-white border-amber-600',
                                  },
                                ] as const
                              ).map((opt) => (
                                <button
                                  key={opt.code}
                                  type="button"
                                  onClick={() =>
                                    setStatuses((prev) => ({ ...prev, [st.id]: opt.code }))
                                  }
                                  className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                                    current === opt.code
                                      ? opt.activeCls
                                      : 'bg-white text-slate-700 border-stone-300 hover:bg-stone-100'
                                  }`}
                                >
                                  {opt.code} · {opt.label}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* WEEKLY & MONTHLY TAP-CYCLING MATRIX */}
      {(viewMode === 'weekly' || viewMode === 'monthly') && (
        <>
          <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              {viewMode === 'weekly' ? (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    {lang === 'bn' ? 'সপ্তাহের তারিখ' : 'Week Containing'}
                  </label>
                  <input
                    type="date"
                    value={dateKey}
                    onChange={(e) => setDateKey(e.target.value)}
                    className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg font-mono"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    {lang === 'bn' ? 'মাস নির্বাচন' : 'Select Month'}
                  </label>
                  <input
                    type="month"
                    value={monthKey}
                    onChange={(e) => setMonthKey(e.target.value)}
                    className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg font-mono"
                  />
                </div>
              )}

              <p className="text-xs text-slate-500">
                {lang === 'bn'
                  ? 'যেকোনো ঘরে ক্লিক/ট্যাপ করে P → A → L পরিবর্তন করুন।'
                  : 'Tap any cell to cycle: — → P → A → L → —'}
              </p>
            </div>

            <button
              type="button"
              disabled={saving || dirtyDates.size === 0}
              onClick={handleSaveMatrixDates}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
            >
              <Save className="w-4 h-4" />
              <span>
                {saving
                  ? t(lang, 'loading')
                  : `${t(lang, 'saveAttendance')} (${dirtyDates.size}d)`}
              </span>
            </button>
          </div>

          <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            {classStudents.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {t(lang, 'noStudentsFound')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-stone-50 border-b border-stone-200 text-slate-600 font-semibold">
                      <th className="py-2.5 px-3 sticky left-0 bg-stone-50 z-10 border-r border-stone-200">
                        {t(lang, 'rollNumber')}
                      </th>
                      <th className="py-2.5 px-3 min-w-[150px] sticky left-12 bg-stone-50 z-10 border-r border-stone-200">
                        {lang === 'bn' ? 'শিক্ষার্থী' : 'Student'}
                      </th>
                      {(viewMode === 'weekly' ? weekDates : monthDates).map((dKey) => (
                        <th
                          key={dKey}
                          className={`py-2 px-1.5 text-center font-mono tabular-nums min-w-[38px] ${
                            dirtyDates.has(dKey) ? 'bg-amber-100/70 text-amber-900' : ''
                          }`}
                        >
                          {viewMode === 'weekly' ? dKey.slice(5) : dKey.slice(8)}
                        </th>
                      ))}
                      <th className="py-2.5 px-3 text-right border-l border-stone-200">P / A / L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {classStudents.map((st) => {
                      const datesList = viewMode === 'weekly' ? weekDates : monthDates;
                      let p = 0;
                      let a = 0;
                      let l = 0;
                      for (const dKey of datesList) {
                        const s = getCellStatus(dKey, st.id);
                        if (s === 'P') p += 1;
                        else if (s === 'A') a += 1;
                        else if (s === 'L') l += 1;
                      }
                      return (
                        <tr key={st.id} className="hover:bg-stone-50/50">
                          <td className="py-2 px-3 font-mono tabular-nums font-semibold sticky left-0 bg-white border-r border-stone-200">
                            {st.rollNumber}
                          </td>
                          <td className="py-2 px-3 font-medium text-slate-900 sticky left-12 bg-white border-r border-stone-200 truncate max-w-[180px]">
                            {st.studentNameBn || st.studentNameEn}
                          </td>
                          {datesList.map((dKey) => {
                            const status = getCellStatus(dKey, st.id);
                            return (
                              <td key={dKey} className="p-1 text-center">
                                <button
                                  type="button"
                                  onClick={() => handleCycleMatrixCell(dKey, st.id)}
                                  className={`w-7 h-7 rounded font-mono font-bold text-xs transition-colors cursor-pointer ${
                                    status === 'P'
                                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                                      : status === 'A'
                                      ? 'bg-rose-100 text-rose-700 border border-rose-300'
                                      : status === 'L'
                                      ? 'bg-amber-100 text-amber-800 border border-amber-300'
                                      : 'bg-stone-50 text-slate-400 border border-stone-200 hover:bg-stone-100'
                                  }`}
                                >
                                  {status || '·'}
                                </button>
                              </td>
                            );
                          })}
                          <td className="py-2 px-3 text-right font-mono tabular-nums border-l border-stone-200 whitespace-nowrap">
                            <span className="text-emerald-700 font-semibold">{p}</span>/
                            <span className="text-rose-600 font-semibold">{a}</span>/
                            <span className="text-amber-600 font-semibold">{l}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* YEARLY SUMMARY */}
      {viewMode === 'yearly' && (
        <div className="space-y-4">
          <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-slate-900">
              {selectedAcademicYear} — {getClassLabel(selectedClass, lang)}
            </span>
            <button
              type="button"
              disabled={classStudents.length === 0}
              onClick={exportYearlyAttendance}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t(lang, 'exportExcel')}</span>
            </button>
          </div>

          <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            {classStudents.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {t(lang, 'noStudentsFound')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="bg-stone-50 border-b border-stone-200 text-slate-600 font-semibold">
                      <th className="py-2.5 px-3">{t(lang, 'rollNumber')}</th>
                      <th className="py-2.5 px-3 min-w-[150px]">
                        {lang === 'bn' ? 'শিক্ষার্থী' : 'Student'}
                      </th>
                      {yearlyBreakdown.months.map((m) => (
                        <th key={m} className="py-2.5 px-2 text-center font-mono">
                          {m.slice(5)}
                        </th>
                      ))}
                      <th className="py-2.5 px-3 text-right">P</th>
                      <th className="py-2.5 px-3 text-right">A</th>
                      <th className="py-2.5 px-3 text-right">L</th>
                      <th className="py-2.5 px-3 text-right">%</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {yearlyBreakdown.rows.map((r) => (
                      <tr key={r.st.id} className="hover:bg-stone-50/60">
                        <td className="py-2 px-3 font-mono tabular-nums font-semibold">
                          {r.st.rollNumber}
                        </td>
                        <td className="py-2 px-3 font-medium text-slate-900">
                          {r.st.studentNameBn || r.st.studentNameEn}
                        </td>
                        {yearlyBreakdown.months.map((m) => {
                          const stat = r.byMonth[m];
                          const has = stat.p + stat.a + stat.l > 0;
                          return (
                            <td
                              key={m}
                              className="py-2 px-2 text-center font-mono tabular-nums text-[11px] text-slate-600"
                            >
                              {has ? `${stat.p}/${stat.p + stat.a + stat.l}` : '—'}
                            </td>
                          );
                        })}
                        <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold text-emerald-700">
                          {r.totalP}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold text-rose-600">
                          {r.totalA}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums font-semibold text-amber-600">
                          {r.totalL}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums font-bold text-slate-900">
                          {r.pct}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
