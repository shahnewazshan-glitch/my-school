import type {
  ExamConfig,
  ExamSubjectConfig,
  ExamTermId,
  StudentDoc,
} from '../types/school';

export const TERM_ORDER: ExamTermId[] = ['exam_1', 'exam_2', 'exam_3'];

export const DEFAULT_EXAM_TITLES: Record<ExamTermId, string> = {
  exam_1: '1st Term Exam',
  exam_2: '2nd Term Exam',
  exam_3: 'Final / Annual Exam',
};

/**
 * Exact Android School ID normalization:
 * raw.trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32)
 */
export function normalizeSchoolId(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
}

/**
 * Exact Android Bangladesh phone number normalization:
 * - Strip all characters except digits and '+'
 * - If starts with '01' and length === 11 -> prefix '+88' (becomes '+8801XXXXXXXXX')
 * - If starts with '880' and length === 13 -> prefix '+'
 * - Otherwise keep digits/plus as-is
 */
export function normalizeBdPhone(raw: string): string {
  const cleaned = raw.replace(/[^0-9+]/g, '');
  if (cleaned.startsWith('01') && cleaned.length === 11) {
    return `+88${cleaned}`;
  }
  if (cleaned.startsWith('880') && cleaned.length === 13) {
    return `+${cleaned}`;
  }
  return cleaned;
}

/**
 * Client-side SHA-256 hex digest (lowercase 64 chars) via Web Crypto API.
 */
export async function sha256Hex(plainText: string): Promise<string> {
  const bytes = new TextEncoder().encode(plainText);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Format photoBase64 for HTML <img> src, supporting both raw base64 (Android) and data URLs.
 */
export function formatPhotoSrc(photoBase64?: string | null): string | null {
  if (typeof photoBase64 !== 'string') return null;
  const trimmed = photoBase64.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:image/')) {
    return trimmed;
  }
  return `data:image/jpeg;base64,${trimmed}`;
}

/**
 * Compress uploaded image file using HTML5 canvas so raw Base64 stays strictly under 100KB
 * (well within Firestore rule limit of 140,000 chars).
 */
export async function compressImageToBase64(
  file: File,
  maxBase64Length = 98000
): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Invalid image file'));
    image.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');

  let maxDim = 360;
  let quality = 0.82;

  for (let attempt = 0; attempt < 8; attempt++) {
    const maxSide = Math.max(1, img.width || 1, img.height || 1);
    const scale = Math.min(1, maxDim / maxSide);
    const w = Math.max(1, Math.round((img.width || 1) * scale));
    const h = Math.max(1, Math.round((img.height || 1) * scale));
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const outDataUrl = canvas.toDataURL('image/jpeg', quality);
    const rawBase64 = outDataUrl.replace(/^data:image\/jpeg;base64,/, '');
    if (rawBase64.length <= maxBase64Length) {
      return rawBase64;
    }

    quality = Math.max(0.35, quality - 0.12);
    if (attempt >= 3) {
      maxDim = Math.max(160, Math.round(maxDim * 0.78));
    }
  }

  throw new Error('Image is still too large after compression. Please choose a smaller photo.');
}

const PRE_TO_2_CLASSES = new Set(['pre-primary', 'class 1', 'class 2']);
const GRADES_3_TO_5_CLASSES = new Set(['class 3', 'class 4', 'class 5']);

/**
 * Exact Android classScope matching + safe null/undefined guards.
 * Supports:
 * - "" / "ALL" / "All Classes" / "ALL_CLASSES" -> all classes
 * - "Pre-Primary - Class 2" / "GRADES_PRE_TO_2" -> ["Pre-Primary", "Class 1", "Class 2"]
 * - "Class 3 - Class 5" / "GRADES_3_TO_5" -> ["Class 3", "Class 4", "Class 5"]
 * - Exact match or comma-separated list (case-insensitive)
 */
export function matchesClassScope(
  scope: string | undefined | null,
  classLevel: string | undefined | null
): boolean {
  const safeScope = typeof scope === 'string' ? scope.trim() : String(scope || '').trim();
  if (!safeScope) return true;

  const normalizedScope = safeScope.toLowerCase();
  if (
    normalizedScope === 'all' ||
    normalizedScope === 'all classes' ||
    normalizedScope === 'all_classes'
  ) {
    return true;
  }

  const safeClass =
    typeof classLevel === 'string'
      ? classLevel.trim().toLowerCase()
      : String(classLevel || 'Class 1').trim().toLowerCase();

  if (normalizedScope === 'pre-primary - class 2' || normalizedScope === 'grades_pre_to_2') {
    return PRE_TO_2_CLASSES.has(safeClass);
  }
  if (normalizedScope === 'class 3 - class 5' || normalizedScope === 'grades_3_to_5') {
    return GRADES_3_TO_5_CLASSES.has(safeClass);
  }

  const tokens = safeScope
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  if (
    tokens.length === 0 ||
    tokens.includes('all') ||
    tokens.includes('all classes') ||
    tokens.includes('all_classes')
  ) {
    return true;
  }

  for (const token of tokens) {
    if (token === 'pre-primary - class 2' || token === 'grades_pre_to_2') {
      if (PRE_TO_2_CLASSES.has(safeClass)) return true;
    } else if (token === 'class 3 - class 5' || token === 'grades_3_to_5') {
      if (GRADES_3_TO_5_CLASSES.has(safeClass)) return true;
    } else if (token === safeClass) {
      return true;
    }
  }

  return false;
}

/**
 * Safely sanitize a subject spec from Firestore (Android or Web).
 */
export function sanitizeSubjectSpec(spec: Partial<ExamSubjectConfig> | null | undefined, fallbackIdx = 0): ExamSubjectConfig {
  const rawFull = Number(spec?.fullMarks);
  const fullMarks = Number.isFinite(rawFull) && rawFull > 0 ? rawFull : 100;
  const rawPass = Number(spec?.passMarks);
  const passMarks = Number.isFinite(rawPass) && rawPass >= 0 ? rawPass : 0;
  const rawOverride = Number(spec?.highestMarkOverride);
  const highestMarkOverride = Number.isFinite(rawOverride) && rawOverride > 0 ? rawOverride : 0;

  return {
    subjectId: String(spec?.subjectId || `subject_${fallbackIdx + 1}`).trim(),
    subjectName: String(spec?.subjectName || 'Subject').trim() || 'Subject',
    classScope: String(spec?.classScope ?? 'All Classes').trim() || 'All Classes',
    fullMarks,
    passMarks,
    highestMarkOverride,
  };
}

/**
 * Build canonical examConfigs ensuring 3 terms always exist (exam_1, exam_2, exam_3).
 * Safely handles null, non-array maps, missing examId (index fallback), and malformed subject specs.
 */
export function normalizeExamConfigs(rawConfigs?: unknown): ExamConfig[] {
  let existing: Array<Partial<ExamConfig> | null | undefined> = [];
  if (Array.isArray(rawConfigs)) {
    existing = rawConfigs;
  } else if (rawConfigs && typeof rawConfigs === 'object') {
    existing = Object.values(rawConfigs as Record<string, Partial<ExamConfig>>);
  }

  return TERM_ORDER.map((examId, idx) => {
    const byId = existing.find((c) => c && typeof c === 'object' && c.examId === examId);
    const byIndex = existing[idx] && typeof existing[idx] === 'object' ? existing[idx] : undefined;
    const found = byId || byIndex;

    const rawSubjects: unknown[] = Array.isArray(found?.subjects) ? found.subjects : [];
    const subjects: ExamSubjectConfig[] = rawSubjects
      .filter((s): s is Partial<ExamSubjectConfig> => Boolean(s && typeof s === 'object'))
      .map((s, sIdx) => sanitizeSubjectSpec(s, sIdx));

    return {
      examId,
      title: String(found?.title || DEFAULT_EXAM_TITLES[examId]),
      subjects,
    };
  });
}

/**
 * Merge unique subjects across the 3 examConfigs for a given classLevel.
 */
export function getClassSubjectsForMarksheet(
  examConfigs: ExamConfig[] | undefined | null,
  classLevel: string | undefined | null
): ExamSubjectConfig[] {
  const byId = new Map<string, ExamSubjectConfig>();
  const normalized = normalizeExamConfigs(examConfigs);
  const safeClass = String(classLevel || 'Class 1');

  for (const exam of normalized) {
    const subjs = Array.isArray(exam?.subjects) ? exam.subjects : [];
    for (const subj of subjs) {
      if (!subj || typeof subj !== 'object') continue;
      if (matchesClassScope(subj.classScope, safeClass)) {
        const key = String(subj.subjectId || subj.subjectName || '');
        if (key && !byId.has(key)) {
          byId.set(key, sanitizeSubjectSpec(subj));
        }
      }
    }
  }
  return Array.from(byId.values());
}

/**
 * Internal Bangladesh pass mark calculation (NOT shown as a table column).
 */
export function getInternalPassMarks(fullMarks: number): number {
  const fm = Number(fullMarks);
  if (!Number.isFinite(fm) || fm <= 0) return 0;
  if (fm === 100) return 33;
  if (fm === 50) return 17;
  return Math.ceil(fm * 0.33);
}

export interface GradeResult {
  grade: string;
  gpa: number;
  passed: boolean;
}

/**
 * Bangladesh grading calculation (internal).
 */
export function calculateSubjectGrade(obtained: number, fullMarks: number): GradeResult {
  const fm = Number(fullMarks);
  const obt = Number(obtained);
  if (!Number.isFinite(fm) || fm <= 0 || !Number.isFinite(obt)) {
    return { grade: '-', gpa: 0, passed: true };
  }
  const passMarks = getInternalPassMarks(fm);
  if (obt < passMarks) {
    return { grade: 'F', gpa: 0.0, passed: false };
  }
  const pct = (obt / fm) * 100;
  if (pct >= 80) return { grade: 'A+', gpa: 5.0, passed: true };
  if (pct >= 70) return { grade: 'A', gpa: 4.0, passed: true };
  if (pct >= 60) return { grade: 'A-', gpa: 3.5, passed: true };
  if (pct >= 50) return { grade: 'B', gpa: 3.0, passed: true };
  if (pct >= 40) return { grade: 'C', gpa: 2.0, passed: true };
  return { grade: 'D', gpa: 1.0, passed: true };
}

export function gpaToLetterGrade(gpa: number, passed: boolean): string {
  if (!passed) return 'F';
  const val = Number(gpa);
  if (!Number.isFinite(val)) return 'F';
  if (val >= 5.0) return 'A+';
  if (val >= 4.0) return 'A';
  if (val >= 3.5) return 'A-';
  if (val >= 3.0) return 'B';
  if (val >= 2.0) return 'C';
  if (val >= 1.0) return 'D';
  return 'F';
}

export function readNumericMark(
  examResults: Record<string, number | string> | undefined | null,
  key: string
): number | null {
  if (!examResults || typeof examResults !== 'object' || Array.isArray(examResults)) {
    return null;
  }
  const val = examResults[key];
  if (val === undefined || val === null || val === '' || typeof val === 'object' || typeof val === 'boolean') {
    return null;
  }
  const num = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(num) ? num : null;
}

export interface TermSubjectScore {
  cont: number | null;
  sum: number | null;
  total: number | null;
  hasScore: boolean;
}

export function getTermSubjectScore(
  examResults: Record<string, number | string> | undefined | null,
  examId: string,
  subjectId: string
): TermSubjectScore {
  if (!subjectId) {
    return { cont: null, sum: null, total: null, hasScore: false };
  }
  const cont = readNumericMark(examResults, `${examId}__${subjectId}__cont`);
  const sum = readNumericMark(examResults, `${examId}__${subjectId}__sum`);
  const storedTotal = readNumericMark(examResults, `${examId}__${subjectId}`);

  if (cont !== null || sum !== null) {
    const total = (cont ?? 0) + (sum ?? 0);
    return { cont, sum, total, hasScore: true };
  }
  if (storedTotal !== null) {
    return { cont: null, sum: null, total: storedTotal, hasScore: true };
  }
  return { cont: null, sum: null, total: null, hasScore: false };
}

export interface StudentTermSummary {
  totalFullMarks: number;
  totalObtained: number;
  gpa: number;
  grade: string;
  passed: boolean;
  scoredSubjects: number;
}

export function computeStudentTermSummary(
  student: StudentDoc | null | undefined,
  subjects: ExamSubjectConfig[] | undefined | null,
  examId: ExamTermId
): StudentTermSummary {
  const safeSubjects = Array.isArray(subjects) ? subjects : [];
  const safeExamResults =
    student?.examResults && typeof student.examResults === 'object' && !Array.isArray(student.examResults)
      ? student.examResults
      : {};

  let totalFullMarks = 0;
  let totalObtained = 0;
  let gpaSum = 0;
  let scoredSubjects = 0;
  let allPassed = true;

  for (const subj of safeSubjects) {
    if (!subj || typeof subj !== 'object' || !subj.subjectId) continue;
    const fullMarks = Number(subj.fullMarks) > 0 ? Number(subj.fullMarks) : 100;
    const score = getTermSubjectScore(safeExamResults, examId, subj.subjectId);
    if (score.hasScore && score.total !== null) {
      totalFullMarks += fullMarks;
      totalObtained += score.total;
      const g = calculateSubjectGrade(score.total, fullMarks);
      if (!g.passed) allPassed = false;
      gpaSum += Number.isFinite(g.gpa) ? g.gpa : 0;
      scoredSubjects += 1;
    }
  }

  if (scoredSubjects === 0 || totalFullMarks <= 0) {
    return {
      totalFullMarks: 0,
      totalObtained: 0,
      gpa: 0,
      grade: '-',
      passed: false,
      scoredSubjects: 0,
    };
  }

  const rawGpa = scoredSubjects > 0 ? gpaSum / scoredSubjects : 0;
  const gpa = allPassed && Number.isFinite(rawGpa) ? Number(rawGpa.toFixed(2)) : 0.0;
  const grade = gpaToLetterGrade(gpa, allPassed);
  return {
    totalFullMarks,
    totalObtained,
    gpa,
    grade,
    passed: allPassed,
    scoredSubjects,
  };
}

/**
 * Compute Final/Annual Exam (exam_3) Merit Rank strictly for passers.
 * Returns Map<studentId, rankNumber (1-based)>.
 */
export function computeFinalExamMeritMap(
  students: StudentDoc[] | undefined | null,
  subjects: ExamSubjectConfig[] | undefined | null
): Map<string, number> {
  const safeStudents = Array.isArray(students) ? students : [];
  const safeSubjects = Array.isArray(subjects) ? subjects : [];
  const passers: Array<{
    studentId: string;
    totalObtained: number;
    gpa: number;
    rollNum: number;
  }> = [];

  for (const st of safeStudents) {
    if (!st || !st.id) continue;
    const summary = computeStudentTermSummary(st, safeSubjects, 'exam_3');
    if (summary.scoredSubjects > 0 && summary.passed) {
      const rollNum = Number(st.rollNumber);
      passers.push({
        studentId: st.id,
        totalObtained: summary.totalObtained,
        gpa: summary.gpa,
        rollNum: Number.isFinite(rollNum) ? rollNum : 999999,
      });
    }
  }

  passers.sort((a, b) => {
    if (b.totalObtained !== a.totalObtained) return b.totalObtained - a.totalObtained;
    if (b.gpa !== a.gpa) return b.gpa - a.gpa;
    return a.rollNum - b.rollNum;
  });

  const meritMap = new Map<string, number>();
  passers.forEach((p, idx) => {
    meritMap.set(p.studentId, idx + 1);
  });
  return meritMap;
}

export function getTodayDateKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getAttendanceDocId(
  academicYear: number,
  classLevel: string,
  dateKey: string
): string {
  const classSafe = String(classLevel || 'Class_1').replace(/[^a-zA-Z0-9]/g, '_');
  return `${academicYear}_${classSafe}_${dateKey}`;
}

export function compareRollNumbers(a: StudentDoc, b: StudentDoc): number {
  const na = Number(a?.rollNumber);
  const nb = Number(b?.rollNumber);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb;
  }
  return String(a?.rollNumber || '').localeCompare(String(b?.rollNumber || ''), undefined, {
    numeric: true,
  });
}

export function formatTimestampMs(ts: unknown): string {
  if (!ts) return '-';
  let ms = 0;
  if (typeof ts === 'number') {
    ms = ts;
  } else if (typeof ts === 'object' && ts !== null && 'toMillis' in ts) {
    ms = (ts as { toMillis: () => number }).toMillis();
  } else if (typeof ts === 'object' && ts !== null && 'seconds' in ts) {
    ms = Number((ts as { seconds: number }).seconds) * 1000;
  }
  if (!ms) return '-';
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatTimestampDateTime(ts: unknown): string {
  if (!ts) return '-';
  let ms = 0;
  if (typeof ts === 'number') {
    ms = ts;
  } else if (typeof ts === 'object' && ts !== null && 'toMillis' in ts) {
    ms = (ts as { toMillis: () => number }).toMillis();
  } else if (typeof ts === 'object' && ts !== null && 'seconds' in ts) {
    ms = Number((ts as { seconds: number }).seconds) * 1000;
  }
  if (!ms) return '-';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function isValidHttpUrl(raw: string): boolean {
  if (!raw || !raw.trim()) return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
