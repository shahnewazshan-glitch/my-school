import React, { useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit3,
  FileSpreadsheet,
  MessageCircle,
  Phone,
  Printer,
  Save,
  Settings2,
  X,
  XCircle,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { getFirebaseInstances } from '../lib/firebase';
import {
  buildChunkedExamPatchPayloads,
  buildPendingChangePayload,
  clampText,
  FIRESTORE_LIMITS,
  formatFirestoreError,
  sanitizeStringRecordMap,
  withWriteTimeout,
} from '../lib/firestoreValidation';
import { getClassLabel, t } from '../lib/i18n';
import {
  calculateSubjectGrade,
  compareRollNumbers,
  computeFinalExamMeritMap,
  computeStudentTermSummary,
  formatPhotoSrc,
  getClassSubjectsForMarksheet,
  getTermSubjectScore,
  matchesClassScope,
  normalizeExamConfigs,
  TERM_ORDER,
} from '../lib/schoolUtils';
import { CLASS_LEVELS, type ExamTermId, type StudentDoc } from '../types/school';
import { ErrorBoundary } from './ErrorBoundary';
import { ExamSetupModal } from './ExamSetupModal';

type ProfileTab = 'dossier' | 'marksheet' | 'yearly' | 'attendance';

interface StudentProfileViewProps {
  studentId: string;
  onBack: () => void;
  onSelectStudent: (studentId: string) => void;
  onOpenFullEditModal: (student: StudentDoc) => void;
}

export const StudentProfileView: React.FC<StudentProfileViewProps> = ({
  studentId,
  onBack,
  onSelectStudent,
  onOpenFullEditModal,
}) => {
  const {
    lang,
    session,
    school,
    students,
    subjects,
    customFields,
    attendanceLogs,
    setSyncing,
    activateModule,
  } = useApp();

  const isAdmin = session?.role === 'ADMIN';

  const student = useMemo(
    () => students.find((s) => s.id === studentId) || null,
    [students, studentId]
  );

  // Ordered sibling list in same class & academicYear for Prev / Next navigation
  const classSiblings = useMemo(() => {
    if (!student) return [];
    return students
      .filter(
        (s) =>
          Number(s.academicYear) === Number(student.academicYear) &&
          s.classLevel === student.classLevel
      )
      .sort(compareRollNumbers);
  }, [students, student]);

  const currentIdx = classSiblings.findIndex((s) => s.id === studentId);
  const prevStudent = currentIdx > 0 ? classSiblings[currentIdx - 1] : null;
  const nextStudent =
    currentIdx >= 0 && currentIdx < classSiblings.length - 1
      ? classSiblings[currentIdx + 1]
      : null;

  const [activeTab, setActiveTab] = useState<ProfileTab>('dossier');
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  useEffect(() => {
    if (activeTab === 'attendance') {
      activateModule('attendance');
    }
  }, [activeTab, activateModule]);

  // Marksheet Tab State
  const [activeExamId, setActiveExamId] = useState<ExamTermId>('exam_3');
  const [editMode, setEditMode] = useState<'none' | 'activeTerm' | 'allTerms'>('none');
  const [draftMarks, setDraftMarks] = useState<Record<string, string>>({});
  const [savingMarks, setSavingMarks] = useState(false);
  const [showExamSetupModal, setShowExamSetupModal] = useState(false);
  const [copiedWhatsapp, setCopiedWhatsapp] = useState(false);

  // Yearly & Promotion Tab State
  const [yearlyDraft, setYearlyDraft] = useState({
    rollNumber: '',
    nextYearRollNumber: '',
    classLevel: '',
    section: '',
    promotionStatus: '',
    totalSchoolDays: '0',
    daysPresent: '0',
  });
  const [savingYearly, setSavingYearly] = useState(false);

  // Attendance Log Month State
  const [selectedMonth, setSelectedMonth] = useState<string>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  // Safe defensive defaults for every optional Firestore field on StudentRecord
  const safeClassLevel = String(student?.classLevel || 'Class 1');
  const safeExamResults = useMemo<Record<string, number | string>>(
    () =>
      student?.examResults &&
      typeof student.examResults === 'object' &&
      !Array.isArray(student.examResults)
        ? student.examResults
        : {},
    [student?.examResults]
  );
  const safeCustomValues = useMemo<Record<string, string | number | boolean>>(
    () =>
      student?.customValues &&
      typeof student.customValues === 'object' &&
      !Array.isArray(student.customValues)
        ? student.customValues
        : {},
    [student?.customValues]
  );
  const safeSubjectValues = useMemo<Record<string, string | number | boolean>>(
    () =>
      student?.subjectValues &&
      typeof student.subjectValues === 'object' &&
      !Array.isArray(student.subjectValues)
        ? student.subjectValues
        : {},
    [student?.subjectValues]
  );
  const safeSectorNotesText = useMemo(() => {
    const raw = student?.sectorNotes;
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const entries = Object.entries(raw as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
        .map(([k, v]) => `${k}: ${String(v)}`);
      return entries.join('\n');
    }
    return '';
  }, [student?.sectorNotes]);

  // Reset edit states when student changes
  useEffect(() => {
    if (!student) return;
    setEditMode('none');
    setDraftMarks({});
    setBanner(null);
    setYearlyDraft({
      rollNumber: String(student.rollNumber ?? ''),
      nextYearRollNumber: String(student.nextYearRollNumber ?? ''),
      classLevel: safeClassLevel,
      section: String(student.section ?? ''),
      promotionStatus: String(student.promotionStatus ?? ''),
      totalSchoolDays: String(student.totalSchoolDays ?? 0),
      daysPresent: String(student.daysPresent ?? 0),
    });
  }, [
    studentId,
    student,
    safeClassLevel,
    student?.rollNumber,
    student?.nextYearRollNumber,
    student?.section,
    student?.promotionStatus,
    student?.totalSchoolDays,
    student?.daysPresent,
  ]);

  const examConfigs = useMemo(
    () => normalizeExamConfigs(school?.examConfigs),
    [school?.examConfigs]
  );

  const classSubjects = useMemo(() => {
    if (!student) return [];
    return getClassSubjectsForMarksheet(examConfigs, safeClassLevel);
  }, [examConfigs, student, safeClassLevel]);

  const studentSubjectsWithFields = useMemo(() => {
    if (!student) return [];
    const safeSubjList = Array.isArray(subjects) ? subjects : [];
    return safeSubjList.filter(
      (s) => s && typeof s === 'object' && matchesClassScope(s.gradeScope, safeClassLevel)
    );
  }, [subjects, student, safeClassLevel]);

  // Build live examResults map merging stored examResults with any active draftMarks
  const liveExamResults = useMemo(() => {
    const base: Record<string, number | string> = { ...safeExamResults };
    if (editMode === 'none') return base;

    for (const termId of TERM_ORDER) {
      if (editMode === 'activeTerm' && termId !== activeExamId) continue;
      for (const subj of classSubjects) {
        if (!subj?.subjectId) continue;
        const contKey = `${termId}__${subj.subjectId}__cont`;
        const sumKey = `${termId}__${subj.subjectId}__sum`;
        const totalKey = `${termId}__${subj.subjectId}`;

        const contStr = draftMarks[contKey] ?? '';
        const sumStr = draftMarks[sumKey] ?? '';

        if (contStr !== '') base[contKey] = Number(contStr);
        else delete base[contKey];

        if (sumStr !== '') base[sumKey] = Number(sumStr);
        else delete base[sumKey];

        if (contStr !== '' || sumStr !== '') {
          base[totalKey] =
            (contStr !== '' ? Number(contStr) : 0) + (sumStr !== '' ? Number(sumStr) : 0);
        } else if (safeExamResults[contKey] !== undefined || safeExamResults[sumKey] !== undefined) {
          // Only delete totalKey if user cleared previously existing cont/sum marks;
          // preserve legacy storedTotal if cont & sum were never set.
          delete base[totalKey];
        }
      }
    }
    return base;
  }, [safeExamResults, editMode, activeExamId, classSubjects, draftMarks]);

  const startEditingMarks = (mode: 'activeTerm' | 'allTerms') => {
    if (!student) return;
    const nextDraft: Record<string, string> = {};
    for (const termId of TERM_ORDER) {
      for (const subj of classSubjects) {
        if (!subj?.subjectId) continue;
        const score = getTermSubjectScore(safeExamResults, termId, subj.subjectId);
        nextDraft[`${termId}__${subj.subjectId}__cont`] =
          score.cont !== null ? String(score.cont) : '';
        nextDraft[`${termId}__${subj.subjectId}__sum`] =
          score.sum !== null ? String(score.sum) : '';
      }
    }
    setDraftMarks(nextDraft);
    setEditMode(mode);
    setBanner(null);
  };

  const handleMarkInputChange = (key: string, raw: string) => {
    if (raw !== '' && !/^\d*\.?\d*$/.test(raw)) return;
    setDraftMarks((prev) => ({ ...prev, [key]: raw }));
  };

  // Compute live Student with liveExamResults for summary strip & merit rank
  const liveStudentForCalc = useMemo<StudentDoc | null>(() => {
    if (!student) return null;
    return { ...student, examResults: liveExamResults };
  }, [student, liveExamResults]);

  const liveSiblingsForMerit = useMemo(() => {
    if (!liveStudentForCalc) return classSiblings;
    return classSiblings.map((s) => (s.id === liveStudentForCalc.id ? liveStudentForCalc : s));
  }, [classSiblings, liveStudentForCalc]);

  const meritMap = useMemo(
    () => computeFinalExamMeritMap(liveSiblingsForMerit, classSubjects),
    [liveSiblingsForMerit, classSubjects]
  );

  const activeTermSummary = useMemo(() => {
    if (!liveStudentForCalc) {
      return { totalFullMarks: 0, totalObtained: 0, gpa: 0, grade: '-', passed: false, scoredSubjects: 0 };
    }
    return computeStudentTermSummary(liveStudentForCalc, classSubjects, activeExamId);
  }, [liveStudentForCalc, classSubjects, activeExamId]);

  const activeTermPercentage =
    activeTermSummary.totalFullMarks > 0 && Number.isFinite(activeTermSummary.totalObtained)
      ? Number(
          ((activeTermSummary.totalObtained / activeTermSummary.totalFullMarks) * 100).toFixed(1)
        )
      : 0;

  const finalMeritRank = student ? meritMap.get(student.id) || null : null;

  // Build 3-Term Marksheet rows + Bottom Totals from liveExamResults
  const marksheetGrid = useMemo(() => {
    let fullMarksSum = 0;
    let t1ContSum = 0;
    let t1SumSum = 0;
    let t1TotalSum = 0;
    let t2ContSum = 0;
    let t2SumSum = 0;
    let t2TotalSum = 0;
    let t3ContSum = 0;
    let t3SumSum = 0;
    let t3TotalSum = 0;
    let avgSum = 0;
    let avgCount = 0;

    const rows = classSubjects.map((subj) => {
      const safeFullMarks = Number(subj?.fullMarks) > 0 ? Number(subj.fullMarks) : 100;
      const s1 = getTermSubjectScore(liveExamResults, 'exam_1', subj.subjectId);
      const s2 = getTermSubjectScore(liveExamResults, 'exam_2', subj.subjectId);
      const s3 = getTermSubjectScore(liveExamResults, 'exam_3', subj.subjectId);

      const termTotals = [s1, s2, s3]
        .filter((s) => s.hasScore && s.total !== null && Number.isFinite(s.total))
        .map((s) => s.total as number);

      const rowAvg =
        termTotals.length > 0
          ? Number((termTotals.reduce((a, b) => a + b, 0) / termTotals.length).toFixed(1))
          : null;

      const activeScore =
        activeExamId === 'exam_1' ? s1 : activeExamId === 'exam_2' ? s2 : s3;
      const activeGrade =
        activeScore.hasScore && activeScore.total !== null
          ? calculateSubjectGrade(activeScore.total, safeFullMarks)
          : null;

      fullMarksSum += safeFullMarks;
      if (s1.cont !== null) t1ContSum += s1.cont;
      if (s1.sum !== null) t1SumSum += s1.sum;
      if (s1.total !== null) t1TotalSum += s1.total;

      if (s2.cont !== null) t2ContSum += s2.cont;
      if (s2.sum !== null) t2SumSum += s2.sum;
      if (s2.total !== null) t2TotalSum += s2.total;

      if (s3.cont !== null) t3ContSum += s3.cont;
      if (s3.sum !== null) t3SumSum += s3.sum;
      if (s3.total !== null) t3TotalSum += s3.total;

      if (rowAvg !== null) {
        avgSum += rowAvg;
        avgCount += 1;
      }

      return { subj: { ...subj, fullMarks: safeFullMarks }, s1, s2, s3, rowAvg, activeGrade };
    });

    return {
      rows,
      totals: {
        fullMarksSum,
        t1ContSum,
        t1SumSum,
        t1TotalSum,
        t2ContSum,
        t2SumSum,
        t2TotalSum,
        t3ContSum,
        t3SumSum,
        t3TotalSum,
        overallAvg: avgCount > 0 ? Number(avgSum.toFixed(1)) : null,
      },
    };
  }, [classSubjects, liveExamResults, activeExamId]);

  const handleSaveMarks = async () => {
    if (!student || !session) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSavingMarks(true);
    setSyncing(true);
    setBanner(null);

    try {
      const sanitizedExamResults = sanitizeStringRecordMap(liveExamResults);
      if (Object.keys(sanitizedExamResults).length > FIRESTORE_LIMITS.EXAM_RESULTS_MAX_KEYS) {
        throw new Error(
          `Exam results exceed maximum ${FIRESTORE_LIMITS.EXAM_RESULTS_MAX_KEYS} keys.`
        );
      }

      if (isAdmin) {
        await withWriteTimeout(
          updateDoc(
            doc(instances.db, 'schools', session.schoolId, 'students', student.id),
            {
              examResults: sanitizedExamResults,
              lastUpdatedByName: clampText(session.name, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
              updatedAt: serverTimestamp(),
            }
          )
        );
        setEditMode('none');
        setDraftMarks({});
        setBanner({ type: 'success', text: t(lang, 'marksSavedSuccess') });
      } else {
        // Send ONLY compact examResults key patch (NO full student object, NO photoBase64)
        const patch: Record<string, string> = {};
        const editableTerms = editMode === 'allTerms' ? TERM_ORDER : [activeExamId];
        for (const termId of editableTerms) {
          for (const subj of classSubjects) {
            if (!subj?.subjectId) continue;
            for (const suffix of ['__cont', '__sum', '']) {
              const k = `${termId}__${subj.subjectId}${suffix}`;
              const nextVal = sanitizedExamResults[k];
              const hadOld = safeExamResults[k] !== undefined && safeExamResults[k] !== '';
              if (nextVal !== undefined) {
                patch[k] = nextVal;
              } else if (hadOld) {
                patch[k] = '';
              }
            }
          }
        }

        if (Object.keys(patch).length === 0) {
          setEditMode('none');
          setDraftMarks({});
          return;
        }

        const chunks = buildChunkedExamPatchPayloads([{ studentId: student.id, patch }]);
        for (let idx = 0; idx < chunks.length; idx++) {
          const chunk = chunks[idx];
          const pendingDoc = buildPendingChangePayload({
            schoolId: session.schoolId,
            entityType: 'STUDENT_BATCH_UPDATE',
            targetId: `${student.id}_${Date.now()}_${idx + 1}`,
            submittedByDeviceId: session.deviceId,
            submittedByName: session.name,
            summary: `Marks Update: ${student.studentNameBn || student.studentNameEn} (Roll ${student.rollNumber})`,
            detailsText: `${student.classLevel} (${student.academicYear})`,
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

        setEditMode('none');
        setDraftMarks({});
        setBanner({ type: 'success', text: t(lang, 'marksSubmittedSuccess') });
      }
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${formatFirestoreError(err)}`,
      });
    } finally {
      setSavingMarks(false);
      setSyncing(false);
    }
  };

  const handleCopyWhatsAppSummary = async () => {
    if (!student) return;
    const termTitle =
      activeExamId === 'exam_1'
        ? t(lang, 'term1')
        : activeExamId === 'exam_2'
        ? t(lang, 'term2')
        : t(lang, 'term3');

    const subjectLines = marksheetGrid.rows
      .map((r) => {
        const score =
          activeExamId === 'exam_1' ? r.s1 : activeExamId === 'exam_2' ? r.s2 : r.s3;
        if (!score.hasScore) return null;
        return `• ${r.subj.subjectName}: ${score.total}/${r.subj.fullMarks} (${r.activeGrade?.grade || '-'})`;
      })
      .filter(Boolean)
      .join('\n');

    const gpaLabel = Number.isFinite(activeTermSummary.gpa)
      ? activeTermSummary.gpa.toFixed(2)
      : '0.00';

    const summaryText = [
      `*${school?.schoolName || 'My School'}*`,
      `${student.studentNameBn || student.studentNameEn || 'Student'} (Roll: ${student.rollNumber ?? '-'}, ${getClassLabel(safeClassLevel, lang)} ${student.academicYear || ''})`,
      `Exam: ${termTitle}`,
      subjectLines,
      `Total: ${activeTermSummary.totalObtained}/${activeTermSummary.totalFullMarks} (${activeTermPercentage}%)`,
      `GPA: ${gpaLabel} | Grade: ${activeTermSummary.grade} | ${activeTermSummary.passed ? 'PASSED' : 'FAILED'}`,
      activeExamId === 'exam_3' && finalMeritRank ? `Merit Rank: #${finalMeritRank}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await navigator.clipboard.writeText(summaryText);
      setCopiedWhatsapp(true);
      setTimeout(() => setCopiedWhatsapp(false), 2500);
    } catch {
      setBanner({ type: 'error', text: 'Clipboard copy not permitted by browser.' });
    }
  };

  const handleExportStudentExcel = async () => {
    if (!student) return;
    const XLSX = await import('xlsx');
    const headerRow1 = [
      'Subject',
      'Full Marks',
      '1st Term',
      '',
      '',
      '2nd Term',
      '',
      '',
      'Final Term',
      '',
      '',
      '3-Term Average',
    ];
    const headerRow2 = [
      '',
      '',
      'Cont.',
      'Sum.',
      'Total',
      'Cont.',
      'Sum.',
      'Total',
      'Cont.',
      'Sum.',
      'Total',
      '',
    ];
    const rows = marksheetGrid.rows.map((r) => [
      r.subj.subjectName,
      r.subj.fullMarks,
      r.s1.cont ?? '',
      r.s1.sum ?? '',
      r.s1.total ?? '',
      r.s2.cont ?? '',
      r.s2.sum ?? '',
      r.s2.total ?? '',
      r.s3.cont ?? '',
      r.s3.sum ?? '',
      r.s3.total ?? '',
      r.rowAvg ?? '',
    ]);
    const totalsRow = [
      'Totals',
      marksheetGrid.totals.fullMarksSum,
      marksheetGrid.totals.t1ContSum,
      marksheetGrid.totals.t1SumSum,
      marksheetGrid.totals.t1TotalSum,
      marksheetGrid.totals.t2ContSum,
      marksheetGrid.totals.t2SumSum,
      marksheetGrid.totals.t2TotalSum,
      marksheetGrid.totals.t3ContSum,
      marksheetGrid.totals.t3SumSum,
      marksheetGrid.totals.t3TotalSum,
      marksheetGrid.totals.overallAvg ?? '',
    ];

    const aoa = [
      [`${school?.schoolName || 'My School'} — 3-Term Marksheet`],
      [
        `Student: ${student.studentNameBn || student.studentNameEn}`,
        `Roll: ${student.rollNumber}`,
        `Class: ${student.classLevel}`,
        `Year: ${student.academicYear}`,
      ],
      [],
      headerRow1,
      headerRow2,
      ...rows,
      totalsRow,
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [
      { s: { r: 3, c: 0 }, e: { r: 4, c: 0 } },
      { s: { r: 3, c: 1 }, e: { r: 4, c: 1 } },
      { s: { r: 3, c: 2 }, e: { r: 3, c: 4 } },
      { s: { r: 3, c: 5 }, e: { r: 3, c: 7 } },
      { s: { r: 3, c: 8 }, e: { r: 3, c: 10 } },
      { s: { r: 3, c: 11 }, e: { r: 4, c: 11 } },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Marksheet');
    const safeClassFile = safeClassLevel.replace(/\s+/g, '_');
    const safeRollFile = String(student.rollNumber ?? 'student').replace(/[^a-zA-Z0-9_-]/g, '_');
    XLSX.writeFile(wb, `Marksheet_${safeClassFile}_Roll_${safeRollFile}.xlsx`);
  };

  // Save Yearly & Promotion fields
  const handleSaveYearly = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!student || !session) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSavingYearly(true);
    setSyncing(true);
    setBanner(null);
    try {
      const patch = {
        rollNumber: yearlyDraft.rollNumber.trim(),
        nextYearRollNumber: yearlyDraft.nextYearRollNumber.trim(),
        classLevel: yearlyDraft.classLevel,
        section: yearlyDraft.section.trim(),
        promotionStatus: yearlyDraft.promotionStatus.trim(),
        totalSchoolDays: Math.max(0, Math.trunc(Number(yearlyDraft.totalSchoolDays) || 0)),
        daysPresent: Math.max(0, Math.trunc(Number(yearlyDraft.daysPresent) || 0)),
      };

      if (isAdmin) {
        await withWriteTimeout(
          updateDoc(
            doc(instances.db, 'schools', session.schoolId, 'students', student.id),
            {
              ...patch,
              lastUpdatedByName: clampText(session.name, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
              updatedAt: serverTimestamp(),
            }
          )
        );
        setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
      } else {
        const pendingDoc = buildPendingChangePayload({
          schoolId: session.schoolId,
          entityType: 'STUDENT_BATCH_UPDATE',
          targetId: student.id,
          submittedByDeviceId: session.deviceId,
          submittedByName: session.name,
          summary: `Yearly/Promotion Update: ${student.studentNameBn || student.studentNameEn}`,
          detailsText: `Roll ${patch.rollNumber}, Status: ${patch.promotionStatus || '-'}`,
          payloadJson: JSON.stringify({
            kind: 'ROLL_PROMOTION',
            updates: [
              {
                studentId: student.id,
                studentName: clampText(student.studentNameBn || student.studentNameEn, 80),
                fieldsPatch: patch,
              },
            ],
          }),
          status: 'PENDING',
        });
        await withWriteTimeout(
          addDoc(
            collection(instances.db, 'schools', session.schoolId, 'pendingChanges'),
            pendingDoc
          )
        );
        setBanner({ type: 'success', text: t(lang, 'submittedApprovalSuccess') });
      }
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${formatFirestoreError(err)}`,
      });
    } finally {
      setSavingYearly(false);
      setSyncing(false);
    }
  };

  // Student Attendance Log computations
  const studentAttendanceData = useMemo(() => {
    if (!student) return { monthLogs: [], monthStats: { p: 0, a: 0, l: 0 }, yearlyMonths: [] };
    const safeLogs = Array.isArray(attendanceLogs) ? attendanceLogs : [];
    const classLogs = safeLogs
      .filter(
        (log) =>
          log &&
          Number(log.academicYear) === Number(student.academicYear) &&
          String(log.classLevel || '') === safeClassLevel
      )
      .sort((a, b) => String(a?.dateKey || '').localeCompare(String(b?.dateKey || '')));

    const monthLogs = classLogs
      .filter((l) => (l.monthKey || String(l.dateKey || '').slice(0, 7)) === selectedMonth)
      .map((l) => ({
        dateKey: String(l.dateKey || ''),
        status: l.statuses?.[student.id] || null,
        markedByName: String(l.markedByName || ''),
      }));

    let p = 0;
    let a = 0;
    let l = 0;
    for (const item of monthLogs) {
      if (item.status === 'P') p += 1;
      else if (item.status === 'A') a += 1;
      else if (item.status === 'L') l += 1;
    }

    const byMonth = new Map<string, { p: number; a: number; l: number; days: number }>();
    for (const log of classLogs) {
      const m = log.monthKey || log.dateKey.slice(0, 7);
      const cur = byMonth.get(m) || { p: 0, a: 0, l: 0, days: 0 };
      const st = log.statuses?.[student.id];
      if (st) {
        cur.days += 1;
        if (st === 'P') cur.p += 1;
        else if (st === 'A') cur.a += 1;
        else if (st === 'L') cur.l += 1;
      }
      byMonth.set(m, cur);
    }

    const yearlyMonths = Array.from(byMonth.entries()).map(([month, stat]) => ({
      month,
      ...stat,
    }));

    return { monthLogs, monthStats: { p, a, l }, yearlyMonths };
  }, [attendanceLogs, student, selectedMonth]);

  if (!student) {
    return (
      <div className="bg-white border border-stone-200 rounded-xl p-8 text-center space-y-3">
        <p className="text-sm text-slate-500">Student record not found.</p>
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2 text-xs font-semibold bg-emerald-700 text-white rounded-lg cursor-pointer"
        >
          {t(lang, 'backToStudents')}
        </button>
      </div>
    );
  }

  const photo = formatPhotoSrc(student.photoBase64);
  const yearlyTotalDays = Number(yearlyDraft.totalSchoolDays) || 0;
  const yearlyPresentDays = Number(yearlyDraft.daysPresent) || 0;
  const yearlyAttPct =
    yearlyTotalDays > 0 ? Math.round((yearlyPresentDays / yearlyTotalDays) * 100) : 0;

  return (
    <div className="space-y-5">
      {banner && (
        <div
          className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border text-sm no-print ${
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

      {/* Top Navigation & Student Profile Header */}
      <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-4 no-print">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded-lg cursor-pointer whitespace-nowrap"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>{t(lang, 'backToStudents')}</span>
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!prevStudent}
              onClick={() => prevStudent && onSelectStudent(prevStudent.id)}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 disabled:opacity-40 cursor-pointer whitespace-nowrap"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>{t(lang, 'prevStudent')}</span>
            </button>
            <button
              type="button"
              disabled={!nextStudent}
              onClick={() => nextStudent && onSelectStudent(nextStudent.id)}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 disabled:opacity-40 cursor-pointer whitespace-nowrap"
            >
              <span>{t(lang, 'nextStudent')}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onOpenFullEditModal(student)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer whitespace-nowrap"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>{t(lang, 'editStudent')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('marksheet');
                setTimeout(() => window.print(), 150);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg cursor-pointer whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>{lang === 'bn' ? 'প্রিন্ট' : 'Print'}</span>
            </button>
            <button
              type="button"
              onClick={handleExportStudentExcel}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
              <span>.xlsx</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-stone-100">
          {photo ? (
            <img
              src={photo}
              alt={student.studentNameEn || student.studentNameBn}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="w-16 h-16 rounded-xl object-cover border border-stone-200 shrink-0"
            />
          ) : (
            <div className="w-16 h-16 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-center justify-center text-xl font-bold shrink-0">
              {(student.studentNameEn || student.studentNameBn || '?').charAt(0).toUpperCase()}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold text-slate-900 truncate">
              {student.studentNameBn || student.studentNameEn}
            </h2>
            {student.studentNameBn && student.studentNameEn && (
              <div className="text-sm text-slate-600 truncate">{student.studentNameEn}</div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
              <span>{getClassLabel(student.classLevel, lang)}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums font-semibold text-slate-800">
                {t(lang, 'rollNumber')} {student.rollNumber}
              </span>
              {student.section && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {t(lang, 'section')} {student.section}
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{student.academicYear}</span>
            </div>
          </div>
        </div>

        {/* 4 Profile Tabs */}
        <div className="flex flex-wrap items-center gap-1 p-1 bg-stone-100 rounded-lg w-fit">
          {(
            [
              { id: 'dossier', label: t(lang, 'tabDossier') },
              { id: 'marksheet', label: t(lang, 'tabMarksheet') },
              { id: 'yearly', label: t(lang, 'tabYearlyPromotion') },
              { id: 'attendance', label: t(lang, 'tabAttendanceLog') },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* TAB 1: Dossier & Subjects */}
      {activeTab === 'dossier' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-6 bg-white border border-stone-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-stone-100">
              <h3 className="text-base font-semibold text-slate-900">
                {lang === 'bn' ? 'ব্যক্তিগত ও অভিভাবকের তথ্য' : 'Student & Guardian Particulars'}
              </h3>
              <button
                type="button"
                onClick={() => onOpenFullEditModal(student)}
                className="text-xs font-medium text-emerald-700 hover:text-emerald-800 cursor-pointer"
              >
                {t(lang, 'editStudent')}
              </button>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-xs text-slate-500">{t(lang, 'studentNameBn')}</dt>
                <dd className="font-medium text-slate-900 mt-0.5">{student.studentNameBn || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">{t(lang, 'studentNameEn')}</dt>
                <dd className="font-medium text-slate-900 mt-0.5">{student.studentNameEn || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">{t(lang, 'fatherNameEn')}</dt>
                <dd className="font-medium text-slate-900 mt-0.5">{student.fatherNameEn || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">{t(lang, 'motherNameEn')}</dt>
                <dd className="font-medium text-slate-900 mt-0.5">{student.motherNameEn || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">{t(lang, 'dateOfBirth')}</dt>
                <dd className="font-mono tabular-nums text-slate-900 mt-0.5">
                  {student.dateOfBirth || '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">{t(lang, 'guardianPhone')}</dt>
                <dd className="mt-0.5">
                  {student.guardianPhone ? (
                    <a
                      href={`tel:${student.guardianPhone}`}
                      className="inline-flex items-center gap-1.5 font-mono tabular-nums text-emerald-700 hover:underline font-medium"
                    >
                      <Phone className="w-3.5 h-3.5" />
                      <span>{student.guardianPhone}</span>
                    </a>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-slate-500">{t(lang, 'address')}</dt>
                <dd className="text-slate-900 mt-0.5">{student.address || '—'}</dd>
              </div>
            </dl>

            <div className="pt-4 border-t border-stone-100">
              <div className="text-xs text-slate-500 mb-1">{t(lang, 'sectorNotes')}</div>
              <p className="text-sm text-slate-800 whitespace-pre-wrap bg-stone-50 border border-stone-200 rounded-lg p-3">
                {safeSectorNotesText ||
                  (lang === 'bn' ? 'কোনো মন্তব্য নেই।' : 'No teacher notes recorded.')}
              </p>
            </div>
          </div>

          <div className="lg:col-span-6 space-y-5">
            {/* Custom Fields */}
            <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
              <h3 className="text-base font-semibold text-slate-900 pb-2 border-b border-stone-100">
                {t(lang, 'customFieldsSection')}
              </h3>
              {customFields.length === 0 ? (
                <p className="text-xs text-slate-500">
                  {lang === 'bn' ? 'কোনো কাস্টম ফিল্ড নির্ধারিত নেই।' : 'No custom fields configured.'}
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  {customFields.map((cf) => {
                    const rawVal = safeCustomValues[cf.id];
                    const displayVal =
                      rawVal !== undefined && rawVal !== null && rawVal !== ''
                        ? typeof rawVal === 'object'
                          ? JSON.stringify(rawVal)
                          : String(rawVal)
                        : '—';
                    return (
                      <div key={cf.id} className="bg-stone-50 border border-stone-200 rounded-lg p-3">
                        <div className="text-xs text-slate-500">
                          {cf.label} · {cf.category}
                        </div>
                        <div className="font-medium text-slate-900 mt-0.5">{displayVal}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Subject Assessment Fields */}
            <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-3">
              <h3 className="text-base font-semibold text-slate-900 pb-2 border-b border-stone-100">
                {t(lang, 'subjectFieldsSection')}
              </h3>
              {studentSubjectsWithFields.filter((s) => Array.isArray(s.fields) && s.fields.length > 0)
                .length === 0 ? (
                <p className="text-xs text-slate-500">
                  {lang === 'bn'
                    ? 'এই শ্রেণির জন্য বিষয়ভিত্তিক অতিরিক্ত ফিল্ড নেই।'
                    : 'No subject assessment fields configured for this class.'}
                </p>
              ) : (
                <div className="space-y-3">
                  {studentSubjectsWithFields
                    .filter((s) => Array.isArray(s.fields) && s.fields.length > 0)
                    .map((subj) => (
                      <div key={subj.id} className="border border-stone-200 rounded-lg p-3 space-y-2">
                        <div className="text-xs font-semibold text-slate-800">{subj.name}</div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          {subj.fields.map((fld) => {
                            const val = safeSubjectValues[`${subj.id}__${fld.fieldId}`];
                            const displayVal =
                              val !== undefined && val !== null && val !== ''
                                ? typeof val === 'object'
                                  ? JSON.stringify(val)
                                  : String(val)
                                : '—';
                            return (
                              <div key={fld.fieldId} className="bg-stone-50 px-2.5 py-2 rounded">
                                <span className="text-slate-500">{fld.label}: </span>
                                <span className="font-semibold text-slate-900">{displayVal}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Interactive 3-Term Marksheet wrapped in ErrorBoundary */}
      {activeTab === 'marksheet' && (
        <ErrorBoundary
          onBackToList={onBack}
          backLabel={t(lang, 'backToStudents')}
          title={lang === 'bn' ? 'মার্কশিট প্রদর্শনে সমস্যা হয়েছে' : 'Unable to display Marksheet'}
        >
        <div className="space-y-4">
          {/* Top Controls inside Marksheet Tab */}
          <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4 no-print">
            {/* 3-Exam Selector */}
            <div className="flex flex-wrap items-center gap-2">
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
                      onClick={() => setActiveExamId(termId)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                        activeExamId === termId
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setShowExamSetupModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer whitespace-nowrap"
                >
                  <Settings2 className="w-3.5 h-3.5 text-emerald-700" />
                  <span>{t(lang, 'subjectsExamsSetup')}</span>
                </button>
              )}
            </div>

            {/* Action Buttons: Enter/Edit Marks, Inline Edit All 3 Terms, Print, WhatsApp */}
            <div className="flex flex-wrap items-center gap-2">
              {editMode === 'none' ? (
                <>
                  <button
                    type="button"
                    disabled={classSubjects.length === 0}
                    onClick={() => startEditingMarks('activeTerm')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>{t(lang, 'enterEditMarks')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={classSubjects.length === 0}
                    onClick={() => startEditingMarks('allTerms')}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-emerald-900 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 disabled:opacity-50 rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    <span>{t(lang, 'inlineEditAll3Terms')}</span>
                  </button>
                </>
              ) : (
                <>
                  {editMode === 'activeTerm' && (
                    <button
                      type="button"
                      onClick={() => setEditMode('allTerms')}
                      className="px-3 py-2 text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer whitespace-nowrap"
                    >
                      {t(lang, 'inlineEditAll3Terms')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setEditMode('none');
                      setDraftMarks({});
                    }}
                    className="px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer whitespace-nowrap"
                  >
                    {t(lang, 'discardEdits')}
                  </button>
                  <button
                    type="button"
                    disabled={savingMarks}
                    onClick={handleSaveMarks}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>
                      {savingMarks
                        ? t(lang, 'loading')
                        : isAdmin
                        ? t(lang, 'saveMarks')
                        : t(lang, 'submitForApproval')}
                    </span>
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer whitespace-nowrap"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>{t(lang, 'printMarksheet')}</span>
              </button>

              <button
                type="button"
                onClick={handleCopyWhatsAppSummary}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer whitespace-nowrap"
              >
                {copiedWhatsapp ? (
                  <Check className="w-3.5 h-3.5 text-emerald-700" />
                ) : (
                  <MessageCircle className="w-3.5 h-3.5 text-emerald-700" />
                )}
                <span>
                  {copiedWhatsapp ? t(lang, 'copiedWhatsApp') : t(lang, 'whatsappShareSummary')}
                </span>
                <Copy className="w-3 h-3 text-slate-400" />
              </button>
            </div>
          </div>

          {/* Live Exam Summary Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 no-print">
            <div className="bg-white border border-stone-200 rounded-xl p-3.5">
              <div className="text-xs text-slate-500">{t(lang, 'obtainedFullLabel')}</div>
              <div className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900">
                {activeTermSummary.scoredSubjects > 0
                  ? `${activeTermSummary.totalObtained} / ${activeTermSummary.totalFullMarks}`
                  : '—'}
              </div>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-3.5">
              <div className="text-xs text-slate-500">{t(lang, 'percentageLabel')}</div>
              <div className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900">
                {activeTermSummary.scoredSubjects > 0 ? `${activeTermPercentage}%` : '—'}
              </div>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-3.5">
              <div className="text-xs text-slate-500">GPA / Grade</div>
              <div className="mt-1 text-lg font-bold font-mono tabular-nums text-slate-900">
                {activeTermSummary.scoredSubjects > 0
                  ? `${Number.isFinite(activeTermSummary.gpa) ? activeTermSummary.gpa.toFixed(2) : '0.00'} (${activeTermSummary.grade})`
                  : '—'}
              </div>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-3.5">
              <div className="text-xs text-slate-500">Result Status</div>
              <div className="mt-1 text-sm font-semibold flex items-center gap-1.5">
                {activeTermSummary.scoredSubjects === 0 ? (
                  <span className="text-slate-500">{t(lang, 'notScoredLabel')}</span>
                ) : activeTermSummary.passed ? (
                  <span className="inline-flex items-center gap-1 text-emerald-700">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{t(lang, 'passedLabel')}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-rose-600">
                    <XCircle className="w-4 h-4" />
                    <span>{t(lang, 'failedLabel')}</span>
                  </span>
                )}
              </div>
            </div>
            <div className="bg-white border border-stone-200 rounded-xl p-3.5">
              <div className="text-xs text-slate-500">{t(lang, 'meritPosition')}</div>
              <div className="mt-1 text-lg font-bold font-mono tabular-nums text-emerald-800">
                {finalMeritRank ? `#${finalMeritRank}` : t(lang, 'notQualified')}
              </div>
            </div>
          </div>

          {/* Printable & Interactive 3-Term Marksheet Card */}
          <div className="bg-white border border-stone-200 rounded-xl p-5 sm:p-7 print-card space-y-5">
            {/* Print-only Header */}
            <div className="hidden print:block text-center border-b-2 border-slate-800 pb-3 space-y-1">
              <h2 className="text-xl font-bold">{school?.schoolName || 'My School'}</h2>
              <p className="text-xs text-slate-600">
                {student.studentNameBn || student.studentNameEn || 'Student'} ·{' '}
                {getClassLabel(safeClassLevel, lang)} · Roll {student.rollNumber ?? '—'} ·{' '}
                {student.academicYear || ''}
              </p>
            </div>

            {classSubjects.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500 space-y-3">
                <p>{t(lang, 'noSubjectsConfigured')}</p>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setShowExamSetupModal(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg cursor-pointer"
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    <span>
                      {lang === 'bn'
                        ? 'এই পরীক্ষার জন্য বিষয় সেটআপ করুন'
                        : 'Setup Subjects for This Exam'}
                    </span>
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm border-collapse border border-stone-300">
                  <thead>
                    <tr className="bg-stone-100 text-slate-800 font-semibold">
                      <th
                        rowSpan={2}
                        className="border border-stone-300 py-2.5 px-3 text-left align-middle min-w-[140px]"
                      >
                        {t(lang, 'subject')}
                      </th>
                      <th
                        rowSpan={2}
                        className="border border-stone-300 py-2.5 px-2 text-center align-middle w-16"
                      >
                        {t(lang, 'fullMarks')}
                      </th>
                      <th
                        colSpan={3}
                        className={`border border-stone-300 py-2 px-2 text-center ${
                          activeExamId === 'exam_1' ? 'bg-emerald-100/80' : 'bg-emerald-50/50'
                        }`}
                      >
                        {t(lang, 'term1')}
                      </th>
                      <th
                        colSpan={3}
                        className={`border border-stone-300 py-2 px-2 text-center ${
                          activeExamId === 'exam_2' ? 'bg-sky-100/80' : 'bg-sky-50/40'
                        }`}
                      >
                        {t(lang, 'term2')}
                      </th>
                      <th
                        colSpan={3}
                        className={`border border-stone-300 py-2 px-2 text-center ${
                          activeExamId === 'exam_3' ? 'bg-amber-100/80' : 'bg-amber-50/40'
                        }`}
                      >
                        {t(lang, 'term3')}
                      </th>
                      <th
                        rowSpan={2}
                        className="border border-stone-300 py-2.5 px-2 text-center align-middle w-20"
                      >
                        {t(lang, 'avg3Term')}
                      </th>
                    </tr>
                    <tr className="bg-stone-50 text-slate-600 text-xs font-medium">
                      {TERM_ORDER.map((tid) => (
                        <React.Fragment key={tid}>
                          <th className="border border-stone-300 py-1.5 px-1.5 text-center w-16">
                            {t(lang, 'contShort')}
                          </th>
                          <th className="border border-stone-300 py-1.5 px-1.5 text-center w-16">
                            {t(lang, 'sumShort')}
                          </th>
                          <th className="border border-stone-300 py-1.5 px-1.5 text-center font-semibold text-slate-900 w-16">
                            {t(lang, 'totalShort')}
                          </th>
                        </React.Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {marksheetGrid.rows.map(({ subj, s1, s2, s3, rowAvg, activeGrade }, idx) => {
                      const renderTermCells = (
                        termId: ExamTermId,
                        score: { cont: number | null; sum: number | null; total: number | null }
                      ) => {
                        const isEditable =
                          editMode === 'allTerms' ||
                          (editMode === 'activeTerm' && termId === activeExamId);
                        const contKey = `${termId}__${subj.subjectId}__cont`;
                        const sumKey = `${termId}__${subj.subjectId}__sum`;

                        return (
                          <React.Fragment key={termId}>
                            <td className="border border-stone-300 p-1 text-center font-mono tabular-nums">
                              {isEditable ? (
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={draftMarks[contKey] ?? ''}
                                  onChange={(e) => handleMarkInputChange(contKey, e.target.value)}
                                  placeholder="0"
                                  className="w-14 px-1 py-1 text-center text-xs bg-white border border-emerald-400 rounded focus:outline-none focus:ring-2 focus:ring-emerald-600"
                                />
                              ) : (
                                <span className="text-slate-700">{score.cont ?? '—'}</span>
                              )}
                            </td>
                            <td className="border border-stone-300 p-1 text-center font-mono tabular-nums">
                              {isEditable ? (
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={draftMarks[sumKey] ?? ''}
                                  onChange={(e) => handleMarkInputChange(sumKey, e.target.value)}
                                  placeholder="0"
                                  className="w-14 px-1 py-1 text-center text-xs bg-white border border-emerald-400 rounded focus:outline-none focus:ring-2 focus:ring-emerald-600"
                                />
                              ) : (
                                <span className="text-slate-700">{score.sum ?? '—'}</span>
                              )}
                            </td>
                            <td className="border border-stone-300 py-2 px-1.5 text-center font-mono tabular-nums font-semibold text-slate-900 bg-stone-50/50">
                              {score.total ?? '—'}
                            </td>
                          </React.Fragment>
                        );
                      };

                      return (
                        <tr key={`${subj.subjectId}_${idx}`} className="hover:bg-stone-50/50">
                          <td className="border border-stone-300 py-2 px-3 font-medium text-slate-900">
                            <div className="flex items-center justify-between gap-2">
                              <span>{subj.subjectName}</span>
                              {activeGrade && (
                                <span
                                  className={`text-[11px] font-mono font-semibold ${
                                    activeGrade.passed ? 'text-emerald-700' : 'text-rose-600'
                                  }`}
                                >
                                  {activeGrade.grade}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="border border-stone-300 py-2 px-2 text-center font-mono tabular-nums text-slate-700">
                            {subj.fullMarks}
                          </td>
                          {renderTermCells('exam_1', s1)}
                          {renderTermCells('exam_2', s2)}
                          {renderTermCells('exam_3', s3)}
                          <td className="border border-stone-300 py-2 px-2 text-center font-mono tabular-nums font-semibold text-slate-900">
                            {rowAvg ?? '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-stone-100 font-bold text-slate-900">
                      <td className="border border-stone-300 py-2.5 px-3">
                        {t(lang, 'totalsRow')}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-2 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.fullMarksSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-1.5 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.t1ContSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-1.5 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.t1SumSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-1.5 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.t1TotalSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-1.5 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.t2ContSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-1.5 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.t2SumSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-1.5 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.t2TotalSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-1.5 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.t3ContSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-1.5 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.t3SumSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-1.5 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.t3TotalSum}
                      </td>
                      <td className="border border-stone-300 py-2.5 px-2 text-center font-mono tabular-nums">
                        {marksheetGrid.totals.overallAvg ?? '—'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            {/* Print Signatures */}
            <div className="hidden print:grid pt-10 grid-cols-2 gap-12 text-xs text-slate-700">
              <div className="text-center">
                <div className="border-t border-slate-400 pt-1.5 mx-6">
                  {t(lang, 'classTeacherSign')}
                </div>
              </div>
              <div className="text-center">
                <div className="border-t border-slate-400 pt-1.5 mx-6">
                  {t(lang, 'headTeacherSign')}
                </div>
              </div>
            </div>
          </div>
        </div>
        </ErrorBoundary>
      )}

      {/* TAB 3: Yearly & Promotion */}
      {activeTab === 'yearly' && (
        <form
          onSubmit={handleSaveYearly}
          className="bg-white border border-stone-200 rounded-xl p-6 max-w-3xl space-y-5"
        >
          <div className="flex items-center justify-between pb-3 border-b border-stone-100">
            <h3 className="text-base font-semibold text-slate-900">
              {t(lang, 'tabYearlyPromotion')} ({student.academicYear})
            </h3>
            <span className="text-sm font-mono tabular-nums font-semibold text-emerald-800">
              {t(lang, 'attendancePct')}: {yearlyAttPct}%
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'rollNumber')}
              </label>
              <input
                type="text"
                value={yearlyDraft.rollNumber}
                onChange={(e) =>
                  setYearlyDraft((p) => ({ ...p, rollNumber: e.target.value }))
                }
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'nextYearRollNumber')}
              </label>
              <input
                type="text"
                value={yearlyDraft.nextYearRollNumber}
                onChange={(e) =>
                  setYearlyDraft((p) => ({ ...p, nextYearRollNumber: e.target.value }))
                }
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'classSelector')}
              </label>
              <select
                value={yearlyDraft.classLevel}
                onChange={(e) =>
                  setYearlyDraft((p) => ({ ...p, classLevel: e.target.value }))
                }
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white"
              >
                {CLASS_LEVELS.map((cls) => (
                  <option key={cls} value={cls}>
                    {getClassLabel(cls, lang)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'section')}
              </label>
              <input
                type="text"
                value={yearlyDraft.section}
                onChange={(e) => setYearlyDraft((p) => ({ ...p, section: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'totalSchoolDays')}
              </label>
              <input
                type="number"
                min={0}
                value={yearlyDraft.totalSchoolDays}
                onChange={(e) =>
                  setYearlyDraft((p) => ({ ...p, totalSchoolDays: e.target.value }))
                }
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg font-mono tabular-nums"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'daysPresent')}
              </label>
              <input
                type="number"
                min={0}
                value={yearlyDraft.daysPresent}
                onChange={(e) =>
                  setYearlyDraft((p) => ({ ...p, daysPresent: e.target.value }))
                }
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg font-mono tabular-nums"
              />
            </div>
            <div className="sm:col-span-3">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'promotionStatus')}
              </label>
              <select
                value={yearlyDraft.promotionStatus}
                onChange={(e) =>
                  setYearlyDraft((p) => ({ ...p, promotionStatus: e.target.value }))
                }
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white"
              >
                <option value="">—</option>
                <option value="Promoted">Promoted / উত্তীর্ণ</option>
                <option value="Retained">Retained / পুনঃপঠন</option>
                <option value="Graduated">Graduated / সমাপনী উত্তীর্ণ</option>
                <option value="Transferred">Transferred / ছাড়পত্র</option>
              </select>
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={savingYearly}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              <span>
                {savingYearly
                  ? t(lang, 'loading')
                  : isAdmin
                  ? t(lang, 'saveChanges')
                  : t(lang, 'submitForApproval')}
              </span>
            </button>
          </div>
        </form>
      )}

      {/* TAB 4: Attendance Log */}
      {activeTab === 'attendance' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 bg-white border border-stone-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-stone-100">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-emerald-700" />
                <h3 className="text-base font-semibold text-slate-900">
                  {t(lang, 'tabAttendanceLog')}
                </h3>
              </div>
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg font-mono"
              />
            </div>

            <div className="flex items-center gap-4 text-xs">
              <span>
                {t(lang, 'present')}:{' '}
                <strong className="font-mono tabular-nums text-emerald-700">
                  {studentAttendanceData.monthStats.p}
                </strong>
              </span>
              <span>
                {t(lang, 'absent')}:{' '}
                <strong className="font-mono tabular-nums text-rose-600">
                  {studentAttendanceData.monthStats.a}
                </strong>
              </span>
              <span>
                {t(lang, 'late')}:{' '}
                <strong className="font-mono tabular-nums text-amber-600">
                  {studentAttendanceData.monthStats.l}
                </strong>
              </span>
            </div>

            {studentAttendanceData.monthLogs.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">
                {lang === 'bn'
                  ? 'এই মাসে কোনো উপস্থিতির রেকর্ড পাওয়া যায়নি।'
                  : 'No daily attendance logs recorded for this month.'}
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {studentAttendanceData.monthLogs.map((item) => (
                  <div
                    key={item.dateKey}
                    className="border border-stone-200 rounded-lg p-2.5 flex items-center justify-between text-xs"
                  >
                    <span className="font-mono tabular-nums text-slate-700">{item.dateKey}</span>
                    <span
                      className={`font-mono font-bold ${
                        item.status === 'P'
                          ? 'text-emerald-700'
                          : item.status === 'A'
                          ? 'text-rose-600'
                          : item.status === 'L'
                          ? 'text-amber-600'
                          : 'text-slate-400'
                      }`}
                    >
                      {item.status || '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-5 bg-white border border-stone-200 rounded-xl p-5 space-y-3">
            <h3 className="text-base font-semibold text-slate-900 pb-2 border-b border-stone-100">
              {lang === 'bn' ? 'মাসভিত্তিক বার্ষিক সারসংক্ষেপ' : 'Yearly Monthly Breakdown'}
            </h3>
            {studentAttendanceData.yearlyMonths.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center">
                {lang === 'bn' ? 'কোনো মাসিক তথ্য নেই।' : 'No yearly attendance logs yet.'}
              </p>
            ) : (
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b border-stone-200 text-slate-500 font-semibold">
                    <th className="py-2">Month</th>
                    <th className="py-2 text-right">P</th>
                    <th className="py-2 text-right">A</th>
                    <th className="py-2 text-right">L</th>
                    <th className="py-2 text-right">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {studentAttendanceData.yearlyMonths.map((row) => {
                    const pct =
                      row.days > 0 ? Math.round(((row.p + row.l) / row.days) * 100) : 0;
                    return (
                      <tr
                        key={row.month}
                        onClick={() => setSelectedMonth(row.month)}
                        className="hover:bg-stone-50 cursor-pointer"
                      >
                        <td className="py-2 font-mono tabular-nums font-medium text-slate-900">
                          {row.month}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums text-emerald-700 font-semibold">
                          {row.p}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums text-rose-600 font-semibold">
                          {row.a}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums text-amber-600 font-semibold">
                          {row.l}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums text-slate-700">
                          {pct}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {showExamSetupModal && (
        <ExamSetupModal
          initialTerm={activeExamId}
          defaultClassScope={student.classLevel}
          onClose={() => setShowExamSetupModal(false)}
          onSaved={() => setBanner({ type: 'success', text: t(lang, 'savedSuccess') })}
        />
      )}
    </div>
  );
};
