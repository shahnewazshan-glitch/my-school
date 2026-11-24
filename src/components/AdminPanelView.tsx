import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  Check,
  FileArchive,
  KeyRound,
  Plus,
  ShieldAlert,
  Smartphone,
  Trash2,
  Upload,
  UserX,
  X,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import {
  APK_CHUNK_SIZE_BYTES,
  MAX_APK_CHUNKS,
  type ApkUploadProgress,
  uploadPrivateApkRelease,
} from '../lib/apkChunks';
import { getFirebaseInstances } from '../lib/firebase';
import {
  buildAttendancePayload,
  buildCustomFieldPayload,
  buildSubjectPayload,
  FIRESTORE_LIMITS,
  sanitizeExamConfigs,
  sanitizeStringRecordMap,
  validateAndBuildStudentPayload,
} from '../lib/firestoreValidation';
import { t } from '../lib/i18n';
import {
  formatTimestampDateTime,
  getAttendanceDocId,
  normalizeBdPhone,
  normalizeExamConfigs,
  sha256Hex,
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

  // Private APK Uploader State
  const [versionCode, setVersionCode] = useState(
    school?.latestAppVersionCode !== undefined && school?.latestAppVersionCode !== null
      ? String(school.latestAppVersionCode)
      : '13'
  );
  const [versionName, setVersionName] = useState(school?.latestAppVersionName || '2.2');
  const [apkFile, setApkFile] = useState<File | null>(null);
  const apkInputRef = useRef<HTMLInputElement | null>(null);
  const [updateNotes, setUpdateNotes] = useState(school?.appUpdateNotes || '');
  const [updateAdminPassword, setUpdateAdminPassword] = useState('');
  const [savingUpdate, setSavingUpdate] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ApkUploadProgress | null>(null);

  useEffect(() => {
    setAdminTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setExamDrafts(normalizeExamConfigs(school?.examConfigs));
  }, [school?.examConfigs]);

  useEffect(() => {
    setVersionCode(
      school?.latestAppVersionCode !== undefined && school?.latestAppVersionCode !== null
        ? String(school.latestAppVersionCode)
        : '13'
    );
    setVersionName(school?.latestAppVersionName || '2.2');
    setUpdateNotes(school?.appUpdateNotes || '');
  }, [
    school?.latestAppVersionCode,
    school?.latestAppVersionName,
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
    setBanner(null);

    try {
      const payload = JSON.parse(change.payloadJson || '{}');
      const schoolId = session.schoolId;

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
          change.submittedByName || session.name,
          existing?.createdAt
        );
        const ref = targetStudentId
          ? doc(instances.db, 'schools', schoolId, 'students', targetStudentId)
          : doc(collection(instances.db, 'schools', schoolId, 'students'));
        await setDoc(ref, validated, { merge: true });
      } else if (change.entityType === 'STUDENT_DELETE') {
        const targetId = String(payload.studentId || change.targetId);
        if (targetId) {
          await deleteDoc(doc(instances.db, 'schools', schoolId, 'students', targetId));
        }
      } else if (change.entityType === 'STUDENT_BATCH_UPDATE') {
        const items: Array<Record<string, unknown>> = Array.isArray(payload)
          ? payload
          : Array.isArray(payload.updates)
          ? payload.updates
          : Array.isArray(payload.students)
          ? payload.students
          : [];

        for (let i = 0; i < items.length; i += 400) {
          const chunk = items.slice(i, i + 400);
          const batch = writeBatch(instances.db);
          for (const item of chunk) {
            // Handle ROSTER_IMPORT items { existingId?, data }
            if (item.data && typeof item.data === 'object') {
              const existingId = item.existingId ? String(item.existingId) : undefined;
              const existing = existingId
                ? students.find((s) => s.id === existingId)
                : undefined;
              const validated = validateAndBuildStudentPayload(
                { ...existing, ...(item.data as Partial<StudentDoc>) },
                schoolId,
                change.submittedByName || session.name,
                existing?.createdAt
              );
              const ref = existingId
                ? doc(instances.db, 'schools', schoolId, 'students', existingId)
                : doc(collection(instances.db, 'schools', schoolId, 'students'));
              batch.set(ref, validated, { merge: true });
              continue;
            }

            const studentId = String(item.studentId || item.id || '');
            if (!studentId) continue;
            const existing = students.find((s) => s.id === studentId);
            if (!existing) continue;

            const ref = doc(instances.db, 'schools', schoolId, 'students', studentId);

            if (item.examResultsPatch && typeof item.examResultsPatch === 'object') {
              const merged = { ...(existing.examResults || {}) } as Record<
                string,
                unknown
              >;
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
                lastUpdatedByName: change.submittedByName || session.name,
                updatedAt: serverTimestamp(),
              });
            } else if (item.customValues && typeof item.customValues === 'object') {
              const merged = sanitizeStringRecordMap({
                ...(existing.customValues || {}),
                ...(item.customValues as Record<string, unknown>),
              });
              batch.update(ref, {
                customValues: merged,
                lastUpdatedByName: change.submittedByName || session.name,
                updatedAt: serverTimestamp(),
              });
            } else if (item.subjectValues && typeof item.subjectValues === 'object') {
              const merged = sanitizeStringRecordMap({
                ...(existing.subjectValues || {}),
                ...(item.subjectValues as Record<string, unknown>),
              });
              batch.update(ref, {
                subjectValues: merged,
                lastUpdatedByName: change.submittedByName || session.name,
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
              ]) {
                if (strKey in rawPatch) {
                  rawPatch[strKey] = String(rawPatch[strKey] ?? '').trim();
                }
              }
              batch.update(ref, {
                ...rawPatch,
                lastUpdatedByName: change.submittedByName || session.name,
                updatedAt: serverTimestamp(),
              });
            }
          }
          await batch.commit();
        }
      } else if (change.entityType === 'SUBJECT_SAVE') {
        const existing = change.targetId
          ? subjects.find((s) => s.id === change.targetId)
          : undefined;
        const subPayload = buildSubjectPayload(payload, schoolId, existing?.createdAt);
        const ref = change.targetId
          ? doc(instances.db, 'schools', schoolId, 'subjects', change.targetId)
          : doc(collection(instances.db, 'schools', schoolId, 'subjects'));
        await setDoc(ref, subPayload, { merge: true });
      } else if (change.entityType === 'SUBJECT_DELETE') {
        if (change.targetId) {
          await deleteDoc(doc(instances.db, 'schools', schoolId, 'subjects', change.targetId));
        }
      } else if (change.entityType === 'CUSTOM_FIELD_SAVE') {
        const existing = change.targetId
          ? customFields.find((c) => c.id === change.targetId)
          : undefined;
        const cfPayload = buildCustomFieldPayload(payload, schoolId, existing?.createdAt);
        const ref = change.targetId
          ? doc(instances.db, 'schools', schoolId, 'customFields', change.targetId)
          : doc(collection(instances.db, 'schools', schoolId, 'customFields'));
        await setDoc(ref, cfPayload, { merge: true });
      } else if (change.entityType === 'CUSTOM_FIELD_DELETE') {
        if (change.targetId) {
          await deleteDoc(
            doc(instances.db, 'schools', schoolId, 'customFields', change.targetId)
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
          markedByName: change.submittedByName || session.name,
        });
        await setDoc(
          doc(instances.db, 'schools', schoolId, 'attendanceLogs', docId),
          attPayload,
          { merge: true }
        );
      } else if (change.entityType === 'EXAM_CONFIG_SAVE') {
        const configs = sanitizeExamConfigs(
          Array.isArray(payload.examConfigs) ? payload.examConfigs : payload
        );
        await updateDoc(doc(instances.db, 'schools', schoolId), {
          examConfigs: configs,
          updatedAt: serverTimestamp(),
        });
      }

      await updateDoc(
        doc(instances.db, 'schools', schoolId, 'pendingChanges', change.id),
        {
          status: 'APPROVED',
          reviewedByName: session.name,
          updatedAt: serverTimestamp(),
        }
      );

      setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setProcessingChangeId(null);
    }
  };

  const handleRejectChange = async (change: PendingChangeDoc) => {
    const instances = getFirebaseInstances();
    if (!instances || !session) return;

    setProcessingChangeId(change.id);
    try {
      await updateDoc(
        doc(instances.db, 'schools', session.schoolId, 'pendingChanges', change.id),
        {
          status: 'REJECTED',
          reviewedByName: session.name,
          updatedAt: serverTimestamp(),
        }
      );
      setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setProcessingChangeId(null);
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

  // 4. Private Android APK Uploader (Admin-only + Admin Password Verified)
  const selectedApkChunkCount = apkFile
    ? Math.ceil(apkFile.size / APK_CHUNK_SIZE_BYTES)
    : 0;

  const handleSaveAppUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    const instances = getFirebaseInstances();
    if (!instances || !session) return;

    const trimmedCodeStr = versionCode.trim();
    const rawNum = Number(trimmedCodeStr);
    const intVersionCode = Math.trunc(rawNum);
    if (
      trimmedCodeStr === '' ||
      !Number.isFinite(rawNum) ||
      !Number.isInteger(rawNum) ||
      intVersionCode < 1 ||
      intVersionCode > 999999
    ) {
      setBanner({ type: 'error', text: t(lang, 'invalidVersionCode') });
      return;
    }

    const trimmedVersionName = String(versionName).trim().slice(0, 20);
    if (!trimmedVersionName) {
      setBanner({ type: 'error', text: t(lang, 'invalidVersionName') });
      return;
    }

    if (!apkFile || apkFile.size <= 0) {
      setBanner({ type: 'error', text: t(lang, 'apkFileRequired') });
      return;
    }

    if (selectedApkChunkCount > MAX_APK_CHUNKS) {
      setBanner({
        type: 'error',
        text: `APK size exceeds ${Math.floor((MAX_APK_CHUNKS * APK_CHUNK_SIZE_BYTES) / (1024 * 1024))} MB maximum (${selectedApkChunkCount} > ${MAX_APK_CHUNKS} chunks).`,
      });
      return;
    }

    const trimmedNotes = String(updateNotes || '').trim().slice(0, 300);

    if (!updateAdminPassword) {
      setBanner({ type: 'error', text: t(lang, 'adminPasswordRequiredForUpdate') });
      return;
    }

    setSavingUpdate(true);
    setBanner(null);
    setUploadProgress(null);

    try {
      const currentAdminRecord = teachers.find(
        (m) =>
          normalizeBdPhone(m.phoneNumber) === session.phoneNumber &&
          m.role === 'ADMIN'
      );

      if (!currentAdminRecord || !currentAdminRecord.passwordHash) {
        setBanner({ type: 'error', text: t(lang, 'wrongAdminPasswordUpdate') });
        return;
      }

      const enteredHash = await sha256Hex(updateAdminPassword);
      if (enteredHash !== currentAdminRecord.passwordHash.toLowerCase()) {
        setBanner({ type: 'error', text: t(lang, 'wrongAdminPasswordUpdate') });
        return;
      }

      await uploadPrivateApkRelease({
        db: instances.db,
        schoolId: session.schoolId,
        file: apkFile,
        versionCode: intVersionCode,
        versionName: trimmedVersionName,
        notes: trimmedNotes,
        originUrl: window.location.origin,
        onProgress: setUploadProgress,
      });

      setApkFile(null);
      if (apkInputRef.current) {
        apkInputRef.current.value = '';
      }
      setUpdateAdminPassword('');
      setBanner({ type: 'success', text: t(lang, 'appUpdatePublishedSuccess') });
    } catch (err: unknown) {
      const fbErr = err as { code?: string; message?: string };
      const exactMessage = fbErr?.code
        ? `${fbErr.code}: ${fbErr.message || String(err)}`
        : err instanceof Error
        ? err.message
        : String(err);
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${exactMessage}`,
      });
    } finally {
      setSavingUpdate(false);
      setUploadProgress(null);
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
                    ? '৩-সাময়িকী পরীক্ষার বিষয় ও নম্বর সেটআপ (examConfigs)'
                    : '3-Term Exam Subjects Configuration (examConfigs)'}
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
              <div className="flex items-center gap-1 p-1 bg-stone-100 rounded-lg">
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
                    {tid === 'exam_1'
                      ? t(lang, 'term1')
                      : tid === 'exam_2'
                      ? t(lang, 'term2')
                      : t(lang, 'term3')}
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

      {/* TAB 4: Private In-Website Android APK Uploader (Admin-Only, Password-Protected) */}
      {adminTab === 'update' && (
        <form
          onSubmit={handleSaveAppUpdate}
          className="bg-white border border-stone-200 rounded-xl p-6 max-w-2xl space-y-4"
        >
          <div className="flex items-start justify-between gap-3 pb-3 border-b border-stone-200">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center shrink-0 mt-0.5">
                <Smartphone className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {t(lang, 'publishAppUpdate')}
                </h3>
                <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                  {t(lang, 'versionCodeHint')}
                </p>
              </div>
            </div>
            {(school?.latestAppVersionName || school?.latestAppVersionCode !== undefined) && (
              <span className="text-xs font-mono font-semibold tabular-nums text-emerald-900 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded shrink-0">
                {school?.latestAppVersionName ? `v${school.latestAppVersionName}` : 'v—'}{' '}
                {school?.latestAppVersionCode !== undefined
                  ? `(#${school.latestAppVersionCode})`
                  : ''}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'versionCode')}
              </label>
              <input
                type="number"
                min={1}
                max={999999}
                step={1}
                required
                disabled={savingUpdate}
                value={versionCode}
                onChange={(e) => setVersionCode(e.target.value)}
                placeholder="13"
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg font-mono tabular-nums focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-stone-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'versionName')}
              </label>
              <input
                type="text"
                required
                maxLength={20}
                disabled={savingUpdate}
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
                placeholder="2.2"
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-stone-50"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="apk-file-picker"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              {t(lang, 'apkFileLabel')}
            </label>
            <div className="border border-dashed border-stone-300 rounded-lg p-4 bg-stone-50/70 space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                <input
                  id="apk-file-picker"
                  ref={apkInputRef}
                  type="file"
                  accept=".apk,application/vnd.android.package-archive"
                  disabled={savingUpdate}
                  onChange={(e) => {
                    const chosen = e.target.files?.[0] || null;
                    setApkFile(chosen);
                  }}
                  className="block w-full text-xs text-slate-700 file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border file:border-emerald-200 file:text-xs file:font-semibold file:bg-emerald-50 file:text-emerald-900 hover:file:bg-emerald-100 file:cursor-pointer cursor-pointer"
                />
              </div>

              {apkFile && (
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-white border border-stone-200 rounded-lg text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileArchive className="w-4 h-4 text-emerald-700 shrink-0" />
                    <span className="font-mono font-medium text-slate-900 truncate">
                      {apkFile.name}
                    </span>
                  </div>
                  <div className="font-mono tabular-nums text-slate-600 shrink-0">
                    {(apkFile.size / (1024 * 1024)).toFixed(2)} MB · {selectedApkChunkCount}/
                    {MAX_APK_CHUNKS} chunks
                  </div>
                </div>
              )}

              {apkFile && selectedApkChunkCount > MAX_APK_CHUNKS && (
                <p className="text-xs text-rose-700 font-medium">
                  APK exceeds {Math.floor((MAX_APK_CHUNKS * APK_CHUNK_SIZE_BYTES) / (1024 * 1024))} MB limit ({selectedApkChunkCount} chunks).
                </p>
              )}

              <p className="text-[11px] text-slate-500 leading-relaxed">
                {t(lang, 'apkFileHint')}
              </p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-slate-700">
                {t(lang, 'updateNotes')}
              </label>
              <span className="text-[11px] font-mono tabular-nums text-slate-400">
                {updateNotes.length}/300
              </span>
            </div>
            <textarea
              rows={3}
              maxLength={300}
              disabled={savingUpdate}
              value={updateNotes}
              onChange={(e) => setUpdateNotes(e.target.value)}
              placeholder={
                lang === 'bn'
                  ? 'যেমন: মার্কশিট উন্নতি ও দ্রুত সিঙ্ক যোগ করা হয়েছে'
                  : 'e.g. Marksheet improvements and faster cloud sync.'
              }
              className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-stone-50"
            />
          </div>

          <div className="pt-2 border-t border-stone-100">
            <label
              htmlFor="update-admin-pw"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              {t(lang, 'adminPasswordLabel')}
            </label>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="update-admin-pw"
                type="password"
                required
                disabled={savingUpdate}
                value={updateAdminPassword}
                onChange={(e) => setUpdateAdminPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600 disabled:bg-stone-50"
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1">
              {t(lang, 'adminPasswordRequiredForUpdate')}
            </p>
          </div>

          {savingUpdate && uploadProgress && (
            <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 space-y-2">
              <div className="flex items-center justify-between text-xs font-medium text-emerald-900">
                <span>
                  {uploadProgress.phase === 'clearing'
                    ? t(lang, 'clearingOldApkChunks')
                    : uploadProgress.phase === 'finalizing'
                    ? t(lang, 'finalizingApkPublish')
                    : uploadProgress.phase === 'reading'
                    ? t(lang, 'loading')
                    : `${t(lang, 'uploadingApkProgress')} ${uploadProgress.currentChunk} of ${uploadProgress.totalChunks}...`}
                </span>
                <span className="font-mono tabular-nums">{uploadProgress.percent}%</span>
              </div>
              <div className="w-full h-2 bg-emerald-200/70 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-700 transition-all duration-200"
                  style={{ width: `${uploadProgress.percent}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={savingUpdate || !apkFile || selectedApkChunkCount > MAX_APK_CHUNKS}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>
                {savingUpdate && uploadProgress
                  ? `${uploadProgress.percent}%`
                  : t(lang, 'publishAppUpdate')}
              </span>
            </button>
          </div>
        </form>
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
