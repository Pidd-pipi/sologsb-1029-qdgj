import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import { createOfflinePackage } from './offline';
import type { Lesson, OfflinePackage, PersistedState, PracticeAttempt } from './types';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

type LegacyLesson = Omit<Lesson, 'version'> & { downloaded?: boolean; version?: number };
type PersistedV1 = Omit<PersistedState, 'schemaVersion' | 'offlinePackages' | 'downloadingLessonIds' | 'courses'> & {
  schemaVersion: 1;
  courses: Array<Omit<import('./types').Course, 'lessons'> & { lessons: LegacyLesson[] }>;
};

function migrateV1(legacy: PersistedV1): PersistedState {
  const initial = createInitialState();
  const currentLessons = new Map(initial.courses.flatMap((course) => course.lessons.map((lesson) => [lesson.id, lesson])));
  const offlinePackages: Record<string, OfflinePackage> = {};

  legacy.courses.flatMap((course) => course.lessons).forEach((lesson) => {
    if (!lesson.downloaded || !currentLessons.has(lesson.id)) return;
    const { downloaded: _downloaded, ...legacyLesson } = lesson;
    const packagedLesson: Lesson = { ...legacyLesson, version: legacyLesson.version ?? 1 };
    offlinePackages[lesson.id] = createOfflinePackage(packagedLesson);
  });

  return {
    ...initial,
    offlinePackages,
    attempts: legacy.attempts.map((attempt) => ({ ...attempt, contentVersion: attempt.contentVersion ?? 1 })),
    progress: legacy.progress,
    activeLessonId: legacy.activeLessonId,
    activeSentenceId: legacy.activeSentenceId,
    theme: legacy.theme,
    fontScale: legacy.fontScale,
    role: legacy.role
  };
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedState | PersistedV1;
      if (parsed.schemaVersion === 2) return parsed;
      if (parsed.schemaVersion === 1) return migrateV1(parsed);
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState();
}

export const state = reactive<PersistedState>(loadState());

export const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);
export const packageForLesson = (lessonId: string): OfflinePackage | undefined => state.offlinePackages[lessonId];

export function saveOfflinePackage(lesson: Lesson) {
  const pkg = createOfflinePackage(lesson);
  state.offlinePackages[lesson.id] = pkg;
  return pkg;
}

export function downloadOfflinePackage(lessonId: string): Promise<OfflinePackage> {
  const lesson = lessonById(lessonId);
  if (!navigator.onLine) return Promise.reject(new Error('当前处于离线状态，无法下载或更新离线包'));
  if (!lesson) return Promise.reject(new Error('未找到要下载的课节'));
  if (!state.downloadingLessonIds.includes(lessonId)) state.downloadingLessonIds.push(lessonId);

  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      try {
        const pkg = saveOfflinePackage(lesson);
        resolve(pkg);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('离线包保存失败'));
      } finally {
        state.downloadingLessonIds = state.downloadingLessonIds.filter((id) => id !== lessonId);
        persist();
      }
    }, 450);
  });
}

export function removeOfflinePackage(lessonId: string) {
  delete state.offlinePackages[lessonId];
  state.downloadingLessonIds = state.downloadingLessonIds.filter((id) => id !== lessonId);
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: PracticeAttempt['sentenceAttempts'][number]['tokens'][number]['category']; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const token = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId)?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    offlinePackages: Object.fromEntries(Object.entries(state.offlinePackages).map(([id, pkg]) => [
      id,
      {
        lessonId: pkg.lessonId,
        version: pkg.version,
        contentHash: pkg.contentHash,
        cachedAt: pkg.cachedAt,
        expiresAt: pkg.expiresAt,
        cacheDurationDays: pkg.cacheDurationDays,
        sentenceIds: pkg.content.sentences.map((sentence) => sentence.id)
      }
    ])),
    attempts: state.attempts,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}
