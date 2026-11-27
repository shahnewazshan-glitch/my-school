import React, { useMemo, useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  AlertTriangle,
  Award,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  FileSpreadsheet,
  GraduationCap,
  Landmark,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { getFirebaseInstances } from '../lib/firebase';
import {
  buildCustomFieldPayload,
  buildPendingChangePayload,
  clampText,
  FIRESTORE_LIMITS,
  formatFirestoreError,
  sanitizeStringRecordMap,
  withWriteTimeout,
} from '../lib/firestoreValidation';
import {
  BDRIS_VERIFY_URL,
  BLOOD_GROUP_OPTIONS,
  buildPortalFillBookmarklet,
  CUB_SCOUT_URL,
  findExistingMatchingCustomField,
  GENDER_OPTIONS,
  GOVT_PRESET_FIELDS,
  getPortalStatusKey,
  getTargetCustomFieldKey,
  MFS_PROVIDER_OPTIONS,
  PESP_STIPEND_URL,
  RELIGION_OPTIONS,
  type GovtPortalType,
  validateStudentForPortal,
} from '../lib/govtPortal';
import { getClassLabel, t } from '../lib/i18n';
import {
  buildMergedSectorNotes,
  compareRollNumbers,
  getSchoolDisplayMeta,
  matchesStudentSearch,
} from '../lib/schoolUtils';
import {
  downloadSafeCsvWithBom,
  normalizeImportedDigitId,
  normalizeImportedPhone,
  writeSafeXlsxWorkbook,
} from '../lib/spreadsheetUtils';
import type { StudentDoc } from '../types/school';

type StatusFilter = 'all' | 'ready' | 'incomplete' | 'submitted';

interface QuickFillDraft {
  studentNameBn: string;
  studentNameEn: string;
  fatherNameEn: string;
  motherNameEn: string;
  dateOfBirth: string;
  guardianPhone: string;
  address: string;
  brn: string;
  gender: string;
  religion: string;
  bloodGroup: string;
  fatherNid: string;
  motherNid: string;
  mfsNumber: string;
  mfsProvider: string;
  cubPack: string;
  submitted: boolean;
}

export const GovtPortalView: React.FC = () => {
  const {
    lang,
    session,
    school,
    students,
    customFields,
    selectedAcademicYear,
    selectedClass,
    setSyncing,
  } = useApp();

  const isAdmin = session?.role === 'ADMIN';
  const schoolMeta = useMemo(() => getSchoolDisplayMeta(school, lang), [school, lang]);

  const [portal, setPortal] = useState<GovtPortalType>('stipend');
  const [scopeAllClasses, setScopeAllClasses] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [syncingPresets, setSyncingPresets] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Quick-fill modal
  const [activeStudentId, setActiveStudentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<QuickFillDraft | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [showBookmarklet, setShowBookmarklet] = useState(false);

  const missingPresetSpecs = useMemo(
    () =>
      GOVT_PRESET_FIELDS.filter(
        (spec) => !findExistingMatchingCustomField(customFields, spec.id)
      ),
    [customFields]
  );

  const scopedStudents = useMemo(() => {
    return students
      .filter((s) => Number(s.academicYear) === Number(selectedAcademicYear))
      .filter((s) => scopeAllClasses || s.classLevel === selectedClass)
      .sort((a, b) => {
        if (a.classLevel !== b.classLevel) {
          return a.classLevel.localeCompare(b.classLevel);
        }
        return compareRollNumbers(a, b);
      });
  }, [students, selectedAcademicYear, selectedClass, scopeAllClasses]);

  const validatedRows = useMemo(() => {
    return scopedStudents.map((student) => ({
      student,
      validation: validateStudentForPortal(
        student,
        customFields,
        portal,
        selectedAcademicYear
      ),
    }));
  }, [scopedStudents, customFields, portal, selectedAcademicYear]);

  const counts = useMemo(() => {
    let ready = 0;
    let incomplete = 0;
    let submitted = 0;
    for (const row of validatedRows) {
      if (row.validation.status === 'submitted') submitted += 1;
      else if (row.validation.status === 'ready') ready += 1;
      else incomplete += 1;
    }
    return {
      total: validatedRows.length,
      ready,
      incomplete,
      submitted,
    };
  }, [validatedRows]);

  const filteredRows = useMemo(() => {
    return validatedRows.filter(({ student, validation }) => {
      if (statusFilter !== 'all' && validation.status !== statusFilter) return false;
      if (!query.trim()) return true;
      if (matchesStudentSearch(student, query)) return true;
      const lower = query.trim().toLowerCase();
      return (
        validation.data.brn.toLowerCase().includes(lower) ||
        validation.data.fatherNid.toLowerCase().includes(lower) ||
        validation.data.motherNid.toLowerCase().includes(lower) ||
        validation.data.mfsNumber.toLowerCase().includes(lower) ||
        validation.data.cubPack.toLowerCase().includes(lower)
      );
    });
  }, [validatedRows, statusFilter, query]);

  const activeRowIndex = useMemo(
    () =>
      activeStudentId
        ? filteredRows.findIndex((r) => r.student.id === activeStudentId)
        : -1,
    [filteredRows, activeStudentId]
  );

  const activeEntry =
    activeStudentId
      ? validatedRows.find((r) => r.student.id === activeStudentId) || null
      : null;

  const copyText = async (chipKey: string, value: string) => {
    const text = String(value || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(chipKey);
      setTimeout(() => {
        setCopiedKey((prev) => (prev === chipKey ? null : prev));
      }, 1800);
    } catch {
      setBanner({
        type: 'error',
        text: 'Clipboard copy not permitted by browser.',
      });
    }
  };

  const openQuickFill = (student: StudentDoc) => {
    const v = validateStudentForPortal(student, customFields, portal, selectedAcademicYear);
    setActiveStudentId(student.id);
    setShowBookmarklet(false);
    setDraft({
      studentNameBn: student.studentNameBn || '',
      studentNameEn: student.studentNameEn || '',
      fatherNameEn: student.fatherNameEn || '',
      motherNameEn: student.motherNameEn || '',
      dateOfBirth: student.dateOfBirth || '',
      guardianPhone: normalizeImportedPhone(student.guardianPhone || ''),
      address: student.address || '',
      brn: v.data.brn,
      gender: v.data.gender,
      religion: v.data.religion,
      bloodGroup: v.data.bloodGroup,
      fatherNid: v.data.fatherNid,
      motherNid: v.data.motherNid,
      mfsNumber: v.data.mfsNumber,
      mfsProvider: v.data.mfsProvider,
      cubPack: v.data.cubPack,
      submitted: portal === 'stipend' ? v.data.stipendSubmitted : v.data.cubSubmitted,
    });
  };

  const handleSyncMissingPresetFields = async () => {
    if (!session || !isAdmin || missingPresetSpecs.length === 0) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setSyncingPresets(true);
    setSyncing(true);
    setBanner(null);

    try {
      for (const spec of missingPresetSpecs) {
        // Double-check case-insensitive alias match before writing
        if (findExistingMatchingCustomField(customFields, spec.id)) continue;
        const payload = buildCustomFieldPayload(
          {
            category: 'Govt Portal',
            label: spec.labelEn,
            fieldType: 'TEXT',
            resetsYearly: false,
          },
          session.schoolId
        );
        await withWriteTimeout(
          setDoc(
            doc(instances.db, 'schools', session.schoolId, 'customFields', spec.id),
            payload,
            { merge: true }
          )
        );
      }
      setBanner({
        type: 'success',
        text:
          lang === 'bn'
            ? 'সরকারি পোর্টালের অনুপস্থিত ফিল্ডসমূহ সফলভাবে যুক্ত হয়েছে (বিদ্যমান ফিল্ড অপরিবর্তিত)।'
            : 'Synced missing Govt Portal preset custom fields without duplicating existing fields.',
      });
    } catch (err) {
      setBanner({
        type: 'error',
        text: `${t(lang, 'errorPrefix')} ${formatFirestoreError(err)}`,
      });
    } finally {
      setSyncingPresets(false);
      setSyncing(false);
    }
  };

  const handleToggleSubmitted = async (student: StudentDoc, nextSubmitted: boolean) => {
    if (!session) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    const statusKey = getPortalStatusKey(portal, selectedAcademicYear);
    const nextVal = nextSubmitted ? 'Submitted' : '';
    setTogglingId(student.id);
    setSyncing(true);
    setBanner(null);

    try {
      const mergedNotes = buildMergedSectorNotes(student.sectorNotes, {
        [statusKey]: nextVal,
      });

      if (isAdmin) {
        await withWriteTimeout(
          updateDoc(
            doc(instances.db, 'schools', session.schoolId, 'students', student.id),
            {
              sectorNotes: mergedNotes,
              lastUpdatedByName: clampText(session.name, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
              updatedAt: serverTimestamp(),
            }
          )
        );
      } else {
        const pendingDoc = buildPendingChangePayload({
          schoolId: session.schoolId,
          entityType: 'STUDENT_BATCH_UPDATE',
          targetId: `${student.id}_portal_${portal}_${Date.now()}`,
          submittedByDeviceId: session.deviceId,
          submittedByName: session.name,
          summary: `Portal Status (${portal === 'stipend' ? 'Stipend' : 'Cub'} ${selectedAcademicYear}): ${student.studentNameBn || student.studentNameEn}`,
          detailsText: `${statusKey}: ${nextVal || 'Cleared'}`,
          payloadJson: JSON.stringify({
            updates: {
              [student.id]: {
                [`sectorNotes.${statusKey}`]: nextVal,
              },
            },
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
      setTogglingId(null);
      setSyncing(false);
    }
  };

  const handleSaveQuickFill = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !activeEntry || !draft) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    const { student } = activeEntry;
    setSavingDraft(true);
    setSyncing(true);
    setBanner(null);

    try {
      const keyBrn = getTargetCustomFieldKey(customFields, 'cf_govt_brn');
      const keyGender = getTargetCustomFieldKey(customFields, 'cf_govt_gender');
      const keyReligion = getTargetCustomFieldKey(customFields, 'cf_govt_religion');
      const keyBlood = getTargetCustomFieldKey(customFields, 'cf_govt_blood_group');
      const keyFatherNid = getTargetCustomFieldKey(customFields, 'cf_govt_father_nid');
      const keyMotherNid = getTargetCustomFieldKey(customFields, 'cf_govt_mother_nid');
      const keyMfsNum = getTargetCustomFieldKey(customFields, 'cf_govt_mfs_number');
      const keyMfsProv = getTargetCustomFieldKey(customFields, 'cf_govt_mfs_provider');
      const keyCubPack = getTargetCustomFieldKey(customFields, 'cf_govt_cub_pack');

      const customPatch: Record<string, string> = {
        [keyBrn]: normalizeImportedDigitId(draft.brn),
        [keyGender]: draft.gender.trim(),
        [keyReligion]: draft.religion.trim(),
        [keyBlood]: draft.bloodGroup.trim(),
        [keyFatherNid]: normalizeImportedDigitId(draft.fatherNid),
        [keyMotherNid]: normalizeImportedDigitId(draft.motherNid),
        [keyMfsNum]: normalizeImportedPhone(draft.mfsNumber),
        [keyMfsProv]: draft.mfsProvider.trim(),
        [keyCubPack]: draft.cubPack.trim(),
      };

      const mergedCustom: Record<string, unknown> = { ...(student.customValues || {}) };
      for (const [k, v] of Object.entries(customPatch)) {
        if (v === '') delete mergedCustom[k];
        else mergedCustom[k] = v;
      }
      const sanitizedCustom = sanitizeStringRecordMap(mergedCustom);

      const statusKey = getPortalStatusKey(portal, selectedAcademicYear);
      const statusVal = draft.submitted ? 'Submitted' : '';
      const mergedNotes = buildMergedSectorNotes(student.sectorNotes, {
        [statusKey]: statusVal,
      });

      const cleanGuardianPhone = normalizeImportedPhone(draft.guardianPhone);

      if (isAdmin) {
        await withWriteTimeout(
          updateDoc(
            doc(instances.db, 'schools', session.schoolId, 'students', student.id),
            {
              studentNameBn: draft.studentNameBn.trim(),
              studentNameEn: draft.studentNameEn.trim(),
              fatherNameEn: draft.fatherNameEn.trim(),
              motherNameEn: draft.motherNameEn.trim(),
              dateOfBirth: draft.dateOfBirth.trim(),
              guardianPhone: cleanGuardianPhone,
              address: draft.address.trim(),
              customValues: sanitizedCustom,
              sectorNotes: mergedNotes,
              lastUpdatedByName: clampText(session.name, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS),
              updatedAt: serverTimestamp(),
            }
          )
        );
        setBanner({ type: 'success', text: t(lang, 'savedSuccess') });
      } else {
        const patchObj: Record<string, string> = {
          studentNameBn: draft.studentNameBn.trim(),
          studentNameEn: draft.studentNameEn.trim(),
          fatherNameEn: draft.fatherNameEn.trim(),
          motherNameEn: draft.motherNameEn.trim(),
          dateOfBirth: draft.dateOfBirth.trim(),
          guardianPhone: cleanGuardianPhone,
          address: draft.address.trim(),
          [`sectorNotes.${statusKey}`]: statusVal,
        };
        for (const [k, v] of Object.entries(customPatch)) {
          patchObj[`customValues.${k}`] = v;
        }
        const pendingDoc = buildPendingChangePayload({
          schoolId: session.schoolId,
          entityType: 'STUDENT_BATCH_UPDATE',
          targetId: `${student.id}_portal_edit_${Date.now()}`,
          submittedByDeviceId: session.deviceId,
          submittedByName: session.name,
          summary: `Govt Portal Quick-Fill: ${draft.studentNameBn || draft.studentNameEn}`,
          detailsText: `${portal === 'stipend' ? 'Stipend' : 'Cub Scout'} (${selectedAcademicYear})`,
          payloadJson: JSON.stringify({
            updates: {
              [student.id]: patchObj,
            },
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
      setSavingDraft(false);
      setSyncing(false);
    }
  };

  const handleExportPortal = async (format: 'xlsx' | 'csv') => {
    const isStipend = portal === 'stipend';
    const headers = isStipend
      ? [
          'School Code',
          'EMIS',
          'Class',
          'Roll No',
          'Student Name (Bn)',
          'Student Name (En)',
          'Date of Birth',
          'Birth Registration No (BRN)',
          'Gender',
          'Religion',
          "Father's Name",
          'Father NID',
          "Mother's Name",
          'Mother NID',
          'MFS / Payment Mobile',
          'MFS Provider',
          'Guardian Phone',
          'Address',
          'Portal Status',
          'Missing / Warnings',
        ]
      : [
          'School Code',
          'EMIS',
          'Class',
          'Roll No',
          'Student Name (Bn)',
          'Student Name (En)',
          'Date of Birth',
          'Birth Registration No (BRN)',
          'Gender',
          'Religion',
          'Blood Group',
          "Father's Name",
          "Mother's Name",
          'Guardian Phone',
          'Cub Pack / Six Name',
          'Address',
          'Portal Status',
          'Missing / Warnings',
        ];

    const rows = filteredRows.map(({ student, validation }) => {
      const d = validation.data;
      const issueSummary = [...validation.missing, ...validation.warnings].join('; ');
      const statusLabel =
        validation.status === 'submitted'
          ? 'Submitted'
          : validation.status === 'ready'
          ? 'Ready'
          : 'Incomplete';

      if (isStipend) {
        return [
          schoolMeta.displaySchoolCode,
          schoolMeta.emisCode,
          student.classLevel,
          String(student.rollNumber ?? ''),
          student.studentNameBn || '',
          student.studentNameEn || '',
          student.dateOfBirth || '',
          d.brn,
          d.gender,
          d.religion,
          student.fatherNameEn || '',
          d.fatherNid,
          student.motherNameEn || '',
          d.motherNid,
          d.mfsNumber || normalizeImportedPhone(student.guardianPhone || ''),
          d.mfsProvider,
          normalizeImportedPhone(student.guardianPhone || ''),
          student.address || '',
          statusLabel,
          issueSummary,
        ];
      }

      return [
        schoolMeta.displaySchoolCode,
        schoolMeta.emisCode,
        student.classLevel,
        String(student.rollNumber ?? ''),
        student.studentNameBn || '',
        student.studentNameEn || '',
        student.dateOfBirth || '',
        d.brn,
        d.gender,
        d.religion,
        d.bloodGroup,
        student.fatherNameEn || '',
        student.motherNameEn || '',
        normalizeImportedPhone(student.guardianPhone || ''),
        d.cubPack,
        student.address || '',
        statusLabel,
        issueSummary,
      ];
    });

    const scopeSlug = scopeAllClasses ? 'All_Classes' : selectedClass.replace(/\s+/g, '_');
    const portalSlug = isStipend ? 'Primary_Stipend' : 'Cub_Scout';
    const baseName = `${schoolMeta.displaySchoolCode}_${portalSlug}_${scopeSlug}_${selectedAcademicYear}`;

    if (format === 'csv') {
      downloadSafeCsvWithBom(headers, rows, `${baseName}.csv`);
      return;
    }

    const XLSX = await import('xlsx');
    const aoa = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, isStipend ? 'Primary Stipend' : 'Cub Scout');
    writeSafeXlsxWorkbook(XLSX, wb, `${baseName}.xlsx`);
  };

  const CopyChip: React.FC<{ label: string; value: string; chipId: string }> = ({
    label,
    value,
    chipId,
  }) => {
    const clean = String(value || '').trim();
    if (!clean) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-stone-100 text-stone-400 text-[11px]">
          {label}: —
        </span>
      );
    }
    const isCopied = copiedKey === chipId;
    return (
      <button
        type="button"
        onClick={() => copyText(chipId, clean)}
        title={`Copy ${label}: ${clean}`}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono transition-colors cursor-pointer ${
          isCopied
            ? 'bg-emerald-700 text-white border-emerald-700'
            : 'bg-white hover:bg-emerald-50 text-slate-800 border-stone-300'
        }`}
      >
        <span className="font-sans font-medium text-slate-500">
          {isCopied ? 'Copied' : label}:
        </span>
        <span className={isCopied ? 'text-white font-semibold' : 'text-slate-900 font-semibold'}>
          {clean}
        </span>
        {isCopied ? (
          <Check className="w-3 h-3 shrink-0" />
        ) : (
          <Copy className="w-3 h-3 text-slate-400 shrink-0" />
        )}
      </button>
    );
  };

  const activeBookmarklet = useMemo(() => {
    if (!activeEntry) return '';
    return buildPortalFillBookmarklet(activeEntry.student, activeEntry.validation.data);
  }, [activeEntry]);

  return (
    <div className="space-y-5">
      {/* Header & Official Portals */}
      <div className="bg-white border border-stone-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Landmark className="w-5 h-5 text-emerald-700" />
            <h2 className="text-lg font-bold text-slate-900">
              {lang === 'bn'
                ? 'সরকারি পোর্টাল সহায়ক (উপবৃত্তি ও কাব স্কাউট)'
                : 'Govt Portal Submission Helper (Primary Stipend & Cub Scout)'}
            </h2>
          </div>
          <p className="text-xs text-slate-600 mt-1">
            {schoolMeta.schoolName} · {t(lang, 'displaySchoolCodeLabel')}:{' '}
            <span className="font-mono font-semibold text-emerald-800">
              {schoolMeta.displaySchoolCode}
            </span>{' '}
            · EMIS: <span className="font-mono font-semibold">{schoolMeta.emisCode}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={PESP_STIPEND_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg whitespace-nowrap"
          >
            <GraduationCap className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'উপবৃত্তি পোর্টাল (PESP)' : 'Primary Stipend Portal'}</span>
            <ExternalLink className="w-3 h-3" />
          </a>

          <a
            href={CUB_SCOUT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white rounded-lg whitespace-nowrap"
          >
            <Award className="w-3.5 h-3.5" />
            <span>{lang === 'bn' ? 'কাব স্কাউট পোর্টাল' : 'Cub Scout Portal'}</span>
            <ExternalLink className="w-3 h-3" />
          </a>

          <a
            href={BDRIS_VERIFY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white hover:bg-stone-50 text-slate-800 border border-stone-300 rounded-lg whitespace-nowrap"
          >
            <span>{lang === 'bn' ? 'BRN যাচাই (BDRIS)' : 'Verify BRN (BDRIS)'}</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

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

      {/* Sync missing preset custom fields notice (Admin only, non-duplicating) */}
      {isAdmin && missingPresetSpecs.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-amber-950 space-y-0.5">
            <div className="font-semibold">
              {lang === 'bn'
                ? `${missingPresetSpecs.length}টি সরকারি পোর্টাল কাস্টম ফিল্ড এখনো নিবন্ধিত নয়`
                : `${missingPresetSpecs.length} Govt Portal custom field(s) not yet registered in School Setup`}
            </div>
            <p className="text-amber-900/90">
              {lang === 'bn'
                ? 'বিদ্যমান কাস্টম ফিল্ডের নামের সাথে মিল থাকলে ডুপ্লিকেট তৈরি না করে শুধু অনুপস্থিত ফিল্ড যুক্ত হবে।'
                : 'Checks existing field labels case-insensitively first so existing custom field data is never duplicated.'}
            </p>
          </div>
          <button
            type="button"
            disabled={syncingPresets}
            onClick={handleSyncMissingPresetFields}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-amber-700 hover:bg-amber-800 disabled:opacity-60 text-white rounded-lg cursor-pointer whitespace-nowrap shrink-0"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>
              {syncingPresets
                ? t(lang, 'loading')
                : lang === 'bn'
                ? 'অনুপস্থিত পোর্টাল ফিল্ড যুক্ত করুন'
                : 'Sync Preset Fields'}
            </span>
          </button>
        </div>
      )}

      {/* Portal Selector + Stats + Export Bar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
        <div className="lg:col-span-5 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-stone-200/70 rounded-lg">
            <button
              type="button"
              onClick={() => setPortal('stipend')}
              className={`px-3.5 py-2 text-xs font-semibold rounded-md cursor-pointer whitespace-nowrap ${
                portal === 'stipend'
                  ? 'bg-emerald-700 text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              {lang === 'bn' ? 'প্রাথমিক উপবৃত্তি (Stipend)' : 'Primary Stipend'}
            </button>
            <button
              type="button"
              onClick={() => setPortal('cub')}
              className={`px-3.5 py-2 text-xs font-semibold rounded-md cursor-pointer whitespace-nowrap ${
                portal === 'cub'
                  ? 'bg-amber-600 text-white shadow-xs'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              {lang === 'bn' ? 'কাব স্কাউট (Cub Scout)' : 'Cub Scout'}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setScopeAllClasses((p) => !p)}
            className={`px-3 py-2 text-xs font-medium rounded-lg border cursor-pointer whitespace-nowrap ${
              scopeAllClasses
                ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                : 'bg-white border-stone-300 text-slate-700 hover:bg-stone-50'
            }`}
          >
            {scopeAllClasses
              ? t(lang, 'allClasses')
              : getClassLabel(selectedClass, lang)}
          </button>
        </div>

        {/* Summary Counters */}
        <div className="lg:col-span-4 grid grid-cols-4 gap-2 text-center">
          <div className="bg-white border border-stone-200 rounded-lg py-2 px-1">
            <div className="text-base font-bold text-slate-900 tabular-nums">{counts.total}</div>
            <div className="text-[11px] text-slate-500">{lang === 'bn' ? 'মোট' : 'All'}</div>
          </div>
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg py-2 px-1">
            <div className="text-base font-bold text-emerald-800 tabular-nums">{counts.ready}</div>
            <div className="text-[11px] text-emerald-700">{lang === 'bn' ? 'প্রস্তুত' : 'Ready'}</div>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-lg py-2 px-1">
            <div className="text-base font-bold text-amber-800 tabular-nums">
              {counts.incomplete}
            </div>
            <div className="text-[11px] text-amber-700">
              {lang === 'bn' ? 'অসম্পূর্ণ' : 'Incomplete'}
            </div>
          </div>
          <div className="bg-sky-50 border border-sky-200 rounded-lg py-2 px-1">
            <div className="text-base font-bold text-sky-800 tabular-nums">
              {counts.submitted}
            </div>
            <div className="text-[11px] text-sky-700">
              {lang === 'bn' ? 'জমাকৃত' : 'Submitted'}
            </div>
          </div>
        </div>

        {/* Safe Exports */}
        <div className="lg:col-span-3 flex flex-wrap items-center justify-start lg:justify-end gap-2">
          <button
            type="button"
            onClick={() => handleExportPortal('xlsx')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white hover:bg-stone-50 text-slate-800 border border-stone-300 rounded-lg cursor-pointer whitespace-nowrap"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
            <span>Safe .xlsx</span>
          </button>
          <button
            type="button"
            onClick={() => handleExportPortal('csv')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-white hover:bg-stone-50 text-slate-800 border border-stone-300 rounded-lg cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5 text-slate-600" />
            <span>UTF-8 CSV</span>
          </button>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-stone-100 rounded-lg w-fit">
          {(
            [
              { id: 'all', label: lang === 'bn' ? `সকল (${counts.total})` : `All (${counts.total})` },
              {
                id: 'ready',
                label: lang === 'bn' ? `প্রস্তুত (${counts.ready})` : `Ready (${counts.ready})`,
              },
              {
                id: 'incomplete',
                label:
                  lang === 'bn'
                    ? `অসম্পূর্ণ (${counts.incomplete})`
                    : `Incomplete (${counts.incomplete})`,
              },
              {
                id: 'submitted',
                label:
                  lang === 'bn'
                    ? `জমাকৃত (${counts.submitted})`
                    : `Submitted (${counts.submitted})`,
              },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setStatusFilter(f.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer whitespace-nowrap ${
                statusFilter === f.id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              lang === 'bn'
                ? 'নাম, রোল, 04/01, BRN বা মোবাইল...'
                : 'Search name, roll, 04/01, BRN, phone...'
            }
            className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
          />
        </div>
      </div>

      {/* Student Portal Readiness List */}
      <div className="space-y-3">
        {filteredRows.length === 0 ? (
          <div className="bg-white border border-stone-200 rounded-xl p-10 text-center text-sm text-slate-500">
            {t(lang, 'noStudentsFound')}
          </div>
        ) : (
          filteredRows.map(({ student, validation }) => {
            const d = validation.data;
            const isSubmitted = validation.status === 'submitted';
            const effectiveMfs = d.mfsNumber || normalizeImportedPhone(student.guardianPhone || '');

            return (
              <div
                key={student.id}
                className="bg-white border border-stone-200 rounded-xl p-4 space-y-3 hover:border-emerald-300 transition-colors"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2 py-0.5 text-xs font-mono font-bold bg-stone-100 text-slate-800 rounded">
                        Roll {student.rollNumber}
                      </span>
                      {scopeAllClasses && (
                        <span className="text-xs font-medium text-emerald-800">
                          {getClassLabel(student.classLevel, lang)}
                        </span>
                      )}
                      <h3 className="text-sm font-bold text-slate-900">
                        {student.studentNameBn || student.studentNameEn}
                      </h3>
                      {student.studentNameEn && student.studentNameBn && (
                        <span className="text-xs text-slate-500">({student.studentNameEn})</span>
                      )}

                      {validation.status === 'submitted' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-100 text-sky-900 text-[11px] font-semibold">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>Submitted ({selectedAcademicYear})</span>
                        </span>
                      ) : validation.status === 'ready' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-900 text-[11px] font-semibold">
                          <Check className="w-3 h-3" />
                          <span>Ready</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-[11px] font-semibold">
                          <AlertTriangle className="w-3 h-3" />
                          <span>{validation.missing.length} Missing</span>
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                      <span>Father: {student.fatherNameEn || '—'}</span>
                      <span>Mother: {student.motherNameEn || '—'}</span>
                      <span>DOB: {student.dateOfBirth || '—'}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={togglingId === student.id}
                      onClick={() => handleToggleSubmitted(student, !isSubmitted)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border cursor-pointer whitespace-nowrap ${
                        isSubmitted
                          ? 'bg-sky-700 text-white border-sky-700 hover:bg-sky-800'
                          : 'bg-white text-slate-700 border-stone-300 hover:bg-stone-50'
                      }`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>
                        {togglingId === student.id
                          ? '...'
                          : isSubmitted
                          ? lang === 'bn'
                            ? 'জমাকৃত'
                            : 'Submitted'
                          : lang === 'bn'
                          ? 'জমাকৃত চিহ্ন দিন'
                          : 'Mark Submitted'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => openQuickFill(student)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg cursor-pointer whitespace-nowrap"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>{lang === 'bn' ? 'কুইক-ফিল' : 'Quick-Fill'}</span>
                    </button>
                  </div>
                </div>

                {/* 1-Tap Copy Chips */}
                <div className="flex flex-wrap gap-1.5 pt-2 border-t border-stone-100">
                  <CopyChip
                    label="Name"
                    value={student.studentNameEn || student.studentNameBn}
                    chipId={`${student.id}_name`}
                  />
                  <CopyChip
                    label="DOB"
                    value={student.dateOfBirth || ''}
                    chipId={`${student.id}_dob`}
                  />
                  <CopyChip
                    label="BRN"
                    value={d.brn}
                    chipId={`${student.id}_brn`}
                  />
                  <CopyChip
                    label="Gender"
                    value={d.gender}
                    chipId={`${student.id}_gender`}
                  />
                  <CopyChip
                    label="Religion"
                    value={d.religion}
                    chipId={`${student.id}_religion`}
                  />
                  {portal === 'stipend' ? (
                    <>
                      <CopyChip
                        label="F.NID"
                        value={d.fatherNid}
                        chipId={`${student.id}_fnid`}
                      />
                      <CopyChip
                        label="M.NID"
                        value={d.motherNid}
                        chipId={`${student.id}_mnid`}
                      />
                      <CopyChip
                        label={d.mfsProvider || 'MFS'}
                        value={effectiveMfs}
                        chipId={`${student.id}_mfs`}
                      />
                    </>
                  ) : (
                    <>
                      <CopyChip
                        label="Blood"
                        value={d.bloodGroup}
                        chipId={`${student.id}_blood`}
                      />
                      <CopyChip
                        label="Phone"
                        value={normalizeImportedPhone(student.guardianPhone || '')}
                        chipId={`${student.id}_phone`}
                      />
                      {d.cubPack && (
                        <CopyChip
                          label="Pack"
                          value={d.cubPack}
                          chipId={`${student.id}_pack`}
                        />
                      )}
                    </>
                  )}
                  <CopyChip
                    label="Address"
                    value={student.address || ''}
                    chipId={`${student.id}_addr`}
                  />
                </div>

                {/* Missing Fields & Non-blocking Warnings */}
                {(validation.missing.length > 0 || validation.warnings.length > 0) && (
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    {validation.missing.length > 0 && (
                      <span className="px-2 py-0.5 rounded bg-rose-50 border border-rose-200 text-rose-800">
                        <strong>Missing:</strong> {validation.missing.join(', ')}
                      </span>
                    )}
                    {validation.warnings.map((w, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-900"
                      >
                        <strong>Warning:</strong> {w}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Quick-Fill Edit Modal with Previous / Next Student Switcher */}
      {activeEntry && draft && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-stone-200 rounded-xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
            <div className="px-5 py-4 border-b border-stone-200 flex flex-wrap items-center justify-between gap-3 bg-emerald-800 text-white">
              <div className="min-w-0">
                <h3 className="text-base font-bold truncate">
                  {draft.studentNameBn || draft.studentNameEn} (Roll{' '}
                  {activeEntry.student.rollNumber})
                </h3>
                <p className="text-xs text-emerald-100">
                  {getClassLabel(activeEntry.student.classLevel, lang)} ·{' '}
                  {portal === 'stipend' ? 'Primary Stipend' : 'Cub Scout'} ({selectedAcademicYear})
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={activeRowIndex <= 0}
                  onClick={() => {
                    if (activeRowIndex > 0) {
                      openQuickFill(filteredRows[activeRowIndex - 1].student);
                    }
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white rounded-lg cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>{t(lang, 'prevStudent')}</span>
                </button>
                <button
                  type="button"
                  disabled={activeRowIndex < 0 || activeRowIndex >= filteredRows.length - 1}
                  onClick={() => {
                    if (activeRowIndex >= 0 && activeRowIndex < filteredRows.length - 1) {
                      openQuickFill(filteredRows[activeRowIndex + 1].student);
                    }
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white rounded-lg cursor-pointer"
                >
                  <span>{t(lang, 'nextStudent')}</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveStudentId(null);
                    setDraft(null);
                  }}
                  className="p-1.5 text-emerald-100 hover:text-white cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <form onSubmit={handleSaveQuickFill} className="flex-1 overflow-y-auto p-5 space-y-5">
              {/* Live 1-Tap Copy Bar + BDRIS Link */}
              <div className="p-3 rounded-lg bg-stone-50 border border-stone-200 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-700">
                    {lang === 'bn' ? '১-ক্লিক কপি চিপস' : '1-Tap Portal Copy Chips'}
                  </span>
                  <div className="flex items-center gap-2">
                    <a
                      href={BDRIS_VERIFY_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:underline"
                    >
                      <span>BDRIS Verify</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    <button
                      type="button"
                      onClick={() => setShowBookmarklet((p) => !p)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold bg-white border border-stone-300 rounded text-slate-700 hover:bg-stone-100 cursor-pointer"
                    >
                      <Code2 className="w-3 h-3" />
                      <span>{lang === 'bn' ? 'বুকমার্কলেট স্ক্রিপ্ট' : 'Auto-Fill Bookmarklet'}</span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <CopyChip label="BRN" value={draft.brn} chipId="m_brn" />
                  <CopyChip label="DOB" value={draft.dateOfBirth} chipId="m_dob" />
                  <CopyChip label="F.NID" value={draft.fatherNid} chipId="m_fnid" />
                  <CopyChip label="M.NID" value={draft.motherNid} chipId="m_mnid" />
                  <CopyChip label="MFS" value={draft.mfsNumber} chipId="m_mfs" />
                  <CopyChip label="Phone" value={draft.guardianPhone} chipId="m_phone" />
                </div>

                {showBookmarklet && (
                  <div className="mt-2 pt-2 border-t border-stone-200 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-slate-600">
                        {lang === 'bn'
                          ? 'এই স্ক্রিপ্টটি কপি করে ব্রাউজারের বুকমার্ক URL-এ সেভ করুন এবং .gov.bd ফর্ম পেজে ক্লিক করুন (সাবমিটের আগে অবশ্যই যাচাই করুন):'
                          : 'Copy into a browser bookmark URL (or DevTools) while viewing a .gov.bd form. Always review all fields before submitting:'}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyText('bookmarklet', activeBookmarklet)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-emerald-700 text-white rounded cursor-pointer shrink-0"
                      >
                        {copiedKey === 'bookmarklet' ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span>{copiedKey === 'bookmarklet' ? 'Copied!' : 'Copy Script'}</span>
                      </button>
                    </div>
                    <textarea
                      readOnly
                      rows={2}
                      value={activeBookmarklet}
                      className="w-full px-2.5 py-1.5 text-[11px] font-mono bg-white border border-stone-300 rounded text-slate-600"
                    />
                  </div>
                )}
              </div>

              {/* Editable Core + Govt Portal Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'studentNameBn')}
                  </label>
                  <input
                    type="text"
                    value={draft.studentNameBn}
                    onChange={(e) => setDraft((p) => (p ? { ...p, studentNameBn: e.target.value } : null))}
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'studentNameEn')}
                  </label>
                  <input
                    type="text"
                    value={draft.studentNameEn}
                    onChange={(e) => setDraft((p) => (p ? { ...p, studentNameEn: e.target.value } : null))}
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'fatherNameEn')}
                  </label>
                  <input
                    type="text"
                    value={draft.fatherNameEn}
                    onChange={(e) => setDraft((p) => (p ? { ...p, fatherNameEn: e.target.value } : null))}
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'motherNameEn')}
                  </label>
                  <input
                    type="text"
                    value={draft.motherNameEn}
                    onChange={(e) => setDraft((p) => (p ? { ...p, motherNameEn: e.target.value } : null))}
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-700">
                      Birth Registration No (17-digit BRN)
                    </label>
                    <span
                      className={`text-[11px] font-mono tabular-nums ${
                        draft.brn.replace(/\D/g, '').length === 17
                          ? 'text-emerald-700 font-semibold'
                          : 'text-amber-700'
                      }`}
                    >
                      {draft.brn.replace(/\D/g, '').length}/17
                    </span>
                  </div>
                  <input
                    type="text"
                    value={draft.brn}
                    onChange={(e) => setDraft((p) => (p ? { ...p, brn: e.target.value } : null))}
                    placeholder="17 digits e.g. 2016..."
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-stone-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'dateOfBirth')}
                  </label>
                  <input
                    type="text"
                    value={draft.dateOfBirth}
                    onChange={(e) => setDraft((p) => (p ? { ...p, dateOfBirth: e.target.value } : null))}
                    placeholder="YYYY-MM-DD or DD/MM/YYYY"
                    className="w-full px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Gender
                  </label>
                  <select
                    value={draft.gender}
                    onChange={(e) => setDraft((p) => (p ? { ...p, gender: e.target.value } : null))}
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white"
                  >
                    <option value="">-- Select --</option>
                    {GENDER_OPTIONS.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Religion
                  </label>
                  <select
                    value={draft.religion}
                    onChange={(e) => setDraft((p) => (p ? { ...p, religion: e.target.value } : null))}
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white"
                  >
                    <option value="">-- Select --</option>
                    {RELIGION_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Blood Group
                  </label>
                  <select
                    value={draft.bloodGroup}
                    onChange={(e) => setDraft((p) => (p ? { ...p, bloodGroup: e.target.value } : null))}
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white"
                  >
                    <option value="">-- Select --</option>
                    {BLOOD_GROUP_OPTIONS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'guardianPhone')} (11-digit 01...)
                  </label>
                  <input
                    type="text"
                    value={draft.guardianPhone}
                    onChange={(e) => setDraft((p) => (p ? { ...p, guardianPhone: e.target.value } : null))}
                    placeholder="01XXXXXXXXX"
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-stone-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Father NID (10, 13, or 17 digits)
                  </label>
                  <input
                    type="text"
                    value={draft.fatherNid}
                    onChange={(e) => setDraft((p) => (p ? { ...p, fatherNid: e.target.value } : null))}
                    placeholder="10 / 13 / 17 digits"
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-stone-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Mother NID (10, 13, or 17 digits)
                  </label>
                  <input
                    type="text"
                    value={draft.motherNid}
                    onChange={(e) => setDraft((p) => (p ? { ...p, motherNid: e.target.value } : null))}
                    placeholder="10 / 13 / 17 digits"
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-stone-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    MFS / Payment Mobile (01...)
                  </label>
                  <input
                    type="text"
                    value={draft.mfsNumber}
                    onChange={(e) => setDraft((p) => (p ? { ...p, mfsNumber: e.target.value } : null))}
                    placeholder="01XXXXXXXXX"
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-stone-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    MFS Provider
                  </label>
                  <select
                    value={draft.mfsProvider}
                    onChange={(e) => setDraft((p) => (p ? { ...p, mfsProvider: e.target.value } : null))}
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white"
                  >
                    <option value="">-- Select --</option>
                    {MFS_PROVIDER_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Cub Pack / Six Name (Optional)
                  </label>
                  <input
                    type="text"
                    value={draft.cubPack}
                    onChange={(e) => setDraft((p) => (p ? { ...p, cubPack: e.target.value } : null))}
                    placeholder="e.g. Red Six / Lal Shoshthok"
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {t(lang, 'address')}
                  </label>
                  <input
                    type="text"
                    value={draft.address}
                    onChange={(e) => setDraft((p) => (p ? { ...p, address: e.target.value } : null))}
                    className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-stone-200">
                <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.submitted}
                    onChange={(e) => setDraft((p) => (p ? { ...p, submitted: e.target.checked } : null))}
                    className="w-4 h-4 accent-emerald-700"
                  />
                  <span>
                    {lang === 'bn'
                      ? `${portal === 'stipend' ? 'উপবৃত্তি' : 'কাব স্কাউট'} (${selectedAcademicYear}) পোর্টালে জমা সম্পন্ন হয়েছে`
                      : `Mark ${portal === 'stipend' ? 'Primary Stipend' : 'Cub Scout'} (${selectedAcademicYear}) as Submitted`}
                  </span>
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveStudentId(null);
                      setDraft(null);
                    }}
                    className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer"
                  >
                    {t(lang, 'cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={savingDraft}
                    className="px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white rounded-lg cursor-pointer"
                  >
                    {savingDraft
                      ? t(lang, 'loading')
                      : isAdmin
                      ? t(lang, 'saveChanges')
                      : t(lang, 'submitForApproval')}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
