import type * as XLSXType from 'xlsx';

/**
 * Expands numeric scientific notation (e.g. 2.016E+16 or 2.016123456789012e+16)
 * into a full decimal digit string and strips trailing `.0` artifacts added by Excel.
 */
export function expandScientificAndStripDotZero(raw: unknown): string {
  if (raw === undefined || raw === null) return '';

  let str = '';
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return '';
    str = raw.toString();
  } else {
    str = String(raw).trim();
  }

  if (!str) return '';

  // Handle scientific notation like "2.016E+16" or "1.712345678e+9"
  const sciMatch = str.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (sciMatch) {
    const sign = sciMatch[1] || '';
    const intPart = sciMatch[2] || '0';
    const fracPart = sciMatch[3] || '';
    const exp = parseInt(sciMatch[4], 10);

    if (Number.isFinite(exp)) {
      const digits = intPart + fracPart;
      const decimalPos = intPart.length + exp;
      if (decimalPos <= 0) {
        str = `${sign}0.${'0'.repeat(Math.abs(decimalPos))}${digits}`;
      } else if (decimalPos >= digits.length) {
        str = `${sign}${digits}${'0'.repeat(decimalPos - digits.length)}`;
      } else {
        str = `${sign}${digits.slice(0, decimalPos)}.${digits.slice(decimalPos)}`;
      }
    }
  }

  // Strip trailing ".0" or ".00" on numeric-looking values
  if (/^[+-]?\d+\.0+$/.test(str)) {
    str = str.replace(/\.0+$/, '');
  }

  return str.trim();
}

/**
 * Normalizes imported Bangladesh mobile / MFS numbers safely:
 * - Expands scientific notation & strips `.0`
 * - Strips spaces, dashes, parentheses
 * - Restores missing leading 0 on 10-digit numbers: `1XXXXXXXXX` -> `01XXXXXXXXX`
 * - Converts `+8801XXXXXXXXX` / `8801XXXXXXXXX` -> `01XXXXXXXXX`
 */
export function normalizeImportedPhone(raw: unknown): string {
  const expanded = expandScientificAndStripDotZero(raw);
  if (!expanded) return '';

  const compact = expanded.replace(/[\s\-().]/g, '');
  if (!compact) return '';

  if (/^\+8801\d{9}$/.test(compact)) {
    return compact.slice(3);
  }
  if (/^8801\d{9}$/.test(compact)) {
    return compact.slice(2);
  }
  if (/^1\d{9}$/.test(compact)) {
    return `0${compact}`;
  }
  return compact;
}

/**
 * Normalizes imported ID numbers (17-digit BRN, 10/13/17-digit NID):
 * - Expands scientific notation & strips `.0`
 * - If strictly digits/separators, returns pure digits; otherwise returns trimmed expanded string
 */
export function normalizeImportedDigitId(raw: unknown): string {
  const expanded = expandScientificAndStripDotZero(raw);
  if (!expanded) return '';
  if (/^[\d\s\-]+$/.test(expanded)) {
    return expanded.replace(/[\s\-]/g, '');
  }
  return expanded;
}

/**
 * Reads a row value using exact keys or normalized case-insensitive header aliases,
 * optionally rejecting headers matching an exclusion pattern (e.g. keeping BRN & DOB strictly separate).
 */
export function getRowCellByAliases(
  row: Record<string, unknown>,
  aliases: string[],
  excludeRegex?: RegExp
): unknown {
  for (const key of aliases) {
    if (key in row && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return row[key];
    }
  }

  const normalizedAliases = new Set(
    aliases.map((a) => a.trim().toLowerCase().replace(/[\s_\-./()]+/g, ' '))
  );

  for (const [colKey, val] of Object.entries(row)) {
    if (val === undefined || val === null || String(val).trim() === '') continue;
    const normKey = colKey.trim().toLowerCase().replace(/[\s_\-./()]+/g, ' ');
    if (excludeRegex && excludeRegex.test(colKey.toLowerCase())) continue;
    if (normalizedAliases.has(normKey)) {
      return val;
    }
  }

  return '';
}

/**
 * Strictly reads Date of Birth from a spreadsheet row, NEVER matching BRN / Birth Registration columns.
 */
export function readImportedDob(row: Record<string, unknown>): string {
  const val = getRowCellByAliases(
    row,
    ['dateOfBirth', 'Date of Birth', 'DOB', 'Birth Date', 'জন্ম তারিখ'],
    /brn|bdris|registration|reg|নিবন্ধন|সনদ/i
  );
  return expandScientificAndStripDotZero(val);
}

/**
 * Strictly reads Birth Registration No (BRN) from a spreadsheet row, NEVER matching Date of Birth columns.
 */
export function readImportedBrn(row: Record<string, unknown>): string {
  const val = getRowCellByAliases(
    row,
    [
      'cf_govt_brn',
      'BRN',
      'Birth Registration No',
      'Birth Registration No (BRN)',
      'Birth Registration',
      'Birth Reg No',
      'Birth Reg',
      'BDRIS',
      'জন্ম নিবন্ধন',
      'জন্ম নিবন্ধন নং',
      'জন্ম সনদ',
    ],
    /date\s*of\s*birth|\bdob\b|birth\s*date|জন্ম\s*তারিখ/i
  );
  return normalizeImportedDigitId(val);
}

/**
 * Marks all string cells on a SheetJS worksheet with `t: 's'` and text format `z: '@'`
 * so Excel and government portals preserve leading zeros and 17-digit BRN/NID numbers.
 */
export function enforceSheetTextCells(
  XLSX: typeof XLSXType,
  ws: XLSXType.WorkSheet,
  forceAllText = false
): XLSXType.WorkSheet {
  const ref = ws['!ref'];
  if (!ref) return ws;
  const range = XLSX.utils.decode_range(ref);
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      if (cell.t === 's' || (forceAllText && cell.v !== undefined && cell.v !== null && cell.v !== '')) {
        cell.t = 's';
        cell.v = String(cell.v ?? '');
        cell.z = '@';
      }
    }
  }
  return ws;
}

/**
 * Writes an `.xlsx` workbook with `bookSST: false` so SheetJS emits inline text cells (`t="inlineStr"`)
 * and `@` text formatting, preventing scientific notation or dropped leading zeros.
 */
export function writeSafeXlsxWorkbook(
  XLSX: typeof XLSXType,
  wb: XLSXType.WorkBook,
  filename: string
): void {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (ws) enforceSheetTextCells(XLSX, ws, false);
  }
  XLSX.writeFile(wb, filename, {
    bookType: 'xlsx',
    bookSST: false,
    cellStyles: true,
  });
}

function escapeCsvCell(val: unknown): string {
  const s = String(val ?? '');
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Downloads a UTF-8 CSV file WITH BOM (`\uFEFF`) so Bangla text, 17-digit BRN/NID,
 * and `01...` mobile numbers open cleanly without encoding corruption.
 */
export function downloadSafeCsvWithBom(
  headers: string[],
  rows: Array<Array<unknown>>,
  filename: string
): void {
  const lines: string[] = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => row.map(escapeCsvCell).join(',')),
  ];
  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
