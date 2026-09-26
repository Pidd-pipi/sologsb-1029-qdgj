export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher' | 'unavailable';
export type ThemeMode = 'light' | 'dark';

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  note: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  subtitle: string;
  level: string;
  estimatedMinutes: number;
  /** 教材版本号，教材重新发布后递增 */
  version: string;
  sentences: Sentence[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  level: string;
  accent: string;
  lessons: Lesson[];
}

/** 离线包在本机的可用状态 */
export type OfflinePackageStatus = 'ready' | 'stale' | 'expired' | 'invalid';

/** 下载成功后留存的离线包：课节内容 + 版本 + 缓存时间 */
export interface OfflinePackage {
  lessonId: string;
  courseId: string;
  /** 下载时的课节版本 */
  version: string;
  /** 课节内容校验和，用于核对缓存内容是否完好 */
  checksum: string;
  /** 缓存时间（ISO 字符串） */
  cachedAt: string;
  /** 缓存到期时间（ISO 字符串），超过即视为过期 */
  expiresAt: string;
  /** 离线包近似大小（字节） */
  size: number;
  /** 课节内容快照，断网时练习读取的就是这份内容 */
  snapshot: Lesson;
}

/** 课节无法打开时的具体原因 */
export type UnavailableReason = 'not-downloaded' | 'expired' | 'invalid';

export interface TokenResult {
  index: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
}

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

export interface PersistedState {
  schemaVersion: 2;
  courses: Course[];
  /** 已下载的离线包，按课节 id 索引 */
  packages: Record<string, OfflinePackage>;
  /** 最近一次同步到的教材发布时间 */
  catalogUpdatedAt: string;
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}
