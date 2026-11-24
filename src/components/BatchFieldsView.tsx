import React, { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp } from 'firebase/firestore';
import { Save, Send, X } from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { getFirebaseInstances } from '../lib/firebase';
import {
  buildChunkedArrayPendingPayloads,
  buildPendingChangePayload,
  clampText,
  commitBatchesInChunks,
  FIRESTORE_LIMITS,
  formatFirestoreError,
  sanitizeStringRecordMap,
  withWriteTimeout,
} from '../lib/firestoreValidation';
import { t } from '../lib/i18n';
import { matchesClassScope } from '../lib/schoolUtils';
import { DEFAULT_PAGE_SIZE, PaginationBar } from './PaginationBar';

export const BatchFieldsView: React.FC = () => {
  const {
    lang,
    session,
    students,
    subjects,
    customFields,
    selectedAcademicYear,
    selectedClass,
    setSyncing,
  } = useApp();

  const isAdmin = session?.role === 'ADMIN';
  const [mode, setMode] = useState<'custom' | 'subject'>('custom');
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('');
  const [drafts, setDrafts] = useState<
    Record<string, Record<string, string | number | boolean>>
  >({});
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
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

  useEffect(() => {
    setPage(1);
  }, [selectedAcademicYear, selectedClass, mode, selectedSubjectId]);

  const pagedStudents = useMemo(() => {
    const start = (page - 1) * DEFAULT_PAGE_SIZE;
    return classStudents.slice(start, start + DEFAULT_PAGE_SIZE);
  }, [classStudents, page]);

  const classSubjectsWithFields = useMemo(
    () =>
      subjects.filter(
        (s) =>
          matchesClassScope(s.gradeScope, selectedClass) &&
          Array.isArray(s.fields) &&
          s.fields.length > 0
      ),
    [subjects, selectedClass]
  );

  useEffect(() => {
    if (classSubjectsWithFields.length > 0) {
      if (!classSubjectsWithFields.some((s) => s.id === selectedSubjectId)) {
        setSelectedSubjectId(classSubjectsWithFields[0].id);
      }
    } else {
      setSelectedSubjectId('');
    }
  }, [classSubjectsWithFields, selectedSubjectId]);

  const activeSubject = useMemo(
    () => classSubjectsWithFields.find((s) => s.id === selectedSubjectId) || null,
    [classSubjectsWithFields, selectedSubjectId]
  );

  useEffect(() => {
    const next: Record<string, Record<string, string | number | boolean>> = {};
    for (const st of classStudents) {
      next[st.id] =
        mode === 'custom'
          ? { ...(st.customValues || {}) }
          : { ...(st.subjectValues || {}) };
    }
    setDrafts(next);
    setDirtyIds(new Set());
  }, [classStudents, mode, selectedSubjectId]);

  const handleFieldChange = (
    studentId: string,
    key: string,
    value: string | number | boolean
  ) => {
    setDrafts((prev) => ({
      ...prev,
      [studentId]: {
        ...(prev[studentId] || {}),
        [key]: value,
      },
    }));
    setDirtyIds((prev) => {
      const next = new Set(prev);
      next.add(studentId);
      return next;
    });
  };

  const handleSaveAll = async () => {
    if (!session || dirtyIds.size === 0) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setSyncing(true);
    setBanner(null);

    try {
      const updates: Array<{
        studentId: string;
        studentName: string;
        values: Record<string, string>;
      }> = [];

      for (const st of classStudents) {
        if (!dirtyIds.has(st.id)) continue;
        const sanitized = sanitizeStringRecordMap(drafts[st.id] || {});
        const limit =
          mode === 'custom'
            ? FIRESTORE_LIMITS.CUSTOM_VALUES_MAX_KEYS
            : FIRESTORE_LIMITS.SUBJECT_VALUES_MAX_KEYS;

        if (Object.keys(sanitized).length > limit) {
          throw new Error(
            `${st.studentNameEn || st.studentNameBn}: exceeds maximum ${limit} entries.`
          );
        }

        updates.push({
          studentId: st.id,
          studentName: clampText(st.studentNameBn || st.studentNameEn, 80),
          values: sanitized,
        });
      }

      if (isAdmin) {
        const actorName = clampText(session.name, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS);
        await commitBatchesInChunks(instances.db, updates, (batch, u) => {
          const ref = doc(instances.db, 'schools', session.schoolId, 'students', u.studentId);
          batch.update(ref, {
            ...(mode === 'custom'
              ? { customValues: u.values }
              : { subjectValues: u.values }),
            lastUpdatedByName: actorName,
            updatedAt: serverTimestamp(),
          });
        });
        setDirtyIds(new Set());
        setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
      } else {
        const kind = mode === 'custom' ? 'CUSTOM_VALUES' : 'SUBJECT_VALUES';
        const formatted = updates.map((u) => ({
          studentId: u.studentId,
          studentName: u.studentName,
          ...(mode === 'custom'
            ? { customValues: u.values }
            : { subjectValues: u.values }),
        }));
        const chunks = buildChunkedArrayPendingPayloads(kind, 'updates', formatted);
        for (let idx = 0; idx < chunks.length; idx++) {
          const chunk = chunks[idx];
          const pendingDoc = buildPendingChangePayload({
            schoolId: session.schoolId,
            entityType: 'STUDENT_BATCH_UPDATE',
            targetId: `${selectedAcademicYear}_${selectedClass}_${mode}_${idx + 1}`,
            submittedByDeviceId: session.deviceId,
            submittedByName: session.name,
            summary: `Batch ${mode === 'custom' ? 'Custom Fields' : activeSubject?.name || 'Subject Fields'} (${selectedClass})${chunks.length > 1 ? ` [${idx + 1}/${chunks.length}]` : ''}`,
            detailsText: `${chunk.itemCount} student records updated`,
            payloadJson: chunk.payloadJson,
            status: 'PENDING',
          });
          await withWriteTimeout(
            addDoc(
              collection(instances.db, 'schools', session.schoolId, 'pendingChanges'),
              pendingDoc
            )
          );
        }
        setDirtyIds(new Set());
        setBanner({ type: 'success', text: t(lang, 'submittedApprovalSuccess') });
      }
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${formatFirestoreError(err)}`,
      });
    } finally {
      setSaving(false);
      setSyncing(false);
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
      <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-stone-100 rounded-lg">
            <button
              type="button"
              onClick={() => setMode('custom')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'custom'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t(lang, 'customFieldsTab')}
            </button>
            <button
              type="button"
              onClick={() => setMode('subject')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                mode === 'subject'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t(lang, 'subjectFieldsTab')}
            </button>
          </div>

          {mode === 'subject' && classSubjectsWithFields.length > 0 && (
            <select
              value={selectedSubjectId}
              onChange={(e) => setSelectedSubjectId(e.target.value)}
              className="px-3 py-1.5 text-sm bg-white border border-stone-300 rounded-lg"
            >
              {classSubjectsWithFields.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <button
          type="button"
          disabled={saving || dirtyIds.size === 0}
          onClick={handleSaveAll}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
        >
          {isAdmin ? <Save className="w-4 h-4" /> : <Send className="w-4 h-4" />}
          <span>
            {saving
              ? t(lang, 'loading')
              : isAdmin
              ? `${t(lang, 'saveAllFields')} (${dirtyIds.size})`
              : `${t(lang, 'submitForApproval')} (${dirtyIds.size})`}
          </span>
        </button>
      </div>

      {/* Spreadsheet Grid */}
      <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
        {classStudents.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {t(lang, 'noStudentsFound')}
          </div>
        ) : mode === 'custom' && customFields.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {lang === 'bn'
              ? 'কোনো কাস্টম ফিল্ড তৈরি করা হয়নি। অ্যাডমিন প্যানেল থেকে যুক্ত করুন।'
              : 'No custom fields configured yet. Add custom fields in Admin Panel.'}
          </div>
        ) : mode === 'subject' && !activeSubject ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {lang === 'bn'
              ? 'এই শ্রেণির জন্য বিষয়ভিত্তিক অতিরিক্ত ফিল্ড নেই।'
              : 'No subjects with custom assessment fields configured for this class.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left border-collapse">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4 w-20">{t(lang, 'rollNumber')}</th>
                    <th className="py-3 px-4 min-w-[180px]">
                      {lang === 'bn' ? 'শিক্ষার্থীর নাম' : 'Student Name'}
                    </th>
                    {mode === 'custom'
                      ? customFields.map((cf) => (
                          <th key={cf.id} className="py-3 px-3 min-w-[140px]">
                            <div>{cf.label}</div>
                            <div className="text-[11px] font-normal text-slate-400">
                              {cf.category}
                            </div>
                          </th>
                        ))
                      : activeSubject?.fields.map((fld) => (
                          <th key={fld.fieldId} className="py-3 px-3 min-w-[140px]">
                            <div>{fld.label}</div>
                            {fld.maxMarks ? (
                              <div className="text-[11px] font-normal text-slate-400">
                                Max {fld.maxMarks}
                              </div>
                            ) : null}
                          </th>
                        ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {pagedStudents.map((st) => {
                    const isDirty = dirtyIds.has(st.id);
                    const rowMap = drafts[st.id] || {};
                    return (
                      <tr
                        key={st.id}
                        className={isDirty ? 'bg-amber-50/50' : 'hover:bg-stone-50/60'}
                      >
                        <td className="py-2 px-4 font-mono tabular-nums font-semibold text-slate-900">
                          {st.rollNumber}
                        </td>
                        <td className="py-2 px-4 font-medium text-slate-900">
                          {st.studentNameBn || st.studentNameEn}
                        </td>
                        {mode === 'custom'
                          ? customFields.map((cf) => {
                              const val = rowMap[cf.id] ?? '';
                              return (
                                <td key={cf.id} className="py-1.5 px-3">
                                  {cf.fieldType === 'YES_NO' ? (
                                    <select
                                      value={String(val)}
                                      onChange={(e) =>
                                        handleFieldChange(st.id, cf.id, e.target.value)
                                      }
                                      className="w-full px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded-md"
                                    >
                                      <option value="">—</option>
                                      <option value="Yes">Yes</option>
                                      <option value="No">No</option>
                                    </select>
                                  ) : (
                                    <input
                                      type={cf.fieldType === 'NUMBER' ? 'number' : 'text'}
                                      value={String(val)}
                                      onChange={(e) =>
                                        handleFieldChange(
                                          st.id,
                                          cf.id,
                                          cf.fieldType === 'NUMBER' && e.target.value !== ''
                                            ? Number(e.target.value)
                                            : e.target.value
                                        )
                                      }
                                      className="w-full px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded-md"
                                    />
                                  )}
                                </td>
                              );
                            })
                          : activeSubject?.fields.map((fld) => {
                              const key = `${activeSubject.id}__${fld.fieldId}`;
                              const val = rowMap[key] ?? '';
                              return (
                                <td key={key} className="py-1.5 px-3">
                                  {fld.fieldType === 'YES_NO' ? (
                                    <select
                                      value={String(val)}
                                      onChange={(e) =>
                                        handleFieldChange(st.id, key, e.target.value)
                                      }
                                      className="w-full px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded-md"
                                    >
                                      <option value="">—</option>
                                      <option value="Yes">Yes</option>
                                      <option value="No">No</option>
                                    </select>
                                  ) : (
                                    <input
                                      type={fld.fieldType === 'NUMBER' ? 'number' : 'text'}
                                      value={String(val)}
                                      onChange={(e) =>
                                        handleFieldChange(
                                          st.id,
                                          key,
                                          fld.fieldType === 'NUMBER' && e.target.value !== ''
                                            ? Number(e.target.value)
                                            : e.target.value
                                        )
                                      }
                                      className="w-full px-2.5 py-1.5 text-sm bg-white border border-stone-300 rounded-md"
                                    />
                                  )}
                                </td>
                              );
                            })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <PaginationBar
              lang={lang}
              page={page}
              totalItems={classStudents.length}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </div>
  );
};

