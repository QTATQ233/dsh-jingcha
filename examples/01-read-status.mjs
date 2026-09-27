#!/usr/bin/env node
/**
 * 示例 01：读一次快照，打印判定。
 *
 * 用法：
 *   node examples/01-read-status.mjs [status.json 路径]
 *
 * 退出码：判定是 ok / busy -> 0；degraded / erroring / stalled -> 1（方便挂到定时任务或 CI 上）。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const candidates = [
  process.argv[2],
  process.env.JINGCHA_STATUS,
  path.join(process.env.JINGCHA_DATA_DIR || '', 'status.json'),
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'data', 'dsh-jingcha', 'status.json'),
  path.resolve('.dsh-jingcha', 'status.json'),
  path.resolve('..', '.dsh-jingcha', 'status.json'),
].filter((candidate) => candidate && candidate.length > 1);
const file = candidates.find((candidate) => existsSync(candidate)) || candidates[0];

let snapshot;
try {
  snapshot = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error('读不到快照：' + file + '（' + error.message + '）');
  console.error('提示：插件没装、没重启，或 dataDir 不是默认位置。');
  process.exit(2);
}

const v = snapshot.verdict || {};
console.log('数据目录快照：' + file);
console.log('判定：' + (v.label || v.state) + '（' + v.state + '）  自 ' + v.since);
for (const reason of v.reasons || []) console.log('  · [' + reason.severity + '] ' + (reason.text || reason.kind));

const work = snapshot.work || {};
console.log('在途调用：' + (work.inflight || []).length + ' 个 · 运行中轮次 ' + (work.runningAgents || 0));
for (const call of work.inflight || []) {
  console.log('  - ' + call.tool + ' 已 ' + Math.round((call.elapsedMs || 0) / 1000) + 's' +
    (call.phase === 'run' ? '' : '（待派发）') + (call.preview ? '  ' + call.preview : ''));
}

const runtime = snapshot.runtime || {};
console.log('事件循环延迟：' + (runtime.eventLoopLagMs || 0) + 'ms（峰值 ' + (runtime.maxLagMs || 0) + 'ms）');
if (runtime.memoryLeak && runtime.memoryLeak.active) {
  console.log('内存泄漏预警：RSS 连续 ' + runtime.memoryLeak.window + ' 个心跳递增（+' +
    Math.round(runtime.memoryLeak.growth * 100) + '%）');
}

const healthy = v.state === 'ok' || v.state === 'busy';
process.exit(healthy ? 0 : 1);
