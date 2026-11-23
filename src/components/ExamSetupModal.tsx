import React, { useEffect, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { getFirebaseInstances } from '../lib/firebase';
import { sanitizeExamConfigs } from '../lib/firestoreValidation';
import { t } from '../lib/i18n';
import { normalizeExamConfigs } from '../lib/schoolUtils';
import type { ExamConfig, ExamTermId } from '../types/school';

interface ExamSetupModalProps {
  initialTerm?: ExamTermId;
  defaultClassScope?: string;
  onClose: () => void;
  onSaved?: () => void;
}

export const ExamSetupModal: React.FC<ExamSetupModalProps> = ({
  initialTerm = 'exam_1',
  defaultClassScope = 'ALL',
  onClose,
  onSaved,
}) => {
  const { lang, session, school } = useApp();
  const [examDrafts, setExamDrafts] = useState<ExamConfig[]>(() =>
    normalizeExamConfigs(school?.examConfigs)
  );
  const [activeTerm, setActiveTerm] = useState<ExamTermId>(initialTerm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setExamDrafts(normalizeExamConfigs(school?.examConfigs));
  }, [school?.examConfigs]);

  const activeConfig = examDrafts.find((c) => c.examId === activeTerm) || examDrafts[0];
  const activeSubjects = Array.isArray(activeConfig?.subjects) ? activeConfig.subjects : [];

  const handleAddSubject = () => {
    setExamDrafts((prev) =>
      prev.map((term) => {
        if (term.examId !== activeTerm) return term;
        const currentSubjects = Array.isArray(term.subjects) ? term.subjects : [];
        const idx = currentSubjects.length + 1;
        return {
          ...term,
          subjects: [
            ...currentSubjects,
            {
              subjectId: `subj_${Date.now()}_${idx}`,
              subjectName: '',
              classScope: defaultClassScope || 'All Classes',
              fullMarks: 100,
              passMarks: 33,
              highestMarkOverride: 0,
            },
          ],
        };
      })
    );
  };

  const handleCopyTermSubjects = () => {
    const source = examDrafts.find((c) => c.examId === activeTerm);
    if (!source) return;
    setExamDrafts((prev) =>
      prev.map((term) => ({
        ...term,
        subjects: source.subjects.map((s) => ({ ...s })),
      }))
    );
  };

  const handleUpdateSubject = (
    idx: number,
    patch: Partial<ExamConfig['subjects'][number]>
  ) => {
    setExamDrafts((prev) =>
      prev.map((term) => {
        if (term.examId !== activeTerm) return term;
        return {
          ...term,
          subjects: term.subjects.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
        };
      })
    );
  };

  const handleRemoveSubject = (idx: number) => {
    setExamDrafts((prev) =>
      prev.map((term) => {
        if (term.examId !== activeTerm) return term;
        return {
          ...term,
          subjects: term.subjects.filter((_, i) => i !== idx),
        };
      })
    );
  };

  const handleSave = async () => {
    if (!session || session.role !== 'ADMIN') return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setError(null);
    try {
      const sanitized = sanitizeExamConfigs(examDrafts);
      await updateDoc(doc(instances.db, 'schools', session.schoolId), {
        examConfigs: sanitized,
        updatedAt: serverTimestamp(),
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-stone-200 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              {t(lang, 'subjectsExamsSetup')}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {lang === 'bn'
                ? 'প্রতিটি সাময়িকীর বিষয়, শ্রেণির পরিসর, পূর্ণমান ও সর্বোচ্চ নম্বর নির্ধারণ করুন।'
                : 'Configure subjects, class scope, full marks, pass marks, and highest mark overrides per term.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-stone-100 rounded-lg">
              {(['exam_1', 'exam_2', 'exam_3'] as const).map((tid) => (
                <button
                  key={tid}
                  type="button"
                  onClick={() => setActiveTerm(tid)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap ${
                    activeTerm === tid
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tid === 'exam_1'
                    ? t(lang, 'term1')
                    : tid === 'exam_2'
                    ? t(lang, 'term2')
                    : t(lang, 'term3')}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleCopyTermSubjects}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer whitespace-nowrap"
              >
                {lang === 'bn' ? 'সকল সাময়িকীতে কপি করুন' : 'Apply List to All 3 Terms'}
              </button>
              <button
                type="button"
                onClick={handleAddSubject}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{lang === 'bn' ? 'বিষয় যোগ করুন' : 'Add Subject'}</span>
              </button>
            </div>
          </div>

          <div className="overflow-x-auto border border-stone-200 rounded-lg">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="bg-stone-50 border-b border-stone-200 text-slate-600 font-semibold">
                  <th className="py-2.5 px-3">Subject ID</th>
                  <th className="py-2.5 px-3">Subject Name</th>
                  <th className="py-2.5 px-3">Class Scope</th>
                  <th className="py-2.5 px-3 w-24">Full Marks</th>
                  <th className="py-2.5 px-3 w-24">Pass Marks</th>
                  <th className="py-2.5 px-3 w-28">Highest Override</th>
                  <th className="py-2.5 px-3 w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {activeSubjects.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-slate-500">
                      {lang === 'bn'
                        ? 'কোনো বিষয় যুক্ত করা হয়নি। "বিষয় যোগ করুন" বাটনে ক্লিক করুন।'
                        : 'No subjects configured for this term yet. Click "Add Subject".'}
                    </td>
                  </tr>
                ) : (
                  activeSubjects.map((subj, idx) => (
                    <tr key={`${subj?.subjectId || 'subj'}_${idx}`}>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={subj?.subjectId ?? ''}
                          onChange={(e) =>
                            handleUpdateSubject(idx, { subjectId: e.target.value })
                          }
                          className="w-full px-2 py-1.5 border border-stone-300 rounded font-mono"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={subj?.subjectName ?? ''}
                          onChange={(e) =>
                            handleUpdateSubject(idx, { subjectName: e.target.value })
                          }
                          placeholder="e.g. Bangla"
                          className="w-full px-2 py-1.5 border border-stone-300 rounded"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          list="exam-class-scope-presets"
                          value={subj?.classScope ?? 'All Classes'}
                          onChange={(e) =>
                            handleUpdateSubject(idx, { classScope: e.target.value })
                          }
                          placeholder="All Classes or Class 1"
                          className="w-full px-2 py-1.5 border border-stone-300 rounded"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="number"
                          min={1}
                          value={subj.fullMarks}
                          onChange={(e) => {
                            const fm = Number(e.target.value) || 100;
                            const autoPass = fm === 100 ? 33 : fm === 50 ? 17 : Math.ceil(fm * 0.33);
                            handleUpdateSubject(idx, { fullMarks: fm, passMarks: autoPass });
                          }}
                          className="w-full px-2 py-1.5 border border-stone-300 rounded font-mono tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="number"
                          min={0}
                          value={subj.passMarks}
                          onChange={(e) =>
                            handleUpdateSubject(idx, { passMarks: Number(e.target.value) })
                          }
                          className="w-full px-2 py-1.5 border border-stone-300 rounded font-mono tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="number"
                          min={0}
                          value={subj.highestMarkOverride ?? ''}
                          onChange={(e) =>
                            handleUpdateSubject(idx, {
                              highestMarkOverride:
                                e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                          placeholder="Auto"
                          className="w-full px-2 py-1.5 border border-stone-300 rounded font-mono tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveSubject(idx)}
                          className="p-1.5 text-rose-600 hover:bg-rose-50 rounded cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <datalist id="exam-class-scope-presets">
            <option value="All Classes" />
            <option value="Pre-Primary - Class 2" />
            <option value="Class 3 - Class 5" />
            <option value="Pre-Primary" />
            <option value="Class 1" />
            <option value="Class 2" />
            <option value="Class 3" />
            <option value="Class 4" />
            <option value="Class 5" />
          </datalist>
        </div>

        <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-end gap-3 bg-stone-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer"
          >
            {t(lang, 'cancel')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 rounded-lg cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{saving ? t(lang, 'loading') : t(lang, 'saveChanges')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
