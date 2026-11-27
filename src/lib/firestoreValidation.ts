import { serverTimestamp, writeBatch, type Firestore } from 'firebase/firestore';
import { parseSectorNotesMap } from './schoolUtils';
import type {
  AttendanceStatus,
  CustomFieldDoc,
  ExamConfig,
  ParentNoticeDoc,
  PendingChangeDoc,
  StudentDoc,
  SubjectDoc,
} from '../types/school';

export const FIRESTORE_LIMITS = {
  PHOTO_BASE64_MAX_CHARS: 140000,
  EXAM_RESULTS_MAX_KEYS: 350,
  CUSTOM_VALUES_MAX_KEYS: 100,
  SUBJECT_VALUES_MAX_KEYS: 150,
  PENDING_PAYLOAD_MAX_CHARS: 150000,
  PENDING_PAYLOAD_CHUNK_TARGET_CHARS: 120000,
  WRITE_BATCH_MAX_OPS: 200,
  USER_NAME_MAX_CHARS: 100,
  SUMMARY_MAX_CHARS: 180,
  DETAILS_MAX_CHARS: 800,
} as const;

export function clampText(val: unknown, maxLen: number): string {
  return String(val ?? '').trim().slice(0, maxLen);
}

export function formatFirestoreError(err: unknown): string {
  if (err && typeof err === 'object') {
    const fbErr = err as { code?: unknown; message?: unknown };
    if (typeof fbErr.code === 'string' && fbErr.code) {
      const msg = typeof fbErr.message === 'string' ? fbErr.message : String(err);
      return `${fbErr.code}: ${msg}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Race a Firestore write promise against a generous timeout so bad/stalled mobile
 * connections never leave saving/importing buttons stuck permanently.
 */
export async function withWriteTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 25000
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              'Save timed out waiting for server confirmation. Check your internet connection and try again.'
            )
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Splits items into chunks of max 200 and commits one Firestore WriteBatch sequentially per chunk.
 */
export async function commitBatchesInChunks<T>(
  db: Firestore,
  items: T[],
  applyItemToBatch: (batch: ReturnType<typeof writeBatch>, item: T) => void,
  chunkSize: number = FIRESTORE_LIMITS.WRITE_BATCH_MAX_OPS
): Promise<void> {
  const safeSize = Math.max(1, Math.min(chunkSize, FIRESTORE_LIMITS.WRITE_BATCH_MAX_OPS));
  for (let i = 0; i < items.length; i += safeSize) {
    const slice = items.slice(i, i + safeSize);
    const batch = writeBatch(db);
    for (const item of slice) {
      applyItemToBatch(batch, item);
    }
    await withWriteTimeout(batch.commit());
  }
}

export function sanitizeStringRecordMap(
  map: Record<string, unknown> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    const str = String(v).trim();
    if (str !== '' && str !== 'NaN') {
      out[k] = str;
    }
  }
  return out;
}

export function sanitizeRecordMap<T extends string | number | boolean>(
  map: Record<string, T | null | undefined> | null | undefined
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && v !== null && v !== '') {
      out[k] = v;
    }
  }
  return out;
}

const ALLOWED_CUSTOM_FIELD_TYPES = new Set(['TEXT', 'NUMBER', 'YES_NO']);

export function sanitizeCustomFieldType(val: unknown): 'TEXT' | 'NUMBER' | 'YES_NO' {
  const s = String(val ?? 'TEXT').trim().toUpperCase();
  if (ALLOWED_CUSTOM_FIELD_TYPES.has(s)) {
    return s as 'TEXT' | 'NUMBER' | 'YES_NO';
  }
  return 'TEXT';
}

function buildValidatedStudentCoreFields(
  input: Partial<StudentDoc>,
  schoolId: string,
  updatedByName: string
): Record<string, unknown> {
  const examResults = sanitizeStringRecordMap(input.examResults || {});
  if (Object.keys(examResults).length > FIRESTORE_LIMITS.EXAM_RESULTS_MAX_KEYS) {
    throw new Error(
      `Exam results exceed maximum ${FIRESTORE_LIMITS.EXAM_RESULTS_MAX_KEYS} entries.`
    );
  }

  const customValues = sanitizeStringRecordMap(input.customValues || {});
  if (Object.keys(customValues).length > FIRESTORE_LIMITS.CUSTOM_VALUES_MAX_KEYS) {
    throw new Error(
      `Custom field values exceed maximum ${FIRESTORE_LIMITS.CUSTOM_VALUES_MAX_KEYS} entries.`
    );
  }

  const subjectValues = sanitizeStringRecordMap(input.subjectValues || {});
  if (Object.keys(subjectValues).length > FIRESTORE_LIMITS.SUBJECT_VALUES_MAX_KEYS) {
    throw new Error(
      `Subject field values exceed maximum ${FIRESTORE_LIMITS.SUBJECT_VALUES_MAX_KEYS} entries.`
    );
  }

  const rawYear = Number(input.academicYear);
  const rawTotalDays = Number(input.totalSchoolDays);
  const rawPresentDays = Number(input.daysPresent);

  return {
    schoolId,
    studentNameBn: String(input.studentNameBn ?? '').trim(),
    studentNameEn: String(input.studentNameEn ?? '').trim(),
    fatherNameEn: String(input.fatherNameEn ?? '').trim(),
    motherNameEn: String(input.motherNameEn ?? '').trim(),
    dateOfBirth: String(input.dateOfBirth ?? '').trim(),
    guardianPhone: String(input.guardianPhone ?? '').trim(),
    address: String(input.address ?? '').trim(),
    // Never store student photos on Firestore from web (photos remain local to teacher phones)
    photoBase64: '',
    rollNumber: String(input.rollNumber ?? '').trim(),
    nextYearRollNumber: String(input.nextYearRollNumber ?? '').trim(),
    classLevel: String(input.classLevel || 'Class 1').trim(),
    section: String(input.section ?? '').trim(),
    academicYear: Number.isFinite(rawYear) && rawYear > 0 ? Math.trunc(rawYear) : new Date().getFullYear(),
    totalSchoolDays: Number.isFinite(rawTotalDays) && rawTotalDays >= 0 ? Math.trunc(rawTotalDays) : 0,
    daysPresent: Number.isFinite(rawPresentDays) && rawPresentDays >= 0 ? Math.trunc(rawPresentDays) : 0,
    promotionStatus: String(input.promotionStatus ?? '').trim(),
    customValues,
    subjectValues,
    examResults,
    sectorNotes: sanitizeStringRecordMap(parseSectorNotesMap(input.sectorNotes)),
    lastUpdatedByName: clampText(updatedByName, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
  };
}

export function validateAndBuildStudentCreatePayload(
  input: Partial<StudentDoc>,
  schoolId: string,
  updatedByName: string
): Record<string, unknown> {
  return {
    ...buildValidatedStudentCoreFields(input, schoolId, updatedByName),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export function validateAndBuildStudentUpdatePayload(
  input: Partial<StudentDoc>,
  schoolId: string,
  updatedByName: string
): Record<string, unknown> {
  return {
    ...buildValidatedStudentCoreFields(input, schoolId, updatedByName),
    updatedAt: serverTimestamp(),
  };
}

export function validateAndBuildStudentPayload(
  input: Partial<StudentDoc>,
  schoolId: string,
  updatedByName: string,
  existingCreatedAt?: unknown
): Record<string, unknown> {
  return {
    ...buildValidatedStudentCoreFields(input, schoolId, updatedByName),
    createdAt: existingCreatedAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export function buildSubjectPayload(
  input: Partial<SubjectDoc>,
  schoolId: string,
  existingCreatedAt?: unknown
): Record<string, unknown> {
  return {
    schoolId,
    name: String(input.name || '').trim(),
    gradeScope: String(input.gradeScope || 'ALL').trim(),
    fields: (input.fields || []).map((f) => ({
      fieldId: String(f.fieldId || '').trim(),
      label: String(f.label || '').trim(),
      fieldType: sanitizeCustomFieldType(f.fieldType),
      maxMarks: Number.isFinite(Number(f.maxMarks)) ? Math.trunc(Number(f.maxMarks)) : 0,
    })),
    createdAt: existingCreatedAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export function buildSubjectUpdatePayload(
  input: Partial<SubjectDoc>,
  schoolId: string
): Record<string, unknown> {
  return {
    schoolId,
    name: String(input.name || '').trim(),
    gradeScope: String(input.gradeScope || 'ALL').trim(),
    fields: (input.fields || []).map((f) => ({
      fieldId: String(f.fieldId || '').trim(),
      label: String(f.label || '').trim(),
      fieldType: sanitizeCustomFieldType(f.fieldType),
      maxMarks: Number.isFinite(Number(f.maxMarks)) ? Math.trunc(Number(f.maxMarks)) : 0,
    })),
    updatedAt: serverTimestamp(),
  };
}

export function buildCustomFieldPayload(
  input: Partial<CustomFieldDoc>,
  schoolId: string,
  existingCreatedAt?: unknown
): Record<string, unknown> {
  return {
    schoolId,
    category: String(input.category || 'General').trim(),
    label: String(input.label || '').trim(),
    fieldType: sanitizeCustomFieldType(input.fieldType),
    resetsYearly: Boolean(input.resetsYearly),
    createdAt: existingCreatedAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export function buildCustomFieldUpdatePayload(
  input: Partial<CustomFieldDoc>,
  schoolId: string
): Record<string, unknown> {
  return {
    schoolId,
    category: String(input.category || 'General').trim(),
    label: String(input.label || '').trim(),
    fieldType: sanitizeCustomFieldType(input.fieldType),
    resetsYearly: Boolean(input.resetsYearly),
    updatedAt: serverTimestamp(),
  };
}

export function buildAttendancePayload(params: {
  schoolId: string;
  academicYear: number;
  classLevel: string;
  dateKey: string;
  statuses: Record<string, AttendanceStatus>;
  markedByName: string;
  existingCreatedAt?: unknown;
}): Record<string, unknown> {
  return {
    schoolId: params.schoolId,
    academicYear: Math.trunc(Number(params.academicYear)) || new Date().getFullYear(),
    classLevel: params.classLevel,
    dateKey: params.dateKey,
    monthKey: params.dateKey.slice(0, 7),
    statuses: params.statuses,
    markedByName: clampText(params.markedByName, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
    createdAt: params.existingCreatedAt || serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export function buildAttendanceUpdatePayload(params: {
  schoolId: string;
  academicYear: number;
  classLevel: string;
  dateKey: string;
  statuses: Record<string, AttendanceStatus>;
  markedByName: string;
}): Record<string, unknown> {
  return {
    schoolId: params.schoolId,
    academicYear: Math.trunc(Number(params.academicYear)) || new Date().getFullYear(),
    classLevel: params.classLevel,
    dateKey: params.dateKey,
    monthKey: params.dateKey.slice(0, 7),
    statuses: params.statuses,
    markedByName: clampText(params.markedByName, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
    updatedAt: serverTimestamp(),
  };
}

export function buildPendingChangePayload(
  input: Omit<PendingChangeDoc, 'id' | 'createdAt' | 'updatedAt'>
): Record<string, unknown> {
  const payloadJson = String(input.payloadJson || '{}');
  if (payloadJson.length > FIRESTORE_LIMITS.PENDING_PAYLOAD_MAX_CHARS) {
    throw new Error(
      `Pending change payload (${payloadJson.length} chars) exceeds the ${FIRESTORE_LIMITS.PENDING_PAYLOAD_MAX_CHARS} char limit.`
    );
  }
  return {
    schoolId: String(input.schoolId || '').trim(),
    entityType: input.entityType,
    targetId: String(input.targetId || '').trim().slice(0, 120),
    submittedByDeviceId: String(input.submittedByDeviceId || '').trim().slice(0, 120),
    submittedByName: clampText(input.submittedByName, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
    summary: clampText(input.summary, FIRESTORE_LIMITS.SUMMARY_MAX_CHARS),
    detailsText: clampText(input.detailsText, FIRESTORE_LIMITS.DETAILS_MAX_CHARS),
    payloadJson,
    status: 'PENDING',
    reviewedByName: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

/**
 * Builds compact STUDENT_BATCH_UPDATE payloadJson strings strictly <= 120 KB each
 * in the exact shape: { updates: { [studentId]: { "examResults.<key>": "<string>" } } }
 * Never embeds full student objects or photoBase64.
 */
export function buildChunkedExamPatchPayloads(
  studentPatches: Array<{
    studentId: string;
    patch: Record<string, string>;
  }>,
  targetChars = FIRESTORE_LIMITS.PENDING_PAYLOAD_CHUNK_TARGET_CHARS
): Array<{ payloadJson: string; studentCount: number }> {
  const chunks: Array<{ payloadJson: string; studentCount: number }> = [];
  let currentUpdates: Record<string, Record<string, string>> = {};
  let currentCount = 0;

  for (const item of studentPatches) {
    if (!item.studentId || Object.keys(item.patch).length === 0) continue;

    // Ensure every patch value is a trimmed string (empty string "" marks deletion on approval)
    const cleanPatch: Record<string, string> = {};
    for (const [k, v] of Object.entries(item.patch)) {
      const key = k.startsWith('examResults.') ? k : `examResults.${k}`;
      cleanPatch[key] = String(v ?? '').trim();
    }

    const candidate: Record<string, Record<string, string>> = {
      ...currentUpdates,
      [item.studentId]: cleanPatch,
    };
    const candidateJson = JSON.stringify({ updates: candidate });

    if (candidateJson.length > targetChars && currentCount > 0) {
      chunks.push({
        payloadJson: JSON.stringify({ updates: currentUpdates }),
        studentCount: currentCount,
      });
      currentUpdates = { [item.studentId]: cleanPatch };
      currentCount = 1;
    } else {
      currentUpdates = candidate;
      currentCount += 1;
    }
  }

  if (currentCount > 0) {
    const finalJson = JSON.stringify({ updates: currentUpdates });
    if (finalJson.length > FIRESTORE_LIMITS.PENDING_PAYLOAD_MAX_CHARS) {
      throw new Error(
        `Single student marks patch (${finalJson.length} chars) exceeds ${FIRESTORE_LIMITS.PENDING_PAYLOAD_MAX_CHARS} limit.`
      );
    }
    chunks.push({
      payloadJson: finalJson,
      studentCount: currentCount,
    });
  }

  return chunks;
}

/**
 * Splits any array-based pending update payload ({ kind, updates } or { kind, students })
 * into multiple JSON payloads strictly <= 120 KB each.
 */
export function buildChunkedArrayPendingPayloads<T>(
  kind: string,
  arrayKey: 'updates' | 'students',
  items: T[],
  extraFields: Record<string, unknown> = {},
  targetChars = FIRESTORE_LIMITS.PENDING_PAYLOAD_CHUNK_TARGET_CHARS
): Array<{ payloadJson: string; itemCount: number }> {
  const chunks: Array<{ payloadJson: string; itemCount: number }> = [];
  let current: T[] = [];

  for (const item of items) {
    const candidate = [...current, item];
    const candidateJson = JSON.stringify({
      ...extraFields,
      kind,
      [arrayKey]: candidate,
    });
    if (candidateJson.length > targetChars && current.length > 0) {
      chunks.push({
        payloadJson: JSON.stringify({ ...extraFields, kind, [arrayKey]: current }),
        itemCount: current.length,
      });
      current = [item];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) {
    const finalJson = JSON.stringify({ ...extraFields, kind, [arrayKey]: current });
    if (finalJson.length > FIRESTORE_LIMITS.PENDING_PAYLOAD_MAX_CHARS) {
      throw new Error(
        `Pending update item exceeds ${FIRESTORE_LIMITS.PENDING_PAYLOAD_MAX_CHARS} character limit.`
      );
    }
    chunks.push({
      payloadJson: finalJson,
      itemCount: current.length,
    });
  }

  return chunks;
}

export function buildParentNoticePayload(
  input: Omit<ParentNoticeDoc, 'id' | 'createdAt' | 'updatedAt'>
): Record<string, unknown> {
  return {
    schoolId: input.schoolId,
    title: String(input.title || '').trim(),
    message: String(input.message || '').trim(),
    targetClass: String(input.targetClass || 'ALL').trim(),
    academicYear: Math.trunc(Number(input.academicYear)) || new Date().getFullYear(),
    sentByName: clampText(input.sentByName, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
    sentByRole: input.sentByRole || 'USER',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

export function sanitizeExamConfigs(configs: ExamConfig[]): ExamConfig[] {
  return configs.map((c) => ({
    examId: String(c.examId),
    title: String(c.title || '').trim(),
    subjects: (c.subjects || []).map((s) => ({
      subjectId: String(s.subjectId || '').trim(),
      subjectName: String(s.subjectName || '').trim(),
      classScope: String(s.classScope || 'ALL').trim(),
      fullMarks: Math.max(1, Number(s.fullMarks) || 100),
      passMarks: Math.max(0, Number(s.passMarks) || 33),
      highestMarkOverride:
        s.highestMarkOverride !== undefined &&
        s.highestMarkOverride !== null &&
        String(s.highestMarkOverride) !== ''
          ? Number(s.highestMarkOverride)
          : null,
    })),
  }));
}
