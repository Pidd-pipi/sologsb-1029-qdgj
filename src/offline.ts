import type { Lesson, OfflinePackage } from './types';

export const PACKAGE_CACHE_DAYS = 30;

export type OfflineAvailability = 'current' | 'stale' | 'expired' | 'damaged' | 'missing';

export function hashLessonContent(lesson: Lesson): string {
  const content = JSON.stringify({
    id: lesson.id,
    version: lesson.version,
    title: lesson.title,
    subtitle: lesson.subtitle,
    level: lesson.level,
    estimatedMinutes: lesson.estimatedMinutes,
    sentences: lesson.sentences
  });
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(content);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createOfflinePackage(lesson: Lesson, now = new Date()): OfflinePackage {
  const cachedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PACKAGE_CACHE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return {
    lessonId: lesson.id,
    version: lesson.version,
    contentHash: hashLessonContent(lesson),
    content: structuredClone(lesson),
    cachedAt,
    expiresAt,
    cacheDurationDays: PACKAGE_CACHE_DAYS
  };
}

export function getPackageAvailability(lesson: Lesson | undefined, pkg: OfflinePackage | undefined, now = new Date()): OfflineAvailability {
  if (!pkg || !lesson) return 'missing';
  if (hashLessonContent(pkg.content) !== pkg.contentHash) return 'damaged';
  if (new Date(pkg.expiresAt).getTime() < now.getTime()) return 'expired';
  return pkg.version < lesson.version ? 'stale' : 'current';
}

export function isPackageReadable(availability: OfflineAvailability): boolean {
  return availability === 'current' || availability === 'stale';
}

export function getUnavailableReason(availability: OfflineAvailability): string {
  switch (availability) {
    case 'missing':
      return '该课节还没有下载离线包，请先联网下载。';
    case 'damaged':
      return '离线包内容校验失败，请联网重新下载后再离线使用。';
    case 'expired':
      return '离线包已超过缓存有效期，请联网续期或重新下载。';
    default:
      return '该课节当前不可离线打开。';
  }
}

export function getPackageStatusLabel(availability: OfflineAvailability): string {
  switch (availability) {
    case 'current':
      return '已缓存';
    case 'stale':
      return '待更新';
    case 'expired':
      return '已过期';
    case 'damaged':
      return '校验异常';
    default:
      return '未下载';
  }
}
