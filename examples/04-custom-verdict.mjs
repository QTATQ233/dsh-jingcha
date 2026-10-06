#!/usr/bin/env node
/**
 * 示例 04：用 0.5 的注册 API 加一条自己的判定规则（不改宿主、不改 core）。
 *
 * 对照：
 *   本文件          = 新方式：monitor.registerRule({ id, evaluate })，可开关、可注销、进事件流；
 *   04a-old-way.mjs = 0.5 之前的兼容写法：直接 createMonitor 喂事实、拿 verdict。
 */
import { createMonitor } from '../lib/core.js';

let clock = 1_700_000_000_000;
const now = () => clock;
const monitor = createMonitor({ slowCallMs: 5_000 }, now);

console.log('① 注册自定义规则 long-shell（pwsh 跑过 4 分钟就报，并把状态升级为 stalled）');
const cancel = monitor.registerRule({
  id: 'long-shell',
  title: 'shell 调用超过 4 分钟',
  escalate: 'stall',
  evaluate(ctx) {
    return ctx.inflight
      .filter((c) => c.tool === 'pwsh' && c.elapsedMs >= 4 * 60_000)
      .map((c) => ({
        kind: 'shell-slow',
        severity: 'warn',
        tool: c.tool,
        callId: c.callId,
        elapsedMs: c.elapsedMs,
        text: 'pwsh 已跑 ' + ctx.helpers.formatDuration(c.elapsedMs),
      }));
  },
});
console.log('   注册' + (typeof cancel === 'function' ? '成功（返回取消函数）' : '失败（契约不合或 id 重复）'));

// 造事实：一个跑了 4 分 10 秒的 pwsh
monitor.toolStart({ callId: 'c1', name: 'pwsh', arguments: { command: 'npm run build' } });
clock += 250_000;
monitor.tick(clock);
const hit = monitor.verdict();
console.log('② 命中：state=' + hit.state + '  理由=' + hit.reasons.map((r) => r.kind).join(','));
console.log('   （shell-slow 是 warn，escalate: stall 把整体状态升到了 stalled）');

// 运行期停用 / 再启用
monitor.setRuleEnabled('long-shell', false);
console.log('③ 停用后理由=' + monitor.verdict().reasons.map((r) => r.kind).join(',') + '（shell-slow 消失，内置理由还在）');
monitor.setRuleEnabled('long-shell', true);

// 规则清单：来源 / 开关 / 升级语义 / 抛错次数
const rules = monitor.listRules();
console.log('④ 规则清单（' + rules.length + ' 条，含内置 8 条）：');
for (const r of rules) {
  console.log('   - ' + r.id + '  [' + r.source + ']  enabled=' + r.enabled + '  escalate=' + r.escalate + '  failures=' + r.failures);
}

// 失败隔离：规则抛错不中断判定，只记账（failures + plugin.error）
monitor.registerRule({ id: 'broken-rule', title: '故意抛错', evaluate() { throw new Error('boom'); } });
const after = monitor.verdict();
const broken = monitor.listRules().find((r) => r.id === 'broken-rule');
console.log('⑤ 抛错规则：判定照常返回（state=' + after.state + '，理由=' + after.reasons.map((r) => r.kind).join(',') + '）');
console.log('   broken-rule failures=' + broken.failures + '（不影响其它规则与调用）');
monitor.unregisterRule('broken-rule');

// 注销（registerRule 的返回值也能取消）
console.log('⑥ 注销 long-shell：' + monitor.unregisterRule('long-shell'));
console.log('   之后理由=' + monitor.verdict().reasons.map((r) => r.kind).join(','));