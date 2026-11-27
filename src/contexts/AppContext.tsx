import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { getFirebaseInstances } from '../lib/firebase';
import { t, type Language } from '../lib/i18n';
import {
  compareRollNumbers,
  getSchoolDisplayMeta,
  normalizeBdPhone,
  normalizeExamConfigs,
  normalizeSchoolId,
  sha256Hex,
} from '../lib/schoolUtils';
import {
  CLASS_LEVELS,
  type ActiveSession,
  type AttendanceLogDoc,
  type CustomFieldDoc,
  type MessageDoc,
  type ParentNoticeDoc,
  type PendingChangeDoc,
  type SchoolDoc,
  type StudentDoc,
  type SubjectDoc,
} from '../types/school';

const SESSION_STORAGE_KEY = 'myschool_companion_session_v1';
const LANG_STORAGE_KEY = 'myschool_companion_lang_v1';

export type LazyModuleKey = 'attendance' | 'pending' | 'comms';

interface AppContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  session: ActiveSession | null;
  school: SchoolDoc | null;
  students: StudentDoc[];
  subjects: SubjectDoc[];
  customFields: CustomFieldDoc[];
  pendingChanges: PendingChangeDoc[];
  parentNotices: ParentNoticeDoc[];
  messages: MessageDoc[];
  attendanceLogs: AttendanceLogDoc[];
  loadedModules: Record<LazyModuleKey, boolean>;
  activateModule: (mod: LazyModuleKey) => void;
  selectedAcademicYear: number;
  setSelectedAcademicYear: (yr: number) => void;
  selectedClass: string;
  setSelectedClass: (cls: string) => void;
  isOnline: boolean;
  hasPendingSync: boolean;
  setSyncing: (active: boolean) => void;
  dataLoading: boolean;
  authMessage: { type: 'error' | 'revoked'; text: string } | null;
  clearAuthMessage: () => void;
  login: (schoolIdRaw: string, phoneRaw: string, passwordPlain: string) => Promise<boolean>;
  logout: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

function loadStoredSession(): ActiveSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveSession;
    if (parsed?.schoolId && parsed?.phoneNumber && parsed?.passwordHash) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(LANG_STORAGE_KEY);
      return saved === 'bn' ? 'bn' : 'en';
    } catch {
      return 'en';
    }
  });

  const [session, setSession] = useState<ActiveSession | null>(() => loadStoredSession());
  const [school, setSchool] = useState<SchoolDoc | null>(null);
  const [students, setStudents] = useState<StudentDoc[]>([]);
  const [subjects, setSubjects] = useState<SubjectDoc[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldDoc[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingChangeDoc[]>([]);
  const [parentNotices, setParentNotices] = useState<ParentNoticeDoc[]>([]);
  const [messages, setMessages] = useState<MessageDoc[]>([]);
  const [attendanceLogs, setAttendanceLogs] = useState<AttendanceLogDoc[]>([]);
  const [loadedModules, setLoadedModules] = useState<Record<LazyModuleKey, boolean>>({
    attendance: false,
    pending: false,
    comms: false,
  });

  const [selectedAcademicYear, setSelectedAcademicYear] = useState<number>(new Date().getFullYear());
  const [selectedClass, setSelectedClass] = useState<string>(CLASS_LEVELS[1]); // Class 1 default
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [hasPendingSync, setHasPendingSync] = useState<boolean>(false);
  const [dataLoading, setDataLoading] = useState<boolean>(false);
  const [authMessage, setAuthMessage] = useState<{ type: 'error' | 'revoked'; text: string } | null>(
    null
  );

  const syncCountRef = useRef<number>(0);
  const syncSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const yearInitializedRef = useRef<boolean>(false);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }, []);

  const clearAuthMessage = useCallback(() => setAuthMessage(null), []);

  const setSyncing = useCallback((active: boolean) => {
    if (syncSafetyTimerRef.current) {
      clearTimeout(syncSafetyTimerRef.current);
      syncSafetyTimerRef.current = null;
    }

    if (active) {
      syncCountRef.current += 1;
      setHasPendingSync(true);
      // Safety net so header indicator can NEVER stay pinned on "Syncing..."
      syncSafetyTimerRef.current = setTimeout(() => {
        syncCountRef.current = 0;
        setHasPendingSync(false);
      }, 30000);
    } else {
      syncCountRef.current = Math.max(0, syncCountRef.current - 1);
      if (syncCountRef.current === 0) {
        setHasPendingSync(false);
      }
    }
  }, []);

  const activateModule = useCallback((mod: LazyModuleKey) => {
    setLoadedModules((prev) => (prev[mod] ? prev : { ...prev, [mod]: true }));
  }, []);

  const clearSessionState = useCallback(() => {
    setSession(null);
    setSchool(null);
    setStudents([]);
    setSubjects([]);
    setCustomFields([]);
    setPendingChanges([]);
    setParentNotices([]);
    setMessages([]);
    setAttendanceLogs([]);
    setLoadedModules({ attendance: false, pending: false, comms: false });
    yearInitializedRef.current = false;
    syncCountRef.current = 0;
    if (syncSafetyTimerRef.current) {
      clearTimeout(syncSafetyTimerRef.current);
      syncSafetyTimerRef.current = null;
    }
    setHasPendingSync(false);
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const logout = useCallback(() => {
    clearSessionState();
    setAuthMessage(null);
  }, [clearSessionState]);

  // Browser online/offline tracking
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const login = useCallback(
    async (schoolIdRaw: string, phoneRaw: string, passwordPlain: string): Promise<boolean> => {
      const instances = getFirebaseInstances();
      if (!instances) return false;

      const schoolId = normalizeSchoolId(schoolIdRaw);
      const phone = normalizeBdPhone(phoneRaw);

      if (!schoolId || !phone || !passwordPlain) {
        setAuthMessage({ type: 'error', text: t(lang, 'accessDeniedUser') });
        return false;
      }

      try {
        const schoolRef = doc(instances.db, 'schools', schoolId);
        const snap = await getDoc(schoolRef);

        if (!snap.exists()) {
          setAuthMessage({ type: 'error', text: t(lang, 'accessDeniedSchoolNotFound') });
          return false;
        }

        const data = snap.data() as SchoolDoc;
        const teachers = Array.isArray(data.teachers) ? data.teachers : [];
        const matchedMember = teachers.find(
          (member) => member && normalizeBdPhone(member.phoneNumber || '') === phone
        );

        if (!matchedMember) {
          setAuthMessage({ type: 'error', text: t(lang, 'accessDeniedUser') });
          return false;
        }

        const computedHash = await sha256Hex(passwordPlain);
        const memberHash = typeof matchedMember.passwordHash === 'string' ? matchedMember.passwordHash : '';
        if (
          !memberHash ||
          memberHash.trim() === '' ||
          computedHash !== memberHash.toLowerCase()
        ) {
          setAuthMessage({ type: 'error', text: t(lang, 'accessDeniedPassword') });
          return false;
        }

        const nextSession: ActiveSession = {
          schoolId,
          phoneNumber: normalizeBdPhone(matchedMember.phoneNumber),
          deviceId: matchedMember.deviceId,
          name: matchedMember.name,
          role: matchedMember.role === 'ADMIN' ? 'ADMIN' : 'USER',
          passwordHash: matchedMember.passwordHash.toLowerCase(),
        };

        try {
          localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession));
        } catch {
          // ignore
        }

        setAuthMessage(null);
        setSession(nextSession);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAuthMessage({ type: 'error', text: msg });
        return false;
      }
    },
    [lang]
  );

  // Core startup listeners: ONLY school, students, subjects, customFields (NEVER appReleaseChunks)
  useEffect(() => {
    const instances = getFirebaseInstances();
    if (!instances || !session) return;

    const { db } = instances;
    const schoolId = session.schoolId;
    setDataLoading(true);

    // 1. Real-time School Doc + Live Session Revocation Enforcement
    const unsubSchool = onSnapshot(
      doc(db, 'schools', schoolId),
      (snap) => {
        if (!snap.exists()) {
          clearSessionState();
          setAuthMessage({ type: 'revoked', text: t(lang, 'accessRevoked') });
          setDataLoading(false);
          return;
        }

        const data = snap.data() as SchoolDoc;
        const teachers = Array.isArray(data.teachers) ? data.teachers : [];

        const activeMember = teachers.find(
          (member) => normalizeBdPhone(member.phoneNumber || '') === session.phoneNumber
        );

        // Instant Auto-Logout if removed or credentials invalidated
        if (
          !activeMember ||
          !activeMember.passwordHash ||
          activeMember.passwordHash.toLowerCase() !== session.passwordHash
        ) {
          clearSessionState();
          setAuthMessage({ type: 'revoked', text: t(lang, 'accessRevoked') });
          setDataLoading(false);
          return;
        }

        // Sync role/name updates seamlessly if changed by Admin
        const normalizedRole = activeMember.role === 'ADMIN' ? 'ADMIN' : 'USER';
        if (activeMember.name !== session.name || normalizedRole !== session.role) {
          const updatedSession: ActiveSession = {
            ...session,
            name: activeMember.name,
            role: normalizedRole,
          };
          setSession(updatedSession);
          try {
            localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(updatedSession));
          } catch {
            // ignore
          }
        }

        const meta = getSchoolDisplayMeta(data);
        const normalizedSchool: SchoolDoc = {
          ...data,
          schoolId: data.schoolId || schoolId,
          displaySchoolCode: meta.displaySchoolCode,
          emisCode: meta.emisCode,
          teachers,
          examConfigs: normalizeExamConfigs(data.examConfigs),
        };
        setSchool(normalizedSchool);

        if (!yearInitializedRef.current && normalizedSchool.defaultAcademicYear) {
          setSelectedAcademicYear(Number(normalizedSchool.defaultAcademicYear));
          yearInitializedRef.current = true;
        }
        setDataLoading(false);
      },
      (err) => {
        console.error('School snapshot error:', err);
        setDataLoading(false);
      }
    );

    // 2. Students
    const unsubStudents = onSnapshot(
      collection(db, 'schools', schoolId, 'students'),
      (snap) => {
        const list: StudentDoc[] = snap.docs.map((d) => ({
          ...(d.data() as Omit<StudentDoc, 'id'>),
          id: d.id,
        }));
        list.sort(compareRollNumbers);
        setStudents(list);
      },
      (err) => console.error('Students snapshot error:', err)
    );

    // 3. Subjects
    const unsubSubjects = onSnapshot(
      collection(db, 'schools', schoolId, 'subjects'),
      (snap) => {
        const list: SubjectDoc[] = snap.docs.map((d) => ({
          ...(d.data() as Omit<SubjectDoc, 'id'>),
          id: d.id,
        }));
        list.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
        setSubjects(list);
      },
      (err) => console.error('Subjects snapshot error:', err)
    );

    // 4. Custom Fields
    const unsubCustomFields = onSnapshot(
      collection(db, 'schools', schoolId, 'customFields'),
      (snap) => {
        const list: CustomFieldDoc[] = snap.docs.map((d) => ({
          ...(d.data() as Omit<CustomFieldDoc, 'id'>),
          id: d.id,
        }));
        list.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
        setCustomFields(list);
      },
      (err) => console.error('CustomFields snapshot error:', err)
    );

    return () => {
      unsubSchool();
      unsubStudents();
      unsubSubjects();
      unsubCustomFields();
    };
  }, [session?.schoolId, session?.phoneNumber, session?.deviceId, session?.passwordHash, clearSessionState, lang]);

  // 5. Lazy Pending Changes (only when Admin Panel / Approvals is opened)
  useEffect(() => {
    const instances = getFirebaseInstances();
    if (!instances || !session || !loadedModules.pending || session.role !== 'ADMIN') return;

    const q = query(
      collection(instances.db, 'schools', session.schoolId, 'pendingChanges'),
      orderBy('createdAt', 'desc'),
      limit(100)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: PendingChangeDoc[] = snap.docs.map((d) => ({
          ...(d.data() as Omit<PendingChangeDoc, 'id'>),
          id: d.id,
        }));
        setPendingChanges(list);
      },
      (err) => console.error('PendingChanges snapshot error:', err)
    );
    return () => unsub();
  }, [session?.schoolId, session?.role, loadedModules.pending]);

  // 6 & 7. Lazy Parent Notices & Teacher Chat (latest 30 messages, only when Comms tab opens)
  useEffect(() => {
    const instances = getFirebaseInstances();
    if (!instances || !session || !loadedModules.comms) return;

    const schoolId = session.schoolId;

    const unsubNotices = onSnapshot(
      query(
        collection(instances.db, 'schools', schoolId, 'parentNotices'),
        orderBy('createdAt', 'desc'),
        limit(50)
      ),
      (snap) => {
        const list: ParentNoticeDoc[] = snap.docs.map((d) => ({
          ...(d.data() as Omit<ParentNoticeDoc, 'id'>),
          id: d.id,
        }));
        setParentNotices(list);
      },
      (err) => console.error('ParentNotices snapshot error:', err)
    );

    const unsubMessages = onSnapshot(
      query(
        collection(instances.db, 'schools', schoolId, 'messages'),
        orderBy('createdAt', 'desc'),
        limit(30)
      ),
      (snap) => {
        const list: MessageDoc[] = snap.docs
          .map((d) => ({
            ...(d.data() as Omit<MessageDoc, 'id'>),
            id: d.id,
          }))
          .reverse();
        setMessages(list);
      },
      (err) => console.error('Messages snapshot error:', err)
    );

    return () => {
      unsubNotices();
      unsubMessages();
    };
  }, [session?.schoolId, loadedModules.comms]);

  // 8. Lazy Attendance Logs scoped to selectedAcademicYear (only when Attendance / Student Attendance tab / Backup opens)
  useEffect(() => {
    const instances = getFirebaseInstances();
    if (!instances || !session || !loadedModules.attendance) return;

    const q = query(
      collection(instances.db, 'schools', session.schoolId, 'attendanceLogs'),
      where('academicYear', '==', selectedAcademicYear)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: AttendanceLogDoc[] = snap.docs.map((d) => ({
          ...(d.data() as Omit<AttendanceLogDoc, 'id'>),
          id: d.id,
        }));
        setAttendanceLogs(list);
      },
      (err) => console.error('Attendance snapshot error:', err)
    );
    return () => unsub();
  }, [session?.schoolId, selectedAcademicYear, loadedModules.attendance]);

  const value = useMemo<AppContextValue>(
    () => ({
      lang,
      setLang,
      session,
      school,
      students,
      subjects,
      customFields,
      pendingChanges,
      parentNotices,
      messages,
      attendanceLogs,
      loadedModules,
      activateModule,
      selectedAcademicYear,
      setSelectedAcademicYear,
      selectedClass,
      setSelectedClass,
      isOnline,
      hasPendingSync,
      setSyncing,
      dataLoading,
      authMessage,
      clearAuthMessage,
      login,
      logout,
    }),
    [
      lang,
      setLang,
      session,
      school,
      students,
      subjects,
      customFields,
      pendingChanges,
      parentNotices,
      messages,
      attendanceLogs,
      loadedModules,
      activateModule,
      selectedAcademicYear,
      selectedClass,
      isOnline,
      hasPendingSync,
      setSyncing,
      dataLoading,
      authMessage,
      clearAuthMessage,
      login,
      logout,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return ctx;
}
