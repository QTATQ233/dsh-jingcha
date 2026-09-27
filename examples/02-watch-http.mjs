#!/usr/bin/env node
/**
 * 示例 02：盯住 HTTP 接口，只在"判定变差"时打印。
 *
 * 用法：
 *   node examples/02-watch-http.mjs [--once] [--interval 2000] [--url http://127.0.0.1:3080]
 */
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const base = valueOf('--url', 'http://127.0.0.1:3080');
const once = has('--once');
const interval = Number(valueOf('--interval', '2000'));

let lastState = '';

async function poll() {
  try {
    const res = await fetch(base + '/api/jingcha/status', { headers: { accept: 'application/json' } });
    const snapshot = await res.json();
    const state = snapshot.verdict && snapshot.verdict.state;
    if (state !== lastState) {
      const reasons = (snapshot.verdict.reasons || []).map((r) => r.text || r.kind).slice(0, 3).join(' · ');
      console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + state + '  ' + (reasons || '无理由'));
      lastState = state;
    }
  } catch (error) {
    console.error(new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  拉取失败：' + error.message);
  }
}

await poll();
if (!once) setInterval(poll, interval);
