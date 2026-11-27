import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  ArrowRightLeft,
  Check,
  Copy,
  KeyRound,
  Link2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserX,
  X,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import {
  deleteUploadedApkChunksFromServer,
  hasLegacyApkMetadata,
} from '../lib/apkChunks';
import { getFirebaseInstances } from '../lib/firebase';
import {
  buildAttendancePayload,
  buildCustomFieldPayload,
  buildSubjectPayload,
  clampText,
  commitBatchesInChunks,
  FIRESTORE_LIMITS,
  formatFirestoreError,
  sanitizeExamConfigs,
  sanitizeStringRecordMap,
  validateAndBuildStudentPayload,
  withWriteTimeout,
} from '../lib/firestoreValidation';
import { t } from '../lib/i18n';
import {
  formatTimestampDateTime,
  getAttendanceDocId,
  getOfficialExamLabel,
  isSameHostnameUrl,
  normalizeAppUpdateUrl,
  normalizeBdPhone,
  normalizeExamConfigs,
  normalizeSchoolId,
  OFFICIAL_EMIS_CODE,
  OFFICIAL_SCHOOL_ID,
  OFFICIAL_SCHOOL_NAME_EN,
  resolveDirectApkDownloadInfo,
  sha256Hex,
  verifySelfHostedApkUrl,
} from '../lib/schoolUtils';
import type {
  CustomFieldType,
  ExamConfig,
  ExamTermId,
  PendingChangeDoc,
  PendingStatus,
  StudentDoc,
  SubjectField,
  TeacherMember,
} from '../types/school';

interface AdminPanelViewProps {
  initialTab?: 'teachers' | 'approvals' | 'setup' | 'update';
}

export const AdminPanelView: React.FC<AdminPanelViewProps> = ({
  initialTab = 'teachers',
}) => {
  const {
    lang,
    session,
    school,
    students,
    subjects,
    customFields,
    pendingChanges,
    setSyncing,
  } = useApp();

  const [adminTab, setAdminTab] = useState<'teachers' | 'approvals' | 'setup' | 'update'>(
    initialTab
  );
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  // Teacher Removal Modal State
  const [targetTeacher, setTargetTeacher] = useState<TeacherMember | null>(null);
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  // Pending Approvals State
  const [approvalFilter, setApprovalFilter] = useState<PendingStatus>('PENDING');
  const [processingChangeId, setProcessingChangeId] = useState<string | null>(null);

  // Setup: ExamConfigs, Subjects, Custom Fields
  const [examDrafts, setExamDrafts] = useState<ExamConfig[]>(() =>
    normalizeExamConfigs(school?.examConfigs)
  );
  const [activeExamTerm, setActiveExamTerm] = useState<ExamTermId>('exam_1');
  const [savingExamConfigs, setSavingExamConfigs] = useState(false);

  // New Subject Form
  const [newSubjName, setNewSubjName] = useState('');
  const [newSubjScope, setNewSubjScope] = useState('ALL');
  const [newSubjFieldLabel, setNewSubjFieldLabel] = useState('');
  const [newSubjFieldMax, setNewSubjFieldMax] = useState('');

  // New Custom Field Form
  const [newCfCategory, setNewCfCategory] = useState('General');
  const [newCfLabel, setNewCfLabel] = useState('');
  const [newCfType, setNewCfType] = useState<CustomFieldType>('TEXT');
  const [newCfResets, setNewCfResets] = useState(false);

  // Safe Server APK Cleanup State
  const [cleanupPassword, setCleanupPassword] = useState('');
  const [cleaningApk, setCleaningApk] = useState(false);
  const [deletedSoFar, setDeletedSoFar] = useState(0);
  const [lastDeletedResult, setLastDeletedResult] = useState<number | null>(null);

  // Android App Update Publisher State
  const [verCodeInput, setVerCodeInput] = useState(() =>
    school?.latestAppVersionCode ? String(school.latestAppVersionCode) : '11'
  );
  const [verNameInput, setVerNameInput] = useState(
    () => school?.latestAppVersionName || '2.0'
  );
  const [appUrlInput, setAppUrlInput] = useState(() => school?.appUpdateUrl || '');
  const [appNotesInput, setAppNotesInput] = useState(() => school?.appUpdateNotes || '');
  const [appUpdatePassword, setAppUpdatePassword] = useState('');
  const [savingAppUpdate, setSavingAppUpdate] = useState(false);
  const [copiedGeneratedLink, setCopiedGeneratedLink] = useState(false);

  // Zero-Data-Loss Workspace Migration Tool State
  const [migSourceId, setMigSourceId] = useState('');
  const [migTargetId, setMigTargetId] = useState(OFFICIAL_SCHOOL_ID);
  const [migPassword, setMigPassword] = useState('');
  const [migrating, setMigrating] = useState(false);
  const [migReport, setMigReport] = useState<string | null>(null);

  useEffect(() => {
    setAdminTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setExamDrafts(normalizeExamConfigs(school?.examConfigs));
  }, [school?.examConfigs]);

  useEffect(() => {
    if (school?.latestAppVersionCode) setVerCodeInput(String(school.latestAppVersionCode));
    if (school?.latestAppVersionName) setVerNameInput(school.latestAppVersionName);
    if (school?.appUpdateUrl !== undefined) setAppUrlInput(school.appUpdateUrl || '');
    if (school?.appUpdateNotes !== undefined) setAppNotesInput(school.appUpdateNotes || '');
  }, [
    school?.latestAppVersionCode,
    school?.latestAppVersionName,
    school?.appUpdateUrl,
    school?.appUpdateNotes,
  ]);

  if (session?.role !== 'ADMIN') {
    return (
      <div className="bg-white border border-stone-200 rounded-xl p-8 text-center text-sm text-rose-700">
        Admin privileges required.
      </div>
    );
  }

  const teachers = school?.teachers || [];
  const adminCount = teachers.filter((m) => m.role === 'ADMIN').length;

  const isCurrentUser = (m: TeacherMember) =>
    normalizeBdPhone(m.phoneNumber) === session.phoneNumber && m.deviceId === session.deviceId;

  // 1. Remove Teacher Access (STRICT Admin password SHA-256 verification)
  const openRemoveModal = (member: TeacherMember) => {
    setTargetTeacher(member);
    setAdminPasswordInput('');
    setRemovalError(null);
  };

  const handleConfirmRemoval = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetTeacher || !school) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setRemovalError(null);

    if (isCurrentUser(targetTeacher) && adminCount <= 1) {
      setRemovalError(t(lang, 'cannotRemoveSelfOnlyAdmin'));
      return;
    }

    if (!adminPasswordInput) {
      setRemovalError(t(lang, 'wrongAdminPassword'));
      return;
    }

    setRemoving(true);
    try {
      const currentAdminRecord = teachers.find(
        (m) =>
          normalizeBdPhone(m.phoneNumber) === session.phoneNumber &&
          m.role === 'ADMIN'
      );

      if (!currentAdminRecord || !currentAdminRecord.passwordHash) {
        setRemovalError(t(lang, 'wrongAdminPassword'));
        setRemoving(false);
        return;
      }

      const enteredHash = await sha256Hex(adminPasswordInput);
      if (enteredHash !== currentAdminRecord.passwordHash.toLowerCase()) {
        setRemovalError(t(lang, 'wrongAdminPassword'));
        setRemoving(false);
        return;
      }

      const nextTeachers = teachers.filter(
        (m) =>
          !(
            m.deviceId === targetTeacher.deviceId &&
            normalizeBdPhone(m.phoneNumber) === normalizeBdPhone(targetTeacher.phoneNumber)
          )
      );

      await updateDoc(doc(instances.db, 'schools', session.schoolId), {
        teachers: nextTeachers,
        updatedAt: serverTimestamp(),
      });

      setTargetTeacher(null);
      setAdminPasswordInput('');
      setBanner({
        type: 'success',
        text:
          lang === 'bn'
            ? `${targetTeacher.name}-এর অ্যাক্সেস বাতিল করা হয়েছে।`
            : `Access revoked for ${targetTeacher.name}.`,
      });
    } catch (err) {
      setRemovalError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  };

  // 2. Pending Teacher Approvals (Approve / Reject)
  const filteredPending = useMemo(
    () => pendingChanges.filter((c) => c.status === approvalFilter),
    [pendingChanges, approvalFilter]
  );

  const handleApproveChange = async (change: PendingChangeDoc) => {
    const instances = getFirebaseInstances();
    if (!instances || !session) return;

    setProcessingChangeId(change.id);
    setSyncing(true);
    setBanner(null);

    try {
      const payload = JSON.parse(change.payloadJson || '{}');
      const schoolId = session.schoolId;
      const updatedBy = clampText(
        change.submittedByName || session.name,
        FIRESTORE_LIMITS.USER_NAME_MAX_CHARS
      );

      if (change.entityType === 'STUDENT_CREATE' || change.entityType === 'STUDENT_UPDATE') {
        const stData = (payload.student || payload) as Partial<StudentDoc>;
        const targetStudentId =
          change.entityType === 'STUDENT_UPDATE'
            ? String(payload.id || change.targetId)
            : undefined;
        const existing = targetStudentId
          ? students.find((s) => s.id === targetStudentId)
          : undefined;
        const validated = validateAndBuildStudentPayload(
          { ...existing, ...stData },
          schoolId,
          updatedBy,
          existing?.createdAt
        );
        const ref = targetStudentId
          ? doc(instances.db, 'schools', schoolId, 'students', targetStudentId)
          : doc(collection(instances.db, 'schools', schoolId, 'students'));
        await withWriteTimeout(setDoc(ref, validated, { merge: true }));
      } else if (change.entityType === 'STUDENT_DELETE') {
        const targetId = String(payload.studentId || change.targetId);
        if (targetId) {
          await withWriteTimeout(
            deleteDoc(doc(instances.db, 'schools', schoolId, 'students', targetId))
          );
        }
      } else if (change.entityType === 'STUDENT_BATCH_UPDATE') {
        const isRecordUpdatesMap =
          payload &&
          typeof payload === 'object' &&
          payload.updates &&
          typeof payload.updates === 'object' &&
          !Array.isArray(payload.updates);

        if (isRecordUpdatesMap) {
          // Compact patch format: { updates: { [studentId]: { "examResults.<key>": "<string>" } } }
          const entries = Object.entries(
            payload.updates as Record<string, Record<string, unknown>>
          );

          await commitBatchesInChunks(instances.db, entries, (batch, [studentId, patchObj]) => {
            if (!studentId || !patchObj || typeof patchObj !== 'object') return;
            const existing = students.find((s) => s.id === studentId);
            if (!existing) return;

            const mergedExam: Record<string, unknown> = { ...(existing.examResults || {}) };
            const mergedSubj: Record<string, unknown> = { ...(existing.subjectValues || {}) };
            const mergedCustom: Record<string, unknown> = { ...(existing.customValues || {}) };
            let touchedExam = false;
            let touchedSubj = false;
            let touchedCustom = false;
            const directFields: Record<string, unknown> = {};

            for (const [k, v] of Object.entries(patchObj)) {
              if (k.startsWith('examResults.')) {
                touchedExam = true;
                const subKey = k.slice('examResults.'.length);
                const str = String(v ?? '').trim();
                if (str === '') delete mergedExam[subKey];
                else mergedExam[subKey] = str;
              } else if (k.startsWith('subjectValues.')) {
                touchedSubj = true;
                const subKey = k.slice('subjectValues.'.length);
                const str = String(v ?? '').trim();
                if (str === '') delete mergedSubj[subKey];
                else mergedSubj[subKey] = str;
              } else if (k.startsWith('customValues.')) {
                touchedCustom = true;
                const subKey = k.slice('customValues.'.length);
                const str = String(v ?? '').trim();
                if (str === '') delete mergedCustom[subKey];
                else mergedCustom[subKey] = str;
              } else if (
                [
                  'rollNumber',
                  'nextYearRollNumber',
                  'guardianPhone',
                  'sectorNotes',
                  'section',
                  'promotionStatus',
                  'classLevel',
                ].includes(k)
              ) {
                directFields[k] = String(v ?? '').trim();
              } else if (k === 'totalSchoolDays' || k === 'daysPresent') {
                const n = Number(v);
                directFields[k] = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
              }
            }

            const docUpdate: Record<string, unknown> = {
              ...directFields,
              lastUpdatedByName: updatedBy,
              updatedAt: serverTimestamp(),
            };

            if (touchedExam) {
              const sanitized = sanitizeStringRecordMap(mergedExam);
              if (Object.keys(sanitized).length > FIRESTORE_LIMITS.EXAM_RESULTS_MAX_KEYS) {
                throw new Error('Exam results limit exceeded.');
              }
              docUpdate.examResults = sanitized;
            }
            if (touchedSubj) {
              const sanitized = sanitizeStringRecordMap(mergedSubj);
              if (Object.keys(sanitized).length > FIRESTORE_LIMITS.SUBJECT_VALUES_MAX_KEYS) {
                throw new Error('Subject values limit exceeded.');
              }
              docUpdate.subjectValues = sanitized;
            }
            if (touchedCustom) {
              const sanitized = sanitizeStringRecordMap(mergedCustom);
              if (Object.keys(sanitized).length > FIRESTORE_LIMITS.CUSTOM_VALUES_MAX_KEYS) {
                throw new Error('Custom values limit exceeded.');
              }
              docUpdate.customValues = sanitized;
            }

            batch.update(doc(instances.db, 'schools', schoolId, 'students', studentId), docUpdate);
          });
        } else {
          // Legacy array formats: updates[] or students[]
          const items: Array<Record<string, unknown>> = Array.isArray(payload)
            ? payload
            : Array.isArray(payload.updates)
            ? payload.updates
            : Array.isArray(payload.students)
            ? payload.students
            : [];

          await commitBatchesInChunks(instances.db, items, (batch, item) => {
            if (item.data && typeof item.data === 'object') {
              const existingId = item.existingId ? String(item.existingId) : undefined;
              const existing = existingId
                ? students.find((s) => s.id === existingId)
                : undefined;
              const validated = validateAndBuildStudentPayload(
                { ...existing, ...(item.data as Partial<StudentDoc>) },
                schoolId,
                updatedBy,
                existing?.createdAt
              );
              const ref = existingId
                ? doc(instances.db, 'schools', schoolId, 'students', existingId)
                : doc(collection(instances.db, 'schools', schoolId, 'students'));
              batch.set(ref, validated, { merge: true });
              return;
            }

            const studentId = String(item.studentId || item.id || '');
            if (!studentId) return;
            const existing = students.find((s) => s.id === studentId);
            if (!existing) return;

            const ref = doc(instances.db, 'schools', schoolId, 'students', studentId);

            if (item.examResultsPatch && typeof item.examResultsPatch === 'object') {
              const merged = { ...(existing.examResults || {}) } as Record<string, unknown>;
              for (const [k, v] of Object.entries(
                item.examResultsPatch as Record<string, number | string | null>
              )) {
                if (v === null || v === undefined || String(v).trim() === '') {
                  delete merged[k];
                } else {
                  merged[k] = String(v).trim();
                }
              }
              const sanitized = sanitizeStringRecordMap(merged);
              if (Object.keys(sanitized).length > FIRESTORE_LIMITS.EXAM_RESULTS_MAX_KEYS) {
                throw new Error('Exam results limit exceeded.');
              }
              batch.update(ref, {
                examResults: sanitized,
                lastUpdatedByName: updatedBy,
                updatedAt: serverTimestamp(),
              });
            } else if (item.customValues && typeof item.customValues === 'object') {
              const merged = sanitizeStringRecordMap({
                ...(existing.customValues || {}),
                ...(item.customValues as Record<string, unknown>),
              });
              batch.update(ref, {
                customValues: merged,
                lastUpdatedByName: updatedBy,
                updatedAt: serverTimestamp(),
              });
            } else if (item.subjectValues && typeof item.subjectValues === 'object') {
              const merged = sanitizeStringRecordMap({
                ...(existing.subjectValues || {}),
                ...(item.subjectValues as Record<string, unknown>),
              });
              batch.update(ref, {
                subjectValues: merged,
                lastUpdatedByName: updatedBy,
                updatedAt: serverTimestamp(),
              });
            } else if (item.fieldsPatch && typeof item.fieldsPatch === 'object') {
              const rawPatch = { ...(item.fieldsPatch as Record<string, unknown>) };
              for (const strKey of [
                'rollNumber',
                'nextYearRollNumber',
                'guardianPhone',
                'sectorNotes',
                'section',
                'promotionStatus',
                'classLevel',
              ]) {
                if (strKey in rawPatch) {
                  rawPatch[strKey] = String(rawPatch[strKey] ?? '').trim();
                }
              }
              batch.update(ref, {
                ...rawPatch,
                lastUpdatedByName: updatedBy,
                updatedAt: serverTimestamp(),
              });
            }
          });
        }
      } else if (change.entityType === 'SUBJECT_SAVE') {
        const existing = change.targetId
          ? subjects.find((s) => s.id === change.targetId)
          : undefined;
        const subPayload = buildSubjectPayload(payload, schoolId, existing?.createdAt);
        const ref = change.targetId
          ? doc(instances.db, 'schools', schoolId, 'subjects', change.targetId)
          : doc(collection(instances.db, 'schools', schoolId, 'subjects'));
        await withWriteTimeout(setDoc(ref, subPayload, { merge: true }));
      } else if (change.entityType === 'SUBJECT_DELETE') {
        if (change.targetId) {
          await withWriteTimeout(
            deleteDoc(doc(instances.db, 'schools', schoolId, 'subjects', change.targetId))
          );
        }
      } else if (change.entityType === 'CUSTOM_FIELD_SAVE') {
        const existing = change.targetId
          ? customFields.find((c) => c.id === change.targetId)
          : undefined;
        const cfPayload = buildCustomFieldPayload(payload, schoolId, existing?.createdAt);
        const ref = change.targetId
          ? doc(instances.db, 'schools', schoolId, 'customFields', change.targetId)
          : doc(collection(instances.db, 'schools', schoolId, 'customFields'));
        await withWriteTimeout(setDoc(ref, cfPayload, { merge: true }));
      } else if (change.entityType === 'CUSTOM_FIELD_DELETE') {
        if (change.targetId) {
          await withWriteTimeout(
            deleteDoc(doc(instances.db, 'schools', schoolId, 'customFields', change.targetId))
          );
        }
      } else if (change.entityType === 'ATTENDANCE_SAVE') {
        const docId =
          change.targetId ||
          getAttendanceDocId(
            Number(payload.academicYear),
            String(payload.classLevel),
            String(payload.dateKey)
          );
        const attPayload = buildAttendancePayload({
          schoolId,
          academicYear: Number(payload.academicYear),
          classLevel: String(payload.classLevel),
          dateKey: String(payload.dateKey),
          statuses: payload.statuses || {},
          markedByName: updatedBy,
        });
        await withWriteTimeout(
          setDoc(
            doc(instances.db, 'schools', schoolId, 'attendanceLogs', docId),
            attPayload,
            { merge: true }
          )
        );
      } else if (change.entityType === 'EXAM_CONFIG_SAVE') {
        const configs = sanitizeExamConfigs(
          Array.isArray(payload.examConfigs) ? payload.examConfigs : payload
        );
        await withWriteTimeout(
          updateDoc(doc(instances.db, 'schools', schoolId), {
            examConfigs: configs,
            updatedAt: serverTimestamp(),
          })
        );
      }

      await withWriteTimeout(
        updateDoc(doc(instances.db, 'schools', schoolId, 'pendingChanges', change.id), {
          status: 'APPROVED',
          reviewedByName: clampText(session.name, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
          updatedAt: serverTimestamp(),
        })
      );

      setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${formatFirestoreError(err)}`,
      });
    } finally {
      setProcessingChangeId(null);
      setSyncing(false);
    }
  };

  const handleRejectChange = async (change: PendingChangeDoc) => {
    const instances = getFirebaseInstances();
    if (!instances || !session) return;

    setProcessingChangeId(change.id);
    setSyncing(true);
    try {
      await withWriteTimeout(
        updateDoc(doc(instances.db, 'schools', session.schoolId, 'pendingChanges', change.id), {
          status: 'REJECTED',
          reviewedByName: clampText(session.name, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
          updatedAt: serverTimestamp(),
        })
      );
      setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${formatFirestoreError(err)}`,
      });
    } finally {
      setProcessingChangeId(null);
      setSyncing(false);
    }
  };

  // 3. ExamConfigs, Subjects & Custom Fields Setup
  const activeTermConfig = examDrafts.find((c) => c.examId === activeExamTerm) || examDrafts[0];

  const handleAddExamSubject = () => {
    setExamDrafts((prev) =>
      prev.map((term) => {
        if (term.examId !== activeExamTerm) return term;
        const idx = term.subjects.length + 1;
        return {
          ...term,
          subjects: [
            ...term.subjects,
            {
              subjectId: `subj_${Date.now()}_${idx}`,
              subjectName: 'New Subject',
              classScope: 'ALL',
              fullMarks: 100,
              passMarks: 33,
              highestMarkOverride: null,
            },
          ],
        };
      })
    );
  };

  const handleUpdateExamSubject = (
    idx: number,
    patch: Partial<ExamConfig['subjects'][number]>
  ) => {
    setExamDrafts((prev) =>
      prev.map((term) => {
        if (term.examId !== activeExamTerm) return term;
        const nextSubjects = term.subjects.map((s, i) => (i === idx ? { ...s, ...patch } : s));
        return { ...term, subjects: nextSubjects };
      })
    );
  };

  const handleRemoveExamSubject = (idx: number) => {
    setExamDrafts((prev) =>
      prev.map((term) => {
        if (term.examId !== activeExamTerm) return term;
        return {
          ...term,
          subjects: term.subjects.filter((_, i) => i !== idx),
        };
      })
    );
  };

  const handleSaveExamConfigs = async () => {
    const instances = getFirebaseInstances();
    if (!instances || !session) return;
    setSavingExamConfigs(true);
    setBanner(null);
    try {
      const sanitized = sanitizeExamConfigs(examDrafts);
      await updateDoc(doc(instances.db, 'schools', session.schoolId), {
        examConfigs: sanitized,
        updatedAt: serverTimestamp(),
      });
      setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setSavingExamConfigs(false);
    }
  };

  const handleAddSubjectDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    const instances = getFirebaseInstances();
    if (!instances || !session || !newSubjName.trim()) return;

    const fields: SubjectField[] = newSubjFieldLabel.trim()
      ? [
          {
            fieldId: `fld_${Date.now()}`,
            label: newSubjFieldLabel.trim(),
            fieldType: newSubjFieldMax ? 'NUMBER' : 'TEXT',
            maxMarks: Number(newSubjFieldMax) || 0,
          },
        ]
      : [];

    try {
      const payload = buildSubjectPayload(
        { name: newSubjName, gradeScope: newSubjScope, fields },
        session.schoolId
      );
      await setDoc(
        doc(collection(instances.db, 'schools', session.schoolId, 'subjects')),
        payload
      );
      setNewSubjName('');
      setNewSubjFieldLabel('');
      setNewSubjFieldMax('');
      setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleDeleteSubjectDoc = async (id: string) => {
    const instances = getFirebaseInstances();
    if (!instances || !session) return;
    await deleteDoc(doc(instances.db, 'schools', session.schoolId, 'subjects', id));
  };

  const handleAddCustomField = async (e: React.FormEvent) => {
    e.preventDefault();
    const instances = getFirebaseInstances();
    if (!instances || !session || !newCfLabel.trim()) return;
    try {
      const payload = buildCustomFieldPayload(
        {
          category: newCfCategory,
          label: newCfLabel,
          fieldType: newCfType,
          resetsYearly: newCfResets,
        },
        session.schoolId
      );
      await setDoc(
        doc(collection(instances.db, 'schools', session.schoolId, 'customFields')),
        payload
      );
      setNewCfLabel('');
      setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleDeleteCustomField = async (id: string) => {
    const instances = getFirebaseInstances();
    if (!instances || !session) return;
    await deleteDoc(doc(instances.db, 'schools', session.schoolId, 'customFields', id));
  };

  // 4. Delete ONLY Uploaded APK Chunks From Server (Preserves All Student/School Data)
  const handleDeleteApkChunks = async (e: React.FormEvent) => {
    e.preventDefault();
    const instances = getFirebaseInstances();
    if (!instances || !session) return;

    if (!cleanupPassword) {
      setBanner({ type: 'error', text: t(lang, 'adminPasswordRequiredForCleanup') });
      return;
    }

    setCleaningApk(true);
    setSyncing(true);
    setBanner(null);
    setDeletedSoFar(0);

    try {
      const currentAdminRecord = teachers.find(
        (m) =>
          normalizeBdPhone(m.phoneNumber) === session.phoneNumber &&
          m.role === 'ADMIN'
      );

      if (!currentAdminRecord || !currentAdminRecord.passwordHash) {
        setBanner({ type: 'error', text: t(lang, 'wrongAdminPasswordCleanup') });
        return;
      }

      const enteredHash = await sha256Hex(cleanupPassword);
      if (enteredHash !== currentAdminRecord.passwordHash.toLowerCase()) {
        setBanner({ type: 'error', text: t(lang, 'wrongAdminPasswordCleanup') });
        return;
      }

      const { deletedChunks } = await deleteUploadedApkChunksFromServer({
        db: instances.db,
        schoolId: session.schoolId,
        onProgress: setDeletedSoFar,
      });

      setLastDeletedResult(deletedChunks);
      setCleanupPassword('');
      setBanner({
        type: 'success',
        text:
          lang === 'bn'
            ? `${deletedChunks} টি APK অংশ সার্ভার থেকে মুছে ফেলা হয়েছে। সকল শিক্ষার্থী ও নম্বর সম্পূর্ণ অক্ষত রয়েছে।`
            : `Deleted ${deletedChunks} APK chunks. All student & marks data is untouched.`,
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${formatFirestoreError(err)}`,
      });
    } finally {
      setCleaningApk(false);
      setSyncing(false);
    }
  };

  // 5. Publish Android App Update Metadata (Strict 5-field payload on schools/{schoolId})
  const resolvedAppLink = useMemo(
    () => resolveDirectApkDownloadInfo(appUrlInput || school?.appUpdateUrl || ''),
    [appUrlInput, school?.appUpdateUrl]
  );

  const handleGenerateAndCopyUpdateLink = async () => {
    const info = resolveDirectApkDownloadInfo(appUrlInput || school?.appUpdateUrl || '');
    if (!info?.directDownloadUrl) {
      setBanner({
        type: 'error',
        text:
          lang === 'bn'
            ? 'সঠিক Google Drive / GitHub / সরাসরি APK লিংক লিখুন।'
            : 'Enter a valid external APK URL (Google Drive, GitHub Releases, Dropbox, or direct .apk) first.',
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(info.directDownloadUrl);
      setCopiedGeneratedLink(true);
      setTimeout(() => setCopiedGeneratedLink(false), 2600);
    } catch {
      // ignore
    }
  };

  const handlePublishAppUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    const instances = getFirebaseInstances();
    if (!instances || !session) return;

    setBanner(null);
    const code = Math.trunc(Number(verCodeInput));
    if (!Number.isFinite(code) || code < 1 || code > 999999) {
      setBanner({
        type: 'error',
        text:
          lang === 'bn'
            ? 'ভার্সন কোড ১ থেকে ৯৯৯৯৯৯-এর মধ্যে পূর্ণসংখ্যা হতে হবে।'
            : 'Version Code must be an integer between 1 and 999999.',
      });
      return;
    }

    const verName = String(verNameInput || '').trim().slice(0, 20);
    if (!verName) {
      setBanner({
        type: 'error',
        text: lang === 'bn' ? 'ভার্সন নাম লিখুন (যেমন 2.0)।' : 'Version Name is required.',
      });
      return;
    }

    const normalizedUrl = normalizeAppUpdateUrl(appUrlInput).slice(0, 500);
    if (!normalizedUrl) {
      setBanner({
        type: 'error',
        text:
          lang === 'bn'
            ? 'সঠিক https:// বা http:// APK ডাউনলোড লিংক দিন।'
            : 'Please enter a valid https:// or http:// APK download URL.',
      });
      return;
    }

    if (isSameHostnameUrl(normalizedUrl)) {
      const validBinary = await verifySelfHostedApkUrl(normalizedUrl);
      if (!validBinary) {
        setBanner({
          type: 'error',
          text:
            'This URL points back to the website itself and has no APK file. Upload your .apk to Google Drive ("Anyone with the link") or GitHub Releases and paste that link here.',
        });
        return;
      }
    }

    if (!appUpdatePassword) {
      setBanner({ type: 'error', text: t(lang, 'wrongAdminPassword') });
      return;
    }

    setSavingAppUpdate(true);
    setSyncing(true);
    try {
      const currentAdminRecord = teachers.find(
        (m) =>
          normalizeBdPhone(m.phoneNumber) === session.phoneNumber &&
          m.role === 'ADMIN'
      );
      if (!currentAdminRecord?.passwordHash) {
        setBanner({ type: 'error', text: t(lang, 'wrongAdminPassword') });
        return;
      }
      const enteredHash = await sha256Hex(appUpdatePassword);
      if (enteredHash !== currentAdminRecord.passwordHash.toLowerCase()) {
        setBanner({ type: 'error', text: t(lang, 'wrongAdminPassword') });
        return;
      }

      const notes = String(appNotesInput || '').trim().slice(0, 300);

      // STRICT 5-field update payload on schools/{schoolId}
      await withWriteTimeout(
        updateDoc(doc(instances.db, 'schools', session.schoolId), {
          latestAppVersionCode: code,
          latestAppVersionName: verName,
          appUpdateUrl: normalizedUrl,
          appUpdateNotes: notes,
          updatedAt: serverTimestamp(),
        })
      );

      setAppUpdatePassword('');
      setBanner({
        type: 'success',
        text:
          lang === 'bn'
            ? `অ্যান্ড্রয়েড অ্যাপ আপডেট v${verName} (#${code}) সফলভাবে প্রকাশিত হয়েছে।`
            : `Published Android App update v${verName} (#${code}).`,
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${formatFirestoreError(err)}`,
      });
    } finally {
      setSavingAppUpdate(false);
      setSyncing(false);
    }
  };

  // 6. Zero-Data-Loss Workspace Migration Tool (Never overwrites or deletes destination data)
  const handleMigrateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    const instances = getFirebaseInstances();
    if (!instances || !session) return;

    const srcId = normalizeSchoolId(migSourceId);
    const dstId = normalizeSchoolId(migTargetId);

    if (!srcId || !dstId) {
      setBanner({
        type: 'error',
        text:
          lang === 'bn'
            ? 'সঠিক উৎস এবং গন্তব্য স্কুল আইডি লিখুন।'
            : 'Please enter valid Source and Target School IDs.',
      });
      return;
    }

    if (srcId === dstId) {
      setBanner({
        type: 'error',
        text:
          lang === 'bn'
            ? 'উৎস এবং গন্তব্য স্কুল আইডি আলাদা হতে হবে।'
            : 'Source and Target School IDs must be different.',
      });
      return;
    }

    if (!migPassword) {
      setBanner({ type: 'error', text: t(lang, 'wrongAdminPassword') });
      return;
    }

    setMigrating(true);
    setSyncing(true);
    setBanner(null);
    setMigReport(null);

    try {
      const currentAdminRecord = teachers.find(
        (m) =>
          normalizeBdPhone(m.phoneNumber) === session.phoneNumber &&
          m.role === 'ADMIN'
      );
      if (!currentAdminRecord?.passwordHash) {
        setBanner({ type: 'error', text: t(lang, 'wrongAdminPassword') });
        return;
      }
      const enteredHash = await sha256Hex(migPassword);
      if (enteredHash !== currentAdminRecord.passwordHash.toLowerCase()) {
        setBanner({ type: 'error', text: t(lang, 'wrongAdminPassword') });
        return;
      }

      const srcSchoolSnap = await getDoc(doc(instances.db, 'schools', srcId));
      if (!srcSchoolSnap.exists()) {
        throw new Error(`Source school "${srcId}" does not exist.`);
      }
      const srcSchoolData = srcSchoolSnap.data() as Record<string, unknown>;
      const dstSchoolRef = doc(instances.db, 'schools', dstId);
      const dstSchoolSnap = await getDoc(dstSchoolRef);
      const dstSchoolData = dstSchoolSnap.exists()
        ? (dstSchoolSnap.data() as Record<string, unknown>)
        : {};

      // Merge school metadata ONLY for missing fields on target (never overwrite existing target settings)
      const schoolPatch: Record<string, unknown> = {
        schoolId: dstId,
        updatedAt: serverTimestamp(),
      };
      if (!dstSchoolData.schoolName) {
        schoolPatch.schoolName =
          srcSchoolData.schoolName ||
          (dstId === OFFICIAL_SCHOOL_ID ? OFFICIAL_SCHOOL_NAME_EN : dstId);
      }
      if (!dstSchoolData.emisCode) {
        schoolPatch.emisCode =
          srcSchoolData.emisCode ||
          (dstId === OFFICIAL_SCHOOL_ID ? OFFICIAL_EMIS_CODE : '');
      }
      if (!dstSchoolData.upazilaDistrict && srcSchoolData.upazilaDistrict) {
        schoolPatch.upazilaDistrict = srcSchoolData.upazilaDistrict;
      }
      if (!dstSchoolData.defaultAcademicYear && srcSchoolData.defaultAcademicYear) {
        schoolPatch.defaultAcademicYear = srcSchoolData.defaultAcademicYear;
      }
      if (
        (!Array.isArray(dstSchoolData.examConfigs) || dstSchoolData.examConfigs.length === 0) &&
        Array.isArray(srcSchoolData.examConfigs)
      ) {
        schoolPatch.examConfigs = sanitizeExamConfigs(srcSchoolData.examConfigs);
      }

      const existingDstTeachers = Array.isArray(dstSchoolData.teachers)
        ? (dstSchoolData.teachers as TeacherMember[])
        : [];
      const srcTeachers = Array.isArray(srcSchoolData.teachers)
        ? (srcSchoolData.teachers as TeacherMember[])
        : [];
      const mergedTeachers = [...existingDstTeachers];
      for (const stMember of srcTeachers) {
        const normPhone = normalizeBdPhone(stMember.phoneNumber || '');
        const already = mergedTeachers.some(
          (m) =>
            normalizeBdPhone(m.phoneNumber || '') === normPhone ||
            (stMember.deviceId && m.deviceId === stMember.deviceId)
        );
        if (!already) {
          mergedTeachers.push(stMember);
        }
      }
      if (mergedTeachers.length > existingDstTeachers.length || !dstSchoolSnap.exists()) {
        schoolPatch.teachers = mergedTeachers;
      }
      if (!dstSchoolSnap.exists()) {
        schoolPatch.createdAt = serverTimestamp();
      }

      await withWriteTimeout(setDoc(dstSchoolRef, schoolPatch, { merge: true }));

      // Subcollections to migrate WITHOUT overwriting existing destination doc IDs
      const subcols = [
        'students',
        'subjects',
        'customFields',
        'attendanceLogs',
        'parentNotices',
        'messages',
      ] as const;

      const summaryParts: string[] = [];

      for (const subcol of subcols) {
        const [srcSnap, dstSnap] = await Promise.all([
          getDocs(collection(instances.db, 'schools', srcId, subcol)),
          getDocs(collection(instances.db, 'schools', dstId, subcol)),
        ]);

        const existingDstIds = new Set(dstSnap.docs.map((d) => d.id));
        const toCopy = srcSnap.docs.filter((d) => !existingDstIds.has(d.id));
        const skipped = srcSnap.docs.length - toCopy.length;

        if (toCopy.length > 0) {
          await withWriteTimeout(
            commitBatchesInChunks(
              instances.db,
              toCopy,
              (batch, srcDoc) => {
                const raw = srcDoc.data() as Record<string, unknown>;
                const cloned: Record<string, unknown> = {
                  ...raw,
                  schoolId: dstId,
                  updatedAt: serverTimestamp(),
                };
                batch.set(
                  doc(instances.db, 'schools', dstId, subcol, srcDoc.id),
                  cloned,
                  { merge: true }
                );
              },
              200
            )
          );
        }

        summaryParts.push(`${subcol}: +${toCopy.length} copied (${skipped} kept)`);
      }

      const reportStr = summaryParts.join(' · ');
      setMigReport(reportStr);
      setMigPassword('');
      setBanner({
        type: 'success',
        text:
          lang === 'bn'
            ? `${srcId} থেকে ${dstId}-এ নিরাপদ মাইগ্রেশন সম্পন্ন হয়েছে (কোনো বিদ্যমান তথ্য মুছে ফেলা হয়নি)।`
            : `Zero-data-loss migration from ${srcId} to ${dstId} complete.`,
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${formatFirestoreError(err)}`,
      });
    } finally {
      setMigrating(false);
      setSyncing(false);
    }
  };

  const pendingBadgeCount = pendingChanges.filter((c) => c.status === 'PENDING').length;

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

      {/* Admin Sub-Navigation */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-stone-200/70 rounded-lg w-fit">
        {(
          [
            { id: 'teachers', label: t(lang, 'tabTeachers') },
            {
              id: 'approvals',
              label:
                pendingBadgeCount > 0
                  ? `${t(lang, 'tabApprovals')} (${pendingBadgeCount})`
                  : t(lang, 'tabApprovals'),
            },
            { id: 'setup', label: t(lang, 'tabSetup') },
            { id: 'update', label: t(lang, 'tabAppUpdate') },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setAdminTab(tab.id)}
            className={`px-3.5 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              adminTab === tab.id
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* TAB 1: Connected Teachers & Access Control */}
      {adminTab === 'teachers' && (
        <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-stone-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                {t(lang, 'tabTeachers')}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {lang === 'bn'
                  ? 'তালিকা থেকে কোনো শিক্ষককে অপসারণ করলে তাৎক্ষণিকভাবে ওয়েবসাইট ও স্কুল রোস্টার থেকে তার অ্যাক্সেস বাতিল হবে।'
                  : 'Removing a teacher immediately locks them out of the website and removes them from the active school roster.'}
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-slate-600">
              {teachers.length} {lang === 'bn' ? 'জন সদস্য' : 'Members'}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">{lang === 'bn' ? 'নাম' : 'Name'}</th>
                  <th className="py-3 px-4">{t(lang, 'phoneLabel')}</th>
                  <th className="py-3 px-4">{lang === 'bn' ? 'ভূমিকা' : 'Role'}</th>
                  <th className="py-3 px-4">{lang === 'bn' ? 'ডিভাইস আইডি' : 'Device ID'}</th>
                  <th className="py-3 px-4">{lang === 'bn' ? 'যোগদানের তারিখ' : 'Joined Date'}</th>
                  <th className="py-3 px-4 text-right">{lang === 'bn' ? 'নিয়ন্ত্রণ' : 'Access Control'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {teachers.map((member, idx) => {
                  const self = isCurrentUser(member);
                  return (
                    <tr key={`${member.deviceId}_${idx}`} className="hover:bg-stone-50/70">
                      <td className="py-3 px-4 font-medium text-slate-900">
                        {member.name}
                        {self && (
                          <span className="ml-2 text-xs text-emerald-700 font-normal">
                            ({lang === 'bn' ? 'আপনি' : 'You'})
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-700">
                        {member.phoneNumber}
                      </td>
                      <td className="py-3 px-4 text-xs font-semibold">
                        <span
                          className={
                            member.role === 'ADMIN' ? 'text-emerald-800' : 'text-slate-600'
                          }
                        >
                          {member.role === 'ADMIN' ? 'ADMIN' : 'TEACHER'}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-slate-500 max-w-[180px] truncate">
                        {member.deviceId || '—'}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 tabular-nums">
                        {member.joinedAtMs ? formatTimestampDateTime(member.joinedAtMs) : '—'}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {!self ? (
                          <button
                            type="button"
                            onClick={() => openRemoveModal(member)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                          >
                            <UserX className="w-3.5 h-3.5" />
                            <span>{t(lang, 'removeAccess')}</span>
                          </button>
                        ) : (
                          <span className="text-xs text-slate-400">
                            {adminCount <= 1
                              ? lang === 'bn'
                                ? 'একমাত্র অ্যাডমিন'
                                : 'Primary Admin'
                              : '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: Pending Teacher Approvals */}
      {adminTab === 'approvals' && (
        <div className="space-y-4">
          <div className="flex items-center gap-1 p-1 bg-stone-100 border border-stone-200 rounded-lg w-fit">
            {(['PENDING', 'APPROVED', 'REJECTED'] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setApprovalFilter(status)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                  approvalFilter === status
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {status}
              </button>
            ))}
          </div>

          <div className="bg-white border border-stone-200 rounded-xl divide-y divide-stone-200">
            {filteredPending.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {lang === 'bn'
                  ? 'এই বিভাগে কোনো আবেদন নেই।'
                  : `No ${approvalFilter.toLowerCase()} changes found.`}
              </div>
            ) : (
              filteredPending.map((change) => (
                <div key={change.id} className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className="font-mono font-semibold text-slate-800">
                        {change.entityType}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{change.submittedByName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {formatTimestampDateTime(change.createdAt)}
                      </span>
                    </div>
                    <h4 className="text-sm font-semibold text-slate-900">{change.summary}</h4>
                    {change.detailsText && (
                      <p className="text-xs text-slate-600">{change.detailsText}</p>
                    )}
                    {change.reviewedByName && change.status !== 'PENDING' && (
                      <p className="text-xs text-slate-500">
                        Reviewed by {change.reviewedByName}
                      </p>
                    )}
                  </div>

                  {change.status === 'PENDING' && (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        disabled={processingChangeId === change.id}
                        onClick={() => handleApproveChange(change)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>{t(lang, 'approve')}</span>
                      </button>
                      <button
                        type="button"
                        disabled={processingChangeId === change.id}
                        onClick={() => handleRejectChange(change)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 disabled:opacity-50 rounded-lg cursor-pointer whitespace-nowrap"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>{t(lang, 'reject')}</span>
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Marksheet (examConfigs), Subjects & Custom Fields Setup */}
      {adminTab === 'setup' && (
        <div className="space-y-6">
          {/* Exam Configs Editor */}
          <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-stone-200">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {lang === 'bn'
                    ? 'প্রান্তিক পরীক্ষা ও বিষয় কনফিগারেশন (examConfigs)'
                    : 'Term Exams & Subjects Configuration (examConfigs)'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {lang === 'bn'
                    ? 'অ্যান্ড্রয়েড অ্যাপের মার্কশিট ও ওয়েব ব্যাচ এন্ট্রির সাথে সরাসরি সিঙ্ক হয়।'
                    : 'Synced directly with Android marksheets and web batch marks entry.'}
                </p>
              </div>
              <button
                type="button"
                disabled={savingExamConfigs}
                onClick={handleSaveExamConfigs}
                className="px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
              >
                {savingExamConfigs ? t(lang, 'loading') : t(lang, 'saveChanges')}
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1 p-1 bg-stone-100 rounded-lg">
                {(['exam_1', 'exam_2', 'exam_3'] as const).map((tid) => (
                  <button
                    key={tid}
                    type="button"
                    onClick={() => setActiveExamTerm(tid)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                      activeExamTerm === tid
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {getOfficialExamLabel(tid, lang)}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={handleAddExamSubject}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{lang === 'bn' ? 'বিষয় যুক্ত করুন' : 'Add Exam Subject'}</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="bg-stone-50 border-b border-stone-200 text-slate-600 font-semibold">
                    <th className="py-2 px-3">Subject ID</th>
                    <th className="py-2 px-3">Subject Name</th>
                    <th className="py-2 px-3">Class Scope</th>
                    <th className="py-2 px-3 w-24">Full Marks</th>
                    <th className="py-2 px-3 w-24">Pass Marks</th>
                    <th className="py-2 px-3 w-12"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {activeTermConfig.subjects.map((subj, idx) => (
                    <tr key={`${subj.subjectId}_${idx}`}>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={subj.subjectId}
                          onChange={(e) =>
                            handleUpdateExamSubject(idx, { subjectId: e.target.value })
                          }
                          className="w-full px-2 py-1.5 border border-stone-300 rounded font-mono"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={subj.subjectName}
                          onChange={(e) =>
                            handleUpdateExamSubject(idx, { subjectName: e.target.value })
                          }
                          className="w-full px-2 py-1.5 border border-stone-300 rounded"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="text"
                          value={subj.classScope}
                          onChange={(e) =>
                            handleUpdateExamSubject(idx, { classScope: e.target.value })
                          }
                          placeholder="ALL or Class 1, Class 2"
                          className="w-full px-2 py-1.5 border border-stone-300 rounded"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="number"
                          value={subj.fullMarks}
                          onChange={(e) =>
                            handleUpdateExamSubject(idx, { fullMarks: Number(e.target.value) })
                          }
                          className="w-full px-2 py-1.5 border border-stone-300 rounded font-mono tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-2">
                        <input
                          type="number"
                          value={subj.passMarks}
                          onChange={(e) =>
                            handleUpdateExamSubject(idx, { passMarks: Number(e.target.value) })
                          }
                          className="w-full px-2 py-1.5 border border-stone-300 rounded font-mono tabular-nums"
                        />
                      </td>
                      <td className="py-1.5 px-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveExamSubject(idx)}
                          className="p-1 text-rose-600 hover:bg-rose-50 rounded cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Subjects & Custom Fields Subcollections */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Subjects */}
            <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
              <h3 className="text-base font-semibold text-slate-900">
                {lang === 'bn' ? 'বিষয়ভিত্তিক মূল্যায়ন (subjects)' : 'Subject Assessments (subjects)'}
              </h3>

              <form onSubmit={handleAddSubjectDoc} className="grid grid-cols-2 gap-2.5">
                <input
                  type="text"
                  required
                  value={newSubjName}
                  onChange={(e) => setNewSubjName(e.target.value)}
                  placeholder="Subject Name"
                  className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg"
                />
                <input
                  type="text"
                  value={newSubjScope}
                  onChange={(e) => setNewSubjScope(e.target.value)}
                  placeholder="Scope (ALL / Class 1)"
                  className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg"
                />
                <input
                  type="text"
                  value={newSubjFieldLabel}
                  onChange={(e) => setNewSubjFieldLabel(e.target.value)}
                  placeholder="Assessment Field Label (optional)"
                  className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg"
                />
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={newSubjFieldMax}
                    onChange={(e) => setNewSubjFieldMax(e.target.value)}
                    placeholder="Max Marks"
                    className="w-full px-3 py-1.5 text-sm border border-stone-300 rounded-lg font-mono"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-semibold bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 cursor-pointer shrink-0"
                  >
                    Add
                  </button>
                </div>
              </form>

              <div className="divide-y divide-stone-100 border-t border-stone-200">
                {subjects.map((s) => (
                  <div key={s.id} className="py-2.5 flex items-center justify-between gap-2 text-sm">
                    <div>
                      <div className="font-medium text-slate-900">{s.name}</div>
                      <div className="text-xs text-slate-500">
                        Scope: {s.gradeScope} · {s.fields?.length || 0} fields
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteSubjectDoc(s.id)}
                      className="p-1.5 text-rose-600 hover:bg-rose-50 rounded cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Custom Fields */}
            <div className="bg-white border border-stone-200 rounded-xl p-5 space-y-4">
              <h3 className="text-base font-semibold text-slate-900">
                {lang === 'bn' ? 'কাস্টম ফিল্ডসমূহ (customFields)' : 'Custom Student Fields (customFields)'}
              </h3>

              <form onSubmit={handleAddCustomField} className="grid grid-cols-2 gap-2.5">
                <input
                  type="text"
                  value={newCfCategory}
                  onChange={(e) => setNewCfCategory(e.target.value)}
                  placeholder="Category (e.g. Stipend)"
                  className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg"
                />
                <input
                  type="text"
                  required
                  value={newCfLabel}
                  onChange={(e) => setNewCfLabel(e.target.value)}
                  placeholder="Field Label"
                  className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg"
                />
                <select
                  value={newCfType}
                  onChange={(e) => setNewCfType(e.target.value as CustomFieldType)}
                  className="px-3 py-1.5 text-sm border border-stone-300 rounded-lg bg-white"
                >
                  <option value="TEXT">TEXT</option>
                  <option value="NUMBER">NUMBER</option>
                  <option value="YES_NO">YES_NO</option>
                </select>
                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newCfResets}
                      onChange={(e) => setNewCfResets(e.target.checked)}
                    />
                    <span>Resets Yearly</span>
                  </label>
                  <button
                    type="submit"
                    className="px-3 py-1.5 text-xs font-semibold bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 cursor-pointer shrink-0"
                  >
                    Add
                  </button>
                </div>
              </form>

              <div className="divide-y divide-stone-100 border-t border-stone-200">
                {customFields.map((cf) => (
                  <div key={cf.id} className="py-2.5 flex items-center justify-between gap-2 text-sm">
                    <div>
                      <div className="font-medium text-slate-900">{cf.label}</div>
                      <div className="text-xs text-slate-500">
                        {cf.category} · {cf.fieldType} · {cf.resetsYearly ? 'Yearly' : 'Permanent'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteCustomField(cf.id)}
                      className="p-1.5 text-rose-600 hover:bg-rose-50 rounded cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Android App Update Publisher, Safe Workspace Migration & APK Cleanup */}
      {adminTab === 'update' && (
        <div className="space-y-6 max-w-3xl">
          {/* A. Publish Android App Update Link */}
          <form
            onSubmit={handlePublishAppUpdate}
            className="bg-white border border-stone-200 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-start gap-3 pb-3 border-b border-stone-200">
              <div className="w-10 h-10 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center shrink-0">
                <Smartphone className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {lang === 'bn'
                    ? 'অ্যান্ড্রয়েড অ্যাপ আপডেট প্রকাশ ও লিংক জেনারেটর'
                    : 'Publish Android App Update & Link Generator'}
                </h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  {lang === 'bn'
                    ? 'Google Drive, GitHub Releases বা সরাসরি .apk লিংক দিলে স্বয়ংক্রিয়ভাবে সরাসরি ডাউনলোড লিংক তৈরি হয়।'
                    : 'Supports Google Drive share links, GitHub Releases, Dropbox, or direct external .apk URLs.'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Version Code (integer)
                </label>
                <input
                  type="number"
                  min={1}
                  max={999999}
                  required
                  value={verCodeInput}
                  onChange={(e) => setVerCodeInput(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-stone-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Version Name
                </label>
                <input
                  type="text"
                  maxLength={20}
                  required
                  value={verNameInput}
                  onChange={(e) => setVerNameInput(e.target.value)}
                  placeholder="2.0"
                  className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                External APK URL (Google Drive / GitHub Releases / Direct .apk)
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  maxLength={500}
                  required
                  value={appUrlInput}
                  onChange={(e) => setAppUrlInput(e.target.value)}
                  placeholder="https://drive.google.com/file/d/.../view"
                  className="flex-1 px-3 py-2 text-sm border border-stone-300 rounded-lg"
                />
                <button
                  type="button"
                  onClick={handleGenerateAndCopyUpdateLink}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded-lg cursor-pointer whitespace-nowrap"
                >
                  {copiedGeneratedLink ? (
                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                  ) : (
                    <Link2 className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {copiedGeneratedLink
                      ? lang === 'bn'
                        ? 'লিংক কপি হয়েছে'
                        : 'Link Copied'
                      : lang === 'bn'
                      ? 'আপডেট লিংক তৈরি করুন'
                      : 'Generate Update Link'}
                  </span>
                </button>
              </div>
              {resolvedAppLink && (
                <div className="mt-2 p-2.5 rounded-lg bg-stone-50 border border-stone-200 flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-slate-700 truncate">
                    {resolvedAppLink.directDownloadUrl}
                  </span>
                  <button
                    type="button"
                    onClick={handleGenerateAndCopyUpdateLink}
                    className="p-1 text-slate-600 hover:text-slate-900 cursor-pointer shrink-0"
                    title="Copy Direct Link"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Release Notes
              </label>
              <textarea
                rows={2}
                maxLength={300}
                value={appNotesInput}
                onChange={(e) => setAppNotesInput(e.target.value)}
                placeholder="What's new in this update..."
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'adminPasswordLabel')}
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    required
                    value={appUpdatePassword}
                    onChange={(e) => setAppUpdatePassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={savingAppUpdate}
                className="px-4 py-2.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer"
              >
                {savingAppUpdate
                  ? t(lang, 'loading')
                  : lang === 'bn'
                  ? 'অ্যাপ আপডেট প্রকাশ করুন'
                  : 'Publish App Update'}
              </button>
            </div>
          </form>

          {/* B. Zero-Data-Loss Workspace Migration Tool */}
          <form
            onSubmit={handleMigrateWorkspace}
            className="bg-white border border-stone-200 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-start gap-3 pb-3 border-b border-stone-200">
              <div className="w-10 h-10 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center shrink-0">
                <ArrowRightLeft className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {lang === 'bn'
                    ? 'নিরাপদ ওয়ার্কস্পেস মাইগ্রেশন (Zero Data Loss)'
                    : 'Zero-Data-Loss Workspace Migration'}
                </h3>
                <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                  {lang === 'bn'
                    ? 'পুরোনো স্কুল আইডি থেকে অফিসিয়াল স্কুল আইডি (139783)-তে অনুপস্থিত শিক্ষার্থী, নম্বর, উপস্থিতি ও তথ্য কপি করুন। গন্তব্যের কোনো বিদ্যমান তথ্য মুছে ফেলা বা প্রতিস্থাপন করা হবে না।'
                    : 'Safely copy missing students, marks, subjects, customFields, attendance, notices, and messages from an older School ID into Target School ID (139783). Existing destination records are never overwritten or deleted.'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {lang === 'bn' ? 'উৎস স্কুল আইডি (পুরোনো)' : 'Source School ID (Old)'}
                </label>
                <input
                  type="text"
                  required
                  value={migSourceId}
                  onChange={(e) => setMigSourceId(e.target.value)}
                  placeholder="e.g. OLD-SCHOOL-ID"
                  className="w-full px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg uppercase"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {lang === 'bn' ? 'গন্তব্য স্কুল আইডি (অফিসিয়াল)' : 'Target School ID (Official)'}
                </label>
                <input
                  type="text"
                  required
                  value={migTargetId}
                  onChange={(e) => setMigTargetId(e.target.value)}
                  placeholder={OFFICIAL_SCHOOL_ID}
                  className="w-full px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg uppercase"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {t(lang, 'adminPasswordLabel')}
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    required
                    value={migPassword}
                    onChange={(e) => setMigPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={migrating}
                className="px-4 py-2.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer"
              >
                {migrating
                  ? lang === 'bn'
                    ? 'মাইগ্রেট হচ্ছে...'
                    : 'Migrating safely...'
                  : lang === 'bn'
                  ? 'নিরাপদে মাইগ্রেট করুন'
                  : 'Run Safe Merge Migration'}
              </button>
            </div>

            {migReport && (
              <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 font-mono">
                {migReport}
              </div>
            )}
          </form>

          {/* C. Safe Server APK Cleanup */}
          <form
            onSubmit={handleDeleteApkChunks}
            className="bg-white border border-stone-200 rounded-xl p-6 space-y-5"
          >
            <div className="flex items-start justify-between gap-3 pb-4 border-b border-stone-200">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 flex items-center justify-center shrink-0 mt-0.5">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-900">
                    {t(lang, 'deleteApkTitle')}
                  </h3>
                  <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                    {t(lang, 'deleteApkDesc')}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 rounded-lg bg-emerald-50/70 border border-emerald-200 flex items-start gap-3 text-xs text-emerald-950">
              <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold">
                  {lang === 'bn'
                    ? 'নিরাপদ ক্লিনআপ গ্যারান্টি'
                    : 'Protected Collections (Never Modified or Deleted)'}
                </div>
                <p className="text-emerald-900/90 leading-relaxed">
                  <code>students</code>, <code>subjects</code>, <code>customFields</code>,{' '}
                  <code>attendanceLogs</code>, <code>pendingChanges</code>,{' '}
                  <code>parentNotices</code>, <code>messages</code>, <code>teachers</code>
                </p>
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-stone-50 border border-stone-200 text-xs text-slate-700 space-y-1">
              <div>
                <span className="font-semibold text-slate-900">
                  {lang === 'bn' ? 'বর্তমান APK মেটাডেটা:' : 'Current APK Metadata on School Doc:'}
                </span>{' '}
                {hasLegacyApkMetadata(school) ? (
                  <span className="font-mono text-amber-800">
                    v{school?.latestAppVersionName || '—'} (#{school?.latestAppVersionCode ?? 0})
                  </span>
                ) : (
                  <span className="font-medium text-emerald-700">
                    {lang === 'bn' ? 'পরিষ্কার (0 / খালি)' : 'Clean (0 / empty)'}
                  </span>
                )}
              </div>
              {lastDeletedResult !== null && (
                <div className="text-emerald-800 font-medium">
                  {lang === 'bn'
                    ? `সর্বশেষ ক্লিনআপে ${lastDeletedResult} টি APK অংশ মুছে ফেলা হয়েছে।`
                    : `Last cleanup removed ${lastDeletedResult} APK chunk document(s).`}
                </div>
              )}
            </div>

            <div>
              <label
                htmlFor="cleanup-admin-pw"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {t(lang, 'adminPasswordLabel')}
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="cleanup-admin-pw"
                  type="password"
                  required
                  disabled={cleaningApk}
                  value={cleanupPassword}
                  onChange={(e) => setCleanupPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-600 disabled:bg-stone-50"
                />
              </div>
              <p className="text-[11px] text-slate-500 mt-1">
                {t(lang, 'adminPasswordRequiredForCleanup')}
              </p>
            </div>

            {cleaningApk && (
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs font-medium text-amber-900">
                {t(lang, 'deletingApkProgress')} ({deletedSoFar})
              </div>
            )}

            <button
              type="submit"
              disabled={cleaningApk}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-lg cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                {cleaningApk
                  ? `${t(lang, 'deletingApkProgress')} (${deletedSoFar})`
                  : t(lang, 'deleteApkBtn')}
              </span>
            </button>
          </form>
        </div>
      )}

      {/* Confirm Teacher Removal with Admin Password Modal */}
      {targetTeacher && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmRemoval}
            className="bg-white border border-stone-200 rounded-xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {t(lang, 'confirmRemovalTitle')}
                </h3>
                <p className="text-xs text-slate-600 mt-1">
                  {t(lang, 'confirmRemovalDesc')}
                </p>
              </div>
            </div>

            <div className="bg-stone-50 border border-stone-200 rounded-lg p-3.5 text-sm space-y-1">
              <div className="font-semibold text-slate-900">{targetTeacher.name}</div>
              <div className="text-xs font-mono tabular-nums text-slate-600">
                {targetTeacher.phoneNumber} · {targetTeacher.role}
              </div>
            </div>

            {removalError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800"
              >
                {removalError}
              </div>
            )}

            <div>
              <label
                htmlFor="confirm-admin-pw"
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                {t(lang, 'adminPasswordLabel')}
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="confirm-admin-pw"
                  type="password"
                  required
                  autoFocus
                  value={adminPasswordInput}
                  onChange={(e) => setAdminPasswordInput(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-600"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setTargetTeacher(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer"
              >
                {t(lang, 'cancel')}
              </button>
              <button
                type="submit"
                disabled={removing}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-60 rounded-lg cursor-pointer"
              >
                {removing ? t(lang, 'loading') : t(lang, 'removeAccess')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
