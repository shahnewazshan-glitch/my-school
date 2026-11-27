import React, { useMemo, useState } from 'react';
import { BarChart3, ExternalLink } from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { getClassLabel, t } from '../lib/i18n';
import {
  calculateSubjectGrade,
  compareRollNumbers,
  computeClassMeritDetails,
  getClassSubjectsForMarksheet,
  getTermSubjectScore,
  matchesClassScope,
} from '../lib/schoolUtils';

interface AnalyticsViewProps {
  onOpenStudentProfile: (studentId: string) => void;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({
  onOpenStudentProfile,
}) => {
  const {
    lang,
    school,
    students,
    subjects,
    selectedAcademicYear,
    selectedClass,
  } = useApp();

  const classStudents = useMemo(
    () =>
      students
        .filter(
          (s) =>
            Number(s.academicYear) === Number(selectedAcademicYear) &&
            s.classLevel === selectedClass
        )
        .sort(compareRollNumbers),
    [students, selectedAcademicYear, selectedClass]
  );

  const classSubjectDocs = useMemo(
    () =>
      subjects.filter(
        (s) =>
          matchesClassScope(s.gradeScope, selectedClass) &&
          Array.isArray(s.fields) &&
          s.fields.length > 0
      ),
    [subjects, selectedClass]
  );

  const examSubjects = useMemo(
    () => getClassSubjectsForMarksheet(school?.examConfigs, selectedClass),
    [school?.examConfigs, selectedClass]
  );

  const subjectOptions = useMemo(() => {
    const opts: Array<{
      key: string;
      label: string;
      subjectDocId?: string;
      examSubjectId?: string;
      fullMarks?: number;
    }> = [];

    for (const sDoc of classSubjectDocs) {
      const matchedExam = examSubjects.find(
        (es) =>
          es.subjectId === sDoc.id ||
          es.subjectName.trim().toLowerCase() === sDoc.name.trim().toLowerCase()
      );
      opts.push({
        key: `doc:${sDoc.id}`,
        label: sDoc.name,
        subjectDocId: sDoc.id,
        examSubjectId: matchedExam?.subjectId,
        fullMarks: matchedExam?.fullMarks,
      });
    }

    for (const es of examSubjects) {
      const already = opts.some(
        (o) =>
          o.examSubjectId === es.subjectId ||
          o.label.trim().toLowerCase() === es.subjectName.trim().toLowerCase()
      );
      if (!already) {
        opts.push({
          key: `exam:${es.subjectId}`,
          label: es.subjectName,
          examSubjectId: es.subjectId,
          fullMarks: es.fullMarks,
        });
      }
    }
    return opts;
  }, [classSubjectDocs, examSubjects]);

  const [selectedOptKey, setSelectedOptKey] = useState<string>('');

  const activeOption = useMemo(() => {
    if (subjectOptions.length === 0) return null;
    return (
      subjectOptions.find((o) => o.key === selectedOptKey) || subjectOptions[0]
    );
  }, [subjectOptions, selectedOptKey]);

  const activeSubjectDoc = useMemo(
    () =>
      activeOption?.subjectDocId
        ? classSubjectDocs.find((s) => s.id === activeOption.subjectDocId) || null
        : null,
    [classSubjectDocs, activeOption]
  );

  const meritDetails = useMemo(
    () => computeClassMeritDetails(classStudents, examSubjects),
    [classStudents, examSubjects]
  );

  const overviewStats = useMemo(() => {
    let attSum = 0;
    let attCount = 0;
    let zeroFCount = 0;
    let scoredCount = 0;
    let pctSum = 0;

    for (const st of classStudents) {
      const totalDays = Number(st.totalSchoolDays) || 0;
      const presentDays = Number(st.daysPresent) || 0;
      if (totalDays > 0) {
        attSum += Math.min(100, Math.round((presentDays / totalDays) * 100));
        attCount += 1;
      }
      const m = meritDetails.get(st.id);
      if (m && m.scoredCount > 0) {
        scoredCount += 1;
        if (m.fCount === 0) zeroFCount += 1;
        pctSum += m.percentage;
      }
    }

    return {
      totalStudents: classStudents.length,
      avgAttendance: attCount > 0 ? Math.round(attSum / attCount) : null,
      zeroFCount,
      scoredCount,
      avgPct: scoredCount > 0 ? (pctSum / scoredCount).toFixed(1) : null,
    };
  }, [classStudents, meritDetails]);

  const renderFieldCell = (
    rawVal: string | number | boolean | undefined,
    fieldType: string,
    maxMarks?: number
  ) => {
    const str = rawVal === undefined || rawVal === null ? '' : String(rawVal).trim();
    if (!str) {
      return (
        <span className="inline-block px-2 py-0.5 rounded text-xs text-slate-400 bg-stone-100">
          —
        </span>
      );
    }

    const lower = str.toLowerCase();
    if (
      fieldType === 'YES_NO' ||
      lower === 'yes' ||
      lower === 'no' ||
      lower === 'able' ||
      lower === 'পারে' ||
      lower === 'পারে না'
    ) {
      const isYes = lower === 'yes' || lower === 'true' || lower === 'able' || lower === 'পারে';
      return (
        <span
          className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
            isYes
              ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
              : 'bg-rose-100 text-rose-800 border border-rose-200'
          }`}
        >
          {str}
        </span>
      );
    }

    const num = Number(str);
    if (fieldType === 'NUMBER' && Number.isFinite(num)) {
      const max = maxMarks && maxMarks > 0 ? maxMarks : 100;
      const ratio = num / max;
      const cls =
        ratio >= 0.75
          ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
          : ratio >= 0.4
          ? 'bg-amber-100 text-amber-800 border-amber-200'
          : 'bg-rose-100 text-rose-800 border-rose-200';
      return (
        <span
          className={`inline-block px-2 py-0.5 rounded border text-xs font-mono tabular-nums font-semibold ${cls}`}
        >
          {num}
          {maxMarks ? `/${maxMarks}` : ''}
        </span>
      );
    }

    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-slate-800 border border-emerald-200/70 max-w-[140px] truncate">
        {str}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-bold text-slate-900">
          {lang === 'bn'
            ? 'শ্রেণি বিশ্লেষণ ও বিষয়ভিত্তিক পারফরম্যান্স চার্ট'
            : 'Class Analytics & Subject Performance Matrix'}
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          {getClassLabel(selectedClass, lang)} · {selectedAcademicYear} ({classStudents.length}{' '}
          {lang === 'bn' ? 'জন শিক্ষার্থী' : 'students'})
        </p>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-stone-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">
            {t(lang, 'totalStudentsClass')}
          </div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900 tabular-nums">
            {overviewStats.totalStudents}
          </div>
        </div>
        <div className="bg-white border border-stone-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">
            {lang === 'bn' ? 'গড় উপস্থিতি' : 'Avg Attendance'}
          </div>
          <div className="mt-1.5 text-2xl font-bold text-emerald-700 tabular-nums">
            {overviewStats.avgAttendance !== null ? `${overviewStats.avgAttendance}%` : '—'}
          </div>
        </div>
        <div className="bg-white border border-stone-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">
            {lang === 'bn' ? 'সকল বিষয়ে উত্তীর্ণ (0 F)' : 'Zero-F Passers'}
          </div>
          <div className="mt-1.5 text-2xl font-bold text-emerald-700 tabular-nums">
            {overviewStats.scoredCount > 0
              ? `${overviewStats.zeroFCount} / ${overviewStats.scoredCount}`
              : '—'}
          </div>
        </div>
        <div className="bg-white border border-stone-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">
            {lang === 'bn' ? 'শ্রেণির গড় নম্বর %' : 'Class Avg Score %'}
          </div>
          <div className="mt-1.5 text-2xl font-bold text-amber-700 tabular-nums">
            {overviewStats.avgPct !== null ? `${overviewStats.avgPct}%` : '—'}
          </div>
        </div>
      </div>

      {/* Subject Performance Matrix Chart */}
      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-stone-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-emerald-50/40">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-emerald-700 text-white flex items-center justify-center shrink-0">
              <BarChart3 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                {lang === 'bn'
                  ? 'বিষয়ভিত্তিক শিক্ষার্থী পারফরম্যান্স ম্যাট্রিক্স'
                  : 'Subject Performance Matrix Chart'}
              </h3>
              <p className="text-xs text-slate-500">
                {lang === 'bn'
                  ? 'নির্বাচিত বিষয়ের অধীনে শ্রেণির সকল শিক্ষার্থীর মূল্যায়ন ফিল্ড ও পরীক্ষার নম্বর একসাথে দেখুন।'
                  : 'View all students of the selected class alongside every assessment field and exam score for the chosen subject.'}
              </p>
            </div>
          </div>

          <div className="min-w-[230px]">
            <label
              htmlFor="analytics-subject-select"
              className="block text-xs font-medium text-slate-600 mb-1"
            >
              {t(lang, 'selectSubject')}
            </label>
            <select
              id="analytics-subject-select"
              value={activeOption?.key || ''}
              onChange={(e) => setSelectedOptKey(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg font-medium focus:outline-none focus:ring-2 focus:ring-emerald-600"
            >
              {subjectOptions.length === 0 ? (
                <option value="">{t(lang, 'noSubjectsConfigured')}</option>
              ) : (
                subjectOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        {classStudents.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {t(lang, 'noStudentsFound')}
          </div>
        ) : !activeOption ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {t(lang, 'noSubjectsConfigured')}
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[640px]">
            <table className="w-full text-xs text-left border-collapse">
              <thead className="sticky top-0 z-20 bg-stone-50 border-b border-stone-200 text-slate-700 font-semibold">
                <tr>
                  <th className="py-3 px-3 w-16 sticky left-0 bg-stone-50 z-30 border-r border-stone-200">
                    {t(lang, 'rollNumber')}
                  </th>
                  <th className="py-3 px-4 min-w-[180px] sticky left-14 bg-stone-50 z-30 border-r border-stone-200">
                    {lang === 'bn' ? 'শিক্ষার্থীর নাম' : 'Student Name'}
                  </th>
                  {activeSubjectDoc?.fields.map((fld) => (
                    <th key={fld.fieldId} className="py-3 px-3 text-center min-w-[125px]">
                      <div>{fld.label}</div>
                      <div className="text-[10px] font-normal text-slate-400">
                        {fld.fieldType === 'NUMBER' && fld.maxMarks
                          ? `Max ${fld.maxMarks}`
                          : fld.fieldType}
                      </div>
                    </th>
                  ))}
                  {activeOption.examSubjectId && (
                    <>
                      <th className="py-3 px-3 text-center min-w-[100px] border-l border-stone-200">
                        {lang === 'bn' ? '১ম প্রান্তিক' : '1st Term'}
                      </th>
                      <th className="py-3 px-3 text-center min-w-[100px]">
                        {lang === 'bn' ? '২য় প্রান্তিক' : '2nd Term'}
                      </th>
                      <th className="py-3 px-3 text-center min-w-[100px]">
                        {lang === 'bn' ? '৩য় প্রান্তিক' : '3rd Term'}
                      </th>
                    </>
                  )}
                  <th className="py-3 px-3 text-right w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {classStudents.map((st) => {
                  const subjVals = st.subjectValues || {};
                  return (
                    <tr
                      key={st.id}
                      onClick={() => onOpenStudentProfile(st.id)}
                      className="hover:bg-emerald-50/40 cursor-pointer transition-colors"
                    >
                      <td className="py-2.5 px-3 font-mono tabular-nums font-bold text-slate-900 sticky left-0 bg-white border-r border-stone-200">
                        {st.rollNumber}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-slate-900 sticky left-14 bg-white border-r border-stone-200 truncate max-w-[200px]">
                        {st.studentNameBn || st.studentNameEn}
                      </td>
                      {activeSubjectDoc?.fields.map((fld) => {
                        const key = `${activeSubjectDoc.id}__${fld.fieldId}`;
                        return (
                          <td key={key} className="py-2 px-3 text-center">
                            {renderFieldCell(subjVals[key], fld.fieldType, fld.maxMarks)}
                          </td>
                        );
                      })}
                      {activeOption.examSubjectId &&
                        (['exam_1', 'exam_2', 'exam_3'] as const).map((tid, idx) => {
                          const sc = getTermSubjectScore(
                            st.examResults,
                            tid,
                            activeOption.examSubjectId!
                          );
                          const fm = activeOption.fullMarks || 100;
                          if (sc.isAbsent) {
                            return (
                              <td
                                key={tid}
                                className={`py-2 px-3 text-center ${
                                  idx === 0 ? 'border-l border-stone-200' : ''
                                }`}
                              >
                                <span className="inline-block px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-200">
                                  {t(lang, 'absentLabel')}
                                </span>
                              </td>
                            );
                          }
                          if (!sc.hasScore || sc.total === null) {
                            return (
                              <td
                                key={tid}
                                className={`py-2 px-3 text-center text-slate-400 ${
                                  idx === 0 ? 'border-l border-stone-200' : ''
                                }`}
                              >
                                —
                              </td>
                            );
                          }
                          const g = calculateSubjectGrade(sc.total, fm);
                          return (
                            <td
                              key={tid}
                              className={`py-2 px-3 text-center font-mono tabular-nums ${
                                idx === 0 ? 'border-l border-stone-200' : ''
                              }`}
                            >
                              <span
                                className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${
                                  !g.passed
                                    ? 'bg-rose-100 text-rose-800 border-rose-200'
                                    : sc.total / fm >= 0.8
                                    ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
                                    : 'bg-sky-50 text-sky-900 border-sky-200'
                                }`}
                              >
                                {sc.total} ({g.grade})
                              </span>
                            </td>
                          );
                        })}
                      <td className="py-2.5 px-3 text-right text-emerald-700">
                        <ExternalLink className="w-3.5 h-3.5 inline" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
