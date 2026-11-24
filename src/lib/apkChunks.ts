import {
  collection,
  doc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type { SchoolDoc } from '../types/school';

const CLEANUP_BATCH_SIZE = 200;

/**
 * Checks whether the school document still references any previously uploaded APK update metadata.
 */
export function hasLegacyApkMetadata(school: SchoolDoc | null | undefined): boolean {
  if (!school) return false;
  const code = Number(school.latestAppVersionCode || 0);
  const name = String(school.latestAppVersionName || '').trim();
  const url = String(school.appUpdateUrl || '').trim();
  const notes = String(school.appUpdateNotes || '').trim();
  return code > 0 || name !== '' || url !== '' || notes !== '';
}

/**
 * Safely deletes ONLY documents inside schools/{schoolId}/appReleaseChunks
 * in sequential batches of max 200 documents, and resets ONLY the 5 APK
 * metadata fields on schools/{schoolId}.
 *
 * STRICT SAFETY: Never reads, modifies, or deletes students, subjects,
 * customFields, attendanceLogs, pendingChanges, parentNotices, messages, or teachers.
 */
export async function deleteUploadedApkChunksFromServer(params: {
  db: Firestore;
  schoolId: string;
  onProgress?: (deletedSoFar: number) => void;
}): Promise<{ deletedChunks: number }> {
  const { db, schoolId, onProgress } = params;
  const chunksCol = collection(db, 'schools', schoolId, 'appReleaseChunks');

  let deletedChunks = 0;

  while (true) {
    const snap = await getDocs(query(chunksCol, limit(CLEANUP_BATCH_SIZE)));
    if (snap.empty) {
      break;
    }

    const batch = writeBatch(db);
    for (const d of snap.docs) {
      batch.delete(d.ref);
    }
    await batch.commit();

    deletedChunks += snap.docs.length;
    onProgress?.(deletedChunks);

    if (snap.docs.length < CLEANUP_BATCH_SIZE) {
      break;
    }
  }

  await updateDoc(doc(db, 'schools', schoolId), {
    latestAppVersionCode: 0,
    latestAppVersionName: '',
    appUpdateUrl: '',
    appUpdateNotes: '',
    updatedAt: serverTimestamp(),
  });

  return { deletedChunks };
}
