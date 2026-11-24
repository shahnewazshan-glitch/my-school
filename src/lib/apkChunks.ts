import {
  collection,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type { AppReleaseChunkDoc } from '../types/school';

export const APK_CHUNK_SIZE_BYTES = 480 * 1024; // 491,520 bytes (~655,360 Base64 chars <= 800,000 rule limit)
export const MAX_APK_CHUNKS = 300;
export const APK_MIME_TYPE = 'application/vnd.android.package-archive';

export interface ApkUploadProgress {
  phase: 'clearing' | 'reading' | 'uploading' | 'finalizing';
  currentChunk: number;
  totalChunks: number;
  percent: number;
}

export interface ApkDownloadProgress {
  phase: 'fetching' | 'assembling';
  currentChunk: number;
  totalChunks: number;
  percent: number;
}

/**
 * Convert Uint8Array to Base64 safely using an 8 KB loop
 * (avoids String.fromCharCode(...bigArray) stack overflow).
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const SLICE_SIZE = 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += SLICE_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + SLICE_SIZE, bytes.length));
    let str = '';
    for (let j = 0; j < chunk.length; j += 1) {
      str += String.fromCharCode(chunk[j]);
    }
    parts.push(str);
  }
  return btoa(parts.join(''));
}

/**
 * Decode Base64 string back into Uint8Array safely.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export function sanitizeApkFileName(rawFileName: string, versionName: string): string {
  const cleanedVersion = String(versionName || 'update')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_');
  const fallbackName = `My_School_v${cleanedVersion}.apk`;
  const trimmed = String(rawFileName || '').trim();
  if (!trimmed) return fallbackName.slice(0, 120);

  const safeChars = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const withExt = safeChars.toLowerCase().endsWith('.apk') ? safeChars : `${safeChars}.apk`;
  if (withExt.length <= 120) return withExt;
  return `${withExt.slice(0, 116)}.apk`;
}

export class NoApkChunksError extends Error {
  constructor(message = 'NO_APK_CHUNKS_FOUND') {
    super(message);
    this.name = 'NoApkChunksError';
  }
}

export async function uploadPrivateApkRelease(params: {
  db: Firestore;
  schoolId: string;
  file: File;
  versionCode: number;
  versionName: string;
  notes: string;
  originUrl: string;
  onProgress?: (progress: ApkUploadProgress) => void;
}): Promise<{ totalChunks: number; fileName: string; totalSizeBytes: number }> {
  const { db, schoolId, file, versionCode, versionName, notes, originUrl, onProgress } = params;

  const intVersionCode = Math.trunc(Number(versionCode));
  if (!Number.isInteger(intVersionCode) || intVersionCode < 1 || intVersionCode > 999999) {
    throw new Error('Version Code must be an integer between 1 and 999999.');
  }

  const cleanVersionName = String(versionName || '').trim().slice(0, 20);
  if (!cleanVersionName) {
    throw new Error('Version Name is required (max 20 characters).');
  }

  if (!file || file.size <= 0) {
    throw new Error('Please choose a valid .apk file.');
  }

  const totalSizeBytes = Math.trunc(file.size);
  const totalChunks = Math.ceil(totalSizeBytes / APK_CHUNK_SIZE_BYTES);
  if (totalChunks < 1 || totalChunks > MAX_APK_CHUNKS) {
    throw new Error(
      `APK file size exceeds the ${Math.floor((MAX_APK_CHUNKS * APK_CHUNK_SIZE_BYTES) / (1024 * 1024))} MB limit (${totalChunks} > ${MAX_APK_CHUNKS} chunks).`
    );
  }

  const safeFileName = sanitizeApkFileName(file.name, cleanVersionName);
  const chunksCol = collection(db, 'schools', schoolId, 'appReleaseChunks');

  // Step 1: Delete all existing docs in schools/{schoolId}/appReleaseChunks
  onProgress?.({ phase: 'clearing', currentChunk: 0, totalChunks, percent: 2 });
  const existingSnap = await getDocs(chunksCol);
  if (!existingSnap.empty) {
    const docs = existingSnap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      const slice = docs.slice(i, i + 400);
      for (const d of slice) {
        batch.delete(d.ref);
      }
      await batch.commit();
    }
  }

  // Step 2: Read selected .apk as ArrayBuffer
  onProgress?.({ phase: 'reading', currentChunk: 0, totalChunks, percent: 5 });
  const buffer = await file.arrayBuffer();
  const fullBytes = new Uint8Array(buffer);

  // Step 3: Split into 480 KB chunks and upload one-by-one with live progress
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const start = chunkIndex * APK_CHUNK_SIZE_BYTES;
    const end = Math.min(start + APK_CHUNK_SIZE_BYTES, fullBytes.length);
    const slice = fullBytes.subarray(start, end);
    const dataBase64 = uint8ArrayToBase64(slice);

    if (!dataBase64 || dataBase64.length > 800000) {
      throw new Error(
        `Chunk ${chunkIndex} Base64 length (${dataBase64.length}) is out of allowed bounds (1..800000).`
      );
    }

    const chunkDocId = `v${intVersionCode}_chunk_${chunkIndex}`;
    await setDoc(doc(db, 'schools', schoolId, 'appReleaseChunks', chunkDocId), {
      schoolId,
      versionCode: intVersionCode,
      versionName: cleanVersionName,
      fileName: safeFileName,
      chunkIndex,
      totalChunks,
      totalSizeBytes,
      dataBase64,
      createdAt: serverTimestamp(),
    });

    const percent = Math.min(95, 5 + Math.round(((chunkIndex + 1) / totalChunks) * 90));
    onProgress?.({
      phase: 'uploading',
      currentChunk: chunkIndex + 1,
      totalChunks,
      percent,
    });
  }

  // Step 4: Update schools/{schoolId} with ONLY the exact 5 allowed fields
  onProgress?.({ phase: 'finalizing', currentChunk: totalChunks, totalChunks, percent: 98 });
  const cleanOrigin = String(originUrl || '').replace(/\/+$/, '');
  const updateUrl = `${cleanOrigin}/?update=1`.slice(0, 500);
  const cleanNotes = String(notes || '').trim().slice(0, 300);

  await updateDoc(doc(db, 'schools', schoolId), {
    latestAppVersionCode: intVersionCode,
    latestAppVersionName: cleanVersionName,
    appUpdateUrl: updateUrl,
    appUpdateNotes: cleanNotes,
    updatedAt: serverTimestamp(),
  });

  onProgress?.({ phase: 'finalizing', currentChunk: totalChunks, totalChunks, percent: 100 });
  return { totalChunks, fileName: safeFileName, totalSizeBytes };
}

export async function downloadPrivateApkRelease(params: {
  db: Firestore;
  schoolId: string;
  latestAppVersionCode?: number;
  latestAppVersionName?: string;
  onProgress?: (progress: ApkDownloadProgress) => void;
}): Promise<{ fileName: string; totalSizeBytes: number }> {
  const { db, schoolId, latestAppVersionCode, latestAppVersionName, onProgress } = params;

  onProgress?.({ phase: 'fetching', currentChunk: 0, totalChunks: 1, percent: 10 });

  const snap = await getDocs(collection(db, 'schools', schoolId, 'appReleaseChunks'));
  if (snap.empty) {
    throw new NoApkChunksError();
  }

  const allDocs: AppReleaseChunkDoc[] = snap.docs.map(
    (d) => d.data() as AppReleaseChunkDoc
  );

  // Prefer chunks matching latestAppVersionCode; fallback to highest available versionCode
  let targetChunks =
    typeof latestAppVersionCode === 'number' && Number.isFinite(latestAppVersionCode)
      ? allDocs.filter((c) => Number(c.versionCode) === Number(latestAppVersionCode))
      : [];

  if (targetChunks.length === 0) {
    const maxVersion = Math.max(...allDocs.map((c) => Number(c.versionCode) || 0));
    targetChunks = allDocs.filter((c) => Number(c.versionCode) === maxVersion);
  }

  if (targetChunks.length === 0) {
    throw new NoApkChunksError();
  }

  targetChunks.sort((a, b) => Number(a.chunkIndex) - Number(b.chunkIndex));

  const expectedTotalChunks = Number(targetChunks[0].totalChunks) || targetChunks.length;
  if (targetChunks.length !== expectedTotalChunks) {
    throw new Error(
      `Incomplete APK upload (${targetChunks.length} of ${expectedTotalChunks} chunks found). Ask the Admin to re-upload the .apk file.`
    );
  }

  for (let i = 0; i < expectedTotalChunks; i += 1) {
    if (Number(targetChunks[i].chunkIndex) !== i) {
      throw new Error(
        `Missing APK chunk #${i}. Ask the Admin to re-upload the .apk file.`
      );
    }
  }

  onProgress?.({
    phase: 'assembling',
    currentChunk: 0,
    totalChunks: expectedTotalChunks,
    percent: 40,
  });

  const decodedParts: BlobPart[] = [];
  let decodedSize = 0;

  for (let i = 0; i < expectedTotalChunks; i += 1) {
    const chunk = targetChunks[i];
    if (typeof chunk.dataBase64 !== 'string' || !chunk.dataBase64) {
      throw new Error(`Chunk #${i} has empty binary data.`);
    }
    const bytes = base64ToUint8Array(chunk.dataBase64);
    decodedParts.push(bytes.buffer as ArrayBuffer);
    decodedSize += bytes.byteLength;

    const percent = 40 + Math.round(((i + 1) / expectedTotalChunks) * 58);
    onProgress?.({
      phase: 'assembling',
      currentChunk: i + 1,
      totalChunks: expectedTotalChunks,
      percent: Math.min(98, percent),
    });

    // Yield briefly every 4 chunks so the browser repaints the progress bar
    if (i % 4 === 3) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const fileName = sanitizeApkFileName(
    targetChunks[0].fileName || '',
    targetChunks[0].versionName || latestAppVersionName || 'latest'
  );

  const blob = new Blob(decodedParts, { type: APK_MIME_TYPE });
  const blobUrl = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 60_000);

  onProgress?.({
    phase: 'assembling',
    currentChunk: expectedTotalChunks,
    totalChunks: expectedTotalChunks,
    percent: 100,
  });

  return {
    fileName,
    totalSizeBytes: Number(targetChunks[0].totalSizeBytes) || decodedSize,
  };
}
