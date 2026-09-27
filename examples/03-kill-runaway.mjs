#!/usr/bin/env node
/**
 * 示例 03：强制停止一个（跑飞了的）工具调用。
 *
 * 用法：
 *   node examples/03-kill-runaway.mjs                     # 只预览，不停
 *   node examples/03-kill-runaway.mjs --callId <id> --yes # 停指定的
 *   node examples/03-kill-runaway.mjs --oldest --yes      # 停最久的那个
 *   node examples/03-kill-runaway.mjs --scope stalled --yes
 *
 * 安全：默认 dry-run；只有显式 --yes 才会真的 POST /api/jingcha/kill。
 */
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const base = valueOf('--url', 'http://127.0.0.1:3080');
const callId = valueOf('--callId', '');
const scope = valueOf('--scope', '');
const oldest = has('--oldest');
const confirmed = has('--yes');

const snapshot = await (await fetch(base + '/api/jingcha/status')).json();
const inflight = (snapshot.work && snapshot.work.inflight) || [];
if (inflight.length === 0) {
  console.log('当前没有在途调用，无事可做。');
  process.exit(0);
}

console.log('在途调用：');
for (const call of inflight) {
  console.log('  ' + call.callId + '  ' + call.tool + '  已 ' + Math.round((call.elapsedMs || 0) / 1000) + 's' +
    (call.preview ? '  ' + call.preview : ''));
}

let target = callId;
if (!target && oldest) {
  target = inflight.slice().sort((a, b) => (b.elapsedMs || 0) - (a.elapsedMs || 0))[0].callId;
}
const body = target ? { callId: target, reason: '示例脚本强制停止' } : { scope: scope || 'stalled', reason: '示例脚本强制停止' };

if (!confirmed) {
  console.log('\n（dry-run）将要 POST /api/jingcha/kill ' + JSON.stringify(body));
  console.log('确认无误后加 --yes 再跑一次。');
  process.exit(0);
}

const res = await fetch(base + '/api/jingcha/kill', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(body),
});
const result = await res.json();
console.log('\n宿主回答：' + JSON.stringify(result));
if (result.ok === true) console.log('已停止：' + result.killed.join(', '));
else console.log('没停掉，原因：' + (result.reason || '未知') + (result.parentId ? '（父调用 ' + result.parentId + ' 还在跑）' : ''));
