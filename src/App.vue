<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  courseForLesson,
  downloadLesson,
  exportRecords,
  formatBytes,
  isDownloaded,
  lessonById,
  packageFor,
  packageStatus,
  persist,
  removePackage,
  resolveLessonAccess,
  saveAttempt,
  state,
  syncCatalog,
  updateTokenClassification
} from './store';
import type { ErrorCategory, Lesson, LessonProgress, PracticeAttempt, PracticeView, UnavailableReason } from './types';
import type { LessonAccess } from './store';
import { compareSentence, scoreAttempt, segmentText } from './utils';

const view = ref<PracticeView>(state.activeLessonId ? 'practice' : 'library');
const online = ref(navigator.onLine);
const toast = ref('');
const resultAttemptId = ref('');
const selectedResultSentence = ref(0);
const segmentStart = ref(0);
const segmentEnd = ref(1);
const teacherAttemptId = ref(state.attempts[0]?.id ?? '');
const teacherDraft = ref(state.attempts[0]?.teacherFeedback ?? '');
const downloading = reactive<Record<string, boolean>>({});
const catalogSyncing = ref(false);
const activeAccess = ref<LessonAccess>();
const blockedInfo = ref<{ lessonId: string; reason: UnavailableReason; pkg?: { version: string; cachedAt: string; expiresAt: string } }>();
let toastTimer = 0;

const activeLesson = computed<Lesson | undefined>(() => {
  if (activeAccess.value && !activeAccess.value.blocked) return activeAccess.value.lesson;
  if (state.activeLessonId) return lessonById(state.activeLessonId);
  return undefined;
});
const activeCourse = computed(() => activeLesson.value ? courseForLesson(activeLesson.value.id) : undefined);
const currentSentence = computed(() => {
  const lesson = activeLesson.value;
  if (!lesson) return undefined;
  return lesson.sentences.find((sentence) => sentence.id === state.activeSentenceId) ?? lesson.sentences[0];
});
const activeProgress = computed(() => activeLesson.value ? state.progress[activeLesson.value.id] : undefined);
const currentAnswer = ref('');
const currentIndex = computed(() => {
  if (!activeLesson.value || !currentSentence.value) return 0;
  return activeLesson.value.sentences.findIndex((item) => item.id === currentSentence.value?.id);
});
/** 旧版本离线包断网打开时只读：可看内容、原答案和练习记录，但不能改、不能提交新听写 */
const lessonReadOnly = computed(() => activeAccess.value?.blocked === false && activeAccess.value.mode === 'offline-stale');
const lessonCompletion = computed(() => {
  if (!activeLesson.value || !activeProgress.value) return 0;
  const answered = activeLesson.value.sentences.filter((sentence) => (activeProgress.value?.answers[sentence.id] ?? '').trim()).length;
  return Math.round((answered / activeLesson.value.sentences.length) * 100);
});
const resultAttempt = computed(() => state.attempts.find((attempt) => attempt.id === resultAttemptId.value));
const resultSentence = computed(() => resultAttempt.value?.sentenceAttempts[selectedResultSentence.value]);
const teacherAttempt = computed(() => state.attempts.find((attempt) => attempt.id === teacherAttemptId.value));
const totalWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).length);
const correctedWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).filter((token) => !token.correct && token.category !== 'unclassified').length);
const blockedLesson = computed(() => blockedInfo.value ? lessonById(blockedInfo.value.lessonId) : undefined);

const categoryOptions: Array<{ value: ErrorCategory; label: string }> = [
  { value: 'unclassified', label: '未分类' },
  { value: 'spelling', label: '拼写错误' },
  { value: 'omitted', label: '漏词' },
  { value: 'extra', label: '多词' },
  { value: 'punctuation', label: '标点' },
  { value: 'grammar', label: '语法' }
];

watch(currentSentence, (sentence) => {
  // 只读模式同样回填原答案，便于查看；写入由 watch(currentAnswer) 拦截
  currentAnswer.value = sentence && activeProgress.value ? activeProgress.value.answers[sentence.id] ?? '' : '';
  segmentStart.value = 0;
  segmentEnd.value = sentence ? Math.max(0, segmentText(sentence.text).length - 1) : 0;
}, { immediate: true });

watch(currentAnswer, (value) => {
  if (lessonReadOnly.value) return;
  const lesson = activeLesson.value;
  const sentence = currentSentence.value;
  if (!lesson || !sentence) return;
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: sentence.id, updatedAt: new Date().toISOString() };
  progress.answers[sentence.id] = value;
  progress.activeSentenceId = sentence.id;
  progress.updatedAt = new Date().toISOString();
  state.progress[lesson.id] = progress;
});

watch(teacherAttemptId, (id) => {
  teacherDraft.value = state.attempts.find((attempt) => attempt.id === id)?.teacherFeedback ?? '';
});

function notify(message: string) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 2600);
}

function emptyProgress(lesson: Lesson): LessonProgress {
  return { answers: {}, activeSentenceId: lesson.sentences[0]?.id ?? '', updatedAt: new Date().toISOString() };
}

/** 应用开门结果：被拦截则跳转原因页，否则进入课节并恢复上次进度 */
function applyAccess(lessonId: string): boolean {
  const access = resolveLessonAccess(lessonId, online.value);
  activeAccess.value = access;
  if (access.blocked) {
    blockedInfo.value = {
      lessonId,
      reason: access.reason,
      pkg: access.pkg ? { version: access.pkg.version, cachedAt: access.pkg.cachedAt, expiresAt: access.pkg.expiresAt } : undefined
    };
    state.activeLessonId = lessonId;
    view.value = 'unavailable';
    persist();
    return false;
  }
  const lesson = access.lesson;
  const progress = state.progress[lessonId] ?? emptyProgress(lesson);
  if (!lesson.sentences.some((sentence) => sentence.id === progress.activeSentenceId)) progress.activeSentenceId = lesson.sentences[0]?.id ?? '';
  state.progress[lessonId] = progress;
  state.activeLessonId = lessonId;
  state.activeSentenceId = progress.activeSentenceId;
  currentAnswer.value = progress.answers[state.activeSentenceId] ?? '';
  segmentStart.value = 0;
  segmentEnd.value = Math.max(0, segmentText(currentSentence.value?.text ?? '').length - 1);
  persist();
  return true;
}

function startLesson(lesson: Lesson) {
  if (applyAccess(lesson.id)) view.value = 'practice';
}

function goToSentence(index: number) {
  const lesson = activeLesson.value;
  if (!lesson || !lesson.sentences[index]) return;
  const target = lesson.sentences[index];
  state.activeSentenceId = target.id;
  const progress = state.progress[lesson.id];
  if (progress && !lessonReadOnly.value) {
    progress.activeSentenceId = target.id;
    progress.updatedAt = new Date().toISOString();
  }
  currentAnswer.value = progress?.answers[target.id] ?? '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function submitLesson() {
  if (lessonReadOnly.value) {
    notify('旧版本离线包只能查看，联网更新到最新版本后才能提交新听写');
    return;
  }
  const lesson = activeLesson.value;
  const course = activeCourse.value;
  if (!lesson || !course) return;
  const progress = state.progress[lesson.id];
  const answeredCount = lesson.sentences.filter((sentence) => (progress?.answers[sentence.id] ?? '').trim()).length;
  if (!answeredCount) {
    notify('请至少输入一句话再提交');
    return;
  }
  if (answeredCount < lesson.sentences.length && !window.confirm(`还有 ${lesson.sentences.length - answeredCount} 句未作答，仍然提交吗？`)) return;
  const sentenceAttempts = lesson.sentences.map((sentence) => {
    const source = sentence.text;
    const answer = progress?.answers[sentence.id] ?? '';
    const tokens = compareSentence(source, answer);
    const correct = tokens.filter((token) => token.correct).length;
    return { sentenceId: sentence.id, source, answer, tokens, score: tokens.length ? Math.round((correct / tokens.length) * 100) : 0 };
  });
  const attempt: PracticeAttempt = {
    id: `attempt-${Date.now()}`,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    courseTitle: course.title,
    submittedAt: new Date().toISOString(),
    score: scoreAttempt(sentenceAttempts),
    sentenceAttempts,
    teacherFeedback: ''
  };
  saveAttempt(attempt);
  resultAttemptId.value = attempt.id;
  selectedResultSentence.value = 0;
  syncSegment();
  view.value = 'result';
  persist();
  notify('已提交，逐词结果已生成');
}

function syncSegment() {
  const tokenCount = segmentText(resultSentence.value?.source ?? '').length;
  segmentStart.value = 0;
  segmentEnd.value = Math.max(0, tokenCount - 1);
}

function replay(text: string, rate = 0.82) {
  if (!('speechSynthesis' in window)) {
    notify('当前浏览器不支持语音播放');
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = rate;
  window.speechSynthesis.speak(utterance);
}

function replaySegment() {
  const tokens = segmentText(resultSentence.value?.source ?? '');
  const start = Math.min(segmentStart.value, segmentEnd.value);
  const end = Math.max(segmentStart.value, segmentEnd.value);
  replay(tokens.slice(start, end + 1).map((token) => token.display).join(' '), 0.72);
}

function selectResultSentence(index: number) {
  selectedResultSentence.value = index;
  syncSegment();
}

function saveClassification(attemptId: string, sentenceId: string, tokenIndex: number, category: ErrorCategory, reason: string) {
  updateTokenClassification(attemptId, sentenceId, tokenIndex, { category, reason });
  persist();
}

function saveTeacherFeedback() {
  const attempt = teacherAttempt.value;
  if (!attempt) return;
  attempt.teacherFeedback = teacherDraft.value.trim();
  persist();
  notify('教师反馈已保存');
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
}

function changeFont(delta: number) {
  state.fontScale = Math.min(1.25, Math.max(0.85, Number((state.fontScale + delta).toFixed(2))));
}

function downloadRecords() {
  const blob = new Blob([exportRecords()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `echo-step-records-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  notify('练习记录已导出');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 课程库里每个课节的离线包徽标 */
function packageBadge(lesson: Lesson): { tone: 'none' | 'ready' | 'stale' | 'expired' | 'invalid' | 'busy'; text: string; actionable: boolean } {
  if (downloading[lesson.id]) return { tone: 'busy', text: '下载中…', actionable: false };
  const status = packageStatus(lesson.id);
  const pkg = packageFor(lesson.id);
  if (!status || !pkg) return { tone: 'none', text: '未下载', actionable: false };
  if (status === 'ready') return { tone: 'ready', text: `已缓存 v${pkg.version}`, actionable: false };
  if (status === 'stale') return { tone: 'stale', text: `待更新 v${pkg.version} → v${lesson.version}`, actionable: online.value };
  if (status === 'expired') return { tone: 'expired', text: '缓存已过期', actionable: online.value };
  return { tone: 'invalid', text: '缓存已损坏', actionable: online.value };
}

async function runDownload(lessonId: string, successMessage: string): Promise<boolean> {
  if (downloading[lessonId]) return false;
  downloading[lessonId] = true;
  try {
    await downloadLesson(lessonId);
    notify(successMessage);
    return true;
  } catch (error) {
    notify(error instanceof Error && error.message === 'offline' ? '当前离线，无法下载，请联网后再试' : '下载失败，请重试');
    return false;
  } finally {
    downloading[lessonId] = false;
  }
}

/** 开关：开 = 下载离线包（联网）；关 = 只清离线内容，进度与记录保留 */
async function onToggleDownload(lesson: Lesson, want: boolean) {
  if (want) {
    await runDownload(lesson.id, `离线包已下载（v${lesson.version}），断网也可练习`);
  } else {
    removePackage(lesson.id);
    notify('已删除该课节的离线内容，练习进度和记录仍保留');
  }
}

/** 点击“待更新 / 已过期 / 已损坏”徽标：联网换新包 */
async function onBadgeAction(lesson: Lesson) {
  const badge = packageBadge(lesson);
  if (!badge.actionable) {
    if (packageStatus(lesson.id)) notify('当前离线，请联网后再更新离线包');
    return;
  }
  const ok = await runDownload(lesson.id, '离线包已更新到最新版本，旧答案与练习记录保留');
  if (ok && activeAccess.value && !activeAccess.value.blocked && activeLesson.value?.id === lesson.id) applyAccess(lesson.id);
}

async function refreshCatalog() {
  if (catalogSyncing.value || !online.value) return;
  catalogSyncing.value = true;
  try {
    const { updatedLessonIds } = await syncCatalog();
    if (updatedLessonIds.length) {
      notify(`教材已更新：${updatedLessonIds.length} 节课有新版本，已下载课节显示“待更新”`);
    }
    // 正在练习时同步成功，重新开门一次，切到最新内容（未提交答案仍在）
    if (view.value === 'practice' && state.activeLessonId && online.value) applyAccess(state.activeLessonId);
  } catch {
    // 检查更新失败不影响本机使用。
  } finally {
    catalogSyncing.value = false;
  }
}

/** 不可用原因页上的“联网下载后打开” */
async function downloadAndOpen(lesson: Lesson) {
  const ok = await runDownload(lesson.id, '离线包已下载，正在进入课节');
  if (ok) startLesson(lesson);
}

const unavailableTitle = computed(() => {
  switch (blockedInfo.value?.reason) {
    case 'not-downloaded': return '这节课还没有下载';
    case 'expired': return '离线缓存已过期';
    case 'invalid': return '离线包内容已损坏';
    default: return '当前无法进入课节';
  }
});

const unavailableDetail = computed(() => {
  switch (blockedInfo.value?.reason) {
    case 'not-downloaded':
      return '飞行模式或断网时，只能进入已下载且缓存有效的课节。请联网后在课程库打开下载开关，下载成功会记录课节内容、版本和缓存时间。';
    case 'expired':
      return `离线包已于 ${blockedInfo.value.pkg ? formatDate(blockedInfo.value.pkg.expiresAt) : ''} 过期（有效期 30 天）。为保证练习内容不过时，断网不再放行，请联网后重新下载。`;
    case 'invalid':
      return '本机保存的离线包内容与下载时不一致，校验未通过。请联网后重新下载该课节。';
    default:
      return '请联网后重试。';
  }
});

/** 练习页顶部的离线包提示（仅在包需要处理时出现） */
const practiceNotice = computed<{ tone: 'stale-readonly' | 'stale-online' | 'expired' | 'invalid'; text: string } | null>(() => {
  const access = activeAccess.value;
  if (!access || access.blocked || !access.pkg) return null;
  const latestVersion = lessonById(access.pkg.lessonId)?.version;
  if (access.mode === 'offline-stale') {
    return { tone: 'stale-readonly', text: `你正在查看旧版本离线包 v${access.pkg.version}（最新 v${latestVersion ?? '?'}）。断网可看课节内容、原答案和练习记录，但不能提交新听写；联网后更新即可继续。` };
  }
  if (access.mode === 'online-stale') {
    const status = packageStatus(access.pkg.lessonId);
    if (status === 'expired') return { tone: 'expired', text: `离线包已于 ${formatDate(access.pkg.expiresAt)} 过期。在线练习不受影响，建议重新下载，否则断网无法进入。` };
    if (status === 'invalid') return { tone: 'invalid', text: '离线包内容校验失败。在线练习不受影响，建议重新下载，否则断网无法进入。' };
    return { tone: 'stale-online', text: `教材已更新到 v${latestVersion ?? '?'}，离线包仍是 v${access.pkg.version}。更新离线包后，断网也能练新版本（进度和记录保留）。` };
  }
  return null;
});

async function updateActivePackage() {
  const lesson = activeLesson.value;
  if (!lesson) return;
  const ok = await runDownload(lesson.id, '离线包已更新到最新版本');
  if (ok) applyAccess(lesson.id);
}

function onConnectionChange() {
  online.value = navigator.onLine;
  // 网络变化后重新执行开门规则：断网只放行校验通过且未过期的包
  if ((view.value === 'practice' || view.value === 'unavailable') && state.activeLessonId) {
    applyAccess(state.activeLessonId);
  }
  persist();
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') persist();
}

onMounted(() => {
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  window.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', persist);
  // 刷新或旋转后重新进入时，按当前网络状态执行一次开门校验
  if (view.value === 'practice' && state.activeLessonId) applyAccess(state.activeLessonId);
  refreshCatalog();
});

onBeforeUnmount(() => {
  window.removeEventListener('online', onConnectionChange);
  window.removeEventListener('offline', onConnectionChange);
  window.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', persist);
  persist();
});
</script>

<template>
  <var-app>
    <div class="app-shell" :data-theme="state.theme" :style="{ '--font-scale': state.fontScale }">
      <div v-if="view === 'library'" class="page">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">E</div>
            <div><h1>EchoStep</h1><p>移动端语言听写</p></div>
          </div>
          <div class="icon-row">
            <button class="icon-button" :aria-label="state.theme === 'light' ? '切换到深色模式' : '切换到浅色模式'" @click="toggleTheme">{{ state.theme === 'light' ? '◐' : '☀' }}</button>
            <button class="icon-button" aria-label="减小字号" @click="changeFont(-0.05)">A−</button>
            <button class="icon-button" aria-label="增大字号" @click="changeFont(0.05)">A＋</button>
          </div>
        </header>

        <section class="hero">
          <h2>今天也把声音变成文字</h2>
          <p>下载课程离线包后可断网作答；包内记录课节内容、版本与缓存时间，过期或未下载的课节断网不可进入。</p>
          <div class="hero-stats">
            <div class="hero-stat"><strong>{{ state.attempts.length }}</strong><span>练习记录</span></div>
            <div class="hero-stat"><strong>{{ correctedWords }}</strong><span>已分类错误</span></div>
            <div class="hero-stat"><strong>{{ totalWords }}</strong><span>累计词数</span></div>
          </div>
        </section>

        <div class="offline-banner" :class="{ online }">
          <span>{{ online ? '● 在线 · 可下载或更新离线包' : '● 飞行模式 · 仅可进入已缓存且未过期的课节' }}</span>
          <span>{{ catalogSyncing ? '正在检查教材更新…' : `教材版本 ${state.catalogUpdatedAt}` }}</span>
        </div>

        <div class="section-head">
          <h3>课程库</h3>
          <div class="segmented">
            <button :class="{ active: state.role === 'learner' }" @click="state.role = 'learner'; view = 'library'">学习</button>
            <button :class="{ active: state.role === 'teacher' }" @click="state.role = 'teacher'; view = 'teacher'">教师</button>
          </div>
        </div>

        <article v-for="course in state.courses" :key="course.id" class="course-card">
          <div class="course-title">
            <div><h3>{{ course.title }}</h3><p>{{ course.description }}</p></div>
            <span class="level-badge">{{ course.level }}</span>
          </div>
          <div v-for="lesson in course.lessons" :key="lesson.id" class="lesson-row">
            <div class="lesson-info">
              <h4>{{ lesson.title }}</h4>
              <p>{{ lesson.subtitle }} · {{ lesson.sentences.length }} 句 · 约 {{ lesson.estimatedMinutes }} 分钟 · 最新 v{{ lesson.version }}</p>
              <button
                type="button"
                class="pkg-badge"
                :class="packageBadge(lesson).tone"
                :disabled="!packageBadge(lesson).actionable"
                @click="onBadgeAction(lesson)"
              >
                {{ packageBadge(lesson).text }}
              </button>
              <p v-if="packageFor(lesson.id)" class="pkg-detail">
                缓存于 {{ formatDate(packageFor(lesson.id)!.cachedAt) }} · {{ formatBytes(packageFor(lesson.id)!.size) }} · {{ formatDate(packageFor(lesson.id)!.expiresAt) }} 前有效
              </p>
            </div>
            <div class="lesson-actions">
              <var-switch
                :model-value="isDownloaded(lesson.id)"
                :disabled="downloading[lesson.id] === true"
                @update:model-value="onToggleDownload(lesson, $event as boolean)"
              />
              <var-button type="primary" size="small" @click="startLesson(lesson)">{{ isDownloaded(lesson.id) ? '继续' : '开始' }}</var-button>
            </div>
          </div>
        </article>

        <div class="section-head"><h3>最近练习</h3><span>{{ state.attempts.length }} 条记录 · 关闭下载不会清除</span></div>
        <article v-if="state.attempts.length" class="panel">
          <div v-for="attempt in state.attempts.slice(0, 4)" :key="attempt.id" class="history-card">
            <div class="history-top"><strong>{{ attempt.lessonTitle }}</strong><span class="history-score">{{ attempt.score }} 分</span></div>
            <p>{{ formatDate(attempt.submittedAt) }} · {{ attempt.teacherFeedback || '暂无教师反馈' }}</p>
          </div>
          <var-button block type="primary" variant="outline" @click="downloadRecords">导出全部练习记录</var-button>
        </article>
        <div v-else class="empty-state"><strong>还没有练习记录</strong>完成一次听写后，可在这里复核和导出。</div>
      </div>

      <div v-else-if="view === 'practice' && activeLesson" class="page">
        <header class="practice-header">
          <div class="practice-nav">
            <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
            <div><h2>{{ activeLesson.title }}</h2></div>
            <span class="status-chip">{{ online ? '在线' : '离线' }} · v{{ activeLesson.version }}</span>
          </div>
          <div class="progress-line">
            <div class="sentence-count"><span>第 {{ currentIndex + 1 }} / {{ activeLesson.sentences.length }} 句</span><span>{{ lessonCompletion }}% 已填写</span></div>
            <var-progress :value="lessonCompletion" color="#1769e0" />
          </div>
        </header>

        <div v-if="practiceNotice" class="practice-notice" :class="practiceNotice.tone">
          <span>{{ practiceNotice.text }}</span>
          <var-button v-if="practiceNotice.tone !== 'stale-readonly' && online" size="small" color="currentColor" @click="updateActivePackage">
            {{ practiceNotice.tone === 'stale-online' ? '更新离线包' : '重新下载' }}
          </var-button>
        </div>
        <div v-if="lessonReadOnly" class="practice-notice readonly-action">
          <span>只读模式：可查看本课内容、原答案与练习记录，但不能编辑或提交新听写。</span>
        </div>

        <section class="audio-card">
          <div class="audio-meta">
            <button class="play-button" aria-label="播放当前句子" @click="replay(currentSentence?.text ?? '')">▶</button>
            <div><strong>听写提示</strong><p>先完整播放，再输入你听到的英文。播放速度已放慢。</p></div>
          </div>
        </section>

        <div class="dictation-label"><strong>输入听到的内容</strong><span>{{ lessonReadOnly ? '旧版本离线包 · 只读' : '答案在本机自动保存' }}</span></div>
        <textarea v-model="currentAnswer" class="answer-box" :disabled="lessonReadOnly" :aria-label="`第 ${currentIndex + 1} 句听写答案`" placeholder="Type what you hear..." @keydown.ctrl.enter="submitLesson" @keydown.meta.enter="submitLesson"></textarea>
        <div class="practice-actions">
          <var-button block type="default" variant="outline" @click="replay(currentSentence?.text ?? '')">再听一次</var-button>
          <var-button block type="primary" :disabled="lessonReadOnly" @click="submitLesson">提交本次听写</var-button>
        </div>

        <div class="sentence-picker" aria-label="句子导航">
          <button v-for="(sentence, index) in activeLesson.sentences" :key="sentence.id" class="sentence-dot" :class="{ active: sentence.id === currentSentence?.id, done: !!activeProgress?.answers[sentence.id] }" :aria-label="`跳到第 ${index + 1} 句`" @click="goToSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="currentSentence" class="panel">
          <div class="detail-head"><div><h3>场景提示</h3><p>{{ currentSentence.translation }}</p></div></div>
          <div class="feedback-card">{{ currentSentence.note }}</div>
        </section>
      </div>

      <div v-else-if="view === 'unavailable'" class="page">
        <header class="practice-header">
          <div class="practice-nav">
            <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
            <div><h2>{{ blockedLesson?.title ?? '课节不可用' }}</h2></div>
            <span class="status-chip">{{ online ? '在线' : '离线' }}</span>
          </div>
        </header>

        <section class="panel unavailable-card">
          <div class="unavailable-icon" :class="blockedInfo?.reason">!</div>
          <h2>{{ unavailableTitle }}</h2>
          <p>{{ unavailableDetail }}</p>
          <dl v-if="blockedInfo?.pkg" class="unavailable-meta">
            <div><dt>离线包版本</dt><dd>v{{ blockedInfo.pkg.version }}</dd></div>
            <div><dt>缓存时间</dt><dd>{{ formatDate(blockedInfo.pkg.cachedAt) }}</dd></div>
            <div><dt>到期时间</dt><dd>{{ formatDate(blockedInfo.pkg.expiresAt) }}</dd></div>
          </dl>
          <div class="unavailable-actions">
            <var-button block variant="outline" @click="view = 'library'">返回课程库</var-button>
            <var-button v-if="blockedLesson" block type="primary" :loading="downloading[blockedLesson.id] === true" @click="downloadAndOpen(blockedLesson)">联网下载后进入</var-button>
          </div>
          <p class="unavailable-note">练习进度与历史记录始终保留在本机，删除或重新下载离线包都不会丢失。</p>
        </section>
      </div>

      <div v-else-if="view === 'result' && resultAttempt" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <span class="status-chip">提交于 {{ formatDate(resultAttempt.submittedAt) }}</span>
          <button class="icon-button" @click="downloadRecords">导出</button>
        </header>

        <section class="panel result-score">
          <div class="score-ring" :style="{ '--score': `${resultAttempt.score}%` }"><strong>{{ resultAttempt.score }}</strong></div>
          <h2>{{ resultAttempt.score >= 90 ? '几乎完美' : resultAttempt.score >= 70 ? '继续打磨细节' : '再听一遍会更好' }}</h2>
          <p>{{ resultAttempt.lessonTitle }} · 点击红色词可单独重听，并记录错误原因。</p>
        </section>

        <div class="sentence-picker">
          <button v-for="(attempt, index) in resultAttempt.sentenceAttempts" :key="attempt.sentenceId" class="sentence-dot" :class="{ active: index === selectedResultSentence }" @click="selectResultSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="resultSentence" class="panel token-panel">
          <div class="detail-head">
            <div><h3>第 {{ selectedResultSentence + 1 }} 句逐词结果</h3><p>{{ resultSentence.source }}</p></div>
            <span class="history-score">{{ resultSentence.score }}%</span>
          </div>
          <div class="word-list">
            <button v-for="token in resultSentence.tokens" :key="`${token.index}-${token.expected}--${token.actual}`" class="word-chip" :class="{ wrong: !token.correct }" :title="token.correct ? '点击重听' : `你的答案：${token.actual || '未输入'}`" @click="replay(token.expected || token.actual, 0.7)">
              {{ token.expected || `[+${token.actual}]` }}<small v-if="!token.correct">{{ token.actual || '漏词' }}</small>
            </button>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>片段重听</strong><span>选择起止词后播放</span></div>
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center">
              <select v-model.number="segmentStart" aria-label="片段起点"><option v-for="token in segmentText(resultSentence.source)" :key="`s-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <select v-model.number="segmentEnd" aria-label="片段终点"><option v-for="token in segmentText(resultSentence.source)" :key="`e-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <var-button type="primary" size="small" @click="replaySegment">播放片段</var-button>
            </div>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>错误分类与原因</strong><span>会被写入本地记录</span></div>
            <div v-for="token in resultSentence.tokens.filter((item) => !item.correct)" :key="`edit-${token.index}`" class="feedback-card">
              <strong>{{ token.expected || `多出的词：${token.actual}` }}</strong>
              <div style="display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin-top: 9px">
                <select :value="token.category" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, ($event.target as HTMLSelectElement).value as ErrorCategory, token.reason)">
                  <option v-for="option in categoryOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <input :value="token.reason" placeholder="记录原因，如连读、词尾未听清" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, token.category, ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
          </div>
        </section>

        <section v-if="resultAttempt.teacherFeedback" class="panel"><div class="feedback-card"><strong>教师反馈</strong><p>{{ resultAttempt.teacherFeedback }}</p></div></section>
        <var-button v-if="activeLesson" block type="primary" @click="startLesson(activeLesson)">返回本次课程</var-button>
        <var-button block type="default" variant="outline" style="margin-top: 10px" @click="downloadRecords">导出练习记录</var-button>
      </div>

      <div v-else-if="view === 'teacher'" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <div class="brand"><div class="brand-mark">T</div><div><h1>教师复核</h1><p>查看作答并写入反馈</p></div></div>
        </header>

        <div v-if="state.attempts.length" class="panel">
          <div class="dictation-label"><strong>选择一次作答</strong><span>{{ state.attempts.length }} 条</span></div>
          <var-select v-model="teacherAttemptId" placeholder="选择作答">
            <var-option v-for="attempt in state.attempts" :key="attempt.id" :label="`${attempt.lessonTitle} · ${attempt.score} 分 · ${formatDate(attempt.submittedAt)}`" :value="attempt.id" />
          </var-select>
          <template v-if="teacherAttempt">
            <div class="feedback-card"><strong>{{ teacherAttempt.courseTitle }}</strong><p>{{ teacherAttempt.lessonTitle }} · 总分 {{ teacherAttempt.score }}，完成 {{ teacherAttempt.sentenceAttempts.length }} 句。</p></div>
            <div class="teacher-editor">
              <textarea v-model="teacherDraft" placeholder="给学生一条具体、可执行的反馈..." aria-label="教师反馈"></textarea>
              <var-button block type="primary" style="margin-top: 10px" @click="saveTeacherFeedback">保存反馈</var-button>
            </div>
          </template>
        </div>
        <div v-else class="empty-state"><strong>暂无学生作答</strong>学习端提交听写后，这里会出现练习记录。</div>
      </div>

      <div v-if="toast" style="position: fixed; z-index: 30; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 11px 16px; border-radius: 12px; background: #17233d; color: white; font-size: .78rem; box-shadow: 0 10px 30px rgb(0 0 0 / .2)">{{ toast }}</div>
    </div>
  </var-app>
</template>
