/**
 * 鲸察 (dsh-jingcha) · 真 cordis 集成测试
 * ============================================================================
 * 离线自检 test/verify.mjs 用假 ctx；这里换真的 @deepseek-ai/cordis：
 *   · 真实的事件注册与 waterfall 语义（next() 链、返回值透传）
 *   · 真实的 inject: ['tools'] 注入握手
 *   · 真实的 ctx.plugin()/fiber 卸载（dispose）
 *
 * 依赖解析：脚本自身位置能解析到 @deepseek-ai/cordis 时直接跑；否则用环境变量
 *   DSH_CORDIS 指向 cordis 的 lib/index.js（例如 npx 缓存里的那份）。
 * 解析不到就跳过（退出码 0），不算失败。
 *
 * 跑法：
 *   node test/verify-cordis.mjs
 *   $env:DSH_CORDIS='C:\...\node_modules\@deepseek-ai\cordis\lib\index.js'; node test/verify-cordis.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as plugin from '../lib/index.js';
import { instances } from '../lib/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', '.selftest-cordis');

let checks = 0;
let failures = 0;
function check(label, condition, detail) {
  checks++;
  if (condition) console.log('  [PASS] ' + label);
  else { failures++; console.log('  [FAIL] ' + label + (detail === undefined ? '' : ' — ' + detail)); }
}

// cordis 解析：环境变量优先，其次裸包名
let cordis;
const candidates = [];
if (process.env.DSH_CORDIS) candidates.push(pathToFileURL(process.env.DSH_CORDIS).href);
candidates.push('@deepseek-ai/cordis');
for (const candidate of candidates) {
  try { cordis = await import(candidate); break; } catch { /* 试下一个 */ }
}
if (!cordis || !cordis.Context) {
  console.log('[skip] 解析不到 @deepseek-ai/cordis，跳过真 cordis 集成测试。');
  console.log('       想跑就给 DSH_CORDIS 指到 cordis 的 lib/index.js。');
  process.exit(0);
}
console.log('使用 cordis: ' + (process.env.DSH_CORDIS || '@deepseek-ai/cordis'));

fs.rmSync(outDir, { recursive: true, force: true });

const ctx = new cordis.Context();
const registered = [];
let toolsService = null;
try {
  ctx.provide('tools', {
    register(definition) { registered.push(definition); return () => {}; },
    get() { return { timeoutMs: 30_000 }; },
    restrict() {},
  });
  toolsService = ctx.get('tools');
} catch (error) {
  console.log('[skip] 这个 cordis 版本没法注入假 tools 服务：' + error.message);
  process.exit(0);
}
check('假 tools 服务已就位', Boolean(toolsService));
check('模块无 default 导出（否则 loader 的 unwrapExports 会丢掉 inject）', plugin.default === undefined, String(plugin.default));
check('模块带 inject: [tools]', Array.isArray(plugin.inject) && plugin.inject.indexOf('tools') >= 0, JSON.stringify(plugin.inject));

const logs = [];
const realLog = console.log;
console.log = (...args) => logs.push(args.join(' '));
console.log = realLog;

const fiber = await ctx.plugin(plugin, { dataDir: outDir, heartbeatMs: 600_000, console: false, statusEveryMs: 600_000 });
check('ctx.plugin() 成功挂载（inject: tools 握手通过）', instances.length === 1, String(instances.length));
check('工具已注册到 ctx.tools', registered.length === 1 && registered[0].name === 'jingcha_status', String(registered.length));

// 真实 waterfall：pre-execute（next 的裁决必须原样返回）
const exec = { callId: 'c1', name: 'pwsh', arguments: { command: 'echo hi' } };
const decision = { kind: 'allow' };
const preOut = await ctx.waterfall(ctx, 'tools/pre-execute', exec, async () => decision);
check('pre-execute 裁决透传', preOut === decision, JSON.stringify(preOut));

// 真实 waterfall：execute
const result = { isError: false, content: [{ type: 'text', text: 'ok' }] };
const execOut = await ctx.waterfall(ctx, 'tools/execute', exec, async () => result);
check('execute 结果透传', execOut === result);

// 真实 emit：tools/result
ctx.emit('tools/result', exec, { isError: false, content: [{ type: 'text', text: 'ok' }] });
const live = instances[instances.length - 1];
check('调用被记账（含声明超时）', live.monitor.peek().calls.length === 1 && live.monitor.peek().calls[0].declaredTimeoutMs === 30_000,
  JSON.stringify(live.monitor.peek().calls.map((c) => ({ n: c.name, t: c.declaredTimeoutMs }))));

// 真实 emit：agent 状态与流式帧
const agent = { id: 'agent-x', session: { id: 'session-x' } };
ctx.emit('agent/status', { agent, status: 'running' });
ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', turn: 1, index: 0, chunk: 'hi' } });
check('agent 状态与流式帧被记账', live.monitor.peek().agents.length === 1 && live.monitor.peek().counters.streamChunks === 1,
  JSON.stringify(live.monitor.peek().agents));

// 真实 waterfall：agent/request-error（必须调用 next() 并透传）
let nextCalled = false;
const reqOut = await ctx.waterfall(ctx, 'agent/request-error', { agent, failure: { message: 'boom' } }, async () => { nextCalled = true; return { kind: 'retry' }; });
check('request-error 透传重试决策', nextCalled === true && reqOut && reqOut.kind === 'retry', JSON.stringify(reqOut));

// 工具执行
const value = await registered[0].execute({ windowMinutes: 1 });
check('查询工具在真 cordis 下可用', Boolean(value && value.report && value.report.length > 100));
await live.sink.flush();
await live.sink.close();
check('状态快照已落盘', fs.existsSync(path.join(outDir, 'status.json')), outDir);

// 卸载：真 fiber 生命周期（effect disposer 会被 await）
await live.sink.flush();
await fiber.dispose();
check('dispose 后插件实例被清理', instances.length === 0, String(instances.length));

console.log('\n真 cordis 集成测试：检查项 ' + checks + ' 个，失败 ' + failures + ' 个');
if (failures > 0) process.exitCode = 1;
else console.log('全部通过 ✓');
