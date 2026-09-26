/* 离线包规则核对脚本：npx tsx scripts/verify-offline.mts */
// 在引入 store 前准备浏览器环境垫片
const memory = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key)
  },
  navigator: { onLine: true },
  window: { setTimeout: (fn: () => void) => { fn(); return 0; } }
});

const { state, packageStatus, resolveLessonAccess, downloadLesson, syncCatalog, removePackage } = await import('../src/store.ts');
const { createInitialState } = await import('../src/data.ts');
const { checksumOf } = await import('../src/utils.ts');

let passed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`✗ ${name}\n  期望 ${e}\n  实际 ${a}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`✓ ${name}`);
}

// 1. 初始状态：预置 v1.0.0 离线包，记录内容/版本/缓存时间，校验通过、未过期
const seed = state.packages['airport-01'];
check('预置离线包存在', !!seed, true);
check('离线包记录版本', seed.version, '1.0.0');
check('离线包含课节内容快照', seed.snapshot.sentences.length, 4);
check('离线包记录缓存时间', typeof seed.cachedAt === 'string', true);
check('缓存有效期为 30 天', new Date(seed.expiresAt).getTime() - new Date(seed.cachedAt).getTime(), 30 * 24 * 60 * 60 * 1000);
check('校验和与快照一致', checksumOf(seed.snapshot) === seed.checksum, true);
check('当前状态为可用', packageStatus('airport-01'), 'ready');

// 2. 断网：未下载课节拦截，原因 not-downloaded
check('断网未下载 → 拦截', resolveLessonAccess('meeting-01', false).blocked, true);
check('拦截原因 = 未下载', (resolveLessonAccess('meeting-01', false) as { reason: string }).reason, 'not-downloaded');
check('断网有效包 → 放行', resolveLessonAccess('airport-01', false).blocked, false);

// 3. 同步远端教材（机场课节升到 v2.0.0）：旧包变待更新
const { updatedLessonIds } = await syncCatalog();
check('同步后有 2 节课更新', updatedLessonIds.sort(), ['airport-01', 'airport-02']);
check('目录版本为最新', state.catalogUpdatedAt, '2026-09-26');
check('旧离线包状态 = 待更新', packageStatus('airport-01'), 'stale');

// 4. 断网打开旧版本包：只读放行（能看内容/原答案/记录，不能提交由 UI 拦截 mode）
const staleAccess = resolveLessonAccess('airport-01', false);
check('断网旧包不拦截', staleAccess.blocked, false);
check('旧包内容为快照版本', (staleAccess as { lesson: { version: string } }).lesson.version, '1.0.0');
check('断网旧包模式 = offline-stale（只读）', (staleAccess as { mode: string }).mode, 'offline-stale');

// 5. 联网打开同一课节：用最新 v2.0.0 内容
const onlineAccess = resolveLessonAccess('airport-01', true);
check('联网放行', onlineAccess.blocked, false);
check('联网使用最新版本', (onlineAccess as { lesson: { version: string } }).lesson.version, '2.0.0');
check('联网旧包模式 = online-stale（可提示更新）', (onlineAccess as { mode: string }).mode, 'online-stale');

// 6. 联网换新包：下载新版本，状态恢复 ready，进度与历史记录仍在
state.progress['airport-01'].answers['airport-01-s5'] = '练习答案保留';
const attemptsBefore = state.attempts.length;
await downloadLesson('airport-01');
check('换新后版本 = v2.0.0', state.packages['airport-01'].version, '2.0.0');
check('换新后快照为 5 句', state.packages['airport-01'].snapshot.sentences.length, 5);
check('换新后状态 = 可用', packageStatus('airport-01'), 'ready');
check('换新后断网可进新版', (resolveLessonAccess('airport-01', false) as { lesson: { version: string } }).lesson.version, '2.0.0');
check('换新后进度保留', state.progress['airport-01'].answers['airport-01-s5'], '练习答案保留');
check('换新后记录保留', state.attempts.length, attemptsBefore);

// 7. 过期：断网拦截（原因 expired），联网仍可用
state.packages['airport-01'].expiresAt = new Date(Date.now() - 1000).toISOString();
check('过期状态', packageStatus('airport-01'), 'expired');
const expiredOffline = resolveLessonAccess('airport-01', false);
check('断网过期 → 拦截', expiredOffline.blocked, true);
check('断网过期原因 = expired', (expiredOffline as { reason: string }).reason, 'expired');
check('联网过期仍可在线练习', resolveLessonAccess('airport-01', true).blocked, false);
state.packages['airport-01'].expiresAt = new Date(Date.now() + 100000).toISOString();

// 8. 损坏：篡改快照使校验和不符 → 断网拦截 invalid
state.packages['airport-01'].snapshot.sentences[0].text = 'TAMPERED CONTENT';
check('损坏状态', packageStatus('airport-01'), 'invalid');
const invalidOffline = resolveLessonAccess('airport-01', false);
check('断网损坏 → 拦截', invalidOffline.blocked, true);
check('断网损坏原因 = invalid', (invalidOffline as { reason: string }).reason, 'invalid');
state.packages['airport-01'].snapshot.sentences[0].text = 'I would like to check in for my evening flight to London.';

// 9. 断网不能下载
(globalThis as { navigator: { onLine: boolean } }).navigator.onLine = false;
let downloadOfflineError = '';
try {
  await downloadLesson('airport-02');
} catch (error) {
  downloadOfflineError = (error as Error).message;
}
check('断网下载报错 offline', downloadOfflineError, 'offline');
(globalThis as { navigator: { onLine: boolean } }).navigator.onLine = true;

// 10. 关闭下载：只删离线内容，进度与练习记录保留
await downloadLesson('airport-02');
check('下载后状态可用', packageStatus('airport-02'), 'ready');
const progressBefore = state.progress['airport-01'];
const attemptsCount = state.attempts.length;
removePackage('airport-02');
check('删除后无包', !!state.packages['airport-02'], false);
check('删除后断网拦截', resolveLessonAccess('airport-02', false).blocked, true);
check('其他课进度保留', state.progress['airport-01'], progressBefore);
check('练习记录保留', state.attempts.length, attemptsCount);

// 11. 全新初始数据可正常创建且结构完整
const fresh = createInitialState();
check('全新数据有预置包', fresh.packages['airport-01']?.version, '1.0.0');
check('全新数据进度与记录存在', [!!fresh.progress['airport-01'], fresh.attempts.length], [true, 1]);

console.log(`\n全部 ${passed} 项核对通过`);
