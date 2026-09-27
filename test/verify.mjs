/**
 * 鲸察 (dsh-jingcha) · 离线自检
 * ============================================================================
 * 不依赖宿主、不联网：用假时钟 + 假 ctx 把监察逻辑跑一遍，验证
 *   1. 判定逻辑（正常 / 慢 / 挂起 / 卡住 / 错误风暴 / 静默 / 事件循环阻塞）；
 *   2. 宿主接线（事件监听器的语义必须原样透传，内部出错必须被吞掉）；
 *   3. 查询工具（输出形状 + JSON Schema 校验，能用真校验器就用真的）；
 *   4. 落盘（status.json / events.jsonl 真的写出来）。
 *
 * 跑法：node test/verify.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMonitor, classifyError, formatDuration, measureValue, previewArgs, STATES } from '../lib/core.js';
import { apply, instances } from '../lib/index.js';
import * as pluginModule from '../lib/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', '.selftest-out');

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks++;
  if (condition) console.log('  [PASS] ' + label);
  else { failures++; console.log('  [FAIL] ' + label + (detail === undefined ? '' : ' — ' + detail)); }
}
function section(title) { console.log('\n=== ' + title + ' ==='); }

/** 可控假时钟。 */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  now.set = (v) => { t = v; return t; };
  return now;
}

const AGENT = { id: 'agent-1', session: { id: 'session-1' } };

// ── 1. 纯函数 ────────────────────────────────────────────────────────────────
section('模块形状：必须能被 cordis loader 当成插件（而不是裸函数）');
check('没有 default 导出', pluginModule.default === undefined, String(pluginModule.default));
check('有 apply 函数', typeof pluginModule.apply === 'function');
check('有 inject 且含 tools', Array.isArray(pluginModule.inject) && pluginModule.inject.indexOf('tools') >= 0, JSON.stringify(pluginModule.inject));
check('loader unwrapExports(default ?? exports) 之后仍是带 inject 的插件', (pluginModule.default ?? pluginModule) === pluginModule);

section('纯函数：错误分类 / 时长格式 / 体量估算 / 参数预览');
check('classifyError timeout', classifyError('TOOL_TIMEOUT', 'tool call timed out after 30000ms') === 'timeout');
check('classifyError sandbox', classifyError('EPERM', 'sandbox: file access denied under workspace-write mode') === 'denied');
check('classifyError abort', classifyError('ABORTED', 'the caller aborted') === 'aborted');
check('classifyError network', classifyError('FETCH_FAILED', 'fetch failed: getaddrinfo ENOTFOUND api.example.com') === 'network');
check('formatDuration 1500ms', formatDuration(1500) === '1.50s', formatDuration(1500));
check('formatDuration 185000ms', formatDuration(185_000) === '3m05s', formatDuration(185_000));
check('measureValue counts text', measureValue({ text: 'x'.repeat(1000) }) > 900, String(measureValue({ text: 'x'.repeat(1000) })));
check('previewArgs prefers command', previewArgs({ command: 'Get-ChildItem', other: 1 }).indexOf('command=Get-ChildItem') === 0, previewArgs({ command: 'Get-ChildItem', other: 1 }));

// ── 2. 判定逻辑 ──────────────────────────────────────────────────────────────
section('判定：正常运行 → 慢 → 挂起 → 卡住');
{
  const clock = fakeClock();
  const m = createMonitor({ heartbeatMs: 1000, slowCallMs: 30_000, hangCallMs: 60_000, stuckCallMs: 120_000 }, clock);
  check('初始判定 ok', m.verdict().state === STATES.ok, m.verdict().state);

  m.toolStart({ callId: 'c1', name: 'pwsh', arguments: { command: 'echo hi' }, agentKey: 'agent-1', sessionId: 'session-1' });
  check('有在途调用 -> busy', m.verdict().state === STATES.busy, m.verdict().state);

  // 像真宿主那样每秒一跳：挂起线 60s、卡住线 120s 都要被踩到
  const seen = {};
  const findingsSeen = new Set();
  for (let second = 1; second <= 125; second++) {
    clock.advance(1000);
    m.tick(clock());
    for (const finding of m.peek().findings) findingsSeen.add(finding.kind);
    if (second === 31) seen.at31 = m.verdict().state;
    if (second === 61) { seen.at61 = m.verdict().state; seen.hangReasons = m.verdict().reasons.map((r) => r.kind); }
    if (second === 121) { seen.at121 = m.verdict().state; seen.stallReasons = m.verdict().reasons.map((r) => r.kind); }
  }
  check('31s -> degraded（偏慢）', seen.at31 === STATES.degraded, String(seen.at31));
  check('61s -> stalled（挂起也算卡住）', seen.at61 === STATES.stalled, String(seen.at61));
  check('61s 理由里带 tool-hang', Array.isArray(seen.hangReasons) && seen.hangReasons.indexOf('tool-hang') >= 0, JSON.stringify(seen.hangReasons));
  check('121s 理由升级为 tool-stall', Array.isArray(seen.stallReasons) && seen.stallReasons.indexOf('tool-stall') >= 0, JSON.stringify(seen.stallReasons));
  check('心跳登记了 tool-hang 与 tool-stall 告警', findingsSeen.has('tool-hang') && findingsSeen.has('tool-stall'), [...findingsSeen].join(','));
  check('没有误报事件循环阻塞', !findingsSeen.has('event-loop-blocked'), [...findingsSeen].join(','));

  // 进度心跳：长调用期间事件流不该只有开始/结束两条
  const drained = m.drain();
  check('长调用期间写了 tool.progress（进度心跳）', drained.some((e) => e.kind === 'tool.progress'),
    drained.map((e) => e.kind).join(','));
  const slowOnes = drained.filter((e) => e.kind === 'tool.progress' && e.slow === true);
  check('进度心跳在超过慢线后标 slow=true', slowOnes.length > 0, String(slowOnes.length));
  const longNow = m.longRunning(clock());
  check('longRunning() 能列出跑得久的在途调用', longNow.length === 1 && longNow[0].name === 'pwsh',
    JSON.stringify(longNow.map((r) => r.name + '@' + r.elapsedMs)));

  m.toolFinish({ callId: 'c1', isError: false, contentBytes: 12, contentBlocks: 1 });
  check('调用结束后回到 ok', m.verdict().state === STATES.ok, m.verdict().state);
  check('结束后 longRunning() 清空', m.longRunning(clock()).length === 0, String(m.longRunning(clock()).length));
  const stats = m.peek().stats[0];
  check('统计记下 1 次调用与耗时', stats.calls === 1 && stats.maxMs >= 120_000, JSON.stringify({ calls: stats.calls, maxMs: stats.maxMs }));
}

section('后台 job：进入 / 状态变化 / 离开都留痕');
{
  const clock = fakeClock();
  const m = createMonitor({}, clock);
  m.noteJobs([{ id: 'j1', kind: 'pwsh', label: 'npm install', status: 'running', startedAt: clock() }], clock());
  clock.advance(60_000);
  m.noteJobs([{ id: 'j1', kind: 'pwsh', label: 'npm install', status: 'completed', startedAt: clock() - 60_000, finishedAt: clock() }], clock());
  m.noteJobs([], clock());
  const kinds = m.drain().map((e) => e.kind);
  check('job.start / job.status / job.end 都记了',
    kinds.indexOf('job.start') >= 0 && kinds.indexOf('job.status') >= 0 && kinds.indexOf('job.end') >= 0, kinds.join(','));
  const snap = m.snapshot(clock());
  check('snapshot.extras.jobs 带明细字段', Boolean(snap.extras && snap.extras.jobs && Array.isArray(snap.extras.jobs.items)),
    JSON.stringify(snap.extras && snap.extras.jobs));
}

section('判定：错误风暴（同一工具反复失败）与成功复位');
{
  const clock = fakeClock();
  const m = createMonitor({ errorStormCount: 3, errorStormWindowMs: 120_000 }, clock);
  for (let i = 0; i < 3; i++) {
    m.toolStart({ callId: 'e' + i, name: 'read', arguments: { file_path: 'C:/nope.txt' } });
    clock.advance(500);
    m.toolFinish({ callId: 'e' + i, isError: true, errorCode: 'ENOENT', errorMessage: 'no such file', contentBytes: 10, contentBlocks: 1 });
  }
  const v = m.verdict();
  check('三次失败 -> erroring', v.state === STATES.erroring, v.state);
  check('理由里有 error-storm', v.reasons.some((r) => r.kind === 'error-storm'), JSON.stringify(v.reasons.map((r) => r.kind)));
  check('连续失败计数为 3', m.peek().stats[0].consecutiveErrors === 3, String(m.peek().stats[0].consecutiveErrors));

  m.toolStart({ callId: 'ok1', name: 'read', arguments: {} });
  clock.advance(300);
  m.toolFinish({ callId: 'ok1', isError: false, contentBytes: 100, contentBlocks: 1 });
  check('一次成功不再算连续失败', m.peek().stats[0].consecutiveErrors === 0, String(m.peek().stats[0].consecutiveErrors));
}

section('判定：agent 在跑但没有任何输出（静默）');
{
  const clock = fakeClock();
  const m = createMonitor({ silenceMs: 60_000, slowCallMs: 30_000 }, clock);
  m.agentStatus({ key: 'a1', sessionId: 's1', status: 'running' });
  clock.advance(90_000);
  const v = m.verdict();
  check('静默 90s -> stalled', v.state === STATES.stalled, v.state);
  check('理由里有 no-progress', v.reasons.some((r) => r.kind === 'no-progress'), JSON.stringify(v.reasons.map((r) => r.kind)));
  m.streamChunk({ key: 'a1', sessionId: 's1', turn: 1, bytes: 12 });
  check('来了一帧流式输出 -> 恢复 busy', m.verdict().state === STATES.busy, m.verdict().state);
}

section('判定：事件循环被阻塞');
{
  const clock = fakeClock();
  const m = createMonitor({ lagWarnMs: 500, lagStuckMs: 5000 }, clock);
  m.noteLag(800);
  check('800ms -> degraded', m.verdict().state === STATES.degraded, m.verdict().state);
  m.noteLag(7000);
  const v = m.verdict();
  check('7000ms -> stalled（event-loop-blocked）', v.state === STATES.stalled && v.reasons.some((r) => r.kind === 'event-loop-blocked'), v.state);
}

section('判定：内存泄漏预警（RSS 连续递增 + 增幅超阈值）');
{
  // ① 连续 5 个心跳递增、总增幅约 27.6% -> 命中
  const clock = fakeClock();
  const m = createMonitor({ heartbeatMs: 1000, memoryLeakWindow: 5, memoryLeakGrowth: 0.1 }, clock);
  let rss = 100 * 1024 * 1024;
  for (let i = 0; i < 6; i++) { m.noteMemory(rss, clock()); if (i < 5) { rss = Math.round(rss * 1.05); clock.advance(1000); } }
  const v = m.verdict();
  const leak = v.reasons.find((r) => r.kind === 'memory-leak');
  check('连续 5 个心跳递增且 >10% -> reason kind 是 memory-leak', Boolean(leak), v.reasons.map((r) => r.kind).join(','));
  check('理由里带增长率 / 窗口 / 首尾 RSS', Boolean(leak) && leak.growth > 0.1 && leak.window === 5 && leak.fromRssBytes > 0 && leak.rssBytes > leak.fromRssBytes,
    leak ? JSON.stringify({ growth: Number(leak.growth.toFixed(3)), window: leak.window, from: leak.fromRssBytes, to: leak.rssBytes }) : '');
  check('状态是 degraded（是预警，不误报卡住）', v.state === STATES.degraded, v.state);
  check('事件流里有一条 memory.leak（同一次只记一条）', m.drain().filter((e) => e.kind === 'memory.leak').length === 1);
  check('快照里能读到 memoryLeak 明细', m.snapshot().runtime.memoryLeak.active === true && m.snapshot().runtime.memoryLeak.window === 5);
  check('同时写进 findings（挂件「最近告警」能看到）', m.peek().findings.some((f) => f.kind === 'memory-leak'));
}
{
  // ② 一直在涨但总增幅不到 10% -> 不命中
  const clock = fakeClock();
  const m = createMonitor({ memoryLeakWindow: 5, memoryLeakGrowth: 0.1 }, clock);
  let rss = 100 * 1024 * 1024;
  for (let i = 0; i < 6; i++) { m.noteMemory(rss, clock()); rss = Math.round(rss * 1.01); clock.advance(1000); }
  const v = m.verdict();
  check('递增但增幅只有 ~5% -> 不报内存泄漏', !v.reasons.some((r) => r.kind === 'memory-leak'), v.reasons.map((r) => r.kind).join(','));
  check('没命中时快照里 active=false', m.snapshot().runtime.memoryLeak.active === false);
}
{
  // ③ 中间回落一次（不满足"连续递增"）-> 不命中
  const clock = fakeClock();
  const m = createMonitor({ memoryLeakWindow: 5, memoryLeakGrowth: 0.1 }, clock);
  const series = [100, 130, 120, 140, 150, 160].map((mb) => mb * 1024 * 1024);
  for (const rss of series) { m.noteMemory(rss, clock()); clock.advance(1000); }
  const v = m.verdict();
  check('中间掉过一次 -> 不算连续递增', !v.reasons.some((r) => r.kind === 'memory-leak'), v.reasons.map((r) => r.kind).join(','));
}
{
  // ④ 配置生效：窗口 3 / 阈值 50%
  const clock = fakeClock();
  const strict = createMonitor({ memoryLeakWindow: 3, memoryLeakGrowth: 0.5 }, clock);
  let rss = 100 * 1024 * 1024;
  for (let i = 0; i < 4; i++) { strict.noteMemory(rss, clock()); rss = Math.round(rss * 1.2); clock.advance(1000); }
  check('窗口 3 / 阈值 50%：+72.8% -> 命中', strict.verdict().reasons.some((r) => r.kind === 'memory-leak'));
  const clock2 = fakeClock();
  const m2 = createMonitor({ memoryLeakWindow: 3, memoryLeakGrowth: 0.9 }, clock2);
  let rss2 = 100 * 1024 * 1024;
  for (let i = 0; i < 4; i++) { m2.noteMemory(rss2, clock2()); rss2 = Math.round(rss2 * 1.2); clock2.advance(1000); }
  check('同一串数据把阈值抬到 90% -> 不命中（阈值可配）', !m2.verdict().reasons.some((r) => r.kind === 'memory-leak'));
}
{
  // ⑤ 脏输入不该炸，也不该误报
  const clock = fakeClock();
  const m = createMonitor({ memoryLeakWindow: 5, memoryLeakGrowth: 0.1 }, clock);
  m.noteMemory(undefined, clock());
  m.noteMemory(-1, clock());
  m.noteMemory('nonsense', clock());
  m.noteMemory(NaN, clock());
  check('非法 RSS 被忽略，不报内存泄漏也不抛异常', !m.verdict().reasons.some((r) => r.kind === 'memory-leak'));
}

section('判定：审批等待被人看见');
{
  const clock = fakeClock();
  const m = createMonitor({ approvalWarnMs: 20_000 }, clock);
  m.toolStart({ callId: 'a1', name: 'pwsh', arguments: { command: 'rm -rf' } });
  m.toolDecision({ callId: 'a1', name: 'pwsh', kind: 'ask', waitedMs: 45_000, approval: true });
  const f = m.peek().findings.map((x) => x.kind);
  check('等待 45s -> approval-wait 告警', f.indexOf('approval-wait') >= 0, f.join(','));
  check('审批计数 +1', m.peek().counters.approvals === 1 && m.peek().counters.approvalWaits === 1, JSON.stringify(m.peek().counters));
}

section('产出：快照可序列化、报告含关键段落');
{
  const clock = fakeClock();
  const m = createMonitor({}, clock);
  m.toolStart({ callId: 'p1', name: 'pwsh', arguments: { command: 'git status' }, sessionId: 's1' });
  clock.advance(1200);
  m.toolFinish({ callId: 'p1', isError: false, contentBytes: 2048, contentBlocks: 1 });
  const snapshot = m.snapshot();
  let json = '';
  try { json = JSON.stringify(snapshot); } catch (e) { json = 'THREW ' + e.message; }
  check('snapshot 可 JSON.stringify', json.length > 200 && json.indexOf('THREW') !== 0, String(json.length));
  check('snapshot 带 schema 版本', snapshot.schema === 'jingcha/status@1', snapshot.schema);
  const report = m.report({});
  check('报告标题带显示名', report.indexOf('# 鲸察') === 0, report.slice(0, 40));
  check('报告有工具统计表', report.indexOf('## 工具使用统计') > 0);
  check('报告含 pwsh 行', report.indexOf('pwsh') > 0);
  check('报告含输出面', report.indexOf('## 输出面') > 0);
}

// ── 3. 宿主接线（假 ctx） ────────────────────────────────────────────────────
section('接线：假 ctx 里挂载插件并真的走一遍事件');
function makeFakeCtx() {
  const handlers = new Map();
  const registered = [];
  const disposers = [];
  const effectDisposers = [];
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
    },
  };
  const ctx = {
    // 真 cordis 用 ctx.effect() 绑定生命周期（卸载时反向执行），这里照样收集起来
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') effectDisposers.push(disposer);
      return disposer;
    },
    on(event, listener) {
      const list = handlers.get(event) || [];
      list.push(listener);
      handlers.set(event, list);
      const dispose = () => { const current = handlers.get(event) || []; const i = current.indexOf(listener); if (i >= 0) current.splice(i, 1); };
      disposers.push(dispose);
      return dispose;
    },
    tools: {
      register(definition) { registered.push(definition); return () => {}; },
      get(name) { return name === 'pwsh' ? { name, timeoutMs: 30_000 } : { name }; },
    },
    get(name) {
      if (name === 'jobs') return { list: () => [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'completed' }] };
      if (name === 'webServer') return webServer;
      return undefined;
    },
    // 真 cordis 的 ctx.inject(names, cb) 会等服务就位后再回调；这里直接同步回调
    inject(names, callback) {
      const scoped = {
        webServer,
        effect(cb) { const d = cb(); if (typeof d === 'function') effectDisposers.push(d); return d; },
        on() {},
        get: (name) => (name === 'webServer' ? webServer : undefined),
      };
      try { return callback(scoped); } catch (error) { throw error; }
    },
  };
  async function fire(event, ...args) {
    const list = handlers.get(event) || [];
    const results = [];
    for (const listener of list) results.push(await listener(...args));
    return results;
  }
  async function runEffects() {
    for (const dispose of effectDisposers.reverse()) await dispose();
  }
  return { ctx, handlers, registered, routes, webServer, fire, runEffects, disposeAll: () => disposers.forEach((d) => d()) };
}

{
  fs.rmSync(outDir, { recursive: true, force: true });
  const fake = makeFakeCtx();
  const logs = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  let applied = true;
  try { apply(fake.ctx, { dataDir: outDir, heartbeatMs: 600_000, console: true, statusEveryMs: 600_000 }); }
  catch (error) { applied = false; check('apply 不抛异常', false, error && error.message); }
  console.log = realLog;
  console.warn = realWarn;
  check('apply 成功', applied);
  check('注册了 jingcha_status 工具', fake.registered.length === 1 && fake.registered[0].name === 'jingcha_status', JSON.stringify(fake.registered.map((d) => d.name)));
  check('启动自述进了控制台', logs.some((line) => line.indexOf('已挂载') >= 0), logs.join(' | '));

  // pre-execute：语义透传（next 的返回值必须原样返回）
  const exec = { callId: 'call-1', name: 'pwsh', arguments: { command: 'echo hello' }, agent: AGENT };
  const decision = { kind: 'allow' };
  const preOut = (await fake.fire('tools/pre-execute', exec, async () => decision))[0];
  check('pre-execute 原样返回 next() 的裁决', preOut === decision);

  // execute：结果原样返回
  const result = { isError: false, content: [{ type: 'text', text: 'hello world' }] };
  const execOut = (await fake.fire('tools/execute', exec, async () => result))[0];
  check('execute 原样返回 next() 的结果', execOut === result);
  const live = instances[instances.length - 1];
  check('execute 之后有一次调用记录', live.monitor.peek().calls.length === 1, String(live.monitor.peek().calls.length));
  check('记下了声明超时 30000', live.monitor.peek().calls[0].declaredTimeoutMs === 30_000, String(live.monitor.peek().calls[0].declaredTimeoutMs));

  // execute：工具体抛错必须原样抛给上层，同时被记账
  let threw = false;
  try { await fake.fire('tools/execute', { callId: 'call-2', name: 'pwsh', arguments: { command: 'boom' }, agent: AGENT }, async () => { throw new Error('E_BOOM: boom'); }); }
  catch (error) { threw = true; }
  check('execute 里的工具体异常被原样抛出', threw);
  check('异常调用被记为失败', live.monitor.peek().counters.toolErrors === 1, JSON.stringify(live.monitor.peek().counters));

  // tools/result：最终结果观察点（含错误码与内容体量）
  await fake.fire('tools/result', { callId: 'call-3', name: 'read', arguments: { file_path: 'C:/x' }, agent: AGENT },
    { isError: true, error: { message: 'no such file', info: { name: 'FsError', code: 'ENOENT' } }, content: [{ type: 'text', text: 'Error: no such file' }] });
  const lastCall = live.monitor.peek().calls[live.monitor.peek().calls.length - 1];
  check('result 观察点补全了调用记录', lastCall.name === 'read' && lastCall.isError === true, JSON.stringify({ name: lastCall.name, isError: lastCall.isError }));
  check('错误被分类为 not-found', lastCall.category === 'not-found', String(lastCall.category));

  // agent / 流式 / 会话 / 子智能体
  await fake.fire('agent/status', { agent: AGENT, status: 'running' });
  await fake.fire('agent/assistant-stream', { agent: AGENT, frame: { type: 'chunk', turn: 1, index: 0, chunk: 'abc' } });
  await fake.fire('agent/assistant-stream', { agent: AGENT, frame: { type: 'start', turn: 1 } });
  await fake.fire('session/event', { id: 'session-1' }, { type: 'assistant/message' });
  await fake.fire('subagent/start', { subagentId: 'sub-1', description: 'demo' });
  await fake.fire('subagent/end', { subagentId: 'sub-1', status: 'completed' });
  const counters = live.monitor.peek().counters;
  check('流式帧只数 chunk（不数 start）', counters.streamChunks === 1, String(counters.streamChunks));
  check('会话事件计入', counters.sessionEvents === 1, String(counters.sessionEvents));
  check('子智能体起止计入', counters.subagentStarts === 1 && counters.subagentEnds === 1, JSON.stringify({ s: counters.subagentStarts, e: counters.subagentEnds }));
  check('agent 状态为 running', live.monitor.peek().agents[0].status === 'running', JSON.stringify(live.monitor.peek().agents));

  // request-error 的 waterfall 语义：必须调用 next() 并把它的返回值返回
  let nextCalled = false;
  const reqOut = (await fake.fire('agent/request-error', { agent: AGENT, failure: { message: 'rate limited' } }, async () => { nextCalled = true; return { kind: 'retry' }; }))[0];
  check('request-error 调用了 next()', nextCalled);
  check('request-error 原样返回重试决策', reqOut && reqOut.kind === 'retry', JSON.stringify(reqOut));
  check('请求失败计入 requestRetries', live.monitor.peek().counters.requestRetries === 1, String(live.monitor.peek().counters.requestRetries));

  // 垃圾输入：监听器不许抛
  let garbageThrew = null;
  try {
    await fake.fire('tools/result', undefined, undefined);
    await fake.fire('agent/status', {});
    await fake.fire('session/event', null, null);
    await fake.fire('agent/assistant-stream', {});
    await fake.fire('subagent/start', null);
    await fake.fire('tools/pre-execute', {}, async () => undefined);
  } catch (error) { garbageThrew = error; }
  check('垃圾输入不抛异常', garbageThrew === null, garbageThrew && garbageThrew.message);
  check('垃圾输入不记成插件故障', live.monitor.peek().counters.pluginErrors === 0, String(live.monitor.peek().counters.pluginErrors));

  // 查询工具
  const definition = fake.registered[0];
  check('工具有 output.render', typeof definition.output.render === 'function');
  let toolValue = null;
  let toolThrew = null;
  try { toolValue = await definition.execute({ windowMinutes: 5 }); } catch (error) { toolThrew = error; }
  check('工具 execute 不抛', toolThrew === null, toolThrew && toolThrew.message);
  check('工具返回值带 report', Boolean(toolValue && typeof toolValue.report === 'string' && toolValue.report.length > 100));
  check('报告里点了数据文件', Boolean(toolValue && toolValue.report.indexOf('events.jsonl') > 0));
  const rendered = definition.output.render({}, toolValue);
  check('render 产出 text 内容块', Array.isArray(rendered) && rendered[0].type === 'text' && rendered[0].text.length > 100);
  check('工具值能 JSON 序列化', typeof JSON.stringify(toolValue) === 'string');

  // 用宿主真校验器（若有）复核：schema 受支持 + 值合法
  let validatorChecked = false;
  try {
    const tools = await import('@deepseek-ai/dsh-tools');
    tools.assertSupportedJsonSchema(definition.parameters);
    tools.assertSupportedJsonSchema(definition.output.schema);
    const violations = tools.validateJsonSchemaValue(definition.output.schema, JSON.parse(JSON.stringify(toolValue)), 'value');
    check('宿主校验器：schema 受支持且工具值合法', violations.length === 0, JSON.stringify(violations));
    const argViolations = tools.validateJsonSchemaValue(definition.parameters, { windowMinutes: 5 }, 'args');
    check('宿主校验器：参数 schema 合法', argViolations.length === 0, JSON.stringify(argViolations));
    validatorChecked = true;
  } catch (error) {
    check('宿主校验器可用（不可用则跳过，不算失败）', true, 'skipped: ' + (error && error.message));
  }
  if (validatorChecked) console.log('  [INFO] 已用 @deepseek-ai/dsh-tools 的真实 JSON Schema 校验器复核');

  // 落盘：等待 flush 后检查文件
  const alive = instances[instances.length - 1];
  alive.sink.queueRecords(alive.monitor.drain());
  await alive.sink.flush();
  await alive.sink.close();
  const statusPath = path.join(outDir, 'status.json');
  const logPath = path.join(outDir, 'events.jsonl');
  check('status.json 写出来了', fs.existsSync(statusPath), statusPath);
  check('events.jsonl 写出来了', fs.existsSync(logPath), logPath);
  if (fs.existsSync(statusPath)) {
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    check('status.json 是合法快照', parsed.schema === 'jingcha/status@1' && Boolean(parsed.verdict));
  }
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    let allJson = true;
    for (const line of lines) { try { JSON.parse(line); } catch { allJson = false; } }
    check('events.jsonl 每行都是合法 JSON', allJson && lines.length > 0, lines.length + ' lines');
    const kinds = lines.map((line) => { try { return JSON.parse(line).kind; } catch { return 'bad'; } });
    check('事件流里有 tool.call', kinds.indexOf('tool.call') >= 0, kinds.join(','));
  }

  // ── HTTP 接口（给挂件用）与强制停止 ─────────────────────────────────────
  const routePaths = fake.routes.map((r) => r.path);
  check('注册了三个挂件接口', routePaths.indexOf('/api/jingcha/status') >= 0 && routePaths.indexOf('/api/jingcha/kill') >= 0 && routePaths.indexOf('/api/jingcha/stop') >= 0, routePaths.join(','));
  const makeRes = () => ({ statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { this.body = text; } });
  // 真 HTTP 一定带 Host/Origin/Sec-Fetch-Site，桩也按同源请求造，才测得到跨站栅栏
  const makeReq = (url, addr = '127.0.0.1', method = 'POST', body = '', extra = {}) => ({
    method, url,
    headers: Object.assign({ host: '127.0.0.1:3080', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' }, extra),
    socket: { remoteAddress: addr },
    on(evt, cb) {
      if (evt === 'data' && body) setTimeout(() => cb(Buffer.from(body, 'utf8')), 0);
      if (evt === 'end') setTimeout(cb, 0);
    },
  });

  const statusRoute = fake.routes.find((r) => r.path === '/api/jingcha/status');
  const resStatus = makeRes();
  statusRoute.handler(makeReq('/api/jingcha/status', '127.0.0.1', 'GET'), resStatus);
  const statusBody = JSON.parse(resStatus.body);
  check('status 接口返回 verdict 与在途列表', resStatus.statusCode === 200 && Boolean(statusBody.verdict) && Array.isArray(statusBody.work.inflight), resStatus.body.slice(0, 120));
  const resBlocked = makeRes();
  statusRoute.handler(makeReq('/api/jingcha/status', '203.0.113.9', 'GET'), resBlocked);
  check('非回环地址被拒（403）', resBlocked.statusCode === 403, String(resBlocked.statusCode));

  // ── 跨站 / 重绑定栅栏（安全审查 S1、M1）──
  const resEvilHost = makeRes();
  statusRoute.handler(makeReq('/api/jingcha/status', '127.0.0.1', 'GET', '', { host: 'evil.example:3080' }), resEvilHost);
  check('伪造 Host（DNS rebinding）被拒 403', resEvilHost.statusCode === 403, resEvilHost.body);
  const resEvilOrigin = makeRes();
  statusRoute.handler(makeReq('/api/jingcha/status', '127.0.0.1', 'GET', '', { origin: 'https://evil.example' }), resEvilOrigin);
  check('跨站 Origin 被拒 403', resEvilOrigin.statusCode === 403, resEvilOrigin.body);
  const resCrossSite = makeRes();
  statusRoute.handler(makeReq('/api/jingcha/status', '127.0.0.1', 'GET', '', { 'sec-fetch-site': 'cross-site' }), resCrossSite);
  check('Sec-Fetch-Site: cross-site 被拒 403', resCrossSite.statusCode === 403, resCrossSite.body);
  const killRouteEarly = fake.routes.find((r) => r.path === '/api/jingcha/kill');
  const resGetKill = makeRes();
  await killRouteEarly.handler(makeReq('/api/jingcha/kill?scope=all', '127.0.0.1', 'GET'), resGetKill);
  check('状态变更不接受 GET（405，挡住 <img> 一发即杀）', resGetKill.statusCode === 405, resGetKill.body);
  const resFormKill = makeRes();
  await killRouteEarly.handler(makeReq('/api/jingcha/kill', '127.0.0.1', 'POST', JSON.stringify({ scope: 'all' }), { 'content-type': 'text/plain' }), resFormKill);
  check('非 JSON content-type 被拒 415（挡住跨站表单）', resFormKill.statusCode === 415, resFormKill.body);
  const resStatusOk = makeRes();
  statusRoute.handler(makeReq('/api/jingcha/status', '127.0.0.1', 'GET'), resStatusOk);
  check('同源请求照常放行（栅栏不误伤）', resStatusOk.statusCode === 200, String(resStatusOk.statusCode));

  // 设置接口：GET 给默认值，POST 夹紧、落盘并回读
  const settingsRoute = fake.routes.find((r) => r.path === '/api/jingcha/settings');
  check('注册了设置接口', Boolean(settingsRoute), routePaths.join(','));
  const resGetSettings = makeRes();
  settingsRoute.handler(makeReq('/api/jingcha/settings', '127.0.0.1', 'GET'), resGetSettings);
  const getSettings = JSON.parse(resGetSettings.body);
  check('GET settings 返回默认值与 defaults', getSettings.ok === true && getSettings.settings.thresholds.yellowSec === 30 && Boolean(getSettings.defaults),
    resGetSettings.body.slice(0, 140));
  const resPostSettings = makeRes();
  await settingsRoute.handler(
    makeReq('/api/jingcha/settings', '127.0.0.1', 'POST', JSON.stringify({ thresholds: { yellowSec: 5, redSec: 99999 }, size: 99, opacity: -3, position: { mode: 'free', left: 10, top: 20 }, theme: 'neon' })),
    resPostSettings,
  );
  const posted = JSON.parse(resPostSettings.body);
  check('POST settings 夹紧取值范围（size<=2 / redSec<=7200 / yellow<red / theme 白名单）',
    posted.ok === true && posted.settings.size === 2 && posted.settings.thresholds.redSec === 7200 &&
    posted.settings.thresholds.yellowSec === 5 && posted.settings.opacity === 0.2 && posted.settings.theme === 'auto',
    resPostSettings.body.slice(0, 220));
  check('位置写下来了（left/top）', posted.settings.position.left === 10 && posted.settings.position.top === 20, JSON.stringify(posted.settings.position));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const settingsFile = path.join(outDir, 'widget-settings.json');
  check('设置落盘到数据目录', fs.existsSync(settingsFile), settingsFile);
  if (fs.existsSync(settingsFile)) {
    const persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('落盘内容与回读一致', persisted.thresholds.yellowSec === 5 && persisted.position.left === 10, JSON.stringify(persisted.thresholds));
  }

  // 位置 mode 的语义必须两端一致（评审发现的真实分歧：客户端 docked -> 宿主回读 free）
  const resModeDocked = makeRes();
  await settingsRoute.handler(makeReq('/api/jingcha/settings', '127.0.0.1', 'POST', JSON.stringify({ position: { mode: 'docked', right: 20, bottom: 30, left: null, top: null } })), resModeDocked);
  check('mode=docked 存下来还是 docked', JSON.parse(resModeDocked.body).settings.position.mode === 'docked', resModeDocked.body.slice(0, 140));
  const resModeFree = makeRes();
  await settingsRoute.handler(makeReq('/api/jingcha/settings', '127.0.0.1', 'POST', JSON.stringify({ position: { mode: 'free', left: 512, top: 742 } })), resModeFree);
  check('mode=free 且有坐标 -> free', JSON.parse(resModeFree.body).settings.position.mode === 'free', resModeFree.body.slice(0, 140));
  const resModeHeal = makeRes();
  await settingsRoute.handler(makeReq('/api/jingcha/settings', '127.0.0.1', 'POST', JSON.stringify({ position: { mode: 'free', left: null, top: null } })), resModeHeal);
  check('mode=free 但没坐标 -> 自愈回 docked', JSON.parse(resModeHeal.body).settings.position.mode === 'docked', resModeHeal.body.slice(0, 140));

  // 起一个永不返回的调用，然后从 kill 接口掐断它
  const originalSignal = new AbortController().signal;
  const execKill = { callId: 'call-kill', name: 'pwsh', arguments: { command: 'Start-Sleep 999' }, agent: AGENT, signal: originalSignal };
  let fusedSignal = null;
  let killThrew = false;
  const pendingKill = fake.fire('tools/execute', execKill, () => new Promise((_resolve, reject) => {
    fusedSignal = execKill.signal;
    if (execKill.signal.aborted) return reject(new Error('already aborted'));
    execKill.signal.addEventListener('abort', () => reject(new Error('aborted by jingcha')), { once: true });
  })).then(() => {}, () => { killThrew = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('包装层把 exec.signal 换成了鲸察的融合信号', fusedSignal !== null && fusedSignal !== originalSignal);

  const killRoute = fake.routes.find((r) => r.path === '/api/jingcha/kill');
  const resKill = makeRes();
  await killRoute.handler(makeReq('/api/jingcha/kill', '127.0.0.1', 'POST', JSON.stringify({ callId: 'call-kill' })), resKill);
  const killBody = JSON.parse(resKill.body);
  check('kill 接口按 callId 掐断', resKill.statusCode === 200 && killBody.ok === true && killBody.killed[0] === 'call-kill', resKill.body);
  await pendingKill;
  check('被掐断的调用真的中止了', killThrew);
  check('abort 之后 exec.signal 还原成上游信号', execKill.signal === originalSignal);
  const killEvents = live.monitor.drain().filter((e) => e.kind === 'kill.done');
  check('强制停止写进事件流（kill.done）', killEvents.length === 1 && killEvents[0].callId === 'call-kill', JSON.stringify(killEvents));

  // ── 嵌套调用（父:ptc:n）的强停：现场实测过「点了没反应」，这里钉死（安全/功能审查 L1 + 实测）──
  const execNested = { callId: 'ptc-parent:ptc:1', name: 'pwsh', arguments: { command: 'sleep 999' }, agent: AGENT, signal: new AbortController().signal };
  fake.fire('tools/pre-execute', execNested, () => new Promise(() => {}));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const nestedSignal = execNested.signal;
  const nestedAborted = new Promise((resolve) => {
    if (nestedSignal.aborted) return resolve(true);
    nestedSignal.addEventListener('abort', () => resolve(true), { once: true });
  });
  const resNested = makeRes();
  await killRoute.handler(makeReq('/api/jingcha/kill', '127.0.0.1', 'POST', JSON.stringify({ callId: 'ptc-parent:ptc:1' })), resNested);
  const nestedBody = JSON.parse(resNested.body);
  check('嵌套调用能在 pre-execute 阶段被强停（不再 killed: []）', nestedBody.ok === true && nestedBody.killed[0] === 'ptc-parent:ptc:1', resNested.body);
  check('嵌套调用的融合信号真的被 abort', await Promise.race([nestedAborted, new Promise((r) => setTimeout(() => r(false), 80))]) === true);

  const execOuter = { callId: 'outer-call', name: 'run_code', arguments: {}, agent: AGENT, signal: new AbortController().signal };
  fake.fire('tools/pre-execute', execOuter, () => new Promise(() => {}));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const resParent = makeRes();
  await killRoute.handler(makeReq('/api/jingcha/kill', '127.0.0.1', 'POST', JSON.stringify({ callId: 'outer-call:ptc:9' })), resParent);
  const parentBody = JSON.parse(resParent.body);
  check('只有父在跑时杀子 id：明确拒绝而不是误杀父', parentBody.ok === false && parentBody.reason === 'nested-parent-only' && parentBody.parentId === 'outer-call', resParent.body);
  check('父调用的信号没被误 abort', execOuter.signal.aborted === false);
  const resEmpty = makeRes();
  await killRoute.handler(makeReq('/api/jingcha/kill', '127.0.0.1', 'POST', JSON.stringify({ callId: 'undefined' })), resEmpty);
  check('callId=undefined 直接拒绝（L1）', JSON.parse(resEmpty.body).reason === 'empty-callId', resEmpty.body);

  // 心跳里会采一次 RSS 交给 core（内存泄漏预警的数据来源）
  live.heartbeatOnce(Date.now());
  check('宿主心跳确实把 RSS 采给了 core', live.monitor.peek().memorySamples.length >= 1, String(live.monitor.peek().memorySamples.length));
  check('快照里能看到内存采样数（memoryLeak.samples）', live.monitor.snapshot().runtime.memoryLeak.samples >= 1);

  // 卸载：跑 effect disposer（停心跳、写最后快照、清实例）
  await fake.runEffects();
  check('effect disposer 跑完后实例被移除', instances.length === 0, String(instances.length));
}

// ── 4. 禁用开关 ─────────────────────────────────────────────────────────────
section('配置：enabled=false 时完全不挂载');
{
  const fake = makeFakeCtx();
  const realLog = console.log;
  console.log = () => {};
  apply(fake.ctx, { enabled: false });
  console.log = realLog;
  check('禁用时不注册工具、不挂监听器', fake.registered.length === 0 && fake.handlers.size === 0, JSON.stringify({ reg: fake.registered.length, handlers: fake.handlers.size }));
}

console.log('\n=== 汇总 ===');
console.log('检查项 ' + checks + ' 个，失败 ' + failures + ' 个');
if (failures > 0) {
  console.log('自检未通过 ✗');
  process.exitCode = 1;
} else {
  console.log('自检全部通过 ✓（落盘证据见 ' + outDir + '）');
}
