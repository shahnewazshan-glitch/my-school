import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, writeBatch } from 'firebase/firestore';
import {
  CalendarPlus,
  CheckCheck,
  Download,
  ExternalLink,
  Save,
  Send,
  X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { useApp } from '../contexts/AppContext';
import { getFirebaseInstances } from '../lib/firebase';
import {
  buildPendingChangePayload,
  FIRESTORE_LIMITS,
  sanitizeStringRecordMap,
} from '../lib/firestoreValidation';
import { getClassLabel, t } from '../lib/i18n';
import {
  calculateSubjectGrade,
  computeFinalExamMeritMap,
  computeStudentTermSummary,
  getClassSubjectsForMarksheet,
  getTermSubjectScore,
  matchesClassScope,
  normalizeExamConfigs,
  TERM_ORDER,
} from '../lib/schoolUtils';
import { CLASS_LEVELS, type ExamTermId } from '../types/school';

type BatchMode = 'marks' | 'attendance' | 'roll' | 'subjectFields' | 'results';

interface BatchMarksViewProps {
  onOpenStudentProfile?: (studentId: string) => void;
}

export const BatchMarksView: React.FC<BatchMarksViewProps> = ({ onOpenStudentProfile }) => {
  const {
    lang,
    session,
    school,
    students,
    subjects,
    selectedAcademicYear,
    selectedClass,
  } = useApp();

  const isAdmin = session?.role === 'ADMIN';
  const [batchMode, setBatchMode] = useState<BatchMode>('marks');
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const examConfigs = useMemo(
    () => normalizeExamConfigs(school?.examConfigs),
    [school?.examConfigs]
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

  // =========================================================================
  // MODE 1: EXAM MARKS
  // =========================================================================
  const [selectedTerm, setSelectedTerm] = useState<ExamTermId>('exam_1');

  const classSubjects = useMemo(() => {
    const activeTermConfig = examConfigs.find((c) => c.examId === selectedTerm);
    const termSubjects = (activeTermConfig?.subjects || []).filter((s) =>
      matchesClassScope(s.classScope, selectedClass)
    );
    if (termSubjects.length > 0) return termSubjects;
    return getClassSubjectsForMarksheet(examConfigs, selectedClass);
  }, [examConfigs, selectedTerm, selectedClass]);

  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('');
  useEffect(() => {
    if (classSubjects.length > 0) {
      if (!classSubjects.some((s) => s.subjectId === selectedSubjectId)) {
        setSelectedSubjectId(classSubjects[0].subjectId);
      }
    } else {
      setSelectedSubjectId('');
    }
  }, [classSubjects, selectedSubjectId]);

  const activeSubject = useMemo(
    () => classSubjects.find((s) => s.subjectId === selectedSubjectId) || null,
    [classSubjects, selectedSubjectId]
  );

  const [marksDrafts, setMarksDrafts] = useState<Record<string, { cont: string; sum: string }>>(
    {}
  );
  const [dirtyMarkIds, setDirtyMarkIds] = useState<Set<string>>(new Set());
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    if (!selectedSubjectId) {
      setMarksDrafts({});
      setDirtyMarkIds(new Set());
      return;
    }
    const nextDrafts: Record<string, { cont: string; sum: string }> = {};
    for (const st of classStudents) {
      const score = getTermSubjectScore(st.examResults, selectedTerm, selectedSubjectId);
      nextDrafts[st.id] = {
        cont: score.cont !== null ? String(score.cont) : '',
        sum: score.sum !== null ? String(score.sum) : '',
      };
    }
    setMarksDrafts(nextDrafts);
    setDirtyMarkIds(new Set());
  }, [classStudents, selectedTerm, selectedSubjectId]);

  const handleMarkCellChange = (studentId: string, field: 'cont' | 'sum', value: string) => {
    if (value !== '' && !/^\d*\.?\d*$/.test(value)) return;
    setMarksDrafts((prev) => ({
      ...prev,
      [studentId]: {
        cont: field === 'cont' ? value : prev[studentId]?.cont ?? '',
        sum: field === 'sum' ? value : prev[studentId]?.sum ?? '',
      },
    }));
    setDirtyMarkIds((prev) => {
      const next = new Set(prev);
      next.add(studentId);
      return next;
    });
  };

  const handleMarkKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIdx: number,
    col: 'cont' | 'sum'
  ) => {
    const moveFocus = (nextRow: number, nextCol: 'cont' | 'sum') => {
      if (nextRow < 0 || nextRow >= classStudents.length) return;
      const targetStudent = classStudents[nextRow];
      const el = inputRefs.current[`${targetStudent.id}_${nextCol}`];
      if (el) {
        el.focus();
        el.select();
      }
    };

    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(rowIdx + 1, col);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(rowIdx - 1, col);
    } else if (e.key === 'ArrowRight' && col === 'cont') {
      e.preventDefault();
      moveFocus(rowIdx, 'sum');
    } else if (e.key === 'ArrowLeft' && col === 'sum') {
      e.preventDefault();
      moveFocus(rowIdx, 'cont');
    }
  };

  const computeMarkRowStats = (
    studentId: string,
    examResults?: Record<string, number | string>
  ) => {
    const d = marksDrafts[studentId] || { cont: '', sum: '' };
    const contNum = d.cont !== '' ? Number(d.cont) : null;
    const sumNum = d.sum !== '' ? Number(d.sum) : null;
    const hasCurrent = contNum !== null || sumNum !== null;
    const currentTotal = hasCurrent ? (contNum ?? 0) + (sumNum ?? 0) : null;

    let termSum = 0;
    let termCount = 0;
    for (const termId of TERM_ORDER) {
      if (termId === selectedTerm) {
        if (currentTotal !== null) {
          termSum += currentTotal;
          termCount += 1;
        }
      } else if (selectedSubjectId) {
        const s = getTermSubjectScore(examResults, termId, selectedSubjectId);
        if (s.hasScore && s.total !== null) {
          termSum += s.total;
          termCount += 1;
        }
      }
    }
    const avg3Term = termCount > 0 ? Number((termSum / termCount).toFixed(1)) : null;
    const fullMarks = activeSubject?.fullMarks || 100;
    const grade =
      currentTotal !== null ? calculateSubjectGrade(currentTotal, fullMarks) : null;

    return { currentTotal, avg3Term, grade, fullMarks };
  };

  const handleSaveAllMarks = async () => {
    if (!session || !selectedSubjectId || dirtyMarkIds.size === 0) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setBanner(null);

    try {
      const updates: Array<{
        studentId: string;
        studentName: string;
        examResults: Record<string, number | string>;
        patchKeys: Record<string, number | string | null>;
      }> = [];

      for (const st of classStudents) {
        if (!dirtyMarkIds.has(st.id)) continue;
        const d = marksDrafts[st.id] || { cont: '', sum: '' };
        const contKey = `${selectedTerm}__${selectedSubjectId}__cont`;
        const sumKey = `${selectedTerm}__${selectedSubjectId}__sum`;
        const totalKey = `${selectedTerm}__${selectedSubjectId}`;

        const nextResults: Record<string, number | string> = { ...(st.examResults || {}) };
        const contVal = d.cont !== '' ? Number(d.cont) : null;
        const sumVal = d.sum !== '' ? Number(d.sum) : null;

        if (contVal !== null) nextResults[contKey] = contVal;
        else delete nextResults[contKey];

        if (sumVal !== null) nextResults[sumKey] = sumVal;
        else delete nextResults[sumKey];

        if (contVal !== null || sumVal !== null) {
          nextResults[totalKey] = (contVal ?? 0) + (sumVal ?? 0);
        } else {
          delete nextResults[totalKey];
        }

        const sanitized = sanitizeStringRecordMap(nextResults);
        if (Object.keys(sanitized).length > FIRESTORE_LIMITS.EXAM_RESULTS_MAX_KEYS) {
          throw new Error(
            `${st.studentNameEn || st.studentNameBn}: examResults exceeds ${FIRESTORE_LIMITS.EXAM_RESULTS_MAX_KEYS} keys.`
          );
        }

        const totalVal = contVal !== null || sumVal !== null ? (contVal ?? 0) + (sumVal ?? 0) : null;
        updates.push({
          studentId: st.id,
          studentName: st.studentNameBn || st.studentNameEn,
          examResults: sanitized,
          patchKeys: {
            [contKey]: contVal !== null ? String(contVal).trim() : null,
            [sumKey]: sumVal !== null ? String(sumVal).trim() : null,
            [totalKey]: totalVal !== null ? String(totalVal).trim() : null,
          },
        });
      }

      if (isAdmin) {
        const batch = writeBatch(instances.db);
        for (const u of updates) {
          batch.update(doc(instances.db, 'schools', session.schoolId, 'students', u.studentId), {
            examResults: u.examResults,
            lastUpdatedByName: session.name,
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
        setDirtyMarkIds(new Set());
        setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
      } else {
        const pendingDoc = buildPendingChangePayload({
          schoolId: session.schoolId,
          entityType: 'STUDENT_BATCH_UPDATE',
          targetId: `${selectedAcademicYear}_${selectedClass}_${selectedTerm}_${selectedSubjectId}`,
          submittedByDeviceId: session.deviceId,
          submittedByName: session.name,
          summary: `Batch Marks: ${activeSubject?.subjectName || selectedSubjectId} (${selectedTerm}, ${selectedClass})`,
          detailsText: `${updates.length} student mark rows updated`,
          payloadJson: JSON.stringify({
            kind: 'EXAM_MARKS',
            examId: selectedTerm,
            subjectId: selectedSubjectId,
            updates: updates.map((u) => ({
              studentId: u.studentId,
              studentName: u.studentName,
              examResultsPatch: u.patchKeys,
            })),
          }),
          status: 'PENDING',
        });
        await addDoc(
          collection(instances.db, 'schools', session.schoolId, 'pendingChanges'),
          pendingDoc
        );
        setDirtyMarkIds(new Set());
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

  // =========================================================================
  // MODE 2: ATTENDANCE TOTALS (daysPresent / totalSchoolDays + "+1 Working Day" / "All Present Today")
  // =========================================================================
  const [attDrafts, setAttDrafts] = useState<
    Record<string, { totalSchoolDays: string; daysPresent: string }>
  >({});
  const [dirtyAttIds, setDirtyAttIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const next: Record<string, { totalSchoolDays: string; daysPresent: string }> = {};
    for (const st of classStudents) {
      next[st.id] = {
        totalSchoolDays: String(st.totalSchoolDays ?? 0),
        daysPresent: String(st.daysPresent ?? 0),
      };
    }
    setAttDrafts(next);
    setDirtyAttIds(new Set());
  }, [classStudents]);

  const handleAttChange = (
    studentId: string,
    field: 'totalSchoolDays' | 'daysPresent',
    val: string
  ) => {
    if (val !== '' && !/^\d+$/.test(val)) return;
    setAttDrafts((prev) => ({
      ...prev,
      [studentId]: {
        totalSchoolDays:
          field === 'totalSchoolDays' ? val : prev[studentId]?.totalSchoolDays ?? '0',
        daysPresent: field === 'daysPresent' ? val : prev[studentId]?.daysPresent ?? '0',
      },
    }));
    setDirtyAttIds((prev) => new Set(prev).add(studentId));
  };

  const handleIncrementWorkingDay = (markPresentToo: boolean) => {
    const next: Record<string, { totalSchoolDays: string; daysPresent: string }> = {};
    const allIds = new Set<string>();
    for (const st of classStudents) {
      const cur = attDrafts[st.id] || { totalSchoolDays: '0', daysPresent: '0' };
      const tot = (Number(cur.totalSchoolDays) || 0) + 1;
      const pres = (Number(cur.daysPresent) || 0) + (markPresentToo ? 1 : 0);
      next[st.id] = {
        totalSchoolDays: String(tot),
        daysPresent: String(pres),
      };
      allIds.add(st.id);
    }
    setAttDrafts(next);
    setDirtyAttIds(allIds);
  };

  const handleSaveAttendanceTotals = async () => {
    if (!session || dirtyAttIds.size === 0) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setBanner(null);

    try {
      const updates = classStudents
        .filter((st) => dirtyAttIds.has(st.id))
        .map((st) => ({
          studentId: st.id,
          studentName: st.studentNameBn || st.studentNameEn,
          totalSchoolDays: Math.max(0, Number(attDrafts[st.id]?.totalSchoolDays) || 0),
          daysPresent: Math.max(0, Number(attDrafts[st.id]?.daysPresent) || 0),
        }));

      if (isAdmin) {
        const batch = writeBatch(instances.db);
        for (const u of updates) {
          batch.update(doc(instances.db, 'schools', session.schoolId, 'students', u.studentId), {
            totalSchoolDays: u.totalSchoolDays,
            daysPresent: u.daysPresent,
            lastUpdatedByName: session.name,
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
        setDirtyAttIds(new Set());
        setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
      } else {
        const pendingDoc = buildPendingChangePayload({
          schoolId: session.schoolId,
          entityType: 'STUDENT_BATCH_UPDATE',
          targetId: `att_totals_${selectedAcademicYear}_${selectedClass}`,
          submittedByDeviceId: session.deviceId,
          submittedByName: session.name,
          summary: `Batch Attendance Totals (${selectedClass})`,
          detailsText: `${updates.length} students updated`,
          payloadJson: JSON.stringify({
            kind: 'ATTENDANCE_TOTALS',
            updates: updates.map((u) => ({
              studentId: u.studentId,
              studentName: u.studentName,
              fieldsPatch: {
                totalSchoolDays: u.totalSchoolDays,
                daysPresent: u.daysPresent,
              },
            })),
          }),
          status: 'PENDING',
        });
        await addDoc(
          collection(instances.db, 'schools', session.schoolId, 'pendingChanges'),
          pendingDoc
        );
        setDirtyAttIds(new Set());
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

  // =========================================================================
  // MODE 3: ROLL, CLASS & PROMOTION STATUS
  // =========================================================================
  const [rollDrafts, setRollDrafts] = useState<
    Record<
      string,
      {
        rollNumber: string;
        nextYearRollNumber: string;
        classLevel: string;
        section: string;
        promotionStatus: string;
      }
    >
  >({});
  const [dirtyRollIds, setDirtyRollIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const next: Record<
      string,
      {
        rollNumber: string;
        nextYearRollNumber: string;
        classLevel: string;
        section: string;
        promotionStatus: string;
      }
    > = {};
    for (const st of classStudents) {
      next[st.id] = {
        rollNumber: String(st.rollNumber ?? ''),
        nextYearRollNumber: String(st.nextYearRollNumber ?? ''),
        classLevel: st.classLevel || selectedClass,
        section: st.section || '',
        promotionStatus: st.promotionStatus || '',
      };
    }
    setRollDrafts(next);
    setDirtyRollIds(new Set());
  }, [classStudents, selectedClass]);

  const handleRollFieldChange = (
    studentId: string,
    field: 'rollNumber' | 'nextYearRollNumber' | 'classLevel' | 'section' | 'promotionStatus',
    value: string
  ) => {
    setRollDrafts((prev) => ({
      ...prev,
      [studentId]: {
        ...(prev[studentId] || {
          rollNumber: '',
          nextYearRollNumber: '',
          classLevel: selectedClass,
          section: '',
          promotionStatus: '',
        }),
        [field]: value,
      },
    }));
    setDirtyRollIds((prev) => new Set(prev).add(studentId));
  };

  const handleSaveRollChanges = async () => {
    if (!session || dirtyRollIds.size === 0) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setBanner(null);

    try {
      const updates = classStudents
        .filter((st) => dirtyRollIds.has(st.id))
        .map((st) => ({
          studentId: st.id,
          studentName: st.studentNameBn || st.studentNameEn,
          fieldsPatch: {
            rollNumber: rollDrafts[st.id]?.rollNumber.trim() ?? '',
            nextYearRollNumber: rollDrafts[st.id]?.nextYearRollNumber.trim() ?? '',
            classLevel: rollDrafts[st.id]?.classLevel ?? selectedClass,
            section: rollDrafts[st.id]?.section.trim() ?? '',
            promotionStatus: rollDrafts[st.id]?.promotionStatus.trim() ?? '',
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
        setDirtyRollIds(new Set());
        setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
      } else {
        const pendingDoc = buildPendingChangePayload({
          schoolId: session.schoolId,
          entityType: 'STUDENT_BATCH_UPDATE',
          targetId: `roll_promo_${selectedAcademicYear}_${selectedClass}`,
          submittedByDeviceId: session.deviceId,
          submittedByName: session.name,
          summary: `Batch Roll & Promotion (${selectedClass})`,
          detailsText: `${updates.length} students updated`,
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
        setDirtyRollIds(new Set());
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

  // =========================================================================
  // MODE 4: SUBJECT ASSESSMENT FIELDS
  // =========================================================================
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

  const [subjFieldId, setSubjFieldId] = useState<string>('');
  useEffect(() => {
    if (classSubjectsWithFields.length > 0) {
      if (!classSubjectsWithFields.some((s) => s.id === subjFieldId)) {
        setSubjFieldId(classSubjectsWithFields[0].id);
      }
    } else {
      setSubjFieldId('');
    }
  }, [classSubjectsWithFields, subjFieldId]);

  const activeSubjectDoc = useMemo(
    () => classSubjectsWithFields.find((s) => s.id === subjFieldId) || null,
    [classSubjectsWithFields, subjFieldId]
  );

  const [subjValDrafts, setSubjValDrafts] = useState<
    Record<string, Record<string, string | number | boolean>>
  >({});
  const [dirtySubjValIds, setDirtySubjValIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const next: Record<string, Record<string, string | number | boolean>> = {};
    for (const st of classStudents) {
      next[st.id] = { ...(st.subjectValues || {}) };
    }
    setSubjValDrafts(next);
    setDirtySubjValIds(new Set());
  }, [classStudents, subjFieldId]);

  const handleSaveSubjectFields = async () => {
    if (!session || dirtySubjValIds.size === 0) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSaving(true);
    setBanner(null);

    try {
      const updates = classStudents
        .filter((st) => dirtySubjValIds.has(st.id))
        .map((st) => {
          const sanitized = sanitizeStringRecordMap(subjValDrafts[st.id] || {});
          if (Object.keys(sanitized).length > FIRESTORE_LIMITS.SUBJECT_VALUES_MAX_KEYS) {
            throw new Error(
              `${st.studentNameEn || st.studentNameBn}: exceeds maximum ${FIRESTORE_LIMITS.SUBJECT_VALUES_MAX_KEYS} entries.`
            );
          }
          return {
            studentId: st.id,
            studentName: st.studentNameBn || st.studentNameEn,
            subjectValues: sanitized,
          };
        });

      if (isAdmin) {
        const batch = writeBatch(instances.db);
        for (const u of updates) {
          batch.update(doc(instances.db, 'schools', session.schoolId, 'students', u.studentId), {
            subjectValues: u.subjectValues,
            lastUpdatedByName: session.name,
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
        setDirtySubjValIds(new Set());
        setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
      } else {
        const pendingDoc = buildPendingChangePayload({
          schoolId: session.schoolId,
          entityType: 'STUDENT_BATCH_UPDATE',
          targetId: `subj_fields_${selectedAcademicYear}_${selectedClass}`,
          submittedByDeviceId: session.deviceId,
          submittedByName: session.name,
          summary: `Batch Subject Fields (${activeSubjectDoc?.name || selectedClass})`,
          detailsText: `${updates.length} students updated`,
          payloadJson: JSON.stringify({
            kind: 'SUBJECT_VALUES',
            updates,
          }),
          status: 'PENDING',
        });
        await addDoc(
          collection(instances.db, 'schools', session.schoolId, 'pendingChanges'),
          pendingDoc
        );
        setDirtySubjValIds(new Set());
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

  // =========================================================================
  // MODE 5: CLASS RESULTS & MERIT LIST
  // =========================================================================
  const allClassSubjects = useMemo(
    () => getClassSubjectsForMarksheet(examConfigs, selectedClass),
    [examConfigs, selectedClass]
  );

  const meritMap = useMemo(
    () => computeFinalExamMeritMap(classStudents, allClassSubjects),
    [classStudents, allClassSubjects]
  );

  const meritSortedRows = useMemo(() => {
    return classStudents
      .map((st) => {
        const t1 = computeStudentTermSummary(st, allClassSubjects, 'exam_1');
        const t2 = computeStudentTermSummary(st, allClassSubjects, 'exam_2');
        const t3 = computeStudentTermSummary(st, allClassSubjects, 'exam_3');
        const merit = meritMap.get(st.id) || null;
        return { st, t1, t2, t3, merit };
      })
      .sort((a, b) => {
        if (a.merit && b.merit) return a.merit - b.merit;
        if (a.merit) return -1;
        if (b.merit) return 1;
        return (Number(a.st.rollNumber) || 9999) - (Number(b.st.rollNumber) || 9999);
      });
  }, [classStudents, allClassSubjects, meritMap]);

  const exportMeritExcel = () => {
    const rows = meritSortedRows.map((r) => ({
      MeritRank: r.merit ?? '',
      Roll: r.st.rollNumber,
      NameBn: r.st.studentNameBn || '',
      NameEn: r.st.studentNameEn || '',
      Term1Total: r.t1.scoredSubjects > 0 ? r.t1.totalObtained : '',
      Term2Total: r.t2.scoredSubjects > 0 ? r.t2.totalObtained : '',
      FinalTotal: r.t3.scoredSubjects > 0 ? r.t3.totalObtained : '',
      FinalFullMarks: r.t3.scoredSubjects > 0 ? r.t3.totalFullMarks : '',
      FinalGPA: r.t3.scoredSubjects > 0 ? r.t3.gpa.toFixed(2) : '',
      FinalGrade: r.t3.grade,
      Status: r.t3.scoredSubjects === 0 ? 'Not Scored' : r.t3.passed ? 'Passed' : 'Failed',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Merit List');
    XLSX.writeFile(
      wb,
      `Merit_List_${selectedClass.replace(/\s+/g, '_')}_${selectedAcademicYear}.xlsx`
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

      {/* 5-Mode Class Batch Switcher */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-stone-200/70 rounded-lg w-fit">
        {(
          [
            { id: 'marks', label: t(lang, 'modeExamMarks') },
            { id: 'attendance', label: t(lang, 'modeAttendanceTotals') },
            { id: 'roll', label: t(lang, 'modeRollPromotion') },
            { id: 'subjectFields', label: t(lang, 'modeSubjectFields') },
            { id: 'results', label: t(lang, 'modeClassResults') },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setBatchMode(m.id)}
            className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              batchMode === m.id
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* MODE 1: EXAM MARKS */}
      {batchMode === 'marks' && (
        <>
          <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  {t(lang, 'selectTerm')}
                </label>
                <div className="flex items-center gap-1 p-1 bg-stone-100 rounded-lg">
                  {TERM_ORDER.map((termId) => {
                    const label =
                      termId === 'exam_1'
                        ? t(lang, 'term1')
                        : termId === 'exam_2'
                        ? t(lang, 'term2')
                        : t(lang, 'term3');
                    return (
                      <button
                        key={termId}
                        type="button"
                        onClick={() => setSelectedTerm(termId)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                          selectedTerm === termId
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="min-w-[200px]">
                <label
                  htmlFor="batch-subject-select"
                  className="block text-xs font-medium text-slate-600 mb-1"
                >
                  {t(lang, 'selectSubject')}
                </label>
                <select
                  id="batch-subject-select"
                  value={selectedSubjectId}
                  onChange={(e) => setSelectedSubjectId(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                >
                  {classSubjects.length === 0 ? (
                    <option value="">{t(lang, 'noSubjectsConfigured')}</option>
                  ) : (
                    classSubjects.map((s) => (
                      <option key={s.subjectId} value={s.subjectId}>
                        {s.subjectName} ({t(lang, 'fullMarks')}: {s.fullMarks})
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>

            <button
              type="button"
              disabled={saving || dirtyMarkIds.size === 0 || !selectedSubjectId}
              onClick={handleSaveAllMarks}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {isAdmin ? <Save className="w-4 h-4" /> : <Send className="w-4 h-4" />}
              <span>
                {saving
                  ? t(lang, 'loading')
                  : isAdmin
                  ? `${t(lang, 'saveAllMarks')} (${dirtyMarkIds.size})`
                  : `${t(lang, 'submitMarksForApproval')} (${dirtyMarkIds.size})`}
              </span>
            </button>
          </div>

          <p className="text-xs text-slate-500 px-1">{t(lang, 'keyboardTip')}</p>

          <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            {classSubjects.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {t(lang, 'noSubjectsConfigured')}
              </div>
            ) : classStudents.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {t(lang, 'noStudentsFound')}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left border-collapse">
                  <thead>
                    <tr className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 w-20">{t(lang, 'rollNumber')}</th>
                      <th className="py-3 px-4">
                        {lang === 'bn' ? 'শিক্ষার্থীর নাম' : 'Student Name'}
                      </th>
                      <th className="py-3 px-3 text-center w-32">{t(lang, 'contShort')}</th>
                      <th className="py-3 px-3 text-center w-32">{t(lang, 'sumShort')}</th>
                      <th className="py-3 px-4 text-right w-28">
                        {t(lang, 'totalShort')} ({activeSubject?.fullMarks || 100})
                      </th>
                      <th className="py-3 px-4 text-right w-28">{t(lang, 'avg3Term')}</th>
                      <th className="py-3 px-4 text-center w-24">{t(lang, 'gradeInternal')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {classStudents.map((st, rowIdx) => {
                      const isDirty = dirtyMarkIds.has(st.id);
                      const d = marksDrafts[st.id] || { cont: '', sum: '' };
                      const stats = computeMarkRowStats(st.id, st.examResults);
                      const exceedsMax =
                        stats.currentTotal !== null && stats.currentTotal > stats.fullMarks;

                      return (
                        <tr
                          key={st.id}
                          className={isDirty ? 'bg-amber-50/50' : 'hover:bg-stone-50/60'}
                        >
                          <td className="py-2 px-4 font-mono tabular-nums font-semibold text-slate-900">
                            {st.rollNumber}
                          </td>
                          <td className="py-2 px-4">
                            <div className="font-medium text-slate-900">
                              {st.studentNameBn || st.studentNameEn}
                            </div>
                            {st.studentNameBn && st.studentNameEn && (
                              <div className="text-xs text-slate-500">{st.studentNameEn}</div>
                            )}
                          </td>
                          <td className="py-1.5 px-3">
                            <input
                              ref={(el) => {
                                inputRefs.current[`${st.id}_cont`] = el;
                              }}
                              type="text"
                              inputMode="decimal"
                              value={d.cont}
                              onChange={(e) => handleMarkCellChange(st.id, 'cont', e.target.value)}
                              onKeyDown={(e) => handleMarkKeyDown(e, rowIdx, 'cont')}
                              placeholder="0"
                              className="w-full px-2.5 py-1.5 text-center font-mono tabular-nums text-sm bg-white border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600"
                            />
                          </td>
                          <td className="py-1.5 px-3">
                            <input
                              ref={(el) => {
                                inputRefs.current[`${st.id}_sum`] = el;
                              }}
                              type="text"
                              inputMode="decimal"
                              value={d.sum}
                              onChange={(e) => handleMarkCellChange(st.id, 'sum', e.target.value)}
                              onKeyDown={(e) => handleMarkKeyDown(e, rowIdx, 'sum')}
                              placeholder="0"
                              className="w-full px-2.5 py-1.5 text-center font-mono tabular-nums text-sm bg-white border border-stone-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600"
                            />
                          </td>
                          <td
                            className={`py-2 px-4 text-right font-mono tabular-nums font-semibold ${
                              exceedsMax ? 'text-rose-600' : 'text-slate-900'
                            }`}
                          >
                            {stats.currentTotal !== null ? stats.currentTotal : '—'}
                          </td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums text-slate-700">
                            {stats.avg3Term !== null ? stats.avg3Term : '—'}
                          </td>
                          <td className="py-2 px-4 text-center font-mono font-semibold">
                            {stats.grade ? (
                              <span
                                className={
                                  stats.grade.passed ? 'text-emerald-700' : 'text-rose-600'
                                }
                              >
                                {stats.grade.grade}
                              </span>
                            ) : (
                              '—'
                            )}
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

      {/* MODE 2: ATTENDANCE TOTALS */}
      {batchMode === 'attendance' && (
        <div className="space-y-4">
          <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={classStudents.length === 0}
                onClick={() => handleIncrementWorkingDay(false)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <CalendarPlus className="w-3.5 h-3.5 text-emerald-700" />
                <span>{t(lang, 'addWorkingDay')}</span>
              </button>
              <button
                type="button"
                disabled={classStudents.length === 0}
                onClick={() => handleIncrementWorkingDay(true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 disabled:opacity-50 cursor-pointer whitespace-nowrap"
              >
                <CheckCheck className="w-3.5 h-3.5 text-emerald-700" />
                <span>{t(lang, 'allPresentToday')}</span>
              </button>
            </div>

            <button
              type="button"
              disabled={saving || dirtyAttIds.size === 0}
              onClick={handleSaveAttendanceTotals}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
            >
              {isAdmin ? <Save className="w-4 h-4" /> : <Send className="w-4 h-4" />}
              <span>
                {saving
                  ? t(lang, 'loading')
                  : `${isAdmin ? t(lang, 'saveChanges') : t(lang, 'submitForApproval')} (${dirtyAttIds.size})`}
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
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 w-20">{t(lang, 'rollNumber')}</th>
                      <th className="py-3 px-4">{lang === 'bn' ? 'নাম' : 'Student Name'}</th>
                      <th className="py-3 px-3 text-center w-36">{t(lang, 'totalSchoolDays')}</th>
                      <th className="py-3 px-3 text-center w-36">{t(lang, 'daysPresent')}</th>
                      <th className="py-3 px-4 text-right w-28">{t(lang, 'attendancePct')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {classStudents.map((st) => {
                      const d = attDrafts[st.id] || { totalSchoolDays: '0', daysPresent: '0' };
                      const tot = Number(d.totalSchoolDays) || 0;
                      const pres = Number(d.daysPresent) || 0;
                      const pct = tot > 0 ? Math.round((pres / tot) * 100) : 0;
                      return (
                        <tr
                          key={st.id}
                          className={dirtyAttIds.has(st.id) ? 'bg-amber-50/50' : 'hover:bg-stone-50/60'}
                        >
                          <td className="py-2 px-4 font-mono tabular-nums font-semibold">
                            {st.rollNumber}
                          </td>
                          <td className="py-2 px-4 font-medium text-slate-900">
                            {st.studentNameBn || st.studentNameEn}
                          </td>
                          <td className="py-1.5 px-3">
                            <input
                              type="text"
                              inputMode="numeric"
                              value={d.totalSchoolDays}
                              onChange={(e) =>
                                handleAttChange(st.id, 'totalSchoolDays', e.target.value)
                              }
                              className="w-full px-2.5 py-1.5 text-center font-mono tabular-nums border border-stone-300 rounded-md"
                            />
                          </td>
                          <td className="py-1.5 px-3">
                            <input
                              type="text"
                              inputMode="numeric"
                              value={d.daysPresent}
                              onChange={(e) =>
                                handleAttChange(st.id, 'daysPresent', e.target.value)
                              }
                              className="w-full px-2.5 py-1.5 text-center font-mono tabular-nums border border-stone-300 rounded-md"
                            />
                          </td>
                          <td className="py-2 px-4 text-right font-mono tabular-nums font-semibold text-emerald-800">
                            {pct}%
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
      )}

      {/* MODE 3: ROLL, CLASS & PROMOTION */}
      {batchMode === 'roll' && (
        <div className="space-y-4">
          <div className="bg-white border border-stone-200 rounded-xl p-4 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-600">
              {getClassLabel(selectedClass, lang)} · {selectedAcademicYear}
            </span>
            <button
              type="button"
              disabled={saving || dirtyRollIds.size === 0}
              onClick={handleSaveRollChanges}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
            >
              {isAdmin ? <Save className="w-4 h-4" /> : <Send className="w-4 h-4" />}
              <span>
                {saving
                  ? t(lang, 'loading')
                  : `${isAdmin ? t(lang, 'saveChanges') : t(lang, 'submitForApproval')} (${dirtyRollIds.size})`}
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
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 min-w-[160px]">
                        {lang === 'bn' ? 'শিক্ষার্থী' : 'Student'}
                      </th>
                      <th className="py-3 px-3 w-24">{t(lang, 'rollNumber')}</th>
                      <th className="py-3 px-3 w-28">{t(lang, 'nextYearRollNumber')}</th>
                      <th className="py-3 px-3 w-36">{t(lang, 'classSelector')}</th>
                      <th className="py-3 px-3 w-28">{t(lang, 'section')}</th>
                      <th className="py-3 px-3 w-40">{t(lang, 'promotionStatus')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {classStudents.map((st) => {
                      const d = rollDrafts[st.id] || {
                        rollNumber: '',
                        nextYearRollNumber: '',
                        classLevel: selectedClass,
                        section: '',
                        promotionStatus: '',
                      };
                      return (
                        <tr
                          key={st.id}
                          className={
                            dirtyRollIds.has(st.id) ? 'bg-amber-50/50' : 'hover:bg-stone-50/60'
                          }
                        >
                          <td className="py-2 px-4 font-medium text-slate-900">
                            {st.studentNameBn || st.studentNameEn}
                          </td>
                          <td className="py-1.5 px-3">
                            <input
                              type="text"
                              value={d.rollNumber}
                              onChange={(e) =>
                                handleRollFieldChange(st.id, 'rollNumber', e.target.value)
                              }
                              className="w-full px-2.5 py-1.5 font-mono tabular-nums border border-stone-300 rounded-md"
                            />
                          </td>
                          <td className="py-1.5 px-3">
                            <input
                              type="text"
                              value={d.nextYearRollNumber}
                              onChange={(e) =>
                                handleRollFieldChange(st.id, 'nextYearRollNumber', e.target.value)
                              }
                              className="w-full px-2.5 py-1.5 font-mono tabular-nums border border-stone-300 rounded-md"
                            />
                          </td>
                          <td className="py-1.5 px-3">
                            <select
                              value={d.classLevel}
                              onChange={(e) =>
                                handleRollFieldChange(st.id, 'classLevel', e.target.value)
                              }
                              className="w-full px-2.5 py-1.5 bg-white border border-stone-300 rounded-md"
                            >
                              {CLASS_LEVELS.map((cls) => (
                                <option key={cls} value={cls}>
                                  {getClassLabel(cls, lang)}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-1.5 px-3">
                            <input
                              type="text"
                              value={d.section}
                              onChange={(e) =>
                                handleRollFieldChange(st.id, 'section', e.target.value)
                              }
                              className="w-full px-2.5 py-1.5 border border-stone-300 rounded-md"
                            />
                          </td>
                          <td className="py-1.5 px-3">
                            <select
                              value={d.promotionStatus}
                              onChange={(e) =>
                                handleRollFieldChange(st.id, 'promotionStatus', e.target.value)
                              }
                              className="w-full px-2.5 py-1.5 bg-white border border-stone-300 rounded-md"
                            >
                              <option value="">—</option>
                              <option value="Promoted">Promoted</option>
                              <option value="Retained">Retained</option>
                              <option value="Graduated">Graduated</option>
                              <option value="Transferred">Transferred</option>
                            </select>
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
      )}

      {/* MODE 4: SUBJECT ASSESSMENT FIELDS */}
      {batchMode === 'subjectFields' && (
        <div className="space-y-4">
          <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              {classSubjectsWithFields.length > 0 ? (
                <select
                  value={subjFieldId}
                  onChange={(e) => setSubjFieldId(e.target.value)}
                  className="px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg"
                >
                  {classSubjectsWithFields.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-slate-500">
                  {lang === 'bn'
                    ? 'এই শ্রেণির জন্য বিষয়ভিত্তিক অতিরিক্ত ফিল্ড নেই।'
                    : 'No subject assessment fields configured for this class.'}
                </span>
              )}
            </div>

            <button
              type="button"
              disabled={saving || dirtySubjValIds.size === 0 || !activeSubjectDoc}
              onClick={handleSaveSubjectFields}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
            >
              {isAdmin ? <Save className="w-4 h-4" /> : <Send className="w-4 h-4" />}
              <span>
                {saving
                  ? t(lang, 'loading')
                  : `${isAdmin ? t(lang, 'saveChanges') : t(lang, 'submitForApproval')} (${dirtySubjValIds.size})`}
              </span>
            </button>
          </div>

          <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            {!activeSubjectDoc ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {lang === 'bn'
                  ? 'অ্যাডমিন প্যানেল থেকে বিষয়ভিত্তিক ফিল্ড যুক্ত করুন।'
                  : 'Configure subject assessment fields in the Admin Panel.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 w-20">{t(lang, 'rollNumber')}</th>
                      <th className="py-3 px-4">{lang === 'bn' ? 'নাম' : 'Student Name'}</th>
                      {activeSubjectDoc.fields.map((fld) => (
                        <th key={fld.fieldId} className="py-3 px-3 min-w-[140px]">
                          {fld.label}
                          {fld.maxMarks ? ` (${fld.maxMarks})` : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {classStudents.map((st) => (
                      <tr
                        key={st.id}
                        className={
                          dirtySubjValIds.has(st.id) ? 'bg-amber-50/50' : 'hover:bg-stone-50/60'
                        }
                      >
                        <td className="py-2 px-4 font-mono tabular-nums font-semibold">
                          {st.rollNumber}
                        </td>
                        <td className="py-2 px-4 font-medium text-slate-900">
                          {st.studentNameBn || st.studentNameEn}
                        </td>
                        {activeSubjectDoc.fields.map((fld) => {
                          const key = `${activeSubjectDoc.id}__${fld.fieldId}`;
                          const val = subjValDrafts[st.id]?.[key] ?? '';
                          return (
                            <td key={key} className="py-1.5 px-3">
                              <input
                                type={fld.fieldType === 'NUMBER' ? 'number' : 'text'}
                                value={String(val)}
                                onChange={(e) => {
                                  const nextVal =
                                    fld.fieldType === 'NUMBER' && e.target.value !== ''
                                      ? Number(e.target.value)
                                      : e.target.value;
                                  setSubjValDrafts((p) => ({
                                    ...p,
                                    [st.id]: { ...(p[st.id] || {}), [key]: nextVal },
                                  }));
                                  setDirtySubjValIds((p) => new Set(p).add(st.id));
                                }}
                                className="w-full px-2.5 py-1.5 text-sm border border-stone-300 rounded-md"
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODE 5: CLASS RESULTS & MERIT LIST */}
      {batchMode === 'results' && (
        <div className="space-y-4">
          <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                {getClassLabel(selectedClass, lang)} — {t(lang, 'modeClassResults')} ({selectedAcademicYear})
              </h3>
              <p className="text-xs text-slate-500">
                {lang === 'bn'
                  ? 'বার্ষিক পরীক্ষায় (Final Exam) উত্তীর্ণ শিক্ষার্থীদের মোট নম্বরের ভিত্তিতে মেধাক্রম নির্ধারিত হয়েছে।'
                  : 'Merit Rank computed strictly for Final Exam (exam_3) passers sorted by total marks and GPA.'}
              </p>
            </div>
            <button
              type="button"
              disabled={classStudents.length === 0}
              onClick={exportMeritExcel}
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
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-slate-600">
                      <th className="py-3 px-4 w-24">{t(lang, 'meritPosition')}</th>
                      <th className="py-3 px-4 w-20">{t(lang, 'rollNumber')}</th>
                      <th className="py-3 px-4">{lang === 'bn' ? 'শিক্ষার্থী' : 'Student'}</th>
                      <th className="py-3 px-4 text-right">{t(lang, 'term1')}</th>
                      <th className="py-3 px-4 text-right">{t(lang, 'term2')}</th>
                      <th className="py-3 px-4 text-right">{t(lang, 'term3')}</th>
                      <th className="py-3 px-4 text-right">GPA / Grade</th>
                      <th className="py-3 px-4 text-center">Status</th>
                      <th className="py-3 px-4 text-right"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {meritSortedRows.map(({ st, t1, t2, t3, merit }) => (
                      <tr
                        key={st.id}
                        onClick={() => onOpenStudentProfile?.(st.id)}
                        className="hover:bg-stone-50 cursor-pointer"
                      >
                        <td className="py-2.5 px-4 font-mono tabular-nums font-bold text-emerald-800">
                          {merit ? `#${merit}` : '—'}
                        </td>
                        <td className="py-2.5 px-4 font-mono tabular-nums font-semibold text-slate-900">
                          {st.rollNumber}
                        </td>
                        <td className="py-2.5 px-4 font-medium text-slate-900">
                          {st.studentNameBn || st.studentNameEn}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                          {t1.scoredSubjects > 0 ? t1.totalObtained : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                          {t2.scoredSubjects > 0 ? t2.totalObtained : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                          {t3.scoredSubjects > 0 ? t3.totalObtained : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                          {t3.scoredSubjects > 0 ? `${t3.gpa.toFixed(2)} (${t3.grade})` : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-center text-xs font-semibold">
                          {t3.scoredSubjects === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : t3.passed ? (
                            <span className="text-emerald-700">{t(lang, 'passedLabel')}</span>
                          ) : (
                            <span className="text-rose-600">{t(lang, 'failedLabel')}</span>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-right text-emerald-700">
                          <ExternalLink className="w-4 h-4 inline" />
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
