import React, { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { ArrowUpRight, Sparkles, Save, Send, X } from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { getFirebaseInstances } from '../lib/firebase';
import {
  buildPendingChangePayload,
  validateAndBuildStudentPayload,
} from '../lib/firestoreValidation';
import { getClassLabel, t } from '../lib/i18n';
import {
  compareRollNumbers,
  computeFinalExamMeritMap,
  computeStudentTermSummary,
  getClassSubjectsForMarksheet,
  normalizeExamConfigs,
} from '../lib/schoolUtils';
import { CLASS_LEVELS } from '../types/school';

function getNextClassLevel(current: string): string {
  const idx = CLASS_LEVELS.indexOf(current as (typeof CLASS_LEVELS)[number]);
  if (idx >= 0 && idx < CLASS_LEVELS.length - 1) {
    return CLASS_LEVELS[idx + 1];
  }
  return current;
}

export const PromotionManagerView: React.FC = () => {
  const {
    lang,
    session,
    school,
    students,
    customFields,
    selectedAcademicYear,
    selectedClass,
  } = useApp();

  const isAdmin = session?.role === 'ADMIN';
  const targetYear = selectedAcademicYear + 1;
  const [targetClass, setTargetClass] = useState<string>(() =>
    getNextClassLevel(selectedClass)
  );

  useEffect(() => {
    setTargetClass(getNextClassLevel(selectedClass));
  }, [selectedClass]);

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

  const examConfigs = useMemo(
    () => normalizeExamConfigs(school?.examConfigs),
    [school?.examConfigs]
  );

  const classSubjects = useMemo(
    () => getClassSubjectsForMarksheet(examConfigs, selectedClass),
    [examConfigs, selectedClass]
  );

  const meritMap = useMemo(
    () => computeFinalExamMeritMap(classStudents, classSubjects),
    [classStudents, classSubjects]
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<
    Record<string, { promotionStatus: string; nextYearRollNumber: string }>
  >({});
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  useEffect(() => {
    const nextDrafts: Record<
      string,
      { promotionStatus: string; nextYearRollNumber: string }
    > = {};
    const autoSelected = new Set<string>();
    for (const st of classStudents) {
      const summary = computeStudentTermSummary(st, classSubjects, 'exam_3');
      const merit = meritMap.get(st.id);
      const defaultStatus =
        st.promotionStatus ||
        (summary.scoredSubjects > 0 ? (summary.passed ? 'Promoted' : 'Retained') : '');
      const defaultNextRoll =
        st.nextYearRollNumber !== undefined && String(st.nextYearRollNumber) !== ''
          ? String(st.nextYearRollNumber)
          : merit
          ? String(merit)
          : '';
      nextDrafts[st.id] = {
        promotionStatus: defaultStatus,
        nextYearRollNumber: defaultNextRoll,
      };
      if (defaultStatus === 'Promoted') {
        autoSelected.add(st.id);
      }
    }
    setDrafts(nextDrafts);
    setSelectedIds(autoSelected);
  }, [classStudents, classSubjects, meritMap]);

  const handleAutoAssignByMerit = () => {
    const passers = classStudents
      .filter((st) => meritMap.has(st.id))
      .sort((a, b) => (meritMap.get(a.id) || 9999) - (meritMap.get(b.id) || 9999));

    const nextDrafts = { ...drafts };
    const nextSelected = new Set<string>();

    if (passers.length > 0) {
      passers.forEach((st, idx) => {
        nextDrafts[st.id] = {
          promotionStatus: 'Promoted',
          nextYearRollNumber: String(idx + 1),
        };
        nextSelected.add(st.id);
      });
      for (const st of classStudents) {
        if (!meritMap.has(st.id)) {
          nextDrafts[st.id] = {
            promotionStatus: 'Retained',
            nextYearRollNumber: String(st.rollNumber || ''),
          };
        }
      }
    } else {
      // Fallback: assign sequentially by current roll if Final Exam hasn't been scored yet
      classStudents.forEach((st, idx) => {
        nextDrafts[st.id] = {
          promotionStatus: 'Promoted',
          nextYearRollNumber: String(idx + 1),
        };
        nextSelected.add(st.id);
      });
    }

    setDrafts(nextDrafts);
    setSelectedIds(nextSelected);
  };

  const handleSaveCurrentYearStatus = async () => {
    if (!session || classStudents.length === 0) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setBanner(null);

    try {
      const updates = classStudents.map((st) => ({
        studentId: st.id,
        studentName: st.studentNameBn || st.studentNameEn,
        fieldsPatch: {
          promotionStatus: String(drafts[st.id]?.promotionStatus ?? '').trim(),
          nextYearRollNumber: String(drafts[st.id]?.nextYearRollNumber ?? '').trim(),
        },
      }));

      if (isAdmin) {
        const batch = writeBatch(instances.db);
        for (const u of updates) {
          batch.update(doc(instances.db, 'schools', session.schoolId, 'students', u.studentId), {
            ...u.fieldsPatch,
            lastUpdatedByName: session.name,
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
        setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
      } else {
        const pendingDoc = buildPendingChangePayload({
          schoolId: session.schoolId,
          entityType: 'STUDENT_BATCH_UPDATE',
          targetId: `promo_status_${selectedAcademicYear}_${selectedClass}`,
          submittedByDeviceId: session.deviceId,
          submittedByName: session.name,
          summary: `Promotion & Next Rolls (${selectedClass} ${selectedAcademicYear})`,
          detailsText: `${updates.length} student records updated`,
          payloadJson: JSON.stringify({
            kind: 'ROLL_PROMOTION',
            updates,
          }),
          status: 'PENDING',
        });
        await addDoc(
          collection(instances.db, 'schools', session.schoolId, 'pendingChanges'),
          pendingDoc
        );
        setBanner({ type: 'success', text: t(lang, 'submittedApprovalSuccess') });
      }
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePromoteSelectedToNextYear = async () => {
    if (!session || selectedIds.size === 0) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setBanner(null);

    try {
      const resetFieldIds = new Set(
        customFields.filter((f) => f.resetsYearly).map((f) => f.id)
      );

      const newRecords: Array<{ data: Record<string, unknown> }> = [];
      const selectedStudents = classStudents.filter((st) => selectedIds.has(st.id));

      for (const st of selectedStudents) {
        const d = drafts[st.id] || { promotionStatus: 'Promoted', nextYearRollNumber: '' };
        const nextCustomValues: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(st.customValues || {})) {
          if (!resetFieldIds.has(k)) {
            nextCustomValues[k] = v;
          }
        }

        const nextStudentObj = {
          studentNameBn: st.studentNameBn,
          studentNameEn: st.studentNameEn,
          fatherNameEn: st.fatherNameEn,
          motherNameEn: st.motherNameEn,
          dateOfBirth: st.dateOfBirth,
          guardianPhone: st.guardianPhone,
          address: st.address,
          photoBase64: st.photoBase64,
          rollNumber: d.nextYearRollNumber || st.rollNumber,
          nextYearRollNumber: '',
          classLevel: targetClass,
          section: st.section,
          academicYear: targetYear,
          totalSchoolDays: 0,
          daysPresent: 0,
          promotionStatus: '',
          customValues: nextCustomValues,
          subjectValues: {},
          examResults: {},
          sectorNotes: st.sectorNotes || '',
        };

        newRecords.push({
          data: nextStudentObj,
        });
      }

      if (isAdmin) {
        const batch = writeBatch(instances.db);
        for (const st of selectedStudents) {
          const d = drafts[st.id];
          batch.update(doc(instances.db, 'schools', session.schoolId, 'students', st.id), {
            promotionStatus: String(d?.promotionStatus ?? 'Promoted').trim(),
            nextYearRollNumber: String(d?.nextYearRollNumber ?? '').trim(),
            lastUpdatedByName: session.name,
            updatedAt: serverTimestamp(),
          });
        }
        for (const rec of newRecords) {
          const validated = validateAndBuildStudentPayload(
            rec.data,
            session.schoolId,
            session.name
          );
          const newRef = doc(collection(instances.db, 'schools', session.schoolId, 'students'));
          batch.set(newRef, validated);
        }
        await batch.commit();
        setBanner({
          type: 'success',
          text:
            lang === 'bn'
              ? `${selectedStudents.length} জন শিক্ষার্থী ${targetYear} শিক্ষাবর্ষে (${getClassLabel(targetClass, lang)}) উত্তীর্ণ হয়েছে।`
              : `Promoted ${selectedStudents.length} students into ${targetClass} (${targetYear}).`,
        });
      } else {
        const pendingDoc = buildPendingChangePayload({
          schoolId: session.schoolId,
          entityType: 'STUDENT_BATCH_UPDATE',
          targetId: `promote_${selectedAcademicYear}_to_${targetYear}`,
          submittedByDeviceId: session.deviceId,
          submittedByName: session.name,
          summary: `Promote ${selectedStudents.length} students from ${selectedClass} (${selectedAcademicYear}) → ${targetClass} (${targetYear})`,
          detailsText: `${selectedStudents.length} new academic year student records`,
          payloadJson: JSON.stringify({
            kind: 'ROSTER_IMPORT',
            students: newRecords,
          }),
          status: 'PENDING',
        });
        await addDoc(
          collection(instances.db, 'schools', session.schoolId, 'pendingChanges'),
          pendingDoc
        );
        setBanner({ type: 'success', text: t(lang, 'submittedApprovalSuccess') });
      }
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setSaving(false);
    }
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

      {/* Toolbar */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-col xl:flex-row xl:items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {lang === 'bn' ? 'পরবর্তী শিক্ষাবর্ষ ও শ্রেণি' : `Target Class (${targetYear})`}
            </label>
            <select
              value={targetClass}
              onChange={(e) => setTargetClass(e.target.value)}
              className="px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg"
            >
              {CLASS_LEVELS.map((cls) => (
                <option key={cls} value={cls}>
                  {getClassLabel(cls, lang)} ({targetYear})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            disabled={classStudents.length === 0}
            onClick={handleAutoAssignByMerit}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5 text-emerald-700" />
            <span>{t(lang, 'autoAssignRolls')}</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={saving || classStudents.length === 0}
            onClick={handleSaveCurrentYearStatus}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{t(lang, 'savePromotionRolls')}</span>
          </button>

          <button
            type="button"
            disabled={saving || selectedIds.size === 0}
            onClick={handlePromoteSelectedToNextYear}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
          >
            {isAdmin ? <ArrowUpRight className="w-4 h-4" /> : <Send className="w-4 h-4" />}
            <span>
              {t(lang, 'promoteToNextYear')} ({selectedIds.size})
            </span>
          </button>
        </div>
      </div>

      {/* Promotion Table */}
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
                  <th className="py-3 px-4 w-10">
                    <input
                      type="checkbox"
                      checked={
                        classStudents.length > 0 && selectedIds.size === classStudents.length
                      }
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedIds(new Set(classStudents.map((s) => s.id)));
                        } else {
                          setSelectedIds(new Set());
                        }
                      }}
                    />
                  </th>
                  <th className="py-3 px-3 w-20">{t(lang, 'rollNumber')}</th>
                  <th className="py-3 px-4">{lang === 'bn' ? 'শিক্ষার্থী' : 'Student'}</th>
                  <th className="py-3 px-3 text-right">{t(lang, 'term3')}</th>
                  <th className="py-3 px-3 text-right">{t(lang, 'meritPosition')}</th>
                  <th className="py-3 px-3 w-40">{t(lang, 'promotionStatus')}</th>
                  <th className="py-3 px-3 w-32">{t(lang, 'nextYearRollNumber')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {classStudents.map((st) => {
                  const t3 = computeStudentTermSummary(st, classSubjects, 'exam_3');
                  const merit = meritMap.get(st.id);
                  const d = drafts[st.id] || { promotionStatus: '', nextYearRollNumber: '' };
                  return (
                    <tr key={st.id} className="hover:bg-stone-50/60">
                      <td className="py-2.5 px-4">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(st.id)}
                          onChange={(e) => {
                            const next = new Set(selectedIds);
                            if (e.target.checked) next.add(st.id);
                            else next.delete(st.id);
                            setSelectedIds(next);
                          }}
                        />
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums font-semibold">
                        {st.rollNumber}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-slate-900">
                        {st.studentNameBn || st.studentNameEn}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                        {t3.scoredSubjects > 0 ? (
                          <span className={t3.passed ? 'text-emerald-700' : 'text-rose-600'}>
                            {t3.totalObtained} ({t3.grade})
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-emerald-800">
                        {merit ? `#${merit}` : '—'}
                      </td>
                      <td className="py-1.5 px-3">
                        <select
                          value={d.promotionStatus}
                          onChange={(e) =>
                            setDrafts((p) => ({
                              ...p,
                              [st.id]: { ...d, promotionStatus: e.target.value },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded-md"
                        >
                          <option value="">—</option>
                          <option value="Promoted">Promoted</option>
                          <option value="Retained">Retained</option>
                          <option value="Graduated">Graduated</option>
                          <option value="Transferred">Transferred</option>
                        </select>
                      </td>
                      <td className="py-1.5 px-3">
                        <input
                          type="text"
                          value={d.nextYearRollNumber}
                          onChange={(e) =>
                            setDrafts((p) => ({
                              ...p,
                              [st.id]: { ...d, nextYearRollNumber: e.target.value },
                            }))
                          }
                          className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums border border-stone-300 rounded-md"
                        />
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
