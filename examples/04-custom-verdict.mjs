#!/usr/bin/env node
/**
 * 示例 04：直接用 lib/core.js（纯逻辑、零依赖）自己造一条判定。
 *
 * 这说明"加判定规则"不需要改宿主：core 可以被独立引入、喂数据、拿结论。
 */
import { createMonitor, formatBytes, formatDuration } from '../lib/core.js';

let clock = 1_700_000_000_000;
const now = () => clock;
const monitor = createMonitor({ slowCallMs: 5_000, hangCallMs: 10_000, stuckCallMs: 20_000, memoryLeakWindow: 3, memoryLeakGrowth: 0.05 }, now);

// 1) 一次正常调用
monitor.toolStart({ callId: 'c1', name: 'pwsh', arguments: { command: 'git status' } });
clock += 800;
monitor.toolFinish({ callId: 'c1', isError: false, contentBytes: 512 });
console.log('① 正常调用后：' + monitor.verdict().state);

// 2) 一个卡住的调用
monitor.toolStart({ callId: 'c2', name: 'run_code', arguments: { code: 'while (true) {}' } });
clock += 25_000;
monitor.tick(clock);
const stalled = monitor.verdict();
console.log('② 卡住 25s 后：' + stalled.state + '  理由：' + stalled.reasons.map((r) => r.kind).join(','));

// 3) 内存持续增长
let rss = 200 * 1024 * 1024;
for (let i = 0; i < 4; i++) {
  monitor.noteMemory(rss, clock);
  rss = Math.round(rss * 1.08);
  clock += 1_000;
  monitor.tick(clock);
}
const leak = monitor.verdict().reasons.find((r) => r.kind === 'memory-leak');
console.log('③ 连续增长后：' + (leak ? leak.text : '（未触发）'));

// 4) 自己拼一份摘要（宿主报告里的格式）
const snapshot = monitor.snapshot(clock);
console.log('④ 快照：判定=' + snapshot.verdict.state +
  ' · 在途=' + snapshot.work.inflight.length +
  ' · 延迟=' + formatDuration(snapshot.runtime.eventLoopLagMs) +
  ' · RSS=' + formatBytes(snapshot.runtime.rssBytes) +
  ' · 内存采样=' + snapshot.runtime.memoryLeak.samples + ' 个');
console.log('   （core.js 是纯逻辑：没有 IO、没有定时器、没有第三方依赖）');
