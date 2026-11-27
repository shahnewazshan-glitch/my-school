import type { CustomFieldDoc, StudentDoc } from '../types/school';
import { normalizeImportedDigitId, normalizeImportedPhone } from './spreadsheetUtils';
import { parseSectorNotesMap } from './schoolUtils';

export type GovtPortalType = 'stipend' | 'cub';

export const PESP_STIPEND_URL = 'https://pesp.finance.gov.bd/';
export const CUB_SCOUT_URL = 'https://service.scouts.gov.bd/';
export const BDRIS_VERIFY_URL = 'https://everify.bdris.gov.bd/';

export type GovtPresetFieldId =
  | 'cf_govt_brn'
  | 'cf_govt_gender'
  | 'cf_govt_religion'
  | 'cf_govt_blood_group'
  | 'cf_govt_father_nid'
  | 'cf_govt_mother_nid'
  | 'cf_govt_mfs_number'
  | 'cf_govt_mfs_provider'
  | 'cf_govt_cub_pack';

export interface GovtPresetFieldSpec {
  id: GovtPresetFieldId;
  labelEn: string;
  labelBn: string;
  aliases: string[];
  kind: 'digitId' | 'phone' | 'choice' | 'text';
  choices?: string[];
}

export const MFS_PROVIDER_OPTIONS = ['bKash', 'Nagad', 'Rocket', 'Upay'] as const;
export const GENDER_OPTIONS = ['Male', 'Female', 'Other'] as const;
export const RELIGION_OPTIONS = ['Islam', 'Hinduism', 'Buddhism', 'Christianity', 'Other'] as const;
export const BLOOD_GROUP_OPTIONS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

export const GOVT_PRESET_FIELDS: GovtPresetFieldSpec[] = [
  {
    id: 'cf_govt_brn',
    labelEn: 'Birth Registration No (BRN)',
    labelBn: 'জন্ম নিবন্ধন নং (১৭ ডিজিট)',
    aliases: [
      'brn',
      'birth registration no',
      'birth registration no (brn)',
      'birth registration',
      'birth reg no',
      'birth reg',
      'bdris',
      'জন্ম নিবন্ধন',
      'জন্ম নিবন্ধন নং',
      'জন্ম নিবন্ধন নং (১৭ ডিজিট)',
      'জন্ম সনদ',
    ],
    kind: 'digitId',
  },
  {
    id: 'cf_govt_gender',
    labelEn: 'Gender',
    labelBn: 'লিঙ্গ',
    aliases: ['gender', 'sex', 'লিঙ্গ', 'ছেলে/মেয়ে'],
    kind: 'choice',
    choices: [...GENDER_OPTIONS],
  },
  {
    id: 'cf_govt_religion',
    labelEn: 'Religion',
    labelBn: 'ধর্ম',
    aliases: ['religion', 'ধর্ম'],
    kind: 'choice',
    choices: [...RELIGION_OPTIONS],
  },
  {
    id: 'cf_govt_blood_group',
    labelEn: 'Blood Group',
    labelBn: 'রক্তের গ্রুপ',
    aliases: ['blood group', 'blood', 'রক্তের গ্রুপ'],
    kind: 'choice',
    choices: [...BLOOD_GROUP_OPTIONS],
  },
  {
    id: 'cf_govt_father_nid',
    labelEn: 'Father NID',
    labelBn: 'পিতার এনআইডি',
    aliases: [
      'father nid',
      "father's nid",
      'father national id',
      'পিতার এনআইডি',
      'পিতার জাতীয় পরিচয়পত্র',
    ],
    kind: 'digitId',
  },
  {
    id: 'cf_govt_mother_nid',
    labelEn: 'Mother NID',
    labelBn: 'মাতার এনআইডি',
    aliases: [
      'mother nid',
      "mother's nid",
      'mother national id',
      'মাতার এনআইডি',
      'মাতার জাতীয় পরিচয়পত্র',
    ],
    kind: 'digitId',
  },
  {
    id: 'cf_govt_mfs_number',
    labelEn: 'MFS / Payment Mobile',
    labelBn: 'উপবৃত্তি / পেমেন্ট মোবাইল',
    aliases: [
      'mfs / payment mobile',
      'mfs number',
      'mfs mobile',
      'payment mobile',
      'bkash number',
      'nagad number',
      'rocket number',
      'উপবৃত্তি মোবাইল',
      'উপবৃত্তি / পেমেন্ট মোবাইল',
      'পেমেন্ট মোবাইল',
    ],
    kind: 'phone',
  },
  {
    id: 'cf_govt_mfs_provider',
    labelEn: 'MFS Provider',
    labelBn: 'এমএফএস প্রোভাইডার',
    aliases: [
      'mfs provider',
      'payment provider',
      'mobile banking',
      'mfs operator',
      'পেমেন্ট মাধ্যম',
      'এমএফএস প্রোভাইডার',
      'প্রোভাইডার',
    ],
    kind: 'choice',
    choices: [...MFS_PROVIDER_OPTIONS],
  },
  {
    id: 'cf_govt_cub_pack',
    labelEn: 'Cub Pack / Six Name',
    labelBn: 'কাব দল / ষষ্ঠকের নাম',
    aliases: [
      'cub pack / six name',
      'cub pack',
      'six name',
      'cub six',
      'scout pack',
      'কাব দল',
      'কাব দল / ষষ্ঠকের নাম',
      'ষষ্ঠক',
    ],
    kind: 'text',
  },
];

function normalizeAliasToken(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function findExistingMatchingCustomField(
  customFields: CustomFieldDoc[],
  presetId: GovtPresetFieldId
): CustomFieldDoc | undefined {
  const spec = GOVT_PRESET_FIELDS.find((f) => f.id === presetId);
  if (!spec) return undefined;

  const byId = customFields.find((cf) => cf.id === presetId);
  if (byId) return byId;

  const candidateLabels = new Set([
    normalizeAliasToken(spec.labelEn),
    normalizeAliasToken(spec.labelBn),
    ...spec.aliases.map(normalizeAliasToken),
  ]);

  return customFields.find((cf) => candidateLabels.has(normalizeAliasToken(cf.label || '')));
}

export function getTargetCustomFieldKey(
  customFields: CustomFieldDoc[],
  presetId: GovtPresetFieldId
): string {
  return findExistingMatchingCustomField(customFields, presetId)?.id || presetId;
}

export interface ResolvedStudentPortalData {
  brn: string;
  gender: string;
  religion: string;
  bloodGroup: string;
  fatherNid: string;
  motherNid: string;
  mfsNumber: string;
  mfsProvider: string;
  cubPack: string;
  stipendSubmitted: boolean;
  cubSubmitted: boolean;
  resolvedKeys: Record<GovtPresetFieldId, string>;
}

function readPresetValue(
  student: StudentDoc,
  customFields: CustomFieldDoc[],
  presetId: GovtPresetFieldId
): { value: string; storageKey: string } {
  const customValues =
    student.customValues && typeof student.customValues === 'object' && !Array.isArray(student.customValues)
      ? student.customValues
      : {};

  const matchedField = findExistingMatchingCustomField(customFields, presetId);
  const spec = GOVT_PRESET_FIELDS.find((f) => f.id === presetId)!;

  // 1. Check exact preset ID first
  if (customValues[presetId] !== undefined && String(customValues[presetId]).trim() !== '') {
    return {
      value: String(customValues[presetId]).trim(),
      storageKey: matchedField?.id || presetId,
    };
  }

  // 2. Check matched custom field ID (existing field matched case-insensitively by label)
  if (
    matchedField &&
    customValues[matchedField.id] !== undefined &&
    String(customValues[matchedField.id]).trim() !== ''
  ) {
    return {
      value: String(customValues[matchedField.id]).trim(),
      storageKey: matchedField.id,
    };
  }

  // 3. Fallback: scan customValues keys case-insensitively for any alias match
  const aliasSet = new Set([
    normalizeAliasToken(presetId),
    normalizeAliasToken(spec.labelEn),
    normalizeAliasToken(spec.labelBn),
    ...spec.aliases.map(normalizeAliasToken),
  ]);
  for (const [k, v] of Object.entries(customValues)) {
    if (aliasSet.has(normalizeAliasToken(k)) && String(v ?? '').trim() !== '') {
      return {
        value: String(v).trim(),
        storageKey: matchedField?.id || k,
      };
    }
  }

  return {
    value: '',
    storageKey: matchedField?.id || presetId,
  };
}

export function getPortalStatusKey(portal: GovtPortalType, academicYear: number): string {
  return portal === 'stipend' ? `govt_stipend_${academicYear}` : `govt_cub_${academicYear}`;
}

export function resolveStudentPortalData(
  student: StudentDoc,
  customFields: CustomFieldDoc[],
  academicYear: number
): ResolvedStudentPortalData {
  const brnRes = readPresetValue(student, customFields, 'cf_govt_brn');
  const genderRes = readPresetValue(student, customFields, 'cf_govt_gender');
  const religionRes = readPresetValue(student, customFields, 'cf_govt_religion');
  const bloodRes = readPresetValue(student, customFields, 'cf_govt_blood_group');
  const fNidRes = readPresetValue(student, customFields, 'cf_govt_father_nid');
  const mNidRes = readPresetValue(student, customFields, 'cf_govt_mother_nid');
  const mfsNumRes = readPresetValue(student, customFields, 'cf_govt_mfs_number');
  const mfsProvRes = readPresetValue(student, customFields, 'cf_govt_mfs_provider');
  const cubPackRes = readPresetValue(student, customFields, 'cf_govt_cub_pack');

  const notes = parseSectorNotesMap(student.sectorNotes);
  const stipendStatus = (notes[getPortalStatusKey('stipend', academicYear)] || '').toLowerCase();
  const cubStatus = (notes[getPortalStatusKey('cub', academicYear)] || '').toLowerCase();

  return {
    brn: normalizeImportedDigitId(brnRes.value),
    gender: genderRes.value,
    religion: religionRes.value,
    bloodGroup: bloodRes.value,
    fatherNid: normalizeImportedDigitId(fNidRes.value),
    motherNid: normalizeImportedDigitId(mNidRes.value),
    mfsNumber: normalizeImportedPhone(mfsNumRes.value),
    mfsProvider: mfsProvRes.value,
    cubPack: cubPackRes.value,
    stipendSubmitted: stipendStatus === 'submitted',
    cubSubmitted: cubStatus === 'submitted',
    resolvedKeys: {
      cf_govt_brn: brnRes.storageKey,
      cf_govt_gender: genderRes.storageKey,
      cf_govt_religion: religionRes.storageKey,
      cf_govt_blood_group: bloodRes.storageKey,
      cf_govt_father_nid: fNidRes.storageKey,
      cf_govt_mother_nid: mNidRes.storageKey,
      cf_govt_mfs_number: mfsNumRes.storageKey,
      cf_govt_mfs_provider: mfsProvRes.storageKey,
      cf_govt_cub_pack: cubPackRes.storageKey,
    },
  };
}

export interface PortalValidationResult {
  status: 'submitted' | 'ready' | 'incomplete';
  missing: string[];
  warnings: string[];
  data: ResolvedStudentPortalData;
}

export function isValidNidDigits(nid: string): boolean {
  const d = nid.replace(/\D/g, '');
  return d.length === 10 || d.length === 13 || d.length === 17;
}

export function isValid11DigitBdMobile(phone: string): boolean {
  const norm = normalizeImportedPhone(phone);
  return /^01\d{9}$/.test(norm);
}

export function validateStudentForPortal(
  student: StudentDoc,
  customFields: CustomFieldDoc[],
  portal: GovtPortalType,
  academicYear: number
): PortalValidationResult {
  const data = resolveStudentPortalData(student, customFields, academicYear);
  const missing: string[] = [];
  const warnings: string[] = [];

  // Common required fields
  const hasName = Boolean((student.studentNameBn || '').trim() || (student.studentNameEn || '').trim());
  if (!hasName) missing.push('Student Name');
  if (!String(student.rollNumber ?? '').trim()) missing.push('Roll No');
  if (!(student.dateOfBirth || '').trim()) missing.push('Date of Birth');
  if (!(student.fatherNameEn || '').trim()) missing.push("Father's Name");
  if (!(student.motherNameEn || '').trim()) missing.push("Mother's Name");

  const brnDigits = data.brn.replace(/\D/g, '');
  if (!data.brn) {
    missing.push('17-digit BRN');
  } else if (brnDigits.length !== 17) {
    missing.push(`BRN must be 17 digits (${brnDigits.length})`);
  }

  if (!data.gender) missing.push('Gender');
  if (!data.religion) missing.push('Religion');
  if (!(student.address || '').trim()) missing.push('Address');

  if (portal === 'stipend') {
    const hasFatherNid = Boolean(data.fatherNid);
    const hasMotherNid = Boolean(data.motherNid);
    if (!hasFatherNid && !hasMotherNid) {
      missing.push('Father or Mother NID');
    } else {
      if (hasFatherNid && !isValidNidDigits(data.fatherNid)) {
        warnings.push('Father NID should be 10, 13, or 17 digits');
      }
      if (hasMotherNid && !isValidNidDigits(data.motherNid)) {
        warnings.push('Mother NID should be 10, 13, or 17 digits');
      }
    }

    const effectiveMfs = data.mfsNumber || normalizeImportedPhone(student.guardianPhone || '');
    if (!effectiveMfs) {
      missing.push('11-digit MFS/Guardian Mobile');
    } else if (!isValid11DigitBdMobile(effectiveMfs)) {
      missing.push('MFS Mobile must be 11-digit 01...');
    }

    if (!data.mfsProvider) {
      warnings.push('MFS Provider not selected');
    }
  } else {
    if (!data.bloodGroup) missing.push('Blood Group');
    const guardianPhoneNorm = normalizeImportedPhone(student.guardianPhone || '');
    if (!guardianPhoneNorm) {
      missing.push('Guardian Phone');
    } else if (!isValid11DigitBdMobile(guardianPhoneNorm)) {
      warnings.push('Guardian Phone is not 11-digit 01...');
    }
    if (student.classLevel === 'Pre-Primary') {
      warnings.push('Pre-Primary student (Cub Scouts normally Class 1–5)');
    }
  }

  const isSubmitted = portal === 'stipend' ? data.stipendSubmitted : data.cubSubmitted;
  const status: PortalValidationResult['status'] = isSubmitted
    ? 'submitted'
    : missing.length === 0
    ? 'ready'
    : 'incomplete';

  return { status, missing, warnings, data };
}

/**
 * Generates an optional, teacher-reviewed browser bookmarklet snippet containing only
 * the selected student's non-sensitive form fields to assist manual filling on .gov.bd portals.
 */
export function buildPortalFillBookmarklet(
  student: StudentDoc,
  data: ResolvedStudentPortalData
): string {
  const payload = {
    nameEn: (student.studentNameEn || student.studentNameBn || '').trim(),
    nameBn: (student.studentNameBn || student.studentNameEn || '').trim(),
    roll: String(student.rollNumber ?? '').trim(),
    dob: (student.dateOfBirth || '').trim(),
    father: (student.fatherNameEn || '').trim(),
    mother: (student.motherNameEn || '').trim(),
    brn: data.brn,
    gender: data.gender,
    religion: data.religion,
    blood: data.bloodGroup,
    fatherNid: data.fatherNid,
    motherNid: data.motherNid,
    mfs: data.mfsNumber || normalizeImportedPhone(student.guardianPhone || ''),
    provider: data.mfsProvider,
    phone: normalizeImportedPhone(student.guardianPhone || ''),
    address: (student.address || '').trim(),
    cubPack: data.cubPack,
  };

  const json = JSON.stringify(payload);
  return `javascript:(function(){var d=${json};var m=[[/brn|birth.?reg|bdris/i,d.brn],[/dob|birth.?date/i,d.dob],[/father.?nid/i,d.fatherNid],[/mother.?nid/i,d.motherNid],[/mfs|payment.?mobile|bkash|nagad/i,d.mfs],[/provider|operator/i,d.provider],[/mobile|phone|contact/i,d.phone],[/father/i,d.father],[/mother/i,d.mother],[/blood/i,d.blood],[/gender|sex/i,d.gender],[/religion/i,d.religion],[/address/i,d.address],[/roll/i,d.roll],[/pack|six/i,d.cubPack],[/name.?bn|bangla/i,d.nameBn],[/student.?name|name/i,d.nameEn]];var n=0;document.querySelectorAll('input,select,textarea').forEach(function(el){if(el.disabled||el.type==='hidden')return;var hint=((el.name||'')+' '+(el.id||'')+' '+(el.placeholder||'')+' '+(el.getAttribute('aria-label')||'')).trim();for(var i=0;i<m.length;i++){if(m[i][0].test(hint)&&m[i][1]){el.value=m[i][1];el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));n++;break;}}});var b=document.createElement('div');b.textContent='My School: filled '+n+' fields. Verify before submitting.';b.style.cssText='position:fixed;top:12px;right:12px;z-index:999999;background:#065f46;color:#fff;padding:10px 14px;border-radius:8px;font:13px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.2)';document.body.appendChild(b);setTimeout(function(){b.remove();},4000);})();`;
}
