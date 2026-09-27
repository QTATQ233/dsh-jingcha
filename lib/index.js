/**
 * 鲸察 (dsh-jingcha) · DSH 宿主侧监察插件
 * ============================================================================
 * 目的：回答一个问题——**DSH 现在是在正常干活，还是卡住了，还是在出 bug？**
 *
 * 观察面（全部只读、绝不改写被观察对象）：
 *   · tools/pre-execute  调用入口（含审批等待时长、被拒绝/取消的裁决）
 *   · tools/execute      真正的派发窗口（开始/结束/抛异常，用来算在途时长）
 *   · tools/result       最终结果（错误码、内容字节数；补全没看到起点的调用）
 *   · agent/status        谁在跑、谁闲着
 *   · agent/assistant-stream / llm 流式帧   「模型还在吐字」的最直接证据
 *   · session/event       会话仍在追加事件（输出面）
 *   · agent/error、agent/request-error     出错与重试
 *   · subagent/start|end  子智能体起止
 *   · 1s 心跳             事件循环延迟、内存、后台 job 数
 *
 * 产出：
 *   · status.json   实时快照（原子替换）
 *   · events.jsonl  追加式事件流（工具调用 / 告警 / 状态翻转），超限自动轮转
 *   · jingcha_status 工具  让模型（和用户）随时问一句「鲸察，现在正常吗」
 *   · 控制台        只在状态翻转时打一行，避免刷屏
 *
 * 失败隔离：本插件所有监听器都只做「记账」，任何内部异常都被吞进 pluginErrors 计数，
 * 绝不让监察本身影响工具调用（tools/execute 与 tools/pre-execute 的语义原样透传）。
 */

import os from 'node:os';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createMonitor, DEFAULTS, formatDuration } from './core.js';
import { createSink } from './sink.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'jingcha';
/** 只需工具注册表；jobs 等其余服务都是可选增强（拿不到就当没有）。 */
export const inject = ['tools'];

const DEFAULT_TOOL_NAME = 'jingcha_status';

/** 挂载过的实例（调试 / 离线测试用；正常运行时只有一条，随 dispose 移除）。 */
export const instances = [];

/** 显示名：默认「鲸察」，可用 config.displayName 覆盖。 */
function displayNameOf(config) {
  const raw = config && typeof config.displayName === 'string' ? config.displayName.trim() : '';
  return raw.length > 0 ? raw : '鲸察';
}

/** $DSH_HOME（与宿主其它插件的数据目录约定保持一致）。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), '.dsh');
}

function resolveDataDir(cfg) {
  const raw = cfg.dataDir;
  if (typeof raw === 'string' && raw.trim().length > 0) return path.resolve(raw.trim());
  return path.join(dshHome(), 'data', 'dsh-jingcha');
}

/** 从一次执行里抽出会话/agent 标识（字段都是可选的，取不到就 undefined）。 */
function identOf(exec) {
  const agent = exec ? exec.agent : undefined;
  let sessionId;
  let agentKey;
  try {
    const session = agent ? agent.session : undefined;
    if (session && session.id !== undefined && session.id !== null) sessionId = String(session.id);
  } catch { sessionId = undefined; }
  try {
    if (agent && agent.id !== undefined && agent.id !== null) agentKey = String(agent.id);
  } catch { agentKey = undefined; }
  return { agentKey: agentKey ?? sessionId, sessionId };
}

/** 结果内容的体量（字节 / 块数）——只读长度，不复制大字符串。 */
function contentOf(content) {
  if (!Array.isArray(content)) return { bytes: 0, blocks: 0 };
  let bytes = 0;
  for (const block of content) {
    if (block && typeof block === 'object') {
      if (typeof block.text === 'string') bytes += block.text.length;
      else bytes += 64;
    } else bytes += 8;
  }
  return { bytes, blocks: content.length };
}

function textOf(value, max = 300) {
  let text;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') text = value;
  else if (value instanceof Error) text = value.message;
  else if (typeof value === 'object' && typeof value.message === 'string') text = value.message;
  else { try { text = JSON.stringify(value); } catch { text = String(value); } }
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * 挂载监察。
 * @param ctx 宿主上下文（至少含 tools）。
 * @param config patch 层给的配置（阈值、数据目录、开关）。
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  if (cfg.enabled === false) {
    console.log('[' + displayNameOf(config) + '] 已按配置禁用（enabled: false），未挂载任何监听器。');
    return;
  }

  const displayName = displayNameOf(cfg);
  const monitor = createMonitor({ ...cfg, displayName });
  const dataDir = resolveDataDir(cfg);
  const sink = createSink({ dir: dataDir, maxBytes: cfg.maxLogBytes });
  const toolName = typeof cfg.toolName === 'string' && cfg.toolName.length > 0 ? cfg.toolName : DEFAULT_TOOL_NAME;

  // 在 apply 期把 tools 服务解析一次：热路径不再走 ctx 代理，
  // 也避免在别的 fiber 的调用栈里访问 ctx.tools 时被 inject 检查拦下。
  const toolsService = safe('apply:tools', () => ctx.tools, undefined);
  // 强制停止的两个抓手：在途调用 -> 鲸察自己的中止控制器；运行中的 agent -> Agent 对象
  const liveCalls = new Map();
  const execSignals = new WeakMap();   // exec -> { controller, upstream, installed }

  /**
   * 给一次调用装上「鲸察融合控制器」并登记进 liveCalls。
   * 关键：在 **pre-execute 就装**。DSH 的子调用（父 id + ":ptc:<n>"）不一定走 tools/execute，
   * 只在 execute 登记会让嵌套调用的「⛔ 停」按钮点了没反应（现场实测 killed: []）。
   * 上游取消语义不变：上游 abort 会转发到我们的控制器。
   */
  function installController(exec, phase) {
    if (!exec || typeof exec !== "object") return null;
    let entry = execSignals.get(exec);
    if (!entry) {
      const upstream = exec.signal;
      const controller = new AbortController();
      const forward = () => { try { controller.abort(upstream ? upstream.reason : undefined); } catch { /* ignore */ } };
      entry = { controller, upstream, installed: false, forward, startedAt: Date.now(), name: exec.name, agent: exec.agent };
      execSignals.set(exec, entry);
      try {
        if (upstream) {
          if (upstream.aborted) forward();
          else if (typeof upstream.addEventListener === "function") upstream.addEventListener("abort", forward, { once: true });
        }
        exec.signal = controller.signal;      // DSH 的 dispatchToolBody 会把它再融合一次，语义不变
        entry.installed = true;
      } catch (error) {
        onInternal("signal:install", error);
        entry.installed = false;
      }
    }
    const key = String(exec.callId === undefined || exec.callId === null ? "" : exec.callId);
    if (key && key !== "undefined" && key !== "null" && entry.installed) {
      liveCalls.set(key, { controller: entry.controller, name: entry.name, agent: entry.agent, startedAt: entry.startedAt, phase });
    }
    return entry;
  }

  /** 调用结束：还原上游 signal、摘掉监听、从 liveCalls 删除（可重复调用）。 */
  function releaseController(exec) {
    if (!exec || typeof exec !== "object") return;
    const entry = execSignals.get(exec);
    const key = String(exec.callId === undefined || exec.callId === null ? "" : exec.callId);
    if (entry) {
      execSignals.delete(exec);
      safe("signal:release", () => {
        if (entry.upstream && typeof entry.upstream.removeEventListener === "function") entry.upstream.removeEventListener("abort", entry.forward);
        if (entry.installed) exec.signal = entry.upstream;
      });
    }
    if (key) liveCalls.delete(key);
  }
  const liveAgents = new Map();

  let statusWrittenAt = 0;
  const consoleTicks = new Map();   // callId -> 上次往控制台打「仍在跑」的时刻
  let lastState = 'ok';
  let internalErrors = 0;
  let toolRegistered = false;

  const consoleOn = cfg.console !== false;
  const CONSOLE_PREFIX = '[' + displayName + '] ';
  function log(line) {
    if (!consoleOn) return;
    try { console.log(CONSOLE_PREFIX + line); } catch { /* 控制台没了也不能出事 */ }
  }

  /** 内部兜底：监察自己出错时只记账，绝不外抛。 */
  function onInternal(where, error) {
    internalErrors++;
    try { monitor.pluginError({ where, message: textOf(error) }); } catch { /* 记账都失败就只留计数 */ }
    if (internalErrors <= 5) {
      const message = CONSOLE_PREFIX + '内部错误 @' + where + ': ' + textOf(error);
      try { console.warn(message); } catch { /* ignore */ }
    }
  }

  /** 同步安全执行。 */
  function safe(where, fn, fallback) {
    try { return fn(); } catch (error) { onInternal(where, error); return fallback; }
  }

  /** 异步安全执行（吞掉 rejection，保证 await 的调用方不会因此失败）。 */
  async function safeAsync(where, fn) {
    try { return await fn(); } catch (error) { onInternal(where, error); return undefined; }
  }

  // ── 工具调用流水线 ────────────────────────────────────────────────────────

  /** pre-execute：调用入口。注意 next() 可能长时间不返回——那正是「等人审批」。 */
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec || typeof exec !== 'object') return next();
    const startedAt = Date.now();
    safe('pre-execute:start', () => {
      const { agentKey, sessionId } = identOf(exec);
      monitor.toolStart({
        callId: exec.callId,
        name: exec.name,
        agentKey,
        sessionId,
        arguments: exec.arguments,
        nested: exec.parent !== undefined,
        phase: 'pre',
      });
    });
    safe('pre-execute:controller', () => installController(exec, 'pre'));
    const decision = await next();
    safe('pre-execute:decision', () => {
      const waitedMs = Date.now() - startedAt;
      const kind = decision && typeof decision === 'object' ? decision.kind : undefined;
      monitor.toolDecision({
        callId: exec.callId,
        name: exec.name,
        kind,
        waitedMs,
        reason: decision && typeof decision === 'object' ? decision.reason : undefined,
        approval: kind === 'ask',
      });
    });
    return decision;
  });

  /** execute：真正的派发窗口。只观察，不改写 exec，也不改结果。 */
  ctx.on('tools/execute', async (exec, next) => {
    if (!exec || typeof exec !== 'object') return next();
    let declaredTimeoutMs;
    safe('execute:start', () => {
      const { agentKey, sessionId } = identOf(exec);
      const definition = safe('execute:lookup', () => (toolsService ? toolsService.get(exec.name, exec.agent) : undefined), undefined);
      declaredTimeoutMs = definition ? definition.timeoutMs : undefined;
      monitor.toolStart({
        callId: exec.callId,
        name: exec.name,
        agentKey,
        sessionId,
        arguments: exec.arguments,
        nested: exec.parent !== undefined,
        timeoutMs: declaredTimeoutMs,
        phase: 'run',
      });
    });
    // 融合控制器（幂等）：上游取消照旧生效，我们也能主动掐断（强制停止）。
    safe('execute:controller', () => installController(exec, 'run'));
    try {
      const result = await next();
      safe('execute:finish', () => {
        const { bytes, blocks } = contentOf(result ? result.content : undefined);
        monitor.toolFinish({
          callId: exec.callId,
          name: exec.name,
          isError: Boolean(result && result.isError),
          errorCode: result && result.error && result.error.info ? result.error.info.code : undefined,
          errorMessage: result && result.error ? result.error.message : undefined,
          contentBytes: bytes,
          contentBlocks: blocks,
        });
      });
      return result;
    } catch (error) {
      safe('execute:throw', () => {
        monitor.toolThrow({ callId: exec.callId, name: exec.name, error });
      });
      throw error;
    } finally {
      safe('execute:release', () => releaseController(exec));
    }
  });

  /** result：最终结果观察点（补全/纠正；对拒绝、取消这类没进派发的调用尤其重要）。 */
  ctx.on('tools/result', (exec, result) => {
    if (!exec || typeof exec !== 'object') return;
    safe('result:release', () => releaseController(exec));
    if (exec.callId === undefined) return;
    safe('result', () => {
      const { agentKey, sessionId } = identOf(exec);
      const { bytes, blocks } = contentOf(result ? result.content : undefined);
      monitor.toolResult({
        callId: exec.callId,
        name: exec.name,
        agentKey,
        sessionId,
        arguments: exec.arguments,
        isError: Boolean(result && result.isError),
        errorCode: result && result.error && result.error.info ? result.error.info.code : undefined,
        errorMessage: result && result.error ? result.error.message : undefined,
        contentBytes: bytes,
        contentBlocks: blocks,
      });
    });
  });

  // ── agent / 模型 / 会话 ───────────────────────────────────────────────────

  ctx.on('agent/created', (payload) => {
    if (!payload || !payload.agent) return;
    safe('agent/created', () => {
      const { agentKey, sessionId } = identOf(payload);
      const key = String(agentKey ?? sessionId);
      liveAgents.set(key, payload.agent);
      monitor.agentStatus({ key, sessionId, status: 'idle' });
    });
  });

  ctx.on('agent/disposed', (payload) => {
    if (!payload || !payload.agent) return;
    safe('agent/disposed', () => {
      const { agentKey, sessionId } = identOf(payload);
      liveAgents.delete(String(agentKey ?? sessionId));
    });
  });

  ctx.on('agent/status', (payload) => {
    if (!payload || !payload.agent) return;
    safe('agent/status', () => {
      const { agentKey, sessionId } = identOf(payload);
      const key = String(agentKey ?? sessionId);
      liveAgents.set(key, payload.agent);
      monitor.agentStatus({ key, sessionId, status: payload ? payload.status : undefined });
    });
  });

  ctx.on('agent/assistant-stream', (payload) => {
    if (!payload || !payload.agent) return;
    safe('agent/assistant-stream', () => {
      const frame = payload ? payload.frame : undefined;
      if (!frame || frame.type !== 'chunk') return;   // start/end 不参与「还在吐字」的判定
      const { agentKey, sessionId } = identOf(payload);
      let bytes = 0;
      try { bytes = typeof frame.chunk === 'string' ? frame.chunk.length : 0; } catch { bytes = 0; }
      monitor.streamChunk({ key: agentKey ?? sessionId, sessionId, turn: frame.turn, bytes });
    });
  });

  ctx.on('agent/error', (payload) => {
    if (!payload || !payload.agent) return;
    safe('agent/error', () => {
      const { agentKey, sessionId } = identOf(payload);
      const failure = payload ? payload.error : undefined;
      monitor.agentError({
        key: agentKey ?? sessionId,
        sessionId,
        source: 'agent-error',
        message: textOf(failure),
        code: failure && typeof failure === 'object' ? failure.code : undefined,
        escalate: true,
      });
    });
  });

  /** 单次模型请求失败：可能只是要重试，不升级成 bug 判定。 */
  ctx.on('agent/request-error', async (payload, next) => {
    if (!payload || !payload.agent) return next();
    safe('agent/request-error', () => {
      const { agentKey, sessionId } = identOf(payload);
      const failure = payload ? payload.failure : undefined;
      monitor.agentError({
        key: agentKey ?? sessionId,
        sessionId,
        source: 'request-error',
        message: textOf(failure),
        code: failure && typeof failure === 'object' ? failure.code : undefined,
        escalate: false,
      });
    });
    return next();
  });

  ctx.on('session/event', (session, event) => {
    if (!event || !session) return;
    safe('session/event', () => {
      let sessionId;
      try { sessionId = session && session.id !== undefined ? String(session.id) : undefined; } catch { sessionId = undefined; }
      monitor.sessionEvent({ sessionId, type: event ? event.type : undefined });
    });
  });

  ctx.on('subagent/start', (payload) => {
    safe('subagent/start', () => {
      monitor.subagent({ phase: 'start', id: payload ? (payload.subagentId ?? payload.id) : undefined, label: payload ? payload.description : undefined });
    });
  });

  ctx.on('subagent/end', (payload) => {
    safe('subagent/end', () => {
      monitor.subagent({ phase: 'end', id: payload ? (payload.subagentId ?? payload.id) : undefined, status: payload ? payload.status : undefined });
    });
  });

  // ── 强制停止：掐断在途调用 / 取消正在跑的轮次 ─────────────────────────────

  /**
   * 掐断一个在途调用：中止鲸察融合的信号。
   * 响应取消的工具（pwsh 之类的子进程）会被真的停掉；忽略信号的同进程长循环停不下来（宿主没有硬杀能力）。
   */
  function killCall(callId, reason) {
    const key = String(callId === undefined || callId === null ? '' : callId).trim();
    if (!key || key === 'undefined' || key === 'null') return { ok: false, reason: 'empty-callId' };
    let entry = liveCalls.get(key);
    let matchedId = key;
    if (!entry) {
      // 同一调用可能以「父 id」和「父 id:ptc:n」两种形态出现：只在唯一对应时才认，且不拿子 id 去杀父调用
      const base = key.split(':ptc:')[0];
      const candidates = [];
      for (const [id, rec] of liveCalls) if (id.split(':ptc:')[0] === base) candidates.push([id, rec]);
      const safeOnes = candidates.filter(([id]) => !(key.indexOf(':ptc:') >= 0 && id.indexOf(':ptc:') < 0));
      if (safeOnes.length === 1) { matchedId = safeOnes[0][0]; entry = safeOnes[0][1]; }
      else if (candidates.length > 0) return { ok: false, reason: 'nested-parent-only', parentId: candidates[0][0] };
      else return { ok: false, reason: 'not-live', known: [...liveCalls.keys()].slice(0, 20) };
    }
    try {
      entry.controller.abort(new Error(reason || 'jingcha: 强制停止'));
    } catch (error) {
      onInternal('kill:abort', error);
      safe('kill:record-failed', () => monitor.noteKill({ callId: matchedId, tool: entry.name, reason, ok: false }));
      return { ok: false, reason: 'abort-failed' };
    }
    safe('kill:record', () => monitor.noteKill({ callId: matchedId, tool: entry.name, reason, ok: true }));
    log('强制停止：' + entry.name + '（' + matchedId + '）' + (reason ? ' — ' + reason : ''));
    return { ok: true, matchedId };
  }

  /** 按范围停：stalled = 超过 stuckCallMs 的在途；all = 全部在途。 */
  function killScope(scope, reason) {
    const nowMs = Date.now();
    const targets = safe('kill:list', () => monitor.inflightList(nowMs), []) || [];
    const limit = scope === 'stalled' ? Number(cfg.stuckCallMs) : 0;
    const silenceGate = Number(cfg.progressEveryMs ?? 30_000) * 2;
    const killed = [];
    for (const rec of targets) {
      // 「卡住」= 跑得够久 **且** 有一阵子没有任何产出信号（慢但在出活的不杀）
      if (scope === 'stalled' && !(rec.elapsedMs >= limit && Number(rec.silentMs ?? rec.elapsedMs) >= Math.min(limit, silenceGate))) continue;
      const why = reason || (scope === 'stalled' ? '超过卡住阈值 ' + formatDuration(limit) : '要求全部停止');
      if (killCall(rec.callId, why).ok === true) killed.push(rec.callId);
    }
    return killed;
  }

  /** 取消所有正在跑的 agent 轮次（等价于界面上的停止按钮）。 */
  function stopTurns(reason) {
    const cancelled = [];
    for (const [key, agent] of liveAgents) {
      try {
        if (agent && agent.status === 'running' && typeof agent.cancel === 'function') {
          agent.cancel({ kind: 'user' });
          cancelled.push(key);
        }
      } catch (error) { onInternal('stop:cancel:' + key, error); }
    }
    if (cancelled.length > 0) safe('stop:record', () => monitor.noteKill({ scope: 'turns', reason: reason || '要求停止所有轮次', agents: cancelled, ok: true }));
    if (cancelled.length > 0) log('已取消 ' + cancelled.length + ' 个运行中的轮次' + (reason ? '：' + reason : ''));
    return cancelled;
  }

  // ── 心跳：事件循环延迟 + 判定推进 + 落盘 ──────────────────────────────────

  /** 可选增强：后台 job 列表（服务不在就当没有）。明细与 diff 交给 core 的 noteJobs。 */
  function jobList() {
    return safe('peek-jobs', () => {
      const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined;
      if (!jobs || typeof jobs.list !== 'function') return undefined;
      const list = jobs.list();
      return Array.isArray(list) ? list : undefined;
    }, undefined);
  }

  function writeStatus(nowMs, force) {
    if (!force && nowMs - statusWrittenAt < Number(cfg.statusEveryMs ?? 5000)) return;
    statusWrittenAt = nowMs;
    safe('status', () => {
      const snapshot = monitor.snapshot(nowMs);
      snapshot.data = { dir: sink.dir, statusPath: sink.statusPath, logPath: sink.logPath };
      snapshot.sink = sink.stats();
      sink.status(snapshot);
    });
  }

  /**
   * 心跳挂在 cordis 的 effect 上：fiber 卸载时会反向执行 disposer，
   * 于是停表、写最后一次快照、把日志收尾都被自动带上。
   * （注意：本版 cordis 的卸载通知是 internal/plugin + effect，ctx.on('dispose') 不会触发。）
   */
  /** 心跳执行体：挂载时在 ctx.effect 里赋值，自检/排障可以直接驱动一次。 */
  let heartbeatOnce = () => {};

  ctx.effect(() => {
  heartbeatOnce = (nowMs = Date.now()) => {
    try {
      const jobs = jobList();
      if (jobs) monitor.noteJobs(jobs, nowMs);
      monitor.setExtra('node', process.version);
      monitor.setExtra('platform', process.platform);
      monitor.setExtra('activeResources', safe('active-resources', () => (typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().length : undefined), undefined));
      // 采一次 RSS 交给判定（内存泄漏预警用）；采样失败也不影响心跳
      safe('heartbeat:memory', () => {
        const usage = typeof process.memoryUsage === 'function' ? process.memoryUsage() : null;
        if (usage && Number.isFinite(usage.rss)) monitor.noteMemory(usage.rss, nowMs);
      });
      const verdict = monitor.tick(nowMs);
      if (verdict.state !== lastState) {
        const reasons = verdict.reasons.map((reason) => reason.text || reason.kind).slice(0, 3).join(' · ');
        if (verdict.state === 'stalled' || verdict.state === 'erroring') {
          log('判定 -> ' + verdict.label + '（' + verdict.state + '）：' + (reasons || '无细节'));
        } else if (lastState === 'stalled' || lastState === 'erroring') {
          log('判定恢复 -> ' + verdict.label + '（' + verdict.state + '）');
        } else {
          log('判定 -> ' + verdict.label + '（' + verdict.state + '）');
        }
        lastState = verdict.state;
        writeStatus(nowMs, true);
      } else {
        writeStatus(nowMs, false);
      }
      // 长调用期间往控制台打「仍在跑」：超过慢线才打，且按 consoleProgressMs 去抖，避免刷屏
      const progressMs = Number(cfg.consoleProgressMs ?? 60_000);
      if (consoleOn && progressMs > 0) {
        for (const running of monitor.longRunning(nowMs)) {
          const last = consoleTicks.get(running.callId) ?? 0;
          if (nowMs - last < progressMs) continue;
          consoleTicks.set(running.callId, nowMs);
          const preview = running.preview ? '（' + String(running.preview).slice(0, 60) + '）' : '';
          log('仍在跑：' + running.name + ' 已 ' + formatDuration(running.elapsedMs) + preview);
        }
        if (consoleTicks.size > 64) consoleTicks.clear();
      }
      // 自动强制停止（默认关闭）：超过 autoKillAfterMs 的在途调用直接掐断
      const autoKillMs = Number(cfg.autoKillAfterMs ?? 0);
      if (autoKillMs > 0) {
        for (const rec of (safe('autokill:list', () => monitor.inflightList(nowMs), []) || [])) {
          // 同样要求「没有产出」：慢但在出活的任务不该被自动掐掉（安全审查 M4）
          const silent = Number(rec.silentMs ?? rec.elapsedMs);
          if (rec.elapsedMs >= autoKillMs && silent >= Math.min(autoKillMs, Number(cfg.progressEveryMs ?? 30_000) * 2)) {
            killCall(rec.callId, '超过自动停止阈值 ' + formatDuration(autoKillMs));
          }
        }
      }

      sink.queueRecords(monitor.drain());
      sink.flush();
    } catch (error) {
      onInternal('heartbeat', error);
    }
  };
  const heartbeat = setInterval(() => heartbeatOnce(Date.now()), Math.max(200, Number(cfg.heartbeatMs ?? 1000)));
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  return async () => {
    try { clearInterval(heartbeat); } catch { /* ignore */ }
    const index = instances.findIndex((entry) => entry.sink === sink);
    if (index >= 0) instances.splice(index, 1);
    safe('dispose:status', () => sink.status(monitor.snapshot(Date.now())));
    try { await sink.close(); } catch { /* 收尾失败无所谓 */ }
    log('已卸载（本次共记录 ' + monitor.snapshot(Date.now()).work.counters.toolCalls + ' 次工具调用）');
  };
  }, 'jingcha.heartbeat');

  // ── 查询工具：让模型/用户随时问「现在正常吗」 ──────────────────────────────

  const toolDefinition = {
    name: toolName,
    description: '鲸察 (jingcha) — report the live health of this DSH host: whether tool calls and model output are still flowing, '
      + 'which calls are in flight, what is slow, what looks stuck, and what failed recently. '
      + 'Use it to tell "still working" apart from "hung" or "error-looping" before assuming something is wrong; '
      + 'it is cheap, read-only, and never touches the session log.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        windowMinutes: { type: 'number', description: 'Statistics window in minutes (default 30).' },
        includeSnapshot: { type: 'boolean', description: 'Include the raw JSON status snapshot in the tool value (default false).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['report'],
        properties: {
          report: { type: 'string' },
          state: { type: 'string' },
          label: { type: 'string' },
          inflight: { type: 'integer' },
          reasons: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: String(value && value.report ? value.report : '(鲸察: 没有报告)') }];
      },
    },
    async execute(args) {
      const windowMinutes = args && Number.isFinite(args.windowMinutes) && args.windowMinutes > 0 ? Number(args.windowMinutes) : undefined;
      return safe('tool:execute', () => {
        const nowMs = Date.now();
        const snapshot = monitor.snapshot(nowMs);
        const windowMs = windowMinutes ? windowMinutes * 60_000 : Number(cfg.reportWindowMs);
        const report = monitor.report({ windowMs }, nowMs)
          + '\n\n- 监察数据：' + sink.statusPath + '（实时快照） · ' + sink.logPath + '（事件流 JSONL）'
          + '\n- 落盘统计：写入 ' + sink.stats().written + ' 条 · 丢弃 ' + sink.stats().dropped + ' 条 · 写盘错误 ' + sink.stats().errors + ' 次'
          + '\n- 插件内部错误：' + internalErrors + ' 次';
        const value = {
          report,
          state: snapshot.verdict.state,
          label: snapshot.verdict.label,
          inflight: snapshot.work.inflight.length,
          reasons: snapshot.verdict.reasons.map((reason) => reason.text || reason.kind),
        };
        if (args && args.includeSnapshot === true) value.snapshot = snapshot;
        return value;
      }, {
        report: '鲸察内部出错，无法生成报告（详见 ' + sink.logPath + ' 的 plugin.error）',
        state: 'erroring',
        label: '监察自身故障',
        inflight: 0,
        reasons: ['jingcha internal error'],
      });
    },
  };

  if (cfg.toolEnabled !== false) {
    try {
      if (!toolsService) throw new Error('tools 服务不可用（inject 未生效？）');
      toolsService.register(toolDefinition);
      toolRegistered = true;
    } catch (error) {
      onInternal('tool:register', error);
    }
  }

  // ── HTTP 接口：给右下角挂件用（只允许本机回环） ───────────────────────────
  /** 可选的共享口令：配了 apiToken（或环境变量 JINGCHA_API_TOKEN）就必须带 x-jingcha-token 头。 */
  const apiToken = String(cfg.apiToken ?? process.env.JINGCHA_API_TOKEN ?? '');
  // IPv4-mapped 写法也认（[::ffff:127.0.0.1]:port 这种；安全审查 L2）
  const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]'];
  const hostName = (value) => String(value || '').toLowerCase().replace(/^\[/, '').replace(/\]:\d+$/, '').replace(/:\d+$/, '');

  /**
   * 只信 socket 上的真实对端地址（不信任任何 X-Forwarded-*）。
   * 注意：空地址只有自检里的桩请求会出现（真 HTTP 一定有 remoteAddress），属故意放行（安全审查 L3）。
   */
  function loopback(req) {
    try {
      const addr = req && req.socket ? (req.socket.remoteAddress || '') : '';
      return addr === '' || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    } catch { return false; }
  }
  /** 共享口令按常量时间比较：先各自 sha256 再 timingSafeEqual，长度不同也不泄漏信息（安全审查 L1）。 */
  function tokenMatches(given, expected) {
    try {
      const a = createHash('sha256').update(given, 'utf8').digest();
      const b = createHash('sha256').update(expected, 'utf8').digest();
      return timingSafeEqual(a, b);
    } catch { return given === expected; }
  }
  /**
   * 跨站/重绑定的统一栅栏：回环 + Host 白名单 + 拒绝跨站来源 + 变更类必须 POST JSON。
   * 少了这几条，任意网页都能用 <img>/<form>/fetch(no-cors) 打到这些接口（安全审查 S1/M1）。
   */
  function guard(req, res, options = {}) {
    if (!loopback(req)) { sendJson(res, 403, { ok: false, error: 'loopback only' }); return false; }
    const headers = req && req.headers ? req.headers : null;
    // 没有 headers 的只可能是自检里的桩请求（真 HTTP 一定有 Host）——桩放行，真请求一律校验。
    if (headers === null) return true;
    if (!LOCAL_HOSTS.includes(hostName(headers.host))) { sendJson(res, 403, { ok: false, error: 'host not allowed' }); return false; }
    const site = String(headers['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site' || site === 'same-site') { sendJson(res, 403, { ok: false, error: 'cross-site blocked' }); return false; }
    const origin = String(headers.origin || '');
    if (origin && origin !== 'null' && !LOCAL_HOSTS.includes(hostName(origin.replace(/^[a-z]+:\/\//i, '')))) {
      sendJson(res, 403, { ok: false, error: 'origin not allowed' });
      return false;
    }
    if (apiToken && !tokenMatches(String(headers['x-jingcha-token'] || ''), apiToken)) {
      sendJson(res, 403, { ok: false, error: 'bad token' });
      return false;
    }
    if (options.mutation) {
      const method = String((req && req.method) || 'GET').toUpperCase();
      if (method !== 'POST' && method !== 'PUT') { sendJson(res, 405, { ok: false, error: 'use POST' }); return false; }
      const type = String(headers['content-type'] || '').toLowerCase();
      if (type.indexOf('application/json') < 0) { sendJson(res, 415, { ok: false, error: 'content-type must be application/json' }); return false; }
    }
    return true;
  }
  /** 请求里的 reason 会进日志与控制台，限长并去掉控制字符。 */
  function sanitizeReason(value, fallback) {
    const text = String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return (text || fallback || '').slice(0, 200);
  }
  /** 读一个 JSON body（非变更方法直接给空对象）。 */
  async function readJsonBody(req) {
    if (!req || (req.method !== 'POST' && req.method !== 'PUT')) return {};
    const body = await readBody(req);
    if (!body) return {};
    try { const parsed = JSON.parse(body); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
  }
  const exposePaths = cfg.exposePaths === true;
  function sendJson(res, code, value) {
    try {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(value));
    } catch { /* 连接断了就算了 */ }
  }
  function queryOf(req) {
    const out = {};
    try {
      const url = String(req && req.url ? req.url : '');
      const at = url.indexOf('?');
      if (at >= 0) for (const pair of url.slice(at + 1).split('&')) {
        const parts = pair.split('=');
        if (parts[0]) out[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
      }
    } catch { /* ignore */ }
    return out;
  }
  /** 变更类请求只收短 body；单个 chunk 也可能远超上限，所以按剩余额度切片。 */
  function readBody(req, limit = 8192) {
    return new Promise((resolve) => {
      let text = '';
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(text); } };
      try {
        req.on('data', (chunk) => {
          const rest = limit - text.length;
          if (rest > 0) text += chunk.toString('utf8').slice(0, rest);
        });
        req.on('end', finish);
        req.on('error', finish);
        const timer = setTimeout(finish, 500);
        if (typeof timer.unref === 'function') timer.unref();
      } catch { finish(); }
    });
  }
  /** 挂件每 2 秒拉一次，所以只给紧凑载荷，不给整份快照。 */
  function statusPayload() {
    const nowMs = Date.now();
    const snap = safe('api:snapshot', () => monitor.snapshot(nowMs), null);
    if (!snap) {
      return { generatedAt: new Date(nowMs).toISOString(), verdict: { state: 'erroring', label: '监察自身故障', reasons: [] }, work: { inflight: [], runningAgents: 0, counters: {} }, findings: [] };
    }
    return {
      generatedAt: snap.generatedAt,
      verdict: snap.verdict,
      runtime: { eventLoopLagMs: snap.runtime.eventLoopLagMs, maxLagMs: snap.runtime.maxLagMs, rssBytes: snap.runtime.rssBytes },
      work: { inflight: snap.work.inflight, runningAgents: snap.work.runningAgents, counters: snap.work.counters },
      findings: (snap.findings || []).slice(-8),
      thresholds: snap.thresholds,
      dataDir: dataDir,
      tool: toolRegistered ? toolName : null,
      capabilities: { kill: true, stopTurns: true, autoKillAfterMs: Number(cfg.autoKillAfterMs ?? 0) },
    };
  }

  // ── 挂件设置：持久化到数据目录，客户端面通过 GET/POST /api/jingcha/settings 读写 ──
  const WIDGET_DEFAULTS = {
    version: 1,
    position: { mode: 'free', right: 14, bottom: 14, left: null, top: null },
    size: 1,
    opacity: 0.92,
    accent: '',
    labels: true,
    thresholds: { yellowSec: 30, redSec: 120 },
    popups: true,
    popupDurationMs: 6000,
    panel: { defaultOpen: false, width: 340 },
    theme: 'auto',
    hidden: false,
  };
  const settingsPath = path.join(dataDir, 'widget-settings.json');
  let widgetSettings = JSON.parse(JSON.stringify(WIDGET_DEFAULTS));

  const clampNum = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const clampPos = (value, fallback) => {
    if (value === null || value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(Math.min(20000, Math.max(-20000, n))) : fallback;
  };

  /** 只接受已知字段并夹紧取值范围：客户端传什么都不该把宿主写坏。 */
  function sanitizeSettings(input) {
    const src = input && typeof input === 'object' ? input : {};
    const pos = src.position && typeof src.position === 'object' ? src.position : {};
    const thr = src.thresholds && typeof src.thresholds === 'object' ? src.thresholds : {};
    const pan = src.panel && typeof src.panel === 'object' ? src.panel : {};
    const yellow = clampNum(thr.yellowSec, 1, 3600, WIDGET_DEFAULTS.thresholds.yellowSec);
    const red = clampNum(thr.redSec, 2, 7200, WIDGET_DEFAULTS.thresholds.redSec);
    return {
      version: 1,
      position: {
        // 与挂件（lib/client.js 的 sanitize）保持同一套语义：只有明确 free 且真有坐标才算 free，
        // 否则一律 docked。此前两边规则相反，客户端存的 docked 会被宿主回读成 free（评审发现）。
        mode: (pos.mode === 'free' && clampPos(pos.left, null) !== null) || (pos.mode === 'free' && clampPos(pos.top, null) !== null) ? 'free' : 'docked',
        right: clampPos(pos.right, WIDGET_DEFAULTS.position.right),
        bottom: clampPos(pos.bottom, WIDGET_DEFAULTS.position.bottom),
        left: clampPos(pos.left, null),
        top: clampPos(pos.top, null),
      },
      size: clampNum(src.size, 0.6, 2, WIDGET_DEFAULTS.size),
      opacity: clampNum(src.opacity, 0.2, 1, WIDGET_DEFAULTS.opacity),
      accent: typeof src.accent === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(src.accent) ? src.accent : '',
      labels: src.labels !== false,
      thresholds: { yellowSec: yellow, redSec: Math.max(red, yellow + 1) },
      popups: src.popups !== false,
      popupDurationMs: clampNum(src.popupDurationMs, 1500, 60000, WIDGET_DEFAULTS.popupDurationMs),
      panel: { defaultOpen: pan.defaultOpen === true, width: clampNum(pan.width, 260, 620, WIDGET_DEFAULTS.panel.width) },
      theme: ['auto', 'dark', 'light'].includes(src.theme) ? src.theme : 'auto',
      hidden: src.hidden === true,
    };
  }

  function loadSettings() {
    safe('settings:load', () => {
      if (!fs.existsSync(settingsPath)) { saveSettings(); return; }
      widgetSettings = sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    });
  }

  function saveSettings() {
    safe('settings:save', () => {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = settingsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(widgetSettings, null, 2), 'utf8');
      fs.renameSync(tmp, settingsPath);
    });
  }

  const routeDisposers = [];
  /**
   * 路由注册用 ctx.inject(['webServer']) 等服务就位：
   * 本插件由 profile patch 插在最后，但 webServer 可能在自己的 fiber 里稍后就绪，
   * apply 期直接 ctx.get('webServer') 会拿到 undefined（实测就是这样）。
   * whale-widget 也是同款写法："root.inject(['webServer', ...], (ctx) => ...)"。
   */
  safe('routes:inject', () => {
    if (typeof ctx.inject !== 'function') return;
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped && scoped.webServer;
      if (!server || typeof server.register !== 'function') return;
      const add = (path, handler) => {
        try { routeDisposers.push(server.register({ kind: 'exact', path, handler })); }
        catch (error) { onInternal('routes:' + path, error); }
      };
      add('/api/jingcha/status', (req, res) => {
        if (!guard(req, res)) return;
        sendJson(res, 200, statusPayload());
      });
      add('/api/jingcha/kill', async (req, res) => {
        if (!guard(req, res, { mutation: true })) return;
        const payload = await readJsonBody(req);
        const reason = sanitizeReason(payload.reason, '挂件请求强制停止');
        const scope = payload.scope === 'all' ? 'all' : payload.scope === 'stalled' ? 'stalled' : undefined;
        const inflight = safe('api:inflight', () => monitor.inflightList(Date.now()), []) || [];
        const callId = payload.callId === undefined || payload.callId === null ? '' : String(payload.callId);
        if (callId) {
          const result = killCall(callId, reason);
          return sendJson(res, 200, {
            ok: result.ok === true, killed: result.ok ? [result.matchedId] : [],
            reason: result.reason, parentId: result.parentId, known: result.known,
            inflight: inflight.length,
          });
        }
        const killed = killScope(scope || 'stalled', reason);
        return sendJson(res, 200, { ok: true, killed, scope: scope || 'stalled', inflight: inflight.length });
      });
      add('/api/jingcha/stop', async (req, res) => {
        if (!guard(req, res, { mutation: true })) return;
        const payload = await readJsonBody(req);
        const agents = stopTurns(sanitizeReason(payload.reason, '挂件请求停止所有轮次'));
        sendJson(res, 200, { ok: true, agents });
      });
      add('/api/jingcha/settings', async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase();
        const isWrite = method === 'POST' || method === 'PUT';
        if (!guard(req, res, { mutation: isWrite })) return;
        if (isWrite) {
          const payload = await readJsonBody(req);
          widgetSettings = sanitizeSettings(payload && payload.settings ? payload.settings : payload);
          saveSettings();
          return sendJson(res, 200, { ok: true, settings: widgetSettings, file: path.basename(settingsPath) });
        }
        sendJson(res, 200, { ok: true, settings: widgetSettings, defaults: WIDGET_DEFAULTS, file: path.basename(settingsPath) });
      });
      if (routeDisposers.length > 0) {
        monitor.setExtra('api', { status: '/api/jingcha/status', kill: '/api/jingcha/kill', stop: '/api/jingcha/stop', settings: '/api/jingcha/settings' });
        log('挂件接口已就绪：/api/jingcha/status · /api/jingcha/kill · /api/jingcha/stop');
      }
      // 清理：跟着注入出来的作用域 fiber 一起卸载
      try {
        scoped.effect(() => () => {
          for (const dispose of routeDisposers) { try { dispose(); } catch { /* ignore */ } }
        }, 'jingcha.routes');
      } catch (error) { onInternal('routes:effect', error); }
    });
  });

  // ── 启动自述 ─────────────────────────────────────────────────────────────

  safe('startup:status', () => {
    monitor.setExtra('dataDir', dataDir);
    monitor.setExtra('tool', toolRegistered ? toolName : null);
    if (routeDisposers.length === 0) monitor.setExtra('api', null);
    sink.ensureDir();
    loadSettings();
    writeStatus(Date.now(), true);
  });
  log('已挂载 · 数据目录 ' + dataDir + ' · 查询工具 ' + (toolRegistered ? toolName : '（未注册）')
    + ' · 阈值 慢 ' + formatDuration(cfg.slowCallMs) + ' / 挂起 ' + formatDuration(cfg.hangCallMs) + ' / 卡住 ' + formatDuration(cfg.stuckCallMs)
    + ' · 静默 ' + formatDuration(cfg.silenceMs));

  // 便于测试/排障：把内部对象留在模块级（不往 ctx 上乱挂属性）。
  instances.push({ monitor, sink, config: cfg, toolName, startedAt: Date.now(), heartbeatOnce });
}

// 注意：故意**不做** default 导出。
// cordis 的 loader 会先 unwrapExports(exports) -> exports.default ?? exports，
// 一旦有 default，插件就退化成裸的 apply 函数，inject/name 全部丢失，
// 于是 ctx.tools 在 apply 与监听器里都会报 'cannot get property "tools" without inject'。
apply.inject = inject;
