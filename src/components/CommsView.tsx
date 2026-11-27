import React, { useMemo, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  Bell,
  Check,
  Copy,
  MessageCircle,
  MessageSquare,
  Phone,
  Search,
  Send,
  Users,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { getFirebaseInstances } from '../lib/firebase';
import {
  buildParentNoticePayload,
  clampText,
  FIRESTORE_LIMITS,
  formatFirestoreError,
  withWriteTimeout,
} from '../lib/firestoreValidation';
import { getClassLabel, t } from '../lib/i18n';
import {
  compareRollNumbers,
  computeClassMeritDetails,
  formatTimestampDateTime,
  getClassSubjectsForMarksheet,
  getTermSubjectScore,
  matchesStudentSearch,
  normalizeBdPhone,
  normalizeExamConfigs,
  OFFICIAL_SCHOOL_NAME_BN,
  OFFICIAL_SCHOOL_NAME_EN,
  TERM_ORDER,
} from '../lib/schoolUtils';
import { CLASS_LEVELS, type StudentDoc } from '../types/school';

type CommsTab = 'parentMsg' | 'notices' | 'chat';
type AudienceFilter = 'individual' | 'school' | 'class' | 'failed' | 'absentIrregular';

interface RecipientStudentInfo {
  student: StudentDoc;
  badges: string[];
}

interface PhoneRecipientGroup {
  normalizedPhone: string;
  displayPhone: string;
  waDigits: string;
  items: RecipientStudentInfo[];
}

function buildFormattedParentMessage(
  body: string,
  msgLang: 'en' | 'bn',
  childrenLine?: string
): string {
  const greeting =
    msgLang === 'bn' ? 'আসসালামু আলাইকুম/ আদাব,' : 'Assalamu Alaikum/ Adab,';
  const closing =
    msgLang === 'bn'
      ? `প্রধান শিক্ষক\n${OFFICIAL_SCHOOL_NAME_BN}`
      : `Headmaster\n${OFFICIAL_SCHOOL_NAME_EN}`;
  const cleanBody = body.trim();
  const parts = [greeting];
  if (childrenLine && childrenLine.trim()) {
    parts.push(childrenLine.trim());
  }
  if (cleanBody) {
    parts.push(cleanBody);
  }
  parts.push(closing);
  return parts.join('\n\n');
}

export const CommsView: React.FC = () => {
  const {
    lang,
    session,
    school,
    students,
    attendanceLogs,
    parentNotices,
    messages,
    selectedAcademicYear,
    selectedClass,
    setSyncing,
  } = useApp();

  const [activeTab, setActiveTab] = useState<CommsTab>('parentMsg');

  // Parent Messaging (WhatsApp & SMS) State
  const [audienceFilter, setAudienceFilter] = useState<AudienceFilter>('class');
  const [audienceClass, setAudienceClass] = useState<string>(selectedClass);
  const [individualQuery, setIndividualQuery] = useState('');
  const [selectedIndividualId, setSelectedIndividualId] = useState<string>('');
  const [msgLang, setMsgLang] = useState<'en' | 'bn'>(lang);
  const [msgBody, setMsgBody] = useState<string>(() =>
    lang === 'bn'
      ? 'আপনার সন্তানের নিয়মিত বিদ্যালয়ে উপস্থিতি ও লেখাপড়ার প্রতি বিশেষ যত্ন নেওয়ার জন্য অনুরোধ করা হলো।'
      : 'Please ensure your child attends school regularly and stays attentive to daily studies.'
  );
  const [includeChildNames, setIncludeChildNames] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Notices State
  const [noticeTitle, setNoticeTitle] = useState('');
  const [noticeMessage, setNoticeMessage] = useState('');
  const [noticeTargetClass, setNoticeTargetClass] = useState('ALL');
  const [postingNotice, setPostingNotice] = useState(false);

  // Teacher Chat State
  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const yearStudents = useMemo(
    () =>
      students
        .filter((s) => Number(s.academicYear) === Number(selectedAcademicYear))
        .sort(compareRollNumbers),
    [students, selectedAcademicYear]
  );

  const examConfigs = useMemo(
    () => normalizeExamConfigs(school?.examConfigs),
    [school?.examConfigs]
  );

  // Compute fail counts per student across all classes in selectedAcademicYear (excluding Absent)
  const failCountMap = useMemo(() => {
    const out = new Map<string, number>();
    for (const cls of CLASS_LEVELS) {
      const clsStudents = yearStudents.filter((s) => s.classLevel === cls);
      if (clsStudents.length === 0) continue;
      const clsSubjects = getClassSubjectsForMarksheet(examConfigs, cls);
      const details = computeClassMeritDetails(clsStudents, clsSubjects);
      for (const [id, d] of details.entries()) {
        out.set(id, d.fCount);
      }
    }
    return out;
  }, [yearStudents, examConfigs]);

  // Compute daily attendance 'A' count per student from attendanceLogs
  const dailyAbsentCountMap = useMemo(() => {
    const counts = new Map<string, number>();
    for (const log of attendanceLogs) {
      if (Number(log.academicYear) !== Number(selectedAcademicYear)) continue;
      if (!log.statuses) continue;
      for (const [sid, status] of Object.entries(log.statuses)) {
        if (status === 'A') {
          counts.set(sid, (counts.get(sid) || 0) + 1);
        }
      }
    }
    return counts;
  }, [attendanceLogs, selectedAcademicYear]);

  // Detect any exam subject marked Absent per student
  const examAbsentCountMap = useMemo(() => {
    const counts = new Map<string, number>();
    for (const cls of CLASS_LEVELS) {
      const clsStudents = yearStudents.filter((s) => s.classLevel === cls);
      if (clsStudents.length === 0) continue;
      const clsSubjects = getClassSubjectsForMarksheet(examConfigs, cls);
      for (const st of clsStudents) {
        let ab = 0;
        for (const termId of TERM_ORDER) {
          for (const subj of clsSubjects) {
            const sc = getTermSubjectScore(st.examResults, termId, subj.subjectId);
            if (sc.isAbsent) ab += 1;
          }
        }
        if (ab > 0) counts.set(st.id, ab);
      }
    }
    return counts;
  }, [yearStudents, examConfigs]);

  const searchableIndividualStudents = useMemo(() => {
    if (!individualQuery.trim()) return yearStudents.slice(0, 60);
    return yearStudents.filter((s) => matchesStudentSearch(s, individualQuery));
  }, [yearStudents, individualQuery]);

  // Filter matching students by selected audience mode
  const matchingStudents = useMemo<RecipientStudentInfo[]>(() => {
    if (audienceFilter === 'individual') {
      const chosen = yearStudents.find((s) => s.id === selectedIndividualId);
      return chosen ? [{ student: chosen, badges: [] }] : [];
    }
    if (audienceFilter === 'school') {
      return yearStudents.map((st) => ({ student: st, badges: [] }));
    }
    if (audienceFilter === 'class') {
      return yearStudents
        .filter((s) => s.classLevel === audienceClass)
        .map((st) => ({ student: st, badges: [] }));
    }
    if (audienceFilter === 'failed') {
      const list: RecipientStudentInfo[] = [];
      for (const st of yearStudents) {
        const fCount = failCountMap.get(st.id) || 0;
        if (fCount >= 1) {
          list.push({
            student: st,
            badges: [`${fCount} F`],
          });
        }
      }
      return list;
    }
    // absentIrregular: exam subject Absent OR attendance < 75% OR daily log 'A'
    const irregular: RecipientStudentInfo[] = [];
    for (const st of yearStudents) {
      const badges: string[] = [];
      const examAb = examAbsentCountMap.get(st.id) || 0;
      if (examAb > 0) {
        badges.push(msgLang === 'bn' ? `পরীক্ষায় অনুপস্থিত (${examAb})` : `Exam Absent (${examAb})`);
      }
      const totDays = Number(st.totalSchoolDays) || 0;
      const presDays = Number(st.daysPresent) || 0;
      if (totDays > 0) {
        const pct = Math.round((presDays / totDays) * 100);
        if (pct < 75) {
          badges.push(msgLang === 'bn' ? `উপস্থিতি ${pct}%` : `Att ${pct}%`);
        }
      }
      const dailyAb = dailyAbsentCountMap.get(st.id) || 0;
      if (dailyAb > 0) {
        badges.push(msgLang === 'bn' ? `দৈনিক অনুপস্থিত ${dailyAb} দিন` : `Daily Absent: ${dailyAb}d`);
      }
      if (badges.length > 0) {
        irregular.push({ student: st, badges });
      }
    }
    return irregular;
  }, [
    audienceFilter,
    audienceClass,
    selectedIndividualId,
    yearStudents,
    failCountMap,
    examAbsentCountMap,
    dailyAbsentCountMap,
    msgLang,
  ]);

  // Group recipients by normalized phone number so siblings & twins appear together
  const { phoneGroups, missingPhoneStudents } = useMemo(() => {
    const groupsMap = new Map<string, PhoneRecipientGroup>();
    const missing: RecipientStudentInfo[] = [];

    for (const item of matchingStudents) {
      const rawPhone = String(item.student.guardianPhone || '').trim();
      const norm = rawPhone ? normalizeBdPhone(rawPhone) : '';
      const digits = norm.replace(/[^0-9]/g, '');
      if (!digits || digits.length < 10) {
        missing.push(item);
        continue;
      }

      const existing = groupsMap.get(norm);
      if (existing) {
        existing.items.push(item);
      } else {
        groupsMap.set(norm, {
          normalizedPhone: norm,
          displayPhone: norm,
          waDigits: digits,
          items: [item],
        });
      }
    }

    return {
      phoneGroups: Array.from(groupsMap.values()),
      missingPhoneStudents: missing,
    };
  }, [matchingStudents]);

  const applyTemplate = (kind: 'regular' | 'result' | 'meeting' | 'absent') => {
    if (msgLang === 'bn') {
      if (kind === 'regular') {
        setMsgBody(
          'আপনার সন্তানের নিয়মিত বিদ্যালয়ে উপস্থিতি ও লেখাপড়ার প্রতি বিশেষ যত্ন নেওয়ার জন্য অনুরোধ করা হলো।'
        );
      } else if (kind === 'result') {
        setMsgBody(
          'প্রান্তিক মূল্যায়ন পরীক্ষার ফলাফল প্রকাশিত হয়েছে। অনুগ্রহ করে শিক্ষার্থীর নম্বরপত্র পর্যবেক্ষণ করুন এবং প্রয়োজনে শ্রেণি শিক্ষকের সাথে যোগাযোগ করুন।'
        );
      } else if (kind === 'meeting') {
        setMsgBody(
          'বিদ্যালয়ের শিক্ষার মানোন্নয়ন ও শিক্ষার্থীদের অগ্রগতি বিষয়ে অভিভাবক সমাবেশে আপনার উপস্থিতি একান্ত কাম্য।'
        );
      } else {
        setMsgBody(
          'আপনার সন্তান সাম্প্রতিক সময়ে বিদ্যালয়ে/পরীক্ষায় অনুপস্থিত ছিল। নিয়মিত উপস্থিতি নিশ্চিত করতে অনুগ্রহ করে বিদ্যালয়ে যোগাযোগ করুন।'
        );
      }
    } else {
      if (kind === 'regular') {
        setMsgBody(
          'Please ensure your child attends school regularly and stays attentive to daily lessons.'
        );
      } else if (kind === 'result') {
        setMsgBody(
          'Term evaluation results have been published. Please review your child’s performance and contact the class teacher if extra support is needed.'
        );
      } else if (kind === 'meeting') {
        setMsgBody(
          'You are cordially invited to attend the upcoming Guardians Meeting regarding student academic progress.'
        );
      } else {
        setMsgBody(
          'Your child was recently marked absent/irregular at school. Please ensure regular attendance and contact the school office.'
        );
      }
    }
  };

  const formatMessageForGroup = (items: RecipientStudentInfo[]) => {
    if (!includeChildNames || items.length === 0) {
      return buildFormattedParentMessage(msgBody, msgLang);
    }
    const childLabels = items.map(({ student }) => {
      const nm =
        msgLang === 'bn'
          ? student.studentNameBn || student.studentNameEn
          : student.studentNameEn || student.studentNameBn;
      const cls = getClassLabel(student.classLevel, msgLang);
      const roll = student.rollNumber ? (msgLang === 'bn' ? `রোল ${student.rollNumber}` : `Roll ${student.rollNumber}`) : '';
      return `${nm} (${cls}${roll ? `, ${roll}` : ''})`;
    });
    const refLine =
      msgLang === 'bn'
        ? `শিক্ষার্থী: ${childLabels.join(' ও ')}`
        : `Student(s): ${childLabels.join(' & ')}`;
    return buildFormattedParentMessage(msgBody, msgLang, refLine);
  };

  const previewText = useMemo(() => {
    const sampleItems = phoneGroups[0]?.items || matchingStudents.slice(0, 1);
    return formatMessageForGroup(sampleItems);
  }, [phoneGroups, matchingStudents, msgBody, msgLang, includeChildNames]);

  const handleCopyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const handlePublishNotice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !noticeTitle.trim() || !noticeMessage.trim()) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    setPostingNotice(true);
    setSyncing(true);
    setErrorText(null);
    try {
      const payload = buildParentNoticePayload({
        schoolId: session.schoolId,
        title: noticeTitle,
        message: noticeMessage,
        targetClass: noticeTargetClass,
        academicYear: selectedAcademicYear,
        sentByName: session.name,
        sentByRole: session.role,
      });

      await withWriteTimeout(
        addDoc(
          collection(instances.db, 'schools', session.schoolId, 'parentNotices'),
          payload
        )
      );
      setNoticeTitle('');
      setNoticeMessage('');
    } catch (err) {
      setErrorText(formatFirestoreError(err));
    } finally {
      setPostingNotice(false);
      setSyncing(false);
    }
  };

  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session || !chatInput.trim()) return;
    const instances = getFirebaseInstances();
    if (!instances) return;

    const text = chatInput.trim();
    const safeName = clampText(session.name, FIRESTORE_LIMITS.USER_NAME_MAX_CHARS);
    setSendingChat(true);
    setSyncing(true);
    setErrorText(null);

    try {
      const msgRef = await withWriteTimeout(
        addDoc(collection(instances.db, 'schools', session.schoolId, 'messages'), {
          schoolId: session.schoolId,
          text,
          senderName: safeName,
          senderDeviceId: session.deviceId,
          senderPhone: session.phoneNumber,
          senderRole: session.role,
          createdAt: serverTimestamp(),
        })
      );

      try {
        const existingRecent = Array.isArray(school?.recentMessages)
          ? school.recentMessages
          : [];
        const nextRecent = [
          ...existingRecent,
          {
            messageId: msgRef.id,
            senderName: safeName,
            senderRole: session.role,
            text,
            createdAtMs: Date.now(),
          },
        ].slice(-30);

        await withWriteTimeout(
          updateDoc(doc(instances.db, 'schools', session.schoolId), {
            recentMessages: nextRecent,
            updatedAt: serverTimestamp(),
          })
        );
      } catch {
        // Assistant teachers may not have write access to root school doc
      }

      setChatInput('');
    } catch (err) {
      setErrorText(formatFirestoreError(err));
    } finally {
      setSendingChat(false);
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-5">
      {errorText && (
        <div className="px-4 py-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-900 text-sm">
          {errorText}
        </div>
      )}

      {/* Segmented Tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-stone-200/70 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('parentMsg')}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'parentMsg'
              ? 'bg-white text-emerald-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <MessageCircle className="w-3.5 h-3.5" />
          <span>{lang === 'bn' ? 'অভিভাবক মেসেজিং (WA / SMS)' : 'Parent Messaging (WA / SMS)'}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('notices')}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'notices'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Bell className="w-3.5 h-3.5" />
          <span>{t(lang, 'parentNotices')}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('chat')}
          className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'chat'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          <span>{t(lang, 'teacherChat')}</span>
        </button>
      </div>

      {/* TAB 1: ENHANCED PARENT MESSAGING (WhatsApp & SMS with Sibling Grouping) */}
      {activeTab === 'parentMsg' && (
        <div className="space-y-5">
          {/* Audience Filters + Composer */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left: Audience Selector & Composer */}
            <div className="lg:col-span-7 bg-white border border-stone-200 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-stone-200">
                <h3 className="text-base font-bold text-slate-900">
                  {lang === 'bn' ? 'অভিভাবক বার্তা প্রেরণ' : 'Parent WhatsApp & SMS Composer'}
                </h3>
                <div className="flex items-center gap-1 p-0.5 bg-stone-100 rounded-lg border border-stone-200">
                  <button
                    type="button"
                    onClick={() => setMsgLang('bn')}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md cursor-pointer ${
                      msgLang === 'bn' ? 'bg-white text-emerald-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    বাংলা
                  </button>
                  <button
                    type="button"
                    onClick={() => setMsgLang('en')}
                    className={`px-2.5 py-1 text-xs font-semibold rounded-md cursor-pointer ${
                      msgLang === 'en' ? 'bg-white text-emerald-900 shadow-xs' : 'text-slate-600'
                    }`}
                  >
                    EN
                  </button>
                </div>
              </div>

              {/* 5 Audience Filters */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  {lang === 'bn' ? 'প্রাপক নির্বাচন করুন' : 'Audience Filter'}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      {
                        id: 'individual',
                        label: lang === 'bn' ? 'একক শিক্ষার্থী' : 'Individual Student',
                      },
                      {
                        id: 'school',
                        label: lang === 'bn' ? 'সম্পূর্ণ বিদ্যালয়' : 'Whole School',
                      },
                      {
                        id: 'class',
                        label: lang === 'bn' ? 'নির্দিষ্ট শ্রেণি' : 'Specific Class',
                      },
                      {
                        id: 'failed',
                        label: lang === 'bn' ? 'অনুত্তীর্ণ শিক্ষার্থী (F)' : 'Failed Students (F)',
                      },
                      {
                        id: 'absentIrregular',
                        label:
                          lang === 'bn'
                            ? 'অনুপস্থিত / অনিয়মিত (<৭৫%)'
                            : 'Absent / Irregular (<75%)',
                      },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setAudienceFilter(opt.id)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer ${
                        audienceFilter === opt.id
                          ? 'bg-emerald-700 border-emerald-700 text-white'
                          : 'bg-stone-50 border-stone-200 text-slate-700 hover:bg-stone-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Sub-controls for Specific Class or Individual */}
              {audienceFilter === 'class' && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    {t(lang, 'classSelector')}
                  </label>
                  <select
                    value={audienceClass}
                    onChange={(e) => setAudienceClass(e.target.value)}
                    className="w-full sm:w-64 px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg"
                  >
                    {CLASS_LEVELS.map((cls) => (
                      <option key={cls} value={cls}>
                        {getClassLabel(cls, lang)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {audienceFilter === 'individual' && (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={individualQuery}
                      onChange={(e) => setIndividualQuery(e.target.value)}
                      placeholder={t(lang, 'searchStudents')}
                      className="w-full pl-9 pr-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                    />
                  </div>
                  <select
                    value={selectedIndividualId}
                    onChange={(e) => setSelectedIndividualId(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg"
                  >
                    <option value="">
                      {lang === 'bn' ? 'শিক্ষার্থী নির্বাচন করুন...' : 'Select a student...'}
                    </option>
                    {searchableIndividualStudents.map((st) => (
                      <option key={st.id} value={st.id}>
                        {getClassLabel(st.classLevel, lang)} · Roll {st.rollNumber} —{' '}
                        {st.studentNameBn || st.studentNameEn}{' '}
                        {st.guardianPhone ? `(${st.guardianPhone})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Quick Templates */}
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-slate-600">
                  {lang === 'bn' ? 'দ্রুত টেমপ্লেট:' : 'Quick Templates:'}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyTemplate('regular')}
                    className="px-2.5 py-1 text-xs font-medium bg-stone-100 hover:bg-stone-200 text-slate-800 rounded-md cursor-pointer"
                  >
                    {lang === 'bn' ? 'নিয়মিত উপস্থিতি' : 'Regular Attendance'}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate('result')}
                    className="px-2.5 py-1 text-xs font-medium bg-stone-100 hover:bg-stone-200 text-slate-800 rounded-md cursor-pointer"
                  >
                    {lang === 'bn' ? 'পরীক্ষার ফলাফল' : 'Exam Results'}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate('absent')}
                    className="px-2.5 py-1 text-xs font-medium bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 rounded-md cursor-pointer"
                  >
                    {lang === 'bn' ? 'অনুপস্থিতি সতর্কতা' : 'Absent / Irregular'}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate('meeting')}
                    className="px-2.5 py-1 text-xs font-medium bg-stone-100 hover:bg-stone-200 text-slate-800 rounded-md cursor-pointer"
                  >
                    {lang === 'bn' ? 'অভিভাবক সমাবেশ' : 'Guardians Meeting'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {lang === 'bn' ? 'মূল বার্তা লিখুন' : 'Message Body'}
                </label>
                <textarea
                  rows={4}
                  value={msgBody}
                  onChange={(e) => setMsgBody(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeChildNames}
                  onChange={(e) => setIncludeChildNames(e.target.checked)}
                />
                <span>
                  {lang === 'bn'
                    ? 'বার্তায় শিক্ষার্থীর নাম, শ্রেণি ও রোল যুক্ত করুন (ভাই-বোন/যমজ হলে একসাথে দেখাবে)'
                    : 'Include student name(s), class & roll (automatically combines siblings/twins)'}
                </span>
              </label>
            </div>

            {/* Right: Live Formatted Preview */}
            <div className="lg:col-span-5 bg-white border border-stone-200 rounded-xl p-5 flex flex-col justify-between gap-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-stone-200">
                  <span className="text-sm font-semibold text-slate-900">
                    {lang === 'bn' ? 'ফরম্যাটকৃত বার্তার প্রিভিউ' : 'Formatted Message Preview'}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopyText('preview', previewText)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md cursor-pointer"
                  >
                    {copiedKey === 'preview' ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedKey === 'preview' ? (lang === 'bn' ? 'কপি হয়েছে' : 'Copied') : (lang === 'bn' ? 'কপি' : 'Copy')}</span>
                  </button>
                </div>

                <pre className="p-4 rounded-xl bg-emerald-50/50 border border-emerald-200 text-sm text-slate-900 font-sans whitespace-pre-wrap leading-relaxed">
                  {previewText}
                </pre>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-stone-50 border border-stone-200">
                  <div className="text-slate-500">
                    {lang === 'bn' ? 'মোট শিক্ষার্থী' : 'Matched Students'}
                  </div>
                  <div className="text-lg font-bold font-mono tabular-nums text-slate-900">
                    {matchingStudents.length}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-emerald-50/60 border border-emerald-200">
                  <div className="text-emerald-800">
                    {lang === 'bn' ? 'অভিভাবক নম্বর গ্রুপ' : 'Grouped Phone Contacts'}
                  </div>
                  <div className="text-lg font-bold font-mono tabular-nums text-emerald-900">
                    {phoneGroups.length}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Recipients Grouped by Phone Number */}
          <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-stone-200 flex flex-wrap items-center justify-between gap-2 bg-stone-50">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-emerald-700" />
                <h4 className="text-sm font-semibold text-slate-900">
                  {lang === 'bn'
                    ? `প্রাপক তালিকা — মোবাইল নম্বর অনুযায়ী দলবদ্ধ (${phoneGroups.length} জন অভিভাবক)`
                    : `Recipients — Grouped by Phone (${phoneGroups.length} Guardian Contacts)`}
                </h4>
              </div>
              {missingPhoneStudents.length > 0 && (
                <span className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-md">
                  {lang === 'bn'
                    ? `${missingPhoneStudents.length} জন শিক্ষার্থীর ফোন নম্বর নেই`
                    : `${missingPhoneStudents.length} student(s) missing phone`}
                </span>
              )}
            </div>

            {phoneGroups.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {audienceFilter === 'individual' && !selectedIndividualId
                  ? lang === 'bn'
                    ? 'উপরে থেকে একজন শিক্ষার্থী নির্বাচন করুন।'
                    : 'Select a student above to generate WhatsApp / SMS links.'
                  : lang === 'bn'
                  ? 'এই ফিল্টারে বৈধ মোবাইল নম্বরসহ কোনো অভিভাবক পাওয়া যায়নি।'
                  : 'No guardian contacts with a valid phone number matched this filter.'}
              </div>
            ) : (
              <div className="divide-y divide-stone-100">
                {phoneGroups.map((group) => {
                  const personalized = formatMessageForGroup(group.items);
                  const waHref = `https://wa.me/${group.waDigits}?text=${encodeURIComponent(
                    personalized
                  )}`;
                  const smsHref = `sms:${group.normalizedPhone}?body=${encodeURIComponent(
                    personalized
                  )}`;
                  const isSiblings = group.items.length > 1;

                  return (
                    <div
                      key={group.normalizedPhone}
                      className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-stone-50/70"
                    >
                      <div className="space-y-2 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-bold text-slate-900">
                            {group.displayPhone}
                          </span>
                          {isSiblings && (
                            <span className="px-2 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-200 rounded-md">
                              {lang === 'bn'
                                ? `${group.items.length} ভাই-বোন / যমজ একসাথে`
                                : `${group.items.length} Siblings / Twins Linked`}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {group.items.map(({ student: st, badges }) => (
                            <div
                              key={st.id}
                              className="inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1 rounded-lg bg-stone-100 border border-stone-200 text-xs text-slate-800"
                            >
                              <span className="font-semibold text-slate-900">
                                {st.studentNameBn || st.studentNameEn}
                              </span>
                              <span className="text-slate-500">
                                ({getClassLabel(st.classLevel, lang)} · {t(lang, 'rollNumber')}{' '}
                                {st.rollNumber})
                              </span>
                              {badges.map((b, bIdx) => (
                                <span
                                  key={bIdx}
                                  className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-rose-100 text-rose-800"
                                >
                                  {b}
                                </span>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <a
                          href={waHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg whitespace-nowrap"
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                          <span>WhatsApp</span>
                        </a>
                        <a
                          href={smsHref}
                          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white rounded-lg whitespace-nowrap"
                        >
                          <Phone className="w-3.5 h-3.5" />
                          <span>SMS</span>
                        </a>
                        <button
                          type="button"
                          onClick={() => handleCopyText(group.normalizedPhone, personalized)}
                          className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 rounded-lg hover:bg-stone-50 cursor-pointer whitespace-nowrap"
                        >
                          {copiedKey === group.normalizedPhone ? (
                            <Check className="w-3.5 h-3.5 text-emerald-700" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {copiedKey === group.normalizedPhone
                              ? lang === 'bn'
                                ? 'কপি'
                                : 'Copied'
                              : lang === 'bn'
                              ? 'কপি'
                              : 'Copy'}
                          </span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {missingPhoneStudents.length > 0 && (
              <div className="p-4 border-t border-stone-200 bg-amber-50/40 text-xs text-amber-950">
                <div className="font-semibold mb-1.5">
                  {lang === 'bn'
                    ? 'ফোন নম্বরবিহীন শিক্ষার্থী:'
                    : 'Students without Guardian Phone:'}
                </div>
                <div className="flex flex-wrap gap-2">
                  {missingPhoneStudents.map(({ student: st }) => (
                    <span
                      key={st.id}
                      className="px-2 py-0.5 rounded bg-white border border-amber-200 text-slate-800"
                    >
                      {st.studentNameBn || st.studentNameEn} ({getClassLabel(st.classLevel, lang)}{' '}
                      · Roll {st.rollNumber})
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: PARENT NOTICES */}
      {activeTab === 'notices' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handlePublishNotice}
            className="lg:col-span-5 bg-white border border-stone-200 rounded-xl p-5 space-y-4 h-fit"
          >
            <h3 className="text-base font-semibold text-slate-900">
              {t(lang, 'postNotice')}
            </h3>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'targetClass')}
              </label>
              <select
                value={noticeTargetClass}
                onChange={(e) => setNoticeTargetClass(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-white border border-stone-300 rounded-lg"
              >
                <option value="ALL">{t(lang, 'allClasses')}</option>
                {CLASS_LEVELS.map((cls) => (
                  <option key={cls} value={cls}>
                    {getClassLabel(cls, lang)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'noticeTitle')}
              </label>
              <input
                type="text"
                required
                value={noticeTitle}
                onChange={(e) => setNoticeTitle(e.target.value)}
                placeholder={selectedClass}
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                {t(lang, 'noticeMessage')}
              </label>
              <textarea
                rows={4}
                required
                value={noticeMessage}
                onChange={(e) => setNoticeMessage(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <button
              type="submit"
              disabled={postingNotice}
              className="w-full py-2.5 px-4 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg cursor-pointer"
            >
              {postingNotice ? t(lang, 'loading') : t(lang, 'postNotice')}
            </button>
          </form>

          <div className="lg:col-span-7 bg-white border border-stone-200 rounded-xl divide-y divide-stone-100">
            {parentNotices.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                {lang === 'bn' ? 'এখনো কোনো নোটিশ প্রকাশিত হয়নি।' : 'No parent notices published yet.'}
              </div>
            ) : (
              parentNotices.map((n) => (
                <article key={n.id} className="p-5 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-base font-semibold text-slate-900">{n.title}</h4>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {formatTimestampDateTime(n.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{n.message}</p>
                  <div className="text-xs text-slate-500 flex items-center gap-2 pt-1">
                    <span>
                      {n.targetClass === 'ALL' || !n.targetClass
                        ? t(lang, 'allClasses')
                        : getClassLabel(n.targetClass, lang)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{n.sentByName}</span>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 3: TEACHER CHAT */}
      {activeTab === 'chat' && (
        <div className="bg-white border border-stone-200 rounded-xl flex flex-col h-[68vh]">
          <div className="flex-1 overflow-y-auto p-5 space-y-3">
            {messages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-slate-500">
                {lang === 'bn'
                  ? 'এখনো কোনো বার্তা নেই। শিক্ষকদের সাথে কথোপকথন শুরু করুন।'
                  : 'No messages yet. Start a conversation with your school teachers.'}
              </div>
            ) : (
              messages.map((m) => {
                const isMine =
                  (m.senderDeviceId && m.senderDeviceId === session?.deviceId) ||
                  m.senderName === session?.name;
                return (
                  <div
                    key={m.id}
                    className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[80%] sm:max-w-md rounded-xl px-4 py-2.5 text-sm ${
                        isMine
                          ? 'bg-emerald-700 text-white'
                          : 'bg-stone-100 text-slate-900 border border-stone-200'
                      }`}
                    >
                      {!isMine && (
                        <div className="text-xs font-semibold text-emerald-800 mb-0.5">
                          {m.senderName}
                        </div>
                      )}
                      <p className="whitespace-pre-wrap">{m.text}</p>
                    </div>
                    <span className="text-[11px] text-slate-400 mt-1 px-1 tabular-nums">
                      {formatTimestampDateTime(m.createdAt)}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <form
            onSubmit={handleSendChat}
            className="p-3 border-t border-stone-200 flex items-center gap-2 bg-stone-50"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={t(lang, 'typeMessage')}
              className="flex-1 px-3.5 py-2 text-sm bg-white border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
            <button
              type="submit"
              disabled={sendingChat || !chatInput.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-lg cursor-pointer whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{t(lang, 'sendMessage')}</span>
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
