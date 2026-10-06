/**
 * 鲸察 (dsh-jingcha) · 纯逻辑核心（零依赖，可单独测试）
 * ============================================================================
 * 这里只做三件事：
 *   1. 记账：工具调用、agent 状态、模型流式输出、事件循环心跳 → 结构化计数；
 *   2. 判定：把这些事实折算成「正常 / 运行中 / 偏慢 / 出 bug / 疑似卡住」；
 *   3. 出报告：状态快照（JSON）与人读报告（Markdown）。
 *
 * 设计约束：
 *   · 零 import —— 宿主里任何解析失败都不该让监察插件自己变成故障源；
 *   · 任何方法都不抛异常 —— 调用方（宿主事件监听器）只做一次 try/catch 兜底；
 *   · 时间全部来自注入的 now() —— 测试可以用假时钟跑完整场景。
 */

/** 判定状态。 */
export const STATES = Object.freeze({
  ok: 'ok',
  busy: 'busy',
  degraded: 'degraded',
  erroring: 'erroring',
  stalled: 'stalled',
});

/** 状态的中文标签（给人看）。 */
export const STATE_LABELS = Object.freeze({
  ok: '正常（空闲）',
  busy: '运行中（有进展）',
  degraded: '偏慢 / 降级',
  erroring: '出现错误（疑似 bug）',
  stalled: '疑似卡住',
});

/** 判定理由里，哪些属于「卡住」，哪些属于「出 bug」。 */
const STALL_KINDS = new Set(['tool-stall', 'tool-hang', 'no-progress', 'event-loop-blocked']);
const BUG_KINDS = new Set(['error-storm', 'failure-loop', 'agent-error-loop', 'plugin-error']);
/** 带会话身份的理由种类：用了会话过滤（snapshot/verdict 的 sessionId）时，只有这些理由算「这个会话的」。 */
const SESSION_SCOPED_KINDS = new Set(['tool-stall', 'tool-hang', 'tool-slow', 'no-progress', 'progress-slow']);

/** 分类：tool 调用里常见的失败代码 → 粗粒度类别。 */
export function classifyError(code, message) {
  const s = (String(code ?? '') + ' ' + String(message ?? '')).toLowerCase();
  if (/timed?\s*out|timeout|etimedout/.test(s)) return 'timeout';
  if (/abort|cancel|interrupt/.test(s)) return 'aborted';
  if (/sandbox|denied|eperm|eacces|access is denied|拒绝访问|权限/.test(s)) return 'denied';
  if (/unknown.?tool|not found|enoent/.test(s)) return 'not-found';
  if (/argument|args|schema|validation|invalid/.test(s)) return 'invalid-args';
  if (/output|contract|violat/.test(s)) return 'output-contract';
  if (/econn|enotfound|socket|network|fetch failed|dns|tls|proxy/.test(s)) return 'network';
  if (/approval|审批/.test(s)) return 'approval';
  return 'other';
}

/** 把毫秒格式化成 1.2s / 3m05s / 1h02m 这种好读的样子。 */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return n.toFixed(0) + 'ms';
  if (n < 60_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + 's';
  const totalSec = Math.floor(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return h + 'h' + String(m).padStart(2, '0') + 'm';
  return m + 'm' + String(s).padStart(2, '0') + 's';
}

const MAX_PREVIEW = 120;

/** memoryLeakWindow 夹紧到 [2,120]：配置写多大都不会让采样数组无界增长（安全审查 M2）。 */
function clampLeakWindow(value) {
  const n = Math.floor(Number(value ?? 5));
  return Math.min(120, Math.max(2, Number.isFinite(n) && n > 0 ? n : 2));
}

/** 把敏感片段打码（token/secret/password=... 之类）。规则来自配置，编不过就忽略。 */
const REDACT_CACHE = new Map();      // source -> RegExp|null（编译一次，避免事件热路径反复 new RegExp；安全审查 L4）
const REDACT_CACHE_MAX = 64;

function compiledRedact(raw) {
  const source = String(raw).replace(/^\(\?i\)/, '');
  if (REDACT_CACHE.has(source)) return REDACT_CACHE.get(source);
  let compiled = null;
  try { compiled = new RegExp(source, 'gi'); } catch { compiled = null; }
  if (REDACT_CACHE.size >= REDACT_CACHE_MAX) REDACT_CACHE.clear();
  REDACT_CACHE.set(source, compiled);
  return compiled;
}

export function redactText(text, patterns) {
  let out = String(text === undefined || text === null ? '' : text);
  if (!Array.isArray(patterns)) return out;
  for (const raw of patterns) {
    const compiled = compiledRedact(raw);
    if (!compiled) continue;
    compiled.lastIndex = 0;                 // 带 g 的正则复用前要归零
    out = out.replace(compiled, '[已脱敏]');
  }
  return out;
}

/** 取参数里最能说明「这一调用在干什么」的一小段文本。 */
export function previewArgs(args) {
  if (args === null || args === undefined) return '';
  if (typeof args !== 'object') return clip(String(args), MAX_PREVIEW);
  const preferred = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'target', 'id', 'action', 'message', 'content', 'description'];
  const parts = [];
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined) {
      parts.push(key + '=' + clip(stringifyShallow(args[key]), 80));
      if (parts.length >= 3) break;
    }
  }
  if (parts.length === 0) {
    const keys = Object.keys(args);
    for (const key of keys.slice(0, 3)) parts.push(key + '=' + clip(stringifyShallow(args[key]), 60));
  }
  return clip(parts.join(' '), MAX_PREVIEW);
}

function stringifyShallow(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '[' + value.length + ' items]';
  if (typeof value === 'object') return '{' + Object.keys(value).slice(0, 4).join(',') + '}';
  return String(value);
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * 粗估一个值的 JSON 体积（字节）——不做完整 JSON.stringify：
 * 大参数（write 的内容、run_code 的程序）可能有几 MB，逐字节序列化会拖慢热路径。
 * 只走前两层，字符串按长度算，超出预算就收敛。
 */
export function measureValue(value, budget = 4000) {
  let total = 0;
  const stack = [{ node: value, depth: 0 }];
  let work = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (++work > 400) return total + 64;
    if (node === null || node === undefined) { total += 4; continue; }
    const type = typeof node;
    if (type === 'string') { total += node.length + 2; if (total >= budget) return total; continue; }
    if (type === 'number' || type === 'boolean') { total += 8; continue; }
    if (depth >= 2) { total += 24; continue; }
    if (Array.isArray(node)) {
      total += 2;
      for (let i = 0; i < node.length && i < 8; i++) stack.push({ node: node[i], depth: depth + 1 });
      if (node.length > 8) total += (node.length - 8) * 24;
      continue;
    }
    if (type === 'object') {
      total += 2;
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length && i < 12; i++) stack.push({ node: node[keys[i]], depth: depth + 1 });
      if (keys.length > 12) total += (keys.length - 12) * 24;
      continue;
    }
    total += 8;
    if (total >= budget) return total;
  }
  return total;
}

/** 人类可读的字节量（把 RSS 讲清楚：12.3MB / 1.4GB）。 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return (value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)) + units[unit];
}

/** 默认阈值：都能在 profile 的 patch 里按需改。 */
export const DEFAULTS = Object.freeze({
  /** 心跳周期：也是事件循环延迟的采样周期。 */
  heartbeatMs: 1000,
  /** status.json 的重写间隔（状态变化会立即写）。 */
  statusEveryMs: 5000,
  /** 在途调用的「进度心跳」间隔：长调用期间持续往事件流写 tool.progress，别等到 2 分钟才有一条。 */
  progressEveryMs: 30_000,
  /** 是否把工具参数摘要写进事件流/快照（关掉就只记字节数）。 */
  previewArgs: true,
  /** 摘要是否按下面的规则打码（含密钥/口令的命令行会被替换成 [已脱敏]）。 */
  redactPreviews: true,
  /** 脱敏正则（大小写不敏感；写错会被忽略）。注意 events.jsonl 属于敏感文件。 */
  redactPatterns: Object.freeze([
    '(token|secret|password|passwd|authorization|api[_-]?key|cookie)\\s*[=:]\\s*\\S+',
    '(?i)bearer\\s+[A-Za-z0-9._\\-]+',
    // 空格分隔的凭据：--password hunter2 / -p s3cret / token abc123（安全审查 M1）
    '(^|\\s)-{0,2}(p|pw|pass|password|passwd|pwd|token|secret|api[_-]?key|key|sig)\\s+\\S+',
    // 带引号或裸露的键：\"password\":\"x\"、pwd=x、sig:abc、cookie=…（安全审查 M1）
    '"?\\b(token|secret|password|passwd|pwd|key|sig|authorization|cookie)\\b"?\\s*[=:]\\s*\\S+',
  ]),
  /** 控制台「仍在跑」提示的最小间隔（0 = 不打）。 */
  consoleProgressMs: 60_000,
  /** 自动强制停止：在途调用超过它就掐断（0 = 关闭，默认关闭；建议 300000 起）。 */
  autoKillAfterMs: 0,
  /** 状态变化时是否往宿主控制台打一行。 */
  console: true,
  /** 显示名（写进报告标题与控制台前缀）。 */
  displayName: '鲸察',
  /** 数据目录；null = 由宿主接线层决定（默认 $DSH_HOME/data/dsh-jingcha）。 */
  dataDir: null,
  /** 是否注册查询工具 jingcha_status。 */
  toolEnabled: false,
  /** 单次调用超过它就记为「慢」。 */
  slowCallMs: 30_000,
  /** 在途调用超过它就记为「挂起（hang）」。 */
  hangCallMs: 120_000,
  /** 在途调用超过它就升级为「卡住（stall）」。 */
  stuckCallMs: 300_000,
  /** 有人干活但这么久没有任何活动 → 「没有输出」。 */
  silenceMs: 90_000,
  /** 事件循环延迟告警 / 卡死阈值。 */
  lagWarnMs: 500,
  lagStuckMs: 5_000,
  /** 等审批超过它就该提示「在等用户点确认」。 */
  approvalWarnMs: 20_000,
  /** 同一工具在窗口内失败这么多次 → 「错误风暴」。 */
  errorStormCount: 3,
  errorStormWindowMs: 120_000,
  /** 成功但结果小于这个字节数 → 记「空结果」（0 表示关闭该检测）。 */
  emptyResultBytes: 0,
  /** 内存（RSS）告警阈值。 */
  rssWarnBytes: 2_500_000_000,
  /** 「内存泄漏预警」：RSS 连续这么多个心跳周期递增才算（需要 window+1 个采样点）。 */
  memoryLeakWindow: 5,
  /** 「内存泄漏预警」：窗口内首尾增幅超过这个比例才算（0.1 = 10%）。 */
  memoryLeakGrowth: 0.1,
  /** 保留多少条最近的调用 / 告警。 */
  recentCalls: 60,
  recentFindings: 60,
  /** 报告默认统计窗口。 */
  reportWindowMs: 30 * 60_000,
  /** 日志文件轮转阈值（字节），由 sink 使用。 */
  maxLogBytes: 8_000_000,
  /** 判定规则：这些规则 id 不参与判定（内置 8 条见 core.js 的 BUILTIN_RULES；第三方规则走 registerRule）。 */
  disabledRules: Object.freeze([]),
});

// ── 判定规则契约（第三方可注册自己的规则，见 docs/EXTENDING.md 第 1 节） ──────────
//
// 一条规则 = { id, title?, source?, escalate?, evaluate(ctx) }：
//   · id       规则标识（出现在 reason.kind 与事件流里；正则 ^[a-z0-9][a-z0-9._-]{0,63}$）
//   · evaluate 纯函数：读 ctx（事实视图）→ 返回一个理由、一组理由，或 null
//   · escalate 'stall' 让判定升到「卡住」、'bug' 升到「出错」、null 表示这条规则永远只影响「降级」
//              不写的话：第三方规则给的 critical 理由默认按 'bug' 处理，内置规则按 kind 归类
//
// 理由至少要有 severity（warn/high/critical）与 text；kind 不写就取规则 id。
// 规则抛错不会影响判定：只记账 + 进事件流（见 core 的 noteRuleFailure）。

/** 规则 id 的合法形态：小写字母数字开头，可含 . _ -，最长 64。 */
export const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const RULE_SEVERITIES = new Set(['info', 'warn', 'high', 'critical']);

/** 把外部传进来的规则规范化；不合契约就返回 null（调用方负责拒绝）。 */
export function normalizeRule(raw, source = 'custom') {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!RULE_ID_PATTERN.test(id)) return null;
  if (typeof raw.evaluate !== 'function') return null;
  const escalate = (raw.escalate === 'stall' || raw.escalate === 'bug') ? raw.escalate : (raw.escalate === null ? null : undefined);
  return {
    id,
    title: String(raw.title ?? id).slice(0, 80),
    source: String(raw.source ?? source).slice(0, 32),
    escalate,
    evaluate: raw.evaluate,
  };
}

/** 把规则吐出来的理由规范化：补 kind/severity/text，解析升级语义；不认识的东西直接丢掉。 */
export function normalizeReason(raw, rule) {
  if (!raw || typeof raw !== 'object') return null;
  const severity = RULE_SEVERITIES.has(raw.severity) ? raw.severity : 'warn';
  const reason = { ...raw, kind: String(raw.kind ?? rule.id), severity };
  if (typeof reason.text !== 'string') reason.text = rule.title;
  let escalate;
  if (raw.escalate === 'stall' || raw.escalate === 'bug') escalate = raw.escalate;
  else if (rule.escalate === 'stall' || rule.escalate === 'bug') escalate = rule.escalate;
  else if (rule.escalate === null) escalate = null;                                            // 规则显式声明「我不改状态」
  else if (rule.source !== 'builtin' && severity === 'critical') escalate = 'bug';             // 第三方 critical 默认算 bug
  if (escalate) reason.escalate = escalate; else delete reason.escalate;
  return reason;
}

/**
 * 造一个监察核心。
 * @param {object} config 覆盖 {@link DEFAULTS} 的阈值。
 * @param {() => number} now 取当前时间的函数（测试注入假时钟）。
 */
export function createMonitor(config = {}, now = () => Date.now()) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  const startedAt = now();

  const calls = new Map();          // callId -> 记录（含已完成，环形裁剪）
  const inflight = new Map();       // callId -> 记录（未结束）
  const stats = new Map();          // 工具名 -> 统计
  const agents = new Map();         // agentKey -> 状态
  const errWindow = [];             // { at, tool, category }
  const errorEvents = [];           // { at, source, message }
  const findings = [];              // { at, kind, severity, text, tool? }
  const events = [];                // 待落盘的结构化事件
  const hangNotified = new Map();   // callId -> 上次提示的时刻
  const progressNotified = new Map(); // callId -> 上次写 tool.progress 的时刻
  let lastJobs = new Map();           // jobId -> status（用来 diff 出 job.start/status/end）

  const activity = {
    lastAnyAt: startedAt,
    lastSource: 'startup',
    lastToolAt: 0,
    lastStreamAt: 0,
    lastSessionAt: 0,
    lastAgentAt: 0,
  };

  const counters = {
    toolStarts: 0, toolCalls: 0, toolOk: 0, toolErrors: 0, toolTimeouts: 0,
    toolAborted: 0, toolDenied: 0, nestedCalls: 0, emptyResults: 0,
    resultBytes: 0, streamChunks: 0, streamBytes: 0, sessionEvents: 0,
    subagentStarts: 0, subagentEnds: 0, approvals: 0, approvalWaits: 0,
    pluginErrors: 0, logDrops: 0, turns: 0, requestRetries: 0, turnsFailed: 0,
  };

  const extras = new Map();          // 宿主接线层补充的外部事实（如 jobs 运行时）
  const lag = { lastMs: 0, lastRawMs: 0, maxMs: 0, samples: 0, lastAt: startedAt, overWarn: 0, suspended: 0 };
  let lastTickAt = startedAt;
  let verdictCache = { state: 'ok', label: STATE_LABELS.ok, reasons: [], at: startedAt, since: startedAt };

  // ── 内部小工具 ───────────────────────────────────────────────────────────

  function touch(source) {
    activity.lastAnyAt = now();
    activity.lastSource = source;
  }

  function pushEvent(kind, data) {
    // kind 放最后：payload 里若也有 kind 字段（例如 job 的 kind），不许覆盖事件信封
    if (events.length < 4000) events.push({ ts: now(), ...data, kind });
    else counters.logDrops++;
  }

  function addFinding(kind, severity, text, extra = {}) {
    const entry = { at: now(), kind, severity, text, ...extra };
    findings.push(entry);
    if (findings.length > cfg.recentFindings) findings.splice(0, findings.length - cfg.recentFindings);
    pushEvent('finding', { finding: kind, severity, text, ...extra });
    return entry;
  }

  function statFor(name) {
    let st = stats.get(name);
    if (!st) {
      st = {
        name, calls: 0, ok: 0, errors: 0, timeouts: 0, aborted: 0, denied: 0,
        totalMs: 0, maxMs: 0, lastMs: 0, lastAt: 0, lastErrorAt: 0,
        lastError: '', consecutiveErrors: 0, resultBytes: 0, emptyResults: 0,
        stormReported: false,
      };
      stats.set(name, st);
    }
    return st;
  }

  function trim() {
    while (calls.size > cfg.recentCalls) {
      const oldest = calls.keys().next();
      if (oldest.done) break;
      calls.delete(oldest.value);
    }
    const cutoff = now() - Math.max(cfg.errorStormWindowMs * 2, 600_000);
    while (errWindow.length > 0 && errWindow[0].at < cutoff) errWindow.shift();
    while (errorEvents.length > 0 && errorEvents[0].at < cutoff) errorEvents.shift();
  }

  /** 开始一次工具调用（pre-execute 阶段，早于审批等待）。 */
  /** 按配置生成参数摘要：可整个关掉，也可按规则脱敏。 */
  function previewOf(args) {
    if (cfg.previewArgs === false) return '';
    const text = previewArgs(args);
    return cfg.redactPreviews === false ? text : redactText(text, cfg.redactPatterns);
  }

  function toolStart(info = {}) {
    const callId = String(info.callId ?? info.name ?? 'unknown');
    const ts = now();
    const nested = info.nested === true;
    let rec = calls.get(callId);
    if (rec === undefined) {
      rec = {
        callId,
        name: String(info.name ?? 'unknown'),
        sessionId: info.sessionId ? String(info.sessionId) : undefined,
        agentKey: info.agentKey ? String(info.agentKey) : undefined,
        preview: previewOf(info.arguments),
        argsBytes: measureValue(info.arguments),
        startedAt: ts,
        dispatchedAt: 0,
        lastProgressAt: ts,
        phase: info.phase === 'run' ? 'run' : 'pre',
        finishedAt: 0,
        durationMs: 0,
        isError: false,
        errorCode: undefined,
        errorMessage: undefined,
        category: undefined,
        contentBytes: 0,
        contentBlocks: 0,
        declaredTimeoutMs: Number.isFinite(info.timeoutMs) ? info.timeoutMs : undefined,
        nested,
        phase: 'pre',
        finalized: false,
      };
      calls.set(callId, rec);
      hangNotified.delete(callId);
      progressNotified.delete(callId);
      counters.toolStarts++;
      if (nested) counters.nestedCalls++;
    } else if (rec.finalized) {
      // 同一 callId 复用（几乎不该发生）：当成新调用重新计时
      rec.startedAt = ts;
      rec.finishedAt = 0;
      rec.finalized = false;
      rec.isError = false;
      hangNotified.delete(callId);
      counters.toolStarts++;
    }
    // 后到的字段补全（pre-execute 先建记录，execute 才知道声明超时 / 真实 agent）
    if (rec.declaredTimeoutMs === undefined && Number.isFinite(info.timeoutMs)) rec.declaredTimeoutMs = Number(info.timeoutMs);
    if (!rec.preview && info.arguments !== undefined) rec.preview = previewOf(info.arguments);
    if (info.phase === 'run' && rec.phase !== 'run') { rec.phase = 'run'; rec.dispatchedAt = rec.dispatchedAt || ts; }
    if (rec.sessionId === undefined && info.sessionId !== undefined) rec.sessionId = String(info.sessionId);
    if (rec.agentKey === undefined && info.agentKey !== undefined) rec.agentKey = String(info.agentKey);
    if (info.nested === true) rec.nested = true;
    inflight.set(callId, rec);
    touch('tool');
    activity.lastToolAt = ts;
    return rec;
  }

  /** 记录 pre-execute 的裁决（含审批等待时长）。 */
  function toolDecision(info = {}) {
    const callId = String(info.callId ?? 'unknown');
    const rec = calls.get(callId);
    const waitedMs = Number(info.waitedMs ?? 0);
    const kind = String(info.kind ?? '');
    if (kind === 'ask' || info.approval === true) {
      counters.approvals++;
      if (waitedMs >= cfg.approvalWarnMs) {
        counters.approvalWaits++;
        addFinding('approval-wait', 'warn',
          '工具 ' + (info.name ?? rec?.name ?? '?') + ' 等待用户审批 ' + formatDuration(waitedMs) + '（宿主看起来像卡住，其实在等人点确认）',
          { tool: info.name, waitedMs });
      }
      if (rec) rec.approvalWaitedMs = waitedMs;
    } else if (kind === 'deny') {
      if (rec) { rec.denied = true; rec.denyReason = clip(info.reason ?? '', 200); }
      counters.toolDenied++;
      statFor(String(info.name ?? rec?.name ?? 'unknown')).denied++;
      addFinding('tool-denied', 'info',
        '工具 ' + (info.name ?? '?') + ' 被策略拒绝：' + clip(info.reason ?? '', 160),
        { tool: info.name });
    } else if (kind === 'cancel') {
      if (rec) rec.canceled = true;
      counters.toolAborted++;
      statFor(String(info.name ?? rec?.name ?? 'unknown')).aborted++;
    }
    return { waitedMs };
  }

  /** 结束一次工具调用（完成 / 失败 / 结果投影，幂等）。 */
  function toolFinish(info = {}) {
    const callId = String(info.callId ?? '');
    let rec = calls.get(callId);
    const ts = now();
    if (rec === undefined) {
      // 没看到起点就看到了终点：典型是 pre-execute 直接拒绝/取消，或 execute 包装层没跑到。
      rec = toolStart({ ...info, callId, arguments: info.arguments });
    }
    const first = !rec.finalized;
    const isError = info.isError === true;
    const errorCode = info.errorCode !== undefined ? String(info.errorCode) : rec.errorCode;
    const errorMessage = info.errorMessage !== undefined ? String(info.errorMessage) : rec.errorMessage;
    const contentBytes = Number.isFinite(info.contentBytes) ? Number(info.contentBytes) : rec.contentBytes;
    const contentBlocks = Number.isFinite(info.contentBlocks) ? Number(info.contentBlocks) : rec.contentBlocks;

    rec.isError = isError;
    rec.errorCode = errorCode;
    rec.errorMessage = errorMessage;
    rec.contentBytes = contentBytes;
    rec.contentBlocks = contentBlocks;
    rec.finalized = true;
    rec.finishedAt = info.finishedAt ?? ts;
    rec.durationMs = Math.max(0, rec.finishedAt - rec.startedAt);
    rec.category = isError ? classifyError(errorCode, errorMessage) : 'ok';
    if (info.viaResult === true) rec.confirmedByResult = true;
    inflight.delete(callId);
    hangNotified.delete(callId);
    progressNotified.delete(callId);

    if (first) {
      counters.toolCalls++;
      counters.resultBytes += contentBytes;
      const st = statFor(rec.name);
      st.calls++;
      st.lastMs = rec.durationMs;
      st.totalMs += rec.durationMs;
      if (rec.durationMs > st.maxMs) st.maxMs = rec.durationMs;
      st.lastAt = ts;
      st.resultBytes += contentBytes;
      if (isError) {
        counters.toolErrors++;
        st.errors++;
        st.consecutiveErrors++;
        st.lastErrorAt = ts;
        st.lastError = clip((errorCode ? errorCode + ': ' : '') + (errorMessage ?? ''), 200);
        if (rec.category === 'timeout') { st.timeouts++; counters.toolTimeouts++; }
        if (rec.category === 'aborted') { st.aborted++; counters.toolAborted++; }
        errWindow.push({ at: ts, tool: rec.name, category: rec.category });
      } else {
        counters.toolOk++;
        st.ok++;
        st.consecutiveErrors = 0;
        st.stormReported = false;
      }
      if (!isError && cfg.emptyResultBytes > 0 && contentBytes < cfg.emptyResultBytes) {
        counters.emptyResults++;
        st.emptyResults++;
        addFinding('empty-result', 'warn',
          '工具 ' + rec.name + ' 成功但结果几乎为空（' + contentBytes + ' 字节）——可能没读到东西或输出被吞',
          { tool: rec.name, callId, contentBytes });
      }
      if (rec.durationMs >= cfg.slowCallMs) {
        addFinding('tool-slow', 'info',
          '工具 ' + rec.name + ' 用了 ' + formatDuration(rec.durationMs) + '（阈值 ' + formatDuration(cfg.slowCallMs) + '）',
          { tool: rec.name, callId, durationMs: rec.durationMs });
      }
      touch('tool');
      activity.lastToolAt = ts;
      pushEvent('tool.call', {
        callId, tool: rec.name, sessionId: rec.sessionId, agentKey: rec.agentKey,
        durationMs: rec.durationMs, isError, category: rec.category,
        errorCode: rec.errorCode, errorMessage: rec.errorMessage ? clip(rec.errorMessage, 300) : undefined,
        contentBytes, contentBlocks, nested: rec.nested, preview: rec.preview,
        approvalWaitedMs: rec.approvalWaitedMs, declaredTimeoutMs: rec.declaredTimeoutMs,
      });
      // 错误风暴：同一工具在窗口内反复失败 → 更像 bug 而不是慢
      const storm = errWindow.filter((e) => e.tool === rec.name);
      if (isError && storm.length >= cfg.errorStormCount && !st.stormReported) {
        st.stormReported = true;
        const since = ts - storm[0].at;
        addFinding('error-storm', 'critical',
          '工具 ' + rec.name + ' 在 ' + formatDuration(since) + ' 内失败 ' + storm.length + ' 次（最后一次：' +
          clip(rec.errorCode ?? rec.errorMessage ?? '', 60) + '）——像 bug/死循环，不是慢',
          { tool: rec.name, count: storm.length, sinceMs: since });
      }
    }
    trim();
    return rec;
  }

  /** tools/result 观察点：最终结果（可能改写了内容/错误），用于补全或纠正记录。 */
  function toolResult(info = {}) {
    return toolFinish({ ...info, viaResult: true });
  }

  /** 工具体抛异常（next() 拒绝）时调用。 */
  function toolThrow(info = {}) {
    const err = info.error;
    const code = err && typeof err === 'object' ? (err.code ?? err.name) : undefined;
    const message = err instanceof Error ? err.message
      : (err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err ?? ''));
    return toolFinish({ ...info, isError: true, errorCode: code, errorMessage: message });
  }

  /** agent 状态翻转。 */
  function agentStatus(info = {}) {
    const key = String(info.key ?? info.sessionId ?? 'agent');
    const ts = now();
    let a = agents.get(key);
    if (!a) { a = { key, sessionId: info.sessionId, status: 'idle', since: ts, streamChunks: 0, lastStreamAt: 0, errors: 0, turns: 0 }; agents.set(key, a); }
    if (info.sessionId) a.sessionId = String(info.sessionId);
    a.status = info.status === 'running' ? 'running' : 'idle';
    a.since = ts;
    a.lastStatusAt = ts;
    activity.lastAgentAt = ts;
    touch('agent');
    pushEvent('agent.status', { agentKey: key, sessionId: a.sessionId, status: a.status });
    return a;
  }

  /** 模型流式输出（每帧都来，只做计数与时间戳）。 */
  function streamChunk(info = {}) {
    const key = String(info.key ?? info.sessionId ?? 'agent');
    const ts = now();
    let a = agents.get(key);
    if (!a) { a = { key, sessionId: info.sessionId, status: 'running', since: ts, streamChunks: 0, lastStreamAt: 0, errors: 0, turns: 0 }; agents.set(key, a); }
    a.streamChunks++;
    a.lastStreamAt = ts;
    a.lastTurn = info.turn;
    counters.streamChunks++;
    counters.streamBytes += Number(info.bytes) || 0;
    activity.lastStreamAt = ts;
    touch('stream');
    return a;
  }

  /** 会话里落了事件（「还有输出」的最直接证据之一）。 */
  function sessionEvent(info = {}) {
    const ts = now();
    counters.sessionEvents++;
    if (info.type === 'assistant/message' || info.type === 'assistant/attempt') counters.turns++;
    activity.lastSessionAt = ts;
    touch(info.type ? 'session:' + String(info.type) : 'session');
  }

  /**
   * agent 层错误。
   * @param info.escalate false 表示「单次模型请求失败，可能只是要重试」（不升级成 bug 判定）。
   */
  function agentError(info = {}) {
    const ts = now();
    const message = clip(info.message ?? '', 300);
    const escalate = info.escalate !== false;
    errorEvents.push({ at: ts, source: String(info.source ?? 'agent'), message, escalate });
    const key = String(info.key ?? info.sessionId ?? 'agent');
    const a = agents.get(key);
    if (a) a.errors++;
    if (escalate) counters.turnsFailed++;
    else counters.requestRetries++;
    pushEvent('agent.error', { agentKey: key, source: info.source, message, code: info.code, escalate });
    const recent = errorEvents.filter((e) => ts - e.at <= cfg.errorStormWindowMs && e.escalate !== false);
    if (escalate && recent.length >= cfg.errorStormCount) {
      const lastFinding = findings[findings.length - 1];
      if (!lastFinding || lastFinding.kind !== 'agent-error-loop' || ts - lastFinding.at > 15_000) {
        addFinding('agent-error-loop', 'critical',
          '模型/会话层在 ' + formatDuration(cfg.errorStormWindowMs) + ' 内报了 ' + recent.length + ' 次错误（最后：' + message + '）',
          { count: recent.length });
      }
    } else if (escalate) {
      addFinding('agent-error', 'warn', 'agent 报错：' + message, { code: info.code });
    } else {
      addFinding('agent-request-retry', 'info', '模型请求失败（将按策略重试）：' + message, { code: info.code });
    }
    return { at: ts };
  }

  /** 由接线层补充的外部事实（任何 JSON 值）。 */
  function setExtra(key, value) {
    extras.set(String(key), value);
    return value;
  }

  /** 子智能体起止。 */
  function subagent(info = {}) {
    if (info.phase === 'start') { counters.subagentStarts++; pushEvent('subagent.start', { id: info.id, label: info.label }); }
    else { counters.subagentEnds++; pushEvent('subagent.end', { id: info.id, status: info.status }); }
    touch('subagent');
  }

  /** 插件自身出错（尽力而为地记，绝不外抛）。 */
  function pluginError(info = {}) {
    counters.pluginErrors++;
    pushEvent('plugin.error', { where: String(info.where ?? ''), message: clip(info.message ?? '', 300) });
    const lastFinding = findings[findings.length - 1];
    if (!lastFinding || lastFinding.kind !== 'plugin-error' || now() - lastFinding.at > 30_000) {
      addFinding('plugin-error', 'critical', '监察插件内部出错（' + String(info.where ?? '') + '）：' + clip(info.message ?? '', 200));
    }
  }

  /** 超过它就认为「不是被占住，而是宿主本身被挂起/休眠」（默认 30s 或 10 个心跳）。 */
  function suspendThreshold() {
    return Math.max(30_000, Number(cfg.heartbeatMs ?? 1000) * 10);
  }

  /** 事件循环延迟采样。 */
  function noteLag(ms) {
    const raw = Math.max(0, Number(ms) || 0);
    lag.samples++;
    lag.lastAt = now();
    lag.lastRawMs = raw;
    if (raw > lag.maxMs) lag.maxMs = raw;
    let value = raw;
    if (raw >= suspendThreshold()) {
      // 宿主被挂起/休眠，或一个超长同步任务：记 warn，不据此判定「卡住」
      lag.suspended++;
      addFinding('host-suspend', 'warn',
        '事件循环有 ' + formatDuration(raw) + ' 没有响应（宿主被挂起/休眠，或存在超长同步任务）', { lagMs: raw });
      pushEvent('loop.suspend', { lagMs: raw });
      value = cfg.lagWarnMs;
    } else if (raw >= cfg.lagStuckMs) {
      addFinding('event-loop-blocked', 'critical', '事件循环被阻塞 ' + formatDuration(raw) + '——宿主此刻无法响应任何事件', { lagMs: raw });
      pushEvent('loop.lag', { lagMs: raw, blocked: true });
    } else if (raw >= cfg.lagWarnMs) {
      const lastFinding = findings[findings.length - 1];
      const quiet = !lastFinding || lastFinding.kind !== 'event-loop-lag' || now() - lastFinding.at > 30_000;
      if (quiet) {
        addFinding('event-loop-lag', 'warn', '事件循环延迟 ' + formatDuration(raw) + '（阈值 ' + formatDuration(cfg.lagWarnMs) + '）——有同步重活把主线程占住了', { lagMs: raw });
      }
    }
    if (raw >= cfg.lagWarnMs) lag.overWarn++;
    lag.lastMs = value;
    return value;
  }

  /** 在途调用的进度心跳 + 卡住提示（带升级与去抖）。 */
  function checkInflight(nowMs) {
    for (const rec of inflight.values()) {
      const elapsed = nowMs - rec.startedAt;
      // 进度心跳：让「正在跑」在事件流里持续可见，而不是只有开始与结束两条
      const lastTick = progressNotified.get(rec.callId) ?? 0;
      if (nowMs - lastTick >= Number(cfg.progressEveryMs ?? 30_000)) {
        progressNotified.set(rec.callId, nowMs);
        rec.lastProgressAt = nowMs;   // 有产出就刷新：用来区分「卡住」和「慢但在出活」
        pushEvent('tool.progress', {
          callId: rec.callId, tool: rec.name, sessionId: rec.sessionId,
          elapsedMs: elapsed, slow: elapsed >= cfg.slowCallMs, preview: rec.preview,
        });
      }
      if (elapsed < cfg.hangCallMs) continue;
      const severity = elapsed >= cfg.stuckCallMs ? 'critical' : 'warn';
      const previous = hangNotified.get(rec.callId);
      const step = severity === 'critical' ? cfg.stuckCallMs : cfg.hangCallMs;
      // 升级（warn -> critical）要立刻再报一次，同级才按步长去抖
      if (previous && previous.severity === severity && nowMs - previous.at < Math.max(30_000, step)) continue;
      hangNotified.set(rec.callId, { at: nowMs, severity });
      const hint = hintFor(rec);
      addFinding(severity === 'critical' ? 'tool-stall' : 'tool-hang', severity,
        '工具 ' + rec.name + ' 已运行 ' + formatDuration(elapsed) + ' 仍未返回' +
        (rec.declaredTimeoutMs !== undefined ? '（该工具声明上限 ' + formatDuration(rec.declaredTimeoutMs) + '）' : '') +
        (hint ? '：' + hint : ''),
        { tool: rec.name, callId: rec.callId, elapsedMs: elapsed, preview: rec.preview });
      pushEvent('tool.' + (severity === 'critical' ? 'stall' : 'hang'), {
        callId: rec.callId, tool: rec.name, elapsedMs: elapsed, preview: rec.preview, hint,
      });
    }
  }

  /** 所有在途调用（轻量：只给接线层做判定用）。 */
  function inflightList(nowMs = now()) {
    const out = [];
    for (const rec of inflight.values()) {
      out.push({
        callId: rec.callId, name: rec.name, sessionId: rec.sessionId,
        elapsedMs: Math.max(0, nowMs - rec.startedAt), preview: rec.preview, nested: rec.nested,
        phase: rec.phase === 'run' ? 'run' : 'pre',
        silentMs: Math.max(0, nowMs - (rec.lastProgressAt || rec.startedAt)),
      });
    }
    return out;
  }

  /** 给接线层用：跑得够久（>= slowCallMs）的在途调用。 */
  function longRunning(nowMs = now()) {
    return inflightList(nowMs).filter((rec) => rec.elapsedMs >= cfg.slowCallMs);
  }

  /**
   * 记录一次「强制停止」动作（人为或自动）。这不是插件故障，所以只写 info 级 finding + 事件。
   * @param info.callId / info.tool / info.scope / info.reason / info.agents / info.ok
   */
  function noteKill(info = {}) {
    const ok = info.ok !== false;
    pushEvent(ok ? 'kill.done' : 'kill.failed', {
      callId: info.callId, tool: info.tool, scope: info.scope,
      reason: clip(info.reason ?? '', 200), agents: info.agents,
    });
    // 停后取证卡：把这次被掐掉的调用「长什么样」留下来（参数摘要 / 耗时 / 多久没输出 / 声明超时）。
    // 只记我们本来就有的东西——不额外去读模型上下文，也不落任何新数据。
    if (ok && info.callId && !info.scope) {
      const rec = inflight.get(String(info.callId)) || calls.get(String(info.callId)) || null;
      if (rec) {
        const elapsedMs = Math.max(0, now() - rec.startedAt);
        pushEvent('kill.forensics', {
          callId: rec.callId, tool: rec.name, sessionId: rec.sessionId, nested: rec.nested,
          elapsedMs, silentMs: Math.max(0, now() - (rec.lastProgressAt || rec.startedAt)),
          declaredTimeoutMs: rec.declaredTimeoutMs, preview: rec.preview,
          phase: rec.phase === 'run' ? 'run' : 'pre', reason: clip(info.reason ?? '', 200),
        });
      }
    }
    const what = info.scope ? '（范围 ' + info.scope + '）' : (info.tool || info.callId || '');
    addFinding('kill', 'info', (ok ? '已强制停止 ' : '强制停止失败 ') + what + (info.reason ? '：' + clip(info.reason, 80) : ''),
      { callId: info.callId, tool: info.tool, scope: info.scope });
    touch('kill');
    return { at: now() };
  }

  /**
   * 后台 job 快照：与上一轮 diff，产出 job.start / job.status / job.end，
   * 并把明细（含已运行时长）写进 extras.jobs —— 这样 run_in_background 的长活也能在运行时被看见。
   */
  function noteJobs(list, nowMs = now()) {
    const seen = new Map();
    const items = [];
    for (const job of Array.isArray(list) ? list : []) {
      if (!job) continue;
      const id = String(job.id ?? job.jobId ?? '?');
      const status = String(job.status ?? '?');
      const startedAt = Number(job.startedAt ?? 0);
      const finishedAt = Number(job.finishedAt ?? 0);
      items.push({
        id, kind: job.kind, label: clip(job.label ?? job.detail ?? '', 80), status,
        elapsedMs: startedAt > 0 ? Math.max(0, (finishedAt > 0 ? finishedAt : nowMs) - startedAt) : undefined,
      });
      seen.set(id, status);
      if (!lastJobs.has(id)) pushEvent('job.start', { id, jobKind: job.kind, label: clip(job.label ?? '', 80), status });
      else if (lastJobs.get(id) !== status) pushEvent('job.status', { id, from: lastJobs.get(id), to: status });
    }
    for (const [id, status] of lastJobs) if (!seen.has(id)) pushEvent('job.end', { id, status });
    lastJobs = seen;
    const running = items.filter((job) => job.status === 'running' || job.status === 'stopping').length;
    extras.set('jobs', { total: items.length, running, items: items.slice(0, 10) });
    return items;
  }

  function hintFor(rec) {
    const name = String(rec.name).toLowerCase();
    if (name === 'pwsh' || name === 'bash' || name === 'shell') return '子进程可能没退出，或命令在等输入/网络';
    if (name === 'run_code') return '脚本里可能有同步死循环或未释放的等待';
    if (name === 'web_fetch' || name === 'web_search') return '网络请求挂住（DNS/代理/对端不响应）';
    if (name === 'subagent' || name === 'subagent_fork' || name === 'workflow') return '子智能体还在跑（看 subagent/agent 状态）';
    if (name === 'read' || name === 'write' || name === 'edit' || name === 'glob' || name === 'grep') return '文件系统调用异常缓慢（磁盘/杀软/网络盘）';
    if (rec.approvalWaitedMs === undefined) return '也可能在等用户审批';
    return '';
  }

  /** 心跳：算延迟、推进判定、返回新判定。 */
  function tick(nowMs = now()) {
    const expected = lastTickAt + Number(cfg.heartbeatMs ?? 1000);
    const lagMs = Math.max(0, nowMs - expected);
    lastTickAt = nowMs;
    noteLag(lagMs);
    checkInflight(nowMs);
    trim();
    const v = verdict(nowMs);
    if (v.state !== verdictCache.state) {
      pushEvent('state.change', { from: verdictCache.state, to: v.state, reasons: v.reasons.map((r) => r.kind) });
      verdictCache = { ...v, since: nowMs };
    } else {
      verdictCache = { ...v, since: verdictCache.since };
    }
    return verdictCache;
  }

  // ── 判定规则表：判定 = 按顺序跑一遍规则、收集理由 ─────────────────────────────
  // 内置 8 条只是规则表的前 8 项；第三方可以用 registerRule() 追加（见 docs/EXTENDING.md）。
  const BUILTIN_RULES = [
    {
      id: 'inflight-calls', title: '在途调用时长', source: 'builtin',
      evaluate(ctx) {
        const out = [];
        for (const rec of ctx.inflight) {
          if (rec.elapsedMs >= ctx.cfg.stuckCallMs) {
            out.push({ kind: 'tool-stall', severity: 'critical', tool: rec.tool, callId: rec.callId, elapsedMs: rec.elapsedMs,
              text: '工具 ' + rec.tool + ' 卡住 ' + formatDuration(rec.elapsedMs) });
          } else if (rec.elapsedMs >= ctx.cfg.hangCallMs) {
            out.push({ kind: 'tool-hang', severity: 'high', tool: rec.tool, callId: rec.callId, elapsedMs: rec.elapsedMs,
              text: '工具 ' + rec.tool + ' 挂起 ' + formatDuration(rec.elapsedMs) });
          } else if (rec.elapsedMs >= ctx.cfg.slowCallMs) {
            out.push({ kind: 'tool-slow', severity: 'warn', tool: rec.tool, callId: rec.callId, elapsedMs: rec.elapsedMs,
              text: '工具 ' + rec.tool + ' 偏慢 ' + formatDuration(rec.elapsedMs) });
          }
        }
        return out;
      },
    },
    {
      // 只认新鲜的延迟采样：心跳停了（宿主被挂起、插件被卸载）就不该继续拿旧值判「卡住」
      id: 'event-loop', title: '事件循环延迟', source: 'builtin',
      evaluate(ctx) {
        const ms = ctx.lag.effectiveMs;
        if (ms >= ctx.cfg.lagStuckMs) return { kind: 'event-loop-blocked', severity: 'critical', text: '事件循环阻塞 ' + formatDuration(ms) };
        if (ms >= ctx.cfg.lagWarnMs) return { kind: 'event-loop-lag', severity: 'warn', text: '事件循环延迟 ' + formatDuration(ms) };
        return null;
      },
    },
    {
      // 内存泄漏预警：RSS 连续递增且增幅超阈值（默认 5 个心跳 / 10%）
      id: 'memory-leak', title: '内存泄漏预警', source: 'builtin',
      evaluate(ctx) {
        const leak = ctx.memoryLeak;
        if (!leak.active) return null;
        return {
          kind: 'memory-leak', severity: 'warn',
          fromRssBytes: leak.fromRss, rssBytes: leak.toRss,
          growth: leak.growth, window: leak.window, threshold: leak.threshold,
          text: 'RSS 连续 ' + leak.window + ' 个心跳递增：' + formatBytes(leak.fromRss) + ' → ' + formatBytes(leak.toRss) +
            '（+' + Math.round(leak.growth * 100) + '%，阈值 ' + Math.round(leak.threshold * 100) + '%）',
        };
      },
    },
    {
      id: 'no-progress', title: '没有输出', source: 'builtin',
      evaluate(ctx) {
        if (ctx.runningAgents <= 0) return null;
        if (ctx.idleMs >= ctx.cfg.silenceMs) {
          return { kind: 'no-progress', severity: 'critical', text: ctx.runningAgents + ' 个 agent 在跑，但已经 ' + formatDuration(ctx.idleMs) + ' 没有任何输出' };
        }
        if (ctx.idleMs >= Math.max(ctx.cfg.slowCallMs, ctx.cfg.silenceMs * 0.5)) {
          return { kind: 'progress-slow', severity: 'warn', text: '已 ' + formatDuration(ctx.idleMs) + ' 没有新输出（来源：' + ctx.activity.lastSource + '）' };
        }
        return null;
      },
    },
    {
      id: 'error-storm', title: '同一工具错误风暴', source: 'builtin',
      evaluate(ctx) {
        const byTool = new Map();
        for (const e of ctx.errWindow) {
          if (ctx.nowMs - e.at > ctx.cfg.errorStormWindowMs) continue;
          byTool.set(e.tool, (byTool.get(e.tool) ?? 0) + 1);
        }
        const out = [];
        for (const [tool, count] of byTool) {
          if (count >= ctx.cfg.errorStormCount) {
            out.push({ kind: 'error-storm', severity: 'critical', tool, count, text: '工具 ' + tool + ' 同一窗口内失败 ' + count + ' 次' });
          }
        }
        return out;
      },
    },
    {
      id: 'failure-loop', title: '工具连续失败', source: 'builtin',
      evaluate(ctx) {
        const out = [];
        for (const st of ctx.stats) {
          if (st.consecutiveErrors >= ctx.cfg.errorStormCount) {
            out.push({ kind: 'failure-loop', severity: 'high', tool: st.name, count: st.consecutiveErrors, text: '工具 ' + st.name + ' 连续失败 ' + st.consecutiveErrors + ' 次' });
          }
        }
        return out;
      },
    },
    {
      id: 'agent-error-loop', title: '模型/会话层错误', source: 'builtin',
      evaluate(ctx) {
        const recent = ctx.errorEvents.filter((e) => ctx.nowMs - e.at <= ctx.cfg.errorStormWindowMs);
        if (recent.length < ctx.cfg.errorStormCount) return null;
        return { kind: 'agent-error-loop', severity: 'critical', count: recent.length, text: '模型/会话层错误 ' + recent.length + ' 次' };
      },
    },
    {
      // 监察自身出错也要能被看见：最近 10 分钟内出现过 plugin-error，就升级成 bug 级理由
      id: 'plugin-error', title: '监察自身出错', source: 'builtin',
      evaluate(ctx) {
        let last = null;
        for (let i = ctx.findings.length - 1; i >= 0; i--) { if (ctx.findings[i].kind === 'plugin-error') { last = ctx.findings[i]; break; } }
        if (!last || ctx.nowMs - last.at > 600_000) return null;
        return { kind: 'plugin-error', severity: 'critical', text: '监察插件自身出错 ' + ctx.counters.pluginErrors + ' 次（最近：' + clip(last.text, 90) + '）' };
      },
    },
  ];

  const customRules = new Map();     // id -> 第三方注册的规则
  const ruleFailures = new Map();    // id -> { count, reportedAt }
  const disabledRules = new Set();
  for (const id of (Array.isArray(cfg.disabledRules) ? cfg.disabledRules : [])) disabledRules.add(String(id));

  function allRules() { return [...BUILTIN_RULES, ...customRules.values()]; }

  /**
   * 交给规则的事实视图：规则只读这里，绝不碰核心内部状态。
   * scope.sessionId 非空时只保留**带会话身份**的事实（在途调用 / agent）；
   * 宿主级事实（事件循环延迟、内存、错误风暴、插件自身）永远全局可见 —— 它们本来就不属于某个会话。
   */
  function ruleContext(nowMs, scope = null) {
    const only = scope && scope.sessionId ? String(scope.sessionId) : null;
    const match = (id) => !only || String(id ?? '') === only;
    const inflightView = [];
    let oldest = null;
    for (const rec of inflight.values()) {
      if (!match(rec.sessionId)) continue;
      const elapsed = nowMs - rec.startedAt;
      inflightView.push({
        callId: rec.callId, tool: rec.name, sessionId: rec.sessionId, startedAt: rec.startedAt,
        elapsedMs: elapsed, preview: rec.preview, declaredTimeoutMs: rec.declaredTimeoutMs,
      });
      if (!oldest || elapsed > oldest.elapsedMs) oldest = { tool: rec.name, callId: rec.callId, elapsedMs: elapsed };
    }
    const agentsView = [];
    let runningAgents = 0;
    for (const a of agents.values()) {
      if (!match(a.sessionId)) continue;
      agentsView.push(a);
      if (a.status === 'running') runningAgents++;
    }
    const lagFresh = nowMs - lag.lastAt <= Math.max(3000, Number(cfg.heartbeatMs ?? 1000) * 3);
    return {
      nowMs, cfg, states: STATES,
      inflight: inflightView, oldestCall: oldest, runningAgents, agents: agentsView,
      lag: {
        effectiveMs: lagFresh ? lag.lastMs : 0, lastMs: lag.lastMs, rawMs: lag.lastRawMs,
        maxMs: lag.maxMs, samples: lag.samples, fresh: lagFresh,
      },
      memoryLeak: { ...memoryLeak }, memorySamples: memorySamples.length,
      // 过滤到某个会话时，「多久没输出了」必须按这个会话自己的事实算，否则会被别的会话刷新的全局时间盖掉
      idleMs: only ? sessionIdleMs(inflightView, agentsView, nowMs) : nowMs - activity.lastAnyAt,
      activity: { ...activity },
      errWindow: errWindow.slice(), stats: [...stats.values()], errorEvents: errorEvents.slice(),
      findings: findings.slice(), counters: { ...counters },
      helpers: { formatDuration, formatBytes, clip, previewArgs, measureValue },
    };
  }

  /** 某个会话「最后一次有动静」到现在多久（没有事实就当 0，不冤枉它）。 */
  function sessionIdleMs(inflightView, agentsView, nowMs) {
    let lastAt = 0;
    for (const a of agentsView) if (a.lastStreamAt) lastAt = Math.max(lastAt, a.lastStreamAt);
    for (const rec of inflightView) lastAt = Math.max(lastAt, rec.startedAt);
    return lastAt > 0 ? Math.max(0, nowMs - lastAt) : 0;
  }

  /**
   * 注册一条判定规则（第三方扩展点）。契约不合返回 null；id 重复默认拒绝（options.replace === true 才覆盖）。
   * @returns {null | (() => void)} 成功时返回取消注册的函数。
   */
  function registerRule(raw, options = {}) {
    const rule = normalizeRule(raw, options && options.source ? String(options.source) : 'custom');
    if (!rule) return null;
    const existed = customRules.has(rule.id);
    if (existed && options.replace !== true) return null;
    customRules.set(rule.id, rule);
    pushEvent('rule.register', { id: rule.id, title: rule.title, replace: existed });
    return () => { if (customRules.get(rule.id) === rule) customRules.delete(rule.id); };
  }

  /** 注销一条第三方规则。 */
  function unregisterRule(id) {
    const key = String(id ?? '');
    const removed = customRules.delete(key);
    if (removed) pushEvent('rule.unregister', { id: key });
    return removed;
  }

  /** 运行期开关一条规则。规则不存在返回 false。 */
  function setRuleEnabled(id, enabled) {
    const key = String(id ?? '');
    if (!allRules().some((r) => r.id === key)) return false;
    if (enabled) disabledRules.delete(key); else disabledRules.add(key);
    pushEvent('rule.toggle', { id: key, enabled: Boolean(enabled) });
    return true;
  }

  /** 规则清单（含来源、开关、升级语义、失败次数）——给工具/报告/测试用。 */
  function listRules() {
    return allRules().map((r) => ({
      id: r.id, title: r.title, source: r.source,
      enabled: !disabledRules.has(r.id),
      escalate: r.escalate ?? null,
      failures: ruleFailures.get(r.id)?.count ?? 0,
    }));
  }

  /** 规则抛错：记账 + 进事件流（每条规则 5 分钟最多报一次），绝不外抛影响判定。 */
  function noteRuleFailure(rule, error, nowMs) {
    const stat = ruleFailures.get(rule.id) || { count: 0, reportedAt: 0 };
    stat.count++;
    ruleFailures.set(rule.id, stat);
    if (nowMs - stat.reportedAt < 300_000) return;
    stat.reportedAt = nowMs;
    pluginError({ where: 'rule:' + rule.id, message: String((error && error.message) || error) });
  }

  /**
   * 纯函数式判定：不改任何状态。
   * @param options.sessionId 只看这个会话的判定（不传 = 全局）。宿主级事实不受影响。
   */
  function verdict(nowMs = now(), options = {}) {
    const scope = options && options.sessionId !== undefined && options.sessionId !== null && String(options.sessionId) !== ''
      ? { sessionId: String(options.sessionId) } : null;
    const ctx = ruleContext(nowMs, scope);
    const reasons = [];
    for (const rule of allRules()) {
      if (disabledRules.has(rule.id)) continue;
      let produced = null;
      try {
        produced = rule.evaluate(ctx);
      } catch (error) {
        noteRuleFailure(rule, error, nowMs);
        continue;
      }
      if (!produced) continue;
      for (const raw of (Array.isArray(produced) ? produced : [produced])) {
        const reason = normalizeReason(raw, rule);
        if (!reason) continue;
        // 只有带会话过滤时才有「这条理由属于谁」的问题；不带过滤时一个字段都不加（保持 v0.4 形状）
        if (scope) reason.scope = SESSION_SCOPED_KINDS.has(reason.kind) ? 'session' : 'host';
        reasons.push(reason);
      }
    }

    const runningAgents = ctx.runningAgents;
    const oldest = ctx.oldestCall;
    const idleMs = ctx.idleMs;
    const hasStall = reasons.some((r) => STALL_KINDS.has(r.kind) || r.escalate === 'stall');
    const hasBug = reasons.some((r) => BUG_KINDS.has(r.kind) || r.escalate === 'bug');
    // 会话过滤下 busy/inflight 必须按过滤后的视角算，否则「只看我的会话」会被别的会话的调用点亮
    const busy = (scope ? ctx.inflight.length : inflight.size) > 0 || runningAgents > 0;
    let state;
    if (hasStall) state = STATES.stalled;
    else if (hasBug) state = STATES.erroring;
    else if (reasons.length > 0) state = STATES.degraded;
    else state = busy ? STATES.busy : STATES.ok;

    return {
      state,
      label: STATE_LABELS[state],
      reasons,
      scope: scope ? scope.sessionId : null,
      at: nowMs,
      since: verdictCache.state === state ? verdictCache.since : nowMs,
      busy,
      inflight: scope ? ctx.inflight.length : inflight.size,
      runningAgents,
      idleMs,
      oldestCall: oldest,
      lagMs: ctx.lag.effectiveMs,
      lagRawMs: lag.lastRawMs,
    };
  }

  // ── 内存泄漏预警：RSS 连续递增 + 增幅超阈值 ────────────────────────────────
  const memorySamples = [];   // [{ at, rss }]，只保留最近若干个
  let memoryLeak = { active: false, growth: 0, rising: 0, window: 0, threshold: 0, samples: 0, fromRss: 0, toRss: 0, since: 0, checkedAt: 0 };

  /** 采一次 RSS（宿主心跳里调用）。非法值直接忽略，绝不影响其它判定。 */
  function noteMemory(rssBytes, nowMs = now()) {
    const rss = Number(rssBytes);
    if (!Number.isFinite(rss) || rss <= 0) return memoryLeak;
    memorySamples.push({ at: nowMs, rss });
    const keep = Math.min(240, Math.max(8, clampLeakWindow(cfg.memoryLeakWindow) * 4));   // 上限防越界（安全审查 M2）
    while (memorySamples.length > keep) memorySamples.shift();
    return evaluateMemoryLeak(nowMs);
  }

  /** 窗口内每个相邻采样都递增，且首尾增幅大于阈值 → 判定为内存泄漏预警。 */
  function evaluateMemoryLeak(nowMs) {
    const window = clampLeakWindow(cfg.memoryLeakWindow);
    const threshold = Math.max(0, Number(cfg.memoryLeakGrowth ?? 0.1));
    const need = window + 1;
    const slice = memorySamples.length >= need ? memorySamples.slice(-need) : memorySamples;
    let rising = 0;
    for (let i = 1; i < slice.length; i++) if (slice[i].rss > slice[i - 1].rss) rising++;
    const from = slice.length > 0 ? slice[0].rss : 0;
    const to = slice.length > 0 ? slice[slice.length - 1].rss : 0;
    const growth = from > 0 ? (to - from) / from : 0;
    const active = memorySamples.length >= need && rising === window && growth > threshold;
    const wasActive = memoryLeak.active;
    memoryLeak = {
      active, growth, rising, window, threshold, samples: memorySamples.length,
      fromRss: from, toRss: to,
      since: active ? (wasActive ? memoryLeak.since : nowMs) : 0,
      checkedAt: nowMs,
    };
    if (active && !wasActive) {
      pushEvent('memory.leak', { fromRss: from, toRss: to, growth, window });
      addFinding('memory-leak', 'warn',
        'RSS 连续 ' + window + ' 个心跳递增：' + formatBytes(from) + ' → ' + formatBytes(to) + '（+' + Math.round(growth * 100) + '%）',
        { fromRss: from, toRss: to, growth, window });
    } else if (!active && wasActive) {
      pushEvent('memory.leak.clear', { growth, window });
    }
    return memoryLeak;
  }

  function safeMemory() {
    try {
      const m = typeof process !== 'undefined' && typeof process.memoryUsage === 'function' ? process.memoryUsage() : null;
      if (!m) return null;
      return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal };
    } catch { return null; }
  }

  /** 会话维度汇总：挂件选「只看某个会话」用的候选清单（永远是全局视角）。 */
  function sessionSummary(nowMs = now()) {
    const bySession = new Map();
    const ensure = (raw) => {
      const key = raw === undefined || raw === null || raw === '' ? '(unknown)' : String(raw);
      let entry = bySession.get(key);
      if (!entry) {
        entry = { sessionId: key, known: key !== '(unknown)', inflight: 0, runningAgents: 0, oldestMs: 0, oldestCallId: null, idleMs: 0 };
        bySession.set(key, entry);
      }
      return entry;
    };
    for (const rec of inflight.values()) {
      const entry = ensure(rec.sessionId);
      entry.inflight++;
      const elapsed = Math.max(0, nowMs - rec.startedAt);
      if (elapsed > entry.oldestMs) { entry.oldestMs = elapsed; entry.oldestCallId = rec.callId; }
    }
    let newestActivityAt = new Map();
    for (const a of agents.values()) {
      const entry = ensure(a.sessionId);
      if (a.status === 'running') entry.runningAgents++;
      const last = Number(a.lastStreamAt || a.since || 0);
      if (last > 0) newestActivityAt.set(entry.sessionId, Math.max(newestActivityAt.get(entry.sessionId) || 0, last));
    }
    for (const entry of bySession.values()) {
      const last = newestActivityAt.get(entry.sessionId) || 0;
      entry.idleMs = last > 0 ? Math.max(0, nowMs - last) : entry.oldestMs;
    }
    return [...bySession.values()].sort((a, b) => (b.inflight - a.inflight) || (b.runningAgents - a.runningAgents) || a.sessionId.localeCompare(b.sessionId));
  }

  /** 结构化快照（写 status.json / 工具返回）。options.sessionId 见 verdict()。 */
  function snapshot(nowMs = now(), options = {}) {
    const v = verdict(nowMs, options);
    const memory = safeMemory();
    return {
      schema: 'jingcha/status@1',
      generatedAt: new Date(nowMs).toISOString(),
      pid: typeof process !== 'undefined' ? process.pid : undefined,
      uptimeMs: nowMs - startedAt,
      verdict: { state: v.state, label: v.label, since: new Date(v.since).toISOString(), reasons: v.reasons },
      scope: { sessionId: v.scope ?? null },
      runtime: {
        eventLoopLagMs: lag.lastMs,
        eventLoopRawLagMs: lag.lastRawMs,
        maxLagMs: lag.maxMs,
        lagSamples: lag.samples,
        overloaded: lag.overWarn,
        suspendEvents: lag.suspended,
        rssBytes: memory?.rss,
        heapUsedBytes: memory?.heapUsed,
        heapTotalBytes: memory?.heapTotal,
        rssWarn: Boolean(memory && memory.rss >= cfg.rssWarnBytes),
        memoryLeak: {
          active: memoryLeak.active, growth: memoryLeak.growth, rising: memoryLeak.rising,
          window: memoryLeak.window, threshold: memoryLeak.threshold, samples: memoryLeak.samples,
          fromRssBytes: memoryLeak.fromRss || undefined, toRssBytes: memoryLeak.toRss || undefined,
          since: memoryLeak.active ? new Date(memoryLeak.since).toISOString() : undefined,
        },
      },
      work: {
        // 带会话过滤时，明细也按同一个口径裁：快照与判定必须说同一件事
        inflight: [...inflight.values()].filter((r) => !v.scope || String(r.sessionId ?? '') === v.scope).map((r) => ({
          callId: r.callId, tool: r.name, sessionId: r.sessionId,
          elapsedMs: nowMs - r.startedAt, preview: r.preview,
          declaredTimeoutMs: r.declaredTimeoutMs,
        })),
        runningAgents: v.runningAgents,
        sessions: sessionSummary(nowMs),
        agents: [...agents.values()].filter((a) => !v.scope || String(a.sessionId ?? '') === v.scope).map((a) => ({
          key: a.key, sessionId: a.sessionId, status: a.status,
          idleMs: nowMs - (a.lastStreamAt || a.since || nowMs),
          streamChunks: a.streamChunks, errors: a.errors,
        })),
        lastActivity: { at: new Date(activity.lastAnyAt).toISOString(), source: activity.lastSource, idleMs: nowMs - activity.lastAnyAt },
        counters: { ...counters },
        errorRate: counters.toolCalls > 0 ? Number((counters.toolErrors / counters.toolCalls).toFixed(4)) : 0,
      },
      tools: [...stats.values()]
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 12)
        .map((s) => ({
          name: s.name, calls: s.calls, ok: s.ok, errors: s.errors,
          timeouts: s.timeouts, aborted: s.aborted, denied: s.denied,
          avgMs: s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0,
          maxMs: s.maxMs, lastMs: s.lastMs, lastAt: s.lastAt ? new Date(s.lastAt).toISOString() : undefined,
          consecutiveErrors: s.consecutiveErrors, lastError: s.lastError || undefined,
          resultBytes: s.resultBytes, emptyResults: s.emptyResults,
        })),
      recentCalls: [...calls.values()].filter((r) => r.finishedAt > 0).slice(-15).reverse().map((r) => ({
        at: new Date(r.finishedAt).toISOString(), tool: r.name, durationMs: r.durationMs,
        isError: r.isError, category: r.category, errorCode: r.errorCode,
        contentBytes: r.contentBytes, preview: r.preview, nested: r.nested,
      })),
      findings: findings.slice(-20).map((f) => ({ at: new Date(f.at).toISOString(), kind: f.kind, severity: f.severity, text: f.text })),
      extras: Object.fromEntries(extras),
      rules: {
        total: allRules().length,
        enabled: allRules().filter((r) => !disabledRules.has(r.id)).length,
        custom: customRules.size,
        failures: [...ruleFailures.values()].reduce((n, s) => n + s.count, 0),
      },
      thresholds: {
        slowCallMs: cfg.slowCallMs, hangCallMs: cfg.hangCallMs, stuckCallMs: cfg.stuckCallMs,
        silenceMs: cfg.silenceMs, lagWarnMs: cfg.lagWarnMs, lagStuckMs: cfg.lagStuckMs,
        errorStormCount: cfg.errorStormCount, errorStormWindowMs: cfg.errorStormWindowMs,
      },
    };
  }

  /** 人读报告（Markdown，中文）。 */
  function report(options = {}, nowMs = now()) {
    const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : cfg.reportWindowMs;
    const since = nowMs - windowMs;
    const v = verdict(nowMs);
    const lines = [];
    const icon = { ok: '✅', busy: '🟢', degraded: '🟡', erroring: '🟠', stalled: '🔴' }[v.state] ?? '❔';
    lines.push('# ' + (cfg.displayName || 'DSH 运行时监察') + ' · ' + icon + ' ' + v.label);
    lines.push('');
    lines.push('- 判定：**' + v.state + '**（' + v.label + '），自 ' + new Date(v.since).toISOString());
    lines.push('- 当前：在途工具调用 ' + v.inflight + ' · 运行中 agent ' + v.runningAgents +
      ' · 事件循环延迟 ' + formatDuration(v.lagMs) + '（峰值 ' + formatDuration(lag.maxMs) + '）');
    lines.push('- 最近活动：' + formatDuration(v.idleMs) + ' 前（来源 ' + activity.lastSource + '）');
    if (v.oldestCall) lines.push('- 最久在途：' + v.oldestCall.tool + ' 已 ' + formatDuration(v.oldestCall.elapsedMs));
    lines.push('');
    lines.push('## 判定理由');
    if (v.reasons.length > 0) for (const r of v.reasons) lines.push('- [' + r.severity + '] ' + r.text);
    else lines.push('- 无异常：没有卡住、没有失败风暴、事件循环通畅');

    const inflightList = [...inflight.values()];
    if (inflightList.length > 0) {
      lines.push('');
      lines.push('## 正在跑的工具调用');
      lines.push('| 工具 | 已运行 | 声明上限 | 会话 | 参数预览 |');
      lines.push('|---|---|---|---|---|');
      for (const r of inflightList) {
        lines.push('| ' + r.name + ' | ' + formatDuration(nowMs - r.startedAt) + ' | ' +
          (r.declaredTimeoutMs !== undefined ? formatDuration(r.declaredTimeoutMs) : '—') + ' | ' +
          (r.sessionId ? String(r.sessionId).slice(0, 18) : '—') + ' | ' + (r.preview || '—').replace(/\|/g, '/') + ' |');
      }
    }

    const rows = [...stats.values()].filter((s) => s.lastAt >= since).sort((a, b) => b.calls - a.calls);
    lines.push('');
    lines.push('## 工具使用统计（近 ' + formatDuration(windowMs) + '）');
    if (rows.length === 0) {
      lines.push('窗口内没有已完成的工具调用。');
    } else {
      lines.push('| 工具 | 调用 | 失败 | 平均 | 最长 | 结果字节 | 最后错误 |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const s of rows) {
        lines.push('| ' + s.name + ' | ' + s.calls + ' | ' + s.errors + ' | ' +
          formatDuration(s.calls > 0 ? s.totalMs / s.calls : 0) + ' | ' + formatDuration(s.maxMs) + ' | ' +
          s.resultBytes + ' | ' + (s.lastError ? s.lastError.replace(/\|/g, '/').slice(0, 60) : '—') + ' |');
      }
    }

    const recent = [...calls.values()].filter((r) => r.finishedAt >= since).slice(-12).reverse();
    if (recent.length > 0) {
      lines.push('');
      lines.push('## 最近调用（时间倒序）');
      for (const r of recent) {
        lines.push('- ' + new Date(r.finishedAt).toISOString().slice(11, 19) + ' ' + r.name + ' ' +
          formatDuration(r.durationMs) + (r.isError ? ' ❌ ' + (r.errorCode ?? '') + ' ' + clip(r.errorMessage ?? '', 80) : ' ✅ ' + r.contentBytes + 'B') +
          (r.preview ? ' · ' + clip(r.preview, 60) : ''));
      }
    }

    const recentFindings = findings.filter((f) => f.at >= since).slice(-12).reverse();
    lines.push('');
    lines.push('## 告警（近 ' + formatDuration(windowMs) + '，共 ' + findings.filter((f) => f.at >= since).length + ' 条）');
    if (recentFindings.length === 0) lines.push('无。');
    else for (const f of recentFindings) {
      lines.push('- ' + new Date(f.at).toISOString().slice(11, 19) + ' [' + f.severity + '] ' + f.text);
    }

    lines.push('');
    lines.push('## 输出面');
    lines.push('- 工具调用：成功 ' + counters.toolOk + ' · 失败 ' + counters.toolErrors + ' · 取消 ' + counters.toolAborted +
      ' · 拒绝 ' + counters.toolDenied + ' · 超时 ' + counters.toolTimeouts + ' · 空结果 ' + counters.emptyResults);
    lines.push('- 结果字节合计 ' + counters.resultBytes + ' · 模型流式帧 ' + counters.streamChunks +
      ' · 会话事件 ' + counters.sessionEvents + ' · 子智能体起/止 ' + counters.subagentStarts + '/' + counters.subagentEnds);
    lines.push('- 审批：' + counters.approvals + ' 次（其中等待超阈值 ' + counters.approvalWaits + ' 次）');
    if (counters.pluginErrors > 0) lines.push('- ⚠ 监察插件自身错误 ' + counters.pluginErrors + ' 次（看 events.jsonl 的 plugin.error）');
    return lines.join('\n');
  }

  return {
    cfg,
    startedAt,
    // 事实录入
    toolStart, toolDecision, toolFinish, toolResult, toolThrow,
    agentStatus, streamChunk, sessionEvent, agentError, subagent, pluginError, noteLag, noteMemory, setExtra, noteJobs,
    longRunning, inflightList, noteKill,
    // 推进与产出
    tick, verdict, snapshot, report,
    // 判定规则表（第三方扩展点）
    registerRule, unregisterRule, setRuleEnabled, listRules,
    drain() { const out = events.slice(); events.length = 0; return out; },
    pendingEvents() { return events.length; },
    // 只读视图（测试/调试用）
    peek() {
      return {
        inflight: [...inflight.values()], calls: [...calls.values()], stats: [...stats.values()],
        agents: [...agents.values()], findings: findings.slice(), counters: { ...counters },
        activity: { ...activity }, lag: { ...lag },
        memoryLeak: { ...memoryLeak }, memorySamples: memorySamples.slice(-8).map((s) => s.rss),
        rules: listRules(),
      };
    },
  };
}

export default createMonitor;
