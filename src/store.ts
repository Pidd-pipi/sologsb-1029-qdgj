import { reactive, watch } from 'vue';
import { CATALOG_VERSION, createInitialState, fetchRemoteCatalog, fetchRemoteLesson } from './data';
import type {
  Course,
  Lesson,
  OfflinePackage,
  OfflinePackageStatus,
  PersistedState,
  PracticeAttempt,
  UnavailableReason
} from './types';
import { PACKAGE_TTL_MS, checksumOf } from './utils';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v2';

export type LessonAccess =
  | { blocked: false; mode: 'online' | 'offline-ready' | 'offline-stale' | 'online-stale'; lesson: Lesson; pkg?: OfflinePackage }
  | { blocked: true; reason: UnavailableReason; pkg?: OfflinePackage };

/** 课节内容快照、版本、缓存时间构成离线包 */
function packageByteSize(lesson: Lesson): number {
  return new TextEncoder().encode(JSON.stringify(lesson)).length;
}

function buildPackage(lesson: Lesson): OfflinePackage {
  const now = Date.now();
  const snapshot = structuredClone(lesson);
  return {
    lessonId: lesson.id,
    courseId: lesson.courseId,
    version: lesson.version,
    checksum: checksumOf(snapshot),
    cachedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PACKAGE_TTL_MS).toISOString(),
    size: packageByteSize(snapshot),
    snapshot
  };
}

/** 旧版（仅布尔下载标记、无版本概念）状态迁移：为标记过的课节补建离线包 */
function migrateV1(old: Record<string, unknown>): PersistedState {
  const fresh = createInitialState();
  const oldCourses = Array.isArray(old.courses) ? old.courses as Course[] : fresh.courses;
  const courses: Course[] = structuredClone(oldCourses).map((course) => ({
    ...course,
    lessons: course.lessons.map((lesson) => ({ ...lesson, version: lesson.version ?? '1.0.0' }))
  }));
  const packages: Record<string, OfflinePackage> = {};
  for (const course of courses) {
    for (const lesson of course.lessons) {
      const legacy = oldCourses
        .flatMap((item) => item.lessons)
        .find((item) => item.id === lesson.id) as (Lesson & { downloaded?: boolean }) | undefined;
      if (legacy?.downloaded) packages[lesson.id] = buildPackage(lesson);
    }
  }
  return {
    ...fresh,
    courses,
    packages,
    catalogUpdatedAt: CATALOG_VERSION,
    attempts: Array.isArray(old.attempts) ? old.attempts as PersistedState['attempts'] : fresh.attempts,
    progress: old.progress && typeof old.progress === 'object' ? old.progress as PersistedState['progress'] : fresh.progress,
    activeLessonId: typeof old.activeLessonId === 'string' ? old.activeLessonId : '',
    activeSentenceId: typeof old.activeSentenceId === 'string' ? old.activeSentenceId : '',
    theme: old.theme === 'dark' ? 'dark' : 'light',
    fontScale: typeof old.fontScale === 'number' ? old.fontScale : 1,
    role: old.role === 'teacher' ? 'teacher' : 'learner'
  };
}

function loadState(): PersistedState {
  try {
    const v2 = localStorage.getItem(STORAGE_KEY);
    const raw = v2 ?? localStorage.getItem('sologsb-1029-dictation-state-v1');
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.schemaVersion === 2) return parsed as unknown as PersistedState;
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
    localStorage.removeItem('sologsb-1029-dictation-state-v1');
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string): Course | undefined => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);
export const packageFor = (lessonId: string): OfflinePackage | undefined => state.packages[lessonId];

/** 离线包当前状态：内容损坏 → 已过期 → 待更新 → 可用 */
export function packageStatus(lessonId: string): OfflinePackageStatus | undefined {
  const pkg = state.packages[lessonId];
  if (!pkg) return undefined;
  if (pkg.checksum !== checksumOf(pkg.snapshot)) return 'invalid';
  if (Date.now() >= new Date(pkg.expiresAt).getTime()) return 'expired';
  const current = lessonById(lessonId);
  if (current && current.version !== pkg.version) return 'stale';
  return 'ready';
}

export function isDownloaded(lessonId: string): boolean {
  return !!state.packages[lessonId];
}

/**
 * 课节开门规则：
 * - 联网：始终放行，使用最新目录内容；离线包过期/损坏时提示重新下载，旧版提示更新。
 * - 断网：只放行校验通过且未过期的包；旧版本只读（可查看，不能提交新听写）；
 *   未下载、已过期或损坏的课节拦截并给出原因。
 */
export function resolveLessonAccess(lessonId: string, online: boolean): LessonAccess {
  const current = lessonById(lessonId);
  const pkg = state.packages[lessonId];

  if (online) {
    if (current) {
      const stale = !!pkg && (pkg.version !== current.version || pkg.checksum !== checksumOf(pkg.snapshot) || Date.now() >= new Date(pkg.expiresAt).getTime());
      return { blocked: false, mode: stale ? 'online-stale' : 'online', lesson: current, pkg };
    }
    return { blocked: true, reason: 'not-downloaded' };
  }

  if (!pkg) return { blocked: true, reason: 'not-downloaded' };
  if (pkg.checksum !== checksumOf(pkg.snapshot)) return { blocked: true, reason: 'invalid', pkg };
  if (Date.now() >= new Date(pkg.expiresAt).getTime()) return { blocked: true, reason: 'expired', pkg };
  if (!current) return { blocked: false, mode: 'offline-ready', lesson: pkg.snapshot, pkg };
  if (current.version !== pkg.version) return { blocked: false, mode: 'offline-stale', lesson: pkg.snapshot, pkg };
  return { blocked: false, mode: 'offline-ready', lesson: pkg.snapshot, pkg };
}

function upsertCatalogLesson(lesson: Lesson) {
  const course = state.courses.find((item) => item.id === lesson.courseId);
  if (!course) return;
  const index = course.lessons.findIndex((item) => item.id === lesson.id);
  if (index >= 0) course.lessons[index] = structuredClone(lesson);
}

/** 下载（或更新）课节离线包。断网或课节不存在时失败，由调用方提示。 */
export async function downloadLesson(lessonId: string): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('offline');
  }
  const result = await fetchRemoteLesson(lessonId);
  if (!result) throw new Error('not-found');
  upsertCatalogLesson(result.lesson);
  state.catalogUpdatedAt = result.catalogVersion;
  state.packages[lessonId] = buildPackage(result.lesson);
  persist();
}

/** 联网同步教材目录；同步后旧离线包会自动显示“待更新”。 */
export async function syncCatalog(): Promise<{ updatedLessonIds: string[]; catalogVersion: string }> {
  const { catalog, catalogVersion } = await fetchRemoteCatalog();
  const updatedLessonIds: string[] = [];
  catalog.forEach((remoteCourse) => {
    const course = state.courses.find((item) => item.id === remoteCourse.id);
    if (!course) return;
    remoteCourse.lessons.forEach((remoteLesson) => {
      const local = course.lessons.find((item) => item.id === remoteLesson.id);
      if (local && local.version !== remoteLesson.version) updatedLessonIds.push(remoteLesson.id);
    });
  });
  state.courses = catalog;
  state.catalogUpdatedAt = catalogVersion;
  persist();
  return { updatedLessonIds, catalogVersion };
}

/** 关闭下载：只删除离线包内容，练习进度与历史记录保留。 */
export function removePackage(lessonId: string) {
  delete state.packages[lessonId];
  persist();
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
    attempts: state.attempts,
    progress: state.progress
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
