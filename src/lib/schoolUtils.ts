import type {
  ExamConfig,
  ExamSubjectConfig,
  ExamTermId,
  StudentDoc,
} from '../types/school';

export const OFFICIAL_SCHOOL_ID = '139783';
export const OFFICIAL_DISPLAY_SCHOOL_CODE = '139783';
export const OFFICIAL_EMIS_CODE = '91411 070 804';
export const OFFICIAL_SCHOOL_NAME_EN = 'Sreepur Masjid Bari GPS';
export const OFFICIAL_SCHOOL_NAME_BN = 'শ্রীপুর মসজিদ বাড়ি সরকারি প্রাথমিক বিদ্যালয়';
export const MANUAL_MERIT_KEY = '__manualMeritPos';
export const PROFILE_OVERVIEW_NOTE_KEY = 'profile_overview';

export function getSchoolDisplayMeta(
  school: { displaySchoolCode?: string; emisCode?: string; schoolName?: string } | null | undefined,
  lang: 'en' | 'bn' = 'en'
): { displaySchoolCode: string; emisCode: string; schoolName: string } {
  return {
    displaySchoolCode: school?.displaySchoolCode?.trim() || OFFICIAL_DISPLAY_SCHOOL_CODE,
    emisCode: school?.emisCode?.trim() || OFFICIAL_EMIS_CODE,
    schoolName:
      school?.schoolName?.trim() ||
      (lang === 'bn' ? OFFICIAL_SCHOOL_NAME_BN : OFFICIAL_SCHOOL_NAME_EN),
  };
}

/**
 * Safely parse student.sectorNotes whether stored as a Firestore Map<String, String>
 * or as a legacy plain/multi-line string, preserving profile_overview,
 * govt_stipend_<year>, govt_cub_<year>, and any custom sector keys.
 */
export function parseSectorNotesMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      const key = String(k).trim();
      const val = String(v).trim();
      if (key && val) {
        out[key] = val;
      }
    }
    return out;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return out;
    const lines = trimmed.split(/\r?\n/);
    const overviewLines: string[] = [];
    for (const line of lines) {
      const m = line.match(
        /^(profile_overview|govt_stipend_\d{4}|govt_cub_\d{4}|sector_[a-zA-Z0-9_-]+)\s*:\s*(.*)$/
      );
      if (m) {
        const key = m[1].trim();
        const val = m[2].trim();
        if (val) out[key] = val;
      } else {
        overviewLines.push(line);
      }
    }
    const remainingOverview = overviewLines.join('\n').trim();
    if (remainingOverview && !out[PROFILE_OVERVIEW_NOTE_KEY]) {
      out[PROFILE_OVERVIEW_NOTE_KEY] = remainingOverview;
    }
    return out;
  }

  return out;
}

export function readProfileOverviewNote(raw: unknown): string {
  const map = parseSectorNotesMap(raw);
  return map[PROFILE_OVERVIEW_NOTE_KEY] || '';
}

export function buildMergedSectorNotes(
  existingRaw: unknown,
  patch: Record<string, string>
): Record<string, string> {
  const merged = parseSectorNotesMap(existingRaw);
  for (const [rawKey, rawVal] of Object.entries(patch)) {
    const key = String(rawKey).trim();
    if (!key) continue;
    const val = String(rawVal ?? '').trim();
    if (!val) {
      delete merged[key];
    } else {
      merged[key] = val;
    }
  }
  return merged;
}

export const TERM_ORDER: ExamTermId[] = ['exam_1', 'exam_2', 'exam_3'];

export const DEFAULT_EXAM_TITLES: Record<ExamTermId, string> = {
  exam_1: 'প্রথম প্রান্তিক মূল্যায়ন পরীক্ষা',
  exam_2: 'দ্বিতীয় প্রান্তিক মূল্যায়ন পরীক্ষা',
  exam_3: 'তৃতীয় প্রান্তিক মূল্যায়ন পরীক্ষা',
};

export function getOfficialExamLabel(
  examId: ExamTermId,
  lang: 'en' | 'bn' = 'bn'
): string {
  if (lang === 'bn') return DEFAULT_EXAM_TITLES[examId];
  switch (examId) {
    case 'exam_1':
      return '1st Term Evaluation (প্রথম প্রান্তিক)';
    case 'exam_2':
      return '2nd Term Evaluation (দ্বিতীয় প্রান্তিক)';
    case 'exam_3':
      return '3rd Term Evaluation (তৃতীয় প্রান্তিক)';
  }
}

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

export function getExamAbsentKey(examId: string, subjectId: string): string {
  return `${examId}__${subjectId}__absent`;
}

export function isAbsentMarkerValue(val: unknown): boolean {
  if (val === true || val === 1) return true;
  if (typeof val !== 'string') return false;
  const norm = val.trim().toUpperCase();
  return (
    norm === '1' ||
    norm === 'TRUE' ||
    norm === 'AB' ||
    norm === 'ABSENT' ||
    norm === 'অনুপস্থিত'
  );
}

export function readNumericMark(
  examResults: Record<string, number | string> | undefined | null,
  key: string
): number | null {
  if (!examResults || typeof examResults !== 'object' || Array.isArray(examResults)) {
    return null;
  }
  const val = examResults[key];
  if (
    val === undefined ||
    val === null ||
    val === '' ||
    typeof val === 'object' ||
    typeof val === 'boolean'
  ) {
    return null;
  }
  if (typeof val === 'string' && isAbsentMarkerValue(val) && val.trim() !== '1') {
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
  isAbsent: boolean;
}

export function getTermSubjectScore(
  examResults: Record<string, number | string> | undefined | null,
  examId: string,
  subjectId: string
): TermSubjectScore {
  if (!subjectId) {
    return { cont: null, sum: null, total: null, hasScore: false, isAbsent: false };
  }

  const safeMap =
    examResults && typeof examResults === 'object' && !Array.isArray(examResults)
      ? examResults
      : {};

  const absentFlag = safeMap[getExamAbsentKey(examId, subjectId)];
  const rawCont = safeMap[`${examId}__${subjectId}__cont`];
  const rawSum = safeMap[`${examId}__${subjectId}__sum`];
  const rawTotal = safeMap[`${examId}__${subjectId}`];

  const isAbsent =
    isAbsentMarkerValue(absentFlag) ||
    (typeof rawCont === 'string' && rawCont.trim().toUpperCase() === 'AB') ||
    (typeof rawSum === 'string' && rawSum.trim().toUpperCase() === 'AB') ||
    (typeof rawTotal === 'string' && rawTotal.trim().toUpperCase() === 'AB') ||
    (typeof rawCont === 'string' && rawCont.trim().toUpperCase() === 'ABSENT') ||
    (typeof rawSum === 'string' && rawSum.trim().toUpperCase() === 'ABSENT') ||
    (typeof rawTotal === 'string' && rawTotal.trim().toUpperCase() === 'ABSENT');

  if (isAbsent) {
    return { cont: null, sum: null, total: null, hasScore: false, isAbsent: true };
  }

  const cont = readNumericMark(safeMap, `${examId}__${subjectId}__cont`);
  const sum = readNumericMark(safeMap, `${examId}__${subjectId}__sum`);
  const storedTotal = readNumericMark(safeMap, `${examId}__${subjectId}`);

  if (cont !== null || sum !== null) {
    const total = (cont ?? 0) + (sum ?? 0);
    return { cont, sum, total, hasScore: true, isAbsent: false };
  }
  if (storedTotal !== null) {
    return { cont: null, sum: null, total: storedTotal, hasScore: true, isAbsent: false };
  }
  return { cont: null, sum: null, total: null, hasScore: false, isAbsent: false };
}

/**
 * Combined subject average strictly across exams the student actually attended
 * (ignoring unscored and Absent terms).
 */
export function computeSubjectCombinedAverage(
  examResults: Record<string, number | string> | undefined | null,
  subjectId: string
): { avg: number | null; attendedCount: number } {
  let sum = 0;
  let attendedCount = 0;
  for (const termId of TERM_ORDER) {
    const sc = getTermSubjectScore(examResults, termId, subjectId);
    if (!sc.isAbsent && sc.hasScore && sc.total !== null) {
      sum += sc.total;
      attendedCount += 1;
    }
  }
  return {
    avg: attendedCount > 0 ? sum / attendedCount : null,
    attendedCount,
  };
}

export interface StudentTermSummary {
  totalFullMarks: number;
  totalObtained: number;
  gpa: number;
  grade: string;
  passed: boolean;
  scoredSubjects: number;
  absentSubjects: number;
  fCount: number;
}

export function computeStudentTermSummary(
  student: StudentDoc | null | undefined,
  subjects: ExamSubjectConfig[] | undefined | null,
  examId: ExamTermId
): StudentTermSummary {
  const safeSubjects = Array.isArray(subjects) ? subjects : [];
  const safeExamResults =
    student?.examResults &&
    typeof student.examResults === 'object' &&
    !Array.isArray(student.examResults)
      ? student.examResults
      : {};

  let totalFullMarks = 0;
  let totalObtained = 0;
  let gpaSum = 0;
  let scoredSubjects = 0;
  let absentSubjects = 0;
  let fCount = 0;
  let allPassed = true;

  for (const subj of safeSubjects) {
    if (!subj || typeof subj !== 'object' || !subj.subjectId) continue;
    const fullMarks = Number(subj.fullMarks) > 0 ? Number(subj.fullMarks) : 100;
    const score = getTermSubjectScore(safeExamResults, examId, subj.subjectId);
    if (score.isAbsent) {
      absentSubjects += 1;
      continue;
    }
    if (score.hasScore && score.total !== null) {
      totalFullMarks += fullMarks;
      totalObtained += score.total;
      const g = calculateSubjectGrade(score.total, fullMarks);
      if (!g.passed) {
        allPassed = false;
        fCount += 1;
      }
      gpaSum += Number.isFinite(g.gpa) ? g.gpa : 0;
      scoredSubjects += 1;
    }
  }

  if (scoredSubjects === 0 || totalFullMarks <= 0) {
    return {
      totalFullMarks: 0,
      totalObtained: 0,
      gpa: 0,
      grade: absentSubjects > 0 ? 'Absent' : '-',
      passed: false,
      scoredSubjects: 0,
      absentSubjects,
      fCount: 0,
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
    absentSubjects,
    fCount,
  };
}

export function readManualMeritPos(student: StudentDoc | null | undefined): number | null {
  const raw = student?.examResults?.[MANUAL_MERIT_KEY];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

export interface StudentMeritDetail {
  studentId: string;
  rank: number;
  autoRank: number;
  manualPos: number | null;
  fCount: number;
  percentage: number;
  avgGpa: number;
  totalObtained: number;
  totalFullMarks: number;
  scoredCount: number;
  rollNum: number;
}

/**
 * Computes class merit ranking across all attended (non-absent) exams & subjects:
 * 1) Prioritize 0 F grades first, then 1 F, 2 F, ... (Absent never counts as F).
 * 2) Break ties by total / average percentage across attended subjects (higher first),
 *    then average GPA (higher first), then total obtained marks, then roll number.
 * 3) Respect manual merit overrides (__manualMeritPos) by slotting pinned positions and
 *    automatically shifting unpinned students around them with ZERO duplicates or gaps.
 */
export function computeClassMeritDetails(
  students: StudentDoc[] | undefined | null,
  subjects: ExamSubjectConfig[] | undefined | null
): Map<string, StudentMeritDetail> {
  const safeStudents = Array.isArray(students) ? students : [];
  const safeSubjects = Array.isArray(subjects) ? subjects : [];

  type RawEntry = Omit<StudentMeritDetail, 'rank' | 'autoRank'>;
  const rawEntries: RawEntry[] = [];

  for (const st of safeStudents) {
    if (!st || !st.id) continue;
    const examResults =
      st.examResults && typeof st.examResults === 'object' && !Array.isArray(st.examResults)
        ? st.examResults
        : {};

    let fCount = 0;
    let totalObtained = 0;
    let totalFullMarks = 0;
    let gpaSum = 0;
    let scoredCount = 0;

    for (const termId of TERM_ORDER) {
      for (const subj of safeSubjects) {
        if (!subj || !subj.subjectId) continue;
        const fm = Number(subj.fullMarks) > 0 ? Number(subj.fullMarks) : 100;
        const score = getTermSubjectScore(examResults, termId, subj.subjectId);
        if (score.isAbsent || !score.hasScore || score.total === null) continue;
        scoredCount += 1;
        totalObtained += score.total;
        totalFullMarks += fm;
        const g = calculateSubjectGrade(score.total, fm);
        if (!g.passed) fCount += 1;
        gpaSum += Number.isFinite(g.gpa) ? g.gpa : 0;
      }
    }

    const manualPos = readManualMeritPos(st);
    if (scoredCount === 0 && manualPos === null) {
      continue;
    }

    const percentage = totalFullMarks > 0 ? (totalObtained / totalFullMarks) * 100 : 0;
    const avgGpa = scoredCount > 0 ? gpaSum / scoredCount : 0;
    const rollNum = Number(st.rollNumber);

    rawEntries.push({
      studentId: st.id,
      manualPos,
      fCount,
      percentage,
      avgGpa,
      totalObtained,
      totalFullMarks,
      scoredCount,
      rollNum: Number.isFinite(rollNum) ? rollNum : 999999,
    });
  }

  // Natural auto-rank sorting
  rawEntries.sort((a, b) => {
    // Unscored students (only included if manually pinned) go after scored in natural order
    if ((a.scoredCount > 0) !== (b.scoredCount > 0)) {
      return a.scoredCount > 0 ? -1 : 1;
    }
    if (a.fCount !== b.fCount) return a.fCount - b.fCount;
    if (Math.abs(b.percentage - a.percentage) > 1e-6) return b.percentage - a.percentage;
    if (Math.abs(b.avgGpa - a.avgGpa) > 1e-6) return b.avgGpa - a.avgGpa;
    if (b.totalObtained !== a.totalObtained) return b.totalObtained - a.totalObtained;
    return a.rollNum - b.rollNum;
  });

  const withAutoRank: StudentMeritDetail[] = rawEntries.map((entry, idx) => ({
    ...entry,
    autoRank: idx + 1,
    rank: idx + 1,
  }));

  const totalCount = withAutoRank.length;
  if (totalCount === 0) return new Map();

  const pinned = withAutoRank
    .filter((e) => e.manualPos !== null)
    .sort((a, b) => {
      if ((a.manualPos || 0) !== (b.manualPos || 0)) {
        return (a.manualPos || 0) - (b.manualPos || 0);
      }
      return a.autoRank - b.autoRank;
    });

  const unpinned = withAutoRank.filter((e) => e.manualPos === null);
  const slots: Array<StudentMeritDetail | null> = new Array(totalCount).fill(null);

  for (const p of pinned) {
    let targetIdx = Math.max(0, Math.min(totalCount - 1, (p.manualPos || 1) - 1));
    while (targetIdx < totalCount && slots[targetIdx] !== null) {
      targetIdx += 1;
    }
    if (targetIdx >= totalCount) {
      targetIdx = slots.findIndex((s) => s === null);
    }
    if (targetIdx >= 0) {
      slots[targetIdx] = p;
    }
  }

  let uIdx = 0;
  for (let i = 0; i < totalCount; i++) {
    if (slots[i] === null && uIdx < unpinned.length) {
      slots[i] = unpinned[uIdx];
      uIdx += 1;
    }
  }

  const result = new Map<string, StudentMeritDetail>();
  slots.forEach((entry, idx) => {
    if (entry) {
      result.set(entry.studentId, { ...entry, rank: idx + 1 });
    }
  });
  return result;
}

/**
 * Returns Map<studentId, rankNumber (1-based)> using 0-F priority + manual overrides.
 */
export function computeFinalExamMeritMap(
  students: StudentDoc[] | undefined | null,
  subjects: ExamSubjectConfig[] | undefined | null
): Map<string, number> {
  const details = computeClassMeritDetails(students, subjects);
  const out = new Map<string, number>();
  for (const [id, detail] of details.entries()) {
    out.set(id, detail.rank);
  }
  return out;
}

/**
 * Computes updated __manualMeritPos values when moving targetStudentId to desiredPos (1-based),
 * automatically shifting other students in the same class with zero duplicates or gaps.
 */
export function applyManualMeritShift(
  students: StudentDoc[],
  subjects: ExamSubjectConfig[],
  targetStudentId: string,
  desiredPos: number
): Array<{ student: StudentDoc; newRank: number }> {
  const details = computeClassMeritDetails(students, subjects);
  const byId = new Map(students.map((s) => [s.id, s]));

  const rankedList = Array.from(details.values())
    .sort((a, b) => a.rank - b.rank)
    .map((d) => byId.get(d.studentId))
    .filter((s): s is StudentDoc => Boolean(s));

  const targetStudent = byId.get(targetStudentId);
  if (!targetStudent) return [];

  const filtered = rankedList.filter((s) => s.id !== targetStudentId);
  const safeTargetIndex = Math.max(
    0,
    Math.min(filtered.length, Math.trunc(desiredPos) - 1)
  );
  filtered.splice(safeTargetIndex, 0, targetStudent);

  return filtered.map((student, idx) => ({
    student,
    newRank: idx + 1,
  }));
}

const PATH_CLASS_CODE_MAP: Record<string, string> = {
  '0': 'Pre-Primary',
  '00': 'Pre-Primary',
  '1': 'Class 1',
  '01': 'Class 1',
  '2': 'Class 2',
  '02': 'Class 2',
  '3': 'Class 3',
  '03': 'Class 3',
  '4': 'Class 4',
  '04': 'Class 4',
  '5': 'Class 5',
  '05': 'Class 5',
};

/**
 * Supports path search like "04/01" (Class 4, Roll 1) or "00/01" (Pre-Primary, Roll 1),
 * plus standard text search by name, roll number, guardian phone, or parents' names.
 */
export function matchesStudentSearch(student: StudentDoc, rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (!q) return true;

  const pathMatch = q.match(/^(\d{1,2})\s*\/\s*(\d+)$/);
  if (pathMatch) {
    const classCode = pathMatch[1];
    const rollToken = pathMatch[2];
    const targetClass =
      PATH_CLASS_CODE_MAP[classCode] || PATH_CLASS_CODE_MAP[String(Number(classCode))];
    if (targetClass) {
      if (student.classLevel !== targetClass) return false;
      const stRoll = String(student.rollNumber || '').trim();
      const targetNum = Number(rollToken);
      const stNum = Number(stRoll);
      if (Number.isFinite(targetNum) && Number.isFinite(stNum) && stRoll !== '') {
        return stNum === targetNum;
      }
      return stRoll === rollToken;
    }
  }

  const lower = q.toLowerCase();
  return (
    (student.studentNameBn || '').toLowerCase().includes(lower) ||
    (student.studentNameEn || '').toLowerCase().includes(lower) ||
    String(student.rollNumber || '').toLowerCase().includes(lower) ||
    (student.guardianPhone || '').toLowerCase().includes(lower) ||
    (student.fatherNameEn || '').toLowerCase().includes(lower) ||
    (student.motherNameEn || '').toLowerCase().includes(lower)
  );
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

export function normalizeAppUpdateUrl(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  // Reject explicit non-http(s) schemes such as javascript:, data:, file:, ftp:
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return '';
    }
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      // Allow localhost only in dev if needed, otherwise require valid domain dot
      if (parsed.hostname !== 'localhost') return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

export function isValidHttpUrl(raw: string): boolean {
  return normalizeAppUpdateUrl(raw) !== '';
}

export function extractGoogleDriveFileId(rawUrl: string): string | null {
  const normalized = normalizeAppUpdateUrl(rawUrl);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if (
      host !== 'drive.google.com' &&
      host !== 'docs.google.com' &&
      host !== 'drive.usercontent.google.com'
    ) {
      return null;
    }

    // Match /file/d/<ID>/...
    const filePathMatch = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
    if (filePathMatch) return filePathMatch[1];

    // Match ?id=<ID> (used in /open?id=..., /uc?id=..., /uc?export=download&id=...)
    const idParam = parsed.searchParams.get('id');
    if (idParam && /^[a-zA-Z0-9_-]{10,}$/.test(idParam)) {
      return idParam;
    }

    return null;
  } catch {
    return null;
  }
}

export interface ResolvedApkDownloadInfo {
  normalizedUrl: string;
  directDownloadUrl: string;
  backupUrl: string | null;
  provider: 'gdrive' | 'dropbox' | 'direct';
}

export function resolveDirectApkDownloadInfo(rawUrl: string): ResolvedApkDownloadInfo | null {
  const normalizedUrl = normalizeAppUpdateUrl(rawUrl);
  if (!normalizedUrl) return null;

  const driveId = extractGoogleDriveFileId(normalizedUrl);
  if (driveId) {
    const directDownloadUrl = `https://drive.google.com/uc?export=download&id=${driveId}`;
    const backupUrl =
      normalizedUrl === directDownloadUrl
        ? `https://drive.google.com/file/d/${driveId}/view`
        : normalizedUrl;
    return {
      normalizedUrl,
      directDownloadUrl,
      backupUrl,
      provider: 'gdrive',
    };
  }

  try {
    const parsed = new URL(normalizedUrl);
    const host = parsed.hostname.toLowerCase();
    if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
      const directParsed = new URL(normalizedUrl);
      directParsed.searchParams.set('dl', '1');
      const directDownloadUrl = directParsed.toString();
      return {
        normalizedUrl,
        directDownloadUrl,
        backupUrl: directDownloadUrl !== normalizedUrl ? normalizedUrl : null,
        provider: 'dropbox',
      };
    }
  } catch {
    // ignore
  }

  return {
    normalizedUrl,
    directDownloadUrl: normalizedUrl,
    backupUrl: null,
    provider: 'direct',
  };
}

export function isSameHostnameUrl(
  rawUrl: string,
  currentHostname: string | undefined = typeof window !== 'undefined'
    ? window.location.hostname
    : undefined
): boolean {
  if (!currentHostname) return false;
  const normalized = normalizeAppUpdateUrl(rawUrl);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    const stripWww = (h: string) => h.trim().toLowerCase().replace(/^www\./, '');
    return stripWww(parsed.hostname) === stripWww(currentHostname);
  } catch {
    return false;
  }
}

export async function verifySelfHostedApkUrl(rawUrl: string): Promise<boolean> {
  const normalized = normalizeAppUpdateUrl(rawUrl);
  if (!normalized) return false;
  try {
    const res = await fetch(normalized, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return false;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType || contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      return false;
    }
    return (
      contentType.includes('application/vnd.android.package-archive') ||
      contentType.includes('application/octet-stream') ||
      contentType.includes('application/zip') ||
      contentType.includes('application/x-apk') ||
      contentType.includes('binary/octet-stream')
    );
  } catch {
    return false;
  }
}

