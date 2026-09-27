/**
 * 鲸察挂件（lib/client.js）· 无浏览器自检 v4
 * ============================================================================
 * 覆盖：形态/懒加载、阈值分级、拖动与立即持久化、五宫格复位、异常 toast、
 * 设置界面（阈值/滑块不重建 DOM/数字直填/主题三段/五宫格/面板高度）、
 * 主色色板（点外面才关、真正生效且不覆盖灯色）、主题跟随 DSH 界面、隐藏与找回、降级、清理。
 * 跑法：node test/verify-client.mjs
 */

let checks = 0;
let failures = 0;
const check = (label, ok, detail) => {
  checks++;
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + label + (ok || detail === undefined ? '' : ' — ' + String(detail).slice(0, 170)));
  if (!ok) failures++;
};

// ── 极小 DOM / BOM 桩 ───────────────────────────────────────────────────────
const created = [];
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '', className: '', innerHTML: '', title: '', value: '', checked: false,
    type: '', min: '', max: '', step: '',
    style: { setProperty(name, value) { el.style[name] = value; }, removeProperty(name) { delete el.style[name]; } },
    children: [], attributes: {}, handlers: {}, parentNode: null,
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    insertBefore(child) { child.parentNode = el; el.children.unshift(child); return child; },
    removeChild(child) { const i = el.children.indexOf(child); if (i >= 0) el.children.splice(i, 1); child.parentNode = null; return child; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { el.attributes[k] = String(v); if (k === 'id') el.id = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attributes, k); },
    removeAttribute(k) { delete el.attributes[k]; },
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    removeEventListener(type, fn) { const list = el.handlers[type] || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
    dispatch(type, event) { const list = (el.handlers[type] || []).slice(); for (const fn of list) fn(event || {}); },
    setPointerCapture() {}, releasePointerCapture() {},
    querySelector(sel) { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() {
      const l = parseFloat(el.style.left);
      const tp = parseFloat(el.style.top);
      const left = isFinite(l) ? l : 800;
      const top = isFinite(tp) ? tp : 700;
      return { left, top, right: left + 120, bottom: top + 28, width: 120, height: 28 };
    },
    focus() {}, blur() {},
    click() { if (typeof el.onclick === 'function') el.onclick({ stopPropagation() {} }); el.dispatch('click', { stopPropagation() {} }); },
  };
  let ownText = '';
  Object.defineProperty(el, 'textContent', {
    get() { return ownText; },
    set(value) {
      ownText = String(value === undefined || value === null ? '' : value);
      if (ownText === '') { for (const child of el.children) child.parentNode = null; el.children.length = 0; }
    },
    configurable: true,
  });
  created.push(el);
  return el;
}
const storage = new Map();
const documentStub = {
  head: makeEl('head'), body: makeEl('body'), documentElement: makeEl('html'),
  hidden: false, handlers: {},
  createElement: (tag) => makeEl(tag),
  createTextNode: (text) => ({ nodeValue: String(text), textContent: String(text), parentNode: null }),
  getElementById: (id) => created.find((node) => node.id === id) || null,
  addEventListener(type, fn) { (documentStub.handlers[type] = documentStub.handlers[type] || []).push(fn); },
  removeEventListener(type, fn) { const list = documentStub.handlers[type] || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
  dispatch(type, event) { const list = (documentStub.handlers[type] || []).slice(); for (const fn of list) fn(event || {}); },
  querySelector() { return null; }, querySelectorAll() { return []; },
};
const windowStub = {
  document: documentStub, innerWidth: 1280, innerHeight: 800,
  location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  confirm: () => true, console: { warn() {} },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
  },
  addEventListener() {}, removeEventListener() {},
};

// ── 可编程 fetch 桩 ────────────────────────────────────────────────────────
const calls = [];
let settingsReply = { thresholds: { yellowSec: 10, redSec: 20 }, position: { mode: 'docked', right: 14, bottom: 14, left: null, top: null }, theme: 'auto' };
let statusReply = null;
let failStatus = false;
const nowIso = () => new Date().toISOString();
function baseStatus(extra) {
  return Object.assign({
    generatedAt: nowIso(),
    verdict: { state: 'busy', label: '运行中', reasons: [] },
    runtime: { eventLoopLagMs: 9, maxLagMs: 40, rssBytes: 1 },
    work: { inflight: [], runningAgents: 1, counters: { toolCalls: 3, toolErrors: 0 } },
    findings: [],
  }, extra || {});
}
function fetchStub(url, options) {
  const target = String(url);
  const method = (options && options.method) || 'GET';
  calls.push({ url: target, method, body: options && options.body ? options.body : null });
  if (target.indexOf('/api/jingcha/settings') >= 0) {
    if (method === 'POST') { try { settingsReply = Object.assign({}, settingsReply, JSON.parse(options.body)); } catch (error) { /* ignore */ } }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, settings: settingsReply }) });
  }
  if (target.indexOf('/api/jingcha/status') >= 0) {
    if (failStatus) return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: true, status: 200, json: async () => statusReply || baseStatus() });
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
}

function textAll(node) {
  if (!node) return '';
  let out = String(node.textContent || '');
  for (const child of node.children || []) out += ' ' + textAll(child);
  return out;
}
function find(node, predicate, out) {
  out = out || [];
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) find(child, predicate, out);
  return out;
}
function attached(root, node) {
  let current = node;
  while (current) { if (current === root) return true; current = current.parentNode; }
  return false;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let entry = null;
windowStub.__ModuleLoader__ = { load(e) { entry = e; } };
globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.fetch = fetchStub;
try { Object.defineProperty(globalThis, 'location', { value: windowStub.location, configurable: true }); } catch (error) { /* ignore */ }

console.log('== 鲸察挂件自检 v4 ==');
await import('file:///C:/dsh-jingcha/lib/client.js');

check('以 __ModuleLoader__.load 登记', Boolean(entry));
check("id 等于包名 '@local/dsh-jingcha'", entry && entry.id === '@local/dsh-jingcha', entry && entry.id);
const mod = entry.factory((name) => { throw new Error('挂件不该 require 模块：' + name); });
check('factory 返回 { name, apply, __internals }', Boolean(mod && mod.name && typeof mod.apply === 'function' && mod.__internals));
check('apply 之前不碰 DOM（懒加载）', documentStub.body.children.length === 0, String(documentStub.body.children.length));

const it = mod.__internals;
check('levelOfCall：5s/15s/25s -> 绿/黄/红',
  it.levelOfCall(5000, { yellowSec: 10, redSec: 20 }) === 'green' && it.levelOfCall(15000, { yellowSec: 10, redSec: 20 }) === 'yellow' && it.levelOfCall(25000, { yellowSec: 10, redSec: 20 }) === 'red');
check('withAlpha：#2fbf71 + 0.16 -> 8 位十六进制', /^#2fbf71[0-9a-f]{2}$/.test(it.withAlpha('#2fbf71', 0.16)), it.withAlpha('#2fbf71', 0.16));
check('sanitize 自愈：free 但坐标为空 -> 右下角停靠', it.sanitize({ position: { mode: 'free', left: null, top: null } }).position.mode === 'docked');
check('sanitize：主色只接受 #rrggbb', it.sanitize({ accent: 'red' }).accent === '' && it.sanitize({ accent: '#AABBCC' }).accent === '#aabbcc');

// ── 挂载 / 轮询 / 灯色 ─────────────────────────────────────────────────────
const effects = [];
const ctx = { effect(cb) { const d = cb(); effects.push(d); return () => {}; }, on() {} };
statusReply = baseStatus({ work: { inflight: [{ callId: 'call_x', tool: 'pwsh', elapsedMs: 5000, preview: 'command=echo hi' }], runningAgents: 1, counters: { toolCalls: 5, toolErrors: 0 } } });
mod.apply(ctx);
check('apply 后把根节点挂到 body', documentStub.body.children.length > 0);
await sleep(20);
await it.poll();
const nodes = it.state().nodes;
check('轮询 GET /api/jingcha/status', calls.some((c) => c.url.indexOf('/api/jingcha/status') >= 0 && c.method === 'GET'));
check('从宿主读到设置（yellowSec=10/redSec=20）', it.state().settings.thresholds.yellowSec === 10 && it.state().settings.thresholds.redSec === 20);
statusReply = baseStatus({ work: { inflight: [{ callId: 'call_x', tool: 'pwsh', elapsedMs: 25000 }], runningAgents: 1, counters: {} } });
await it.poll();
check('25 秒的调用 -> 灯红', nodes.dot.getAttribute('data-level') === 'red', nodes.dot.getAttribute('data-level'));
check('未派发的调用显示「待派发」', (function () {
  statusReply = baseStatus({ work: { inflight: [{ callId: 'call_p', tool: 'pwsh', elapsedMs: 1000, phase: 'pre' }], runningAgents: 1, counters: {} } });
  return it.poll().then(function () { return textAll(nodes.body_calls).indexOf('待派发') >= 0; });
})(), textAll(nodes.body_calls));
check('久无产出的调用显示「静默」', (function () {
  statusReply = baseStatus({ work: { inflight: [{ callId: 'call_s', tool: 'pwsh', elapsedMs: 400000, silentMs: 300000, phase: 'run' }], runningAgents: 1, counters: {} } });
  return it.poll().then(function () { return textAll(nodes.body_calls).indexOf('静默') >= 0; });
})(), textAll(nodes.body_calls));
check('胶囊显示 工具名 + 时长', textAll(nodes.text).indexOf('pwsh') >= 0 && textAll(nodes.text).indexOf('25s') >= 0, textAll(nodes.text));

// ── 悬停看全文（省略号 -> 停一会儿弹完整小框）─────────────────────────────
statusReply = baseStatus({ work: { inflight: [{ callId: 'call_tip', tool: 'pwsh', elapsedMs: 3000, phase: 'run', preview: 'command=Get-ChildItem -Recurse -Force C:\\very\\long\\path | Where-Object { $_.Length -gt 1MB }' }], runningAgents: 1, counters: {} } });
await it.poll();
const tipTarget = find(nodes.body_calls, (n) => n.className && n.className.indexOf('jingcha-ellipsis') >= 0 && textAll(n).length > 5)[0];
check('在途行有可悬停的省略文本', Boolean(tipTarget), String(Boolean(tipTarget)));
check('省略文本不再挂原生 title（改用自绘提示）', tipTarget.getAttribute('title') === null, String(tipTarget.getAttribute('title')));
tipTarget.dispatch('pointerenter', {});
check('刚悬停时还没有提示框（要停一会儿）', find(nodes.root, (n) => n.className === 'jingcha-tip').length === 0);
await sleep((it.state().local.tipDelayMs || 500) + 150);
const tipBox = find(nodes.root, (n) => n.className === 'jingcha-tip')[0];
check('停够时间后弹出完整内容的小框', Boolean(tipBox) && textAll(tipBox).indexOf('Get-ChildItem -Recurse') >= 0, tipBox ? textAll(tipBox).slice(0, 80) : '（没有提示框）');
check('提示框不会被鼠标抢走悬停（pointer-events 关掉）', ((documentStub.getElementById('jingcha-style') || {}).textContent || '').indexOf('pointer-events:none') >= 0);
await it.poll();      // 模拟 1–2 秒一次的轮询重画
check('轮询重画后提示框还在（不闪烁）', find(nodes.root, (n) => n.className === 'jingcha-tip').length === 1, String(find(nodes.root, (n) => n.className === 'jingcha-tip').length));
tipTarget.dispatch('pointerleave', {});
await sleep(250);
check('移开鼠标先留一会儿（不是立刻消失）', find(nodes.root, (n) => n.className === 'jingcha-tip').length === 1);
await sleep((it.state().local.tipLingerMs || 1500) + 200);
check('停够 tipLingerMs 后才消失', find(nodes.root, (n) => n.className === 'jingcha-tip').length === 0);
tipTarget.scrollWidth = 100; tipTarget.clientWidth = 100;   // 假装没被截断
tipTarget.dispatch('pointerenter', {});
await sleep((it.state().local.tipDelayMs || 500) + 150);
check('没被截断的元素不弹提示', find(nodes.root, (n) => n.className === 'jingcha-tip').length === 0);
tipTarget.dispatch('pointerleave', {});

// ── 拖动：立即落盘 ─────────────────────────────────────────────────────────
calls.length = 0;
nodes.pod.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1, preventDefault() {} });
documentStub.dispatch('pointermove', { clientX: 140, clientY: 120 });
documentStub.dispatch('pointerup', {});
check('拖动后位置是 free 且坐标更新', it.state().settings.position.mode === 'free' && it.state().settings.position.left === 840 && it.state().settings.position.top === 720,
  JSON.stringify(it.state().settings.position));
await sleep(60);
check('拖完立刻 POST 位置（不防抖）', calls.some((c) => c.url.indexOf('/api/jingcha/settings') >= 0 && c.method === 'POST'));
check('本地记下 savedAt', it.state().local.savedAt > 0);

// ── 异常 toast ─────────────────────────────────────────────────────────────
statusReply = baseStatus({ findings: [{ at: new Date(Date.now() + 1000).toISOString(), kind: 'tool-hang', severity: 'warn', text: '工具 pwsh 已运行 2m00s 仍未返回' }] });
await it.poll();
check('新的 warn 告警 -> 右侧 toast', nodes.toasts.children.length === 1, String(nodes.toasts.children.length));

// 停不掉时要说人话（宿主返回 reason 就弹提示）
await (function () {
  statusReply = baseStatus({ work: { inflight: [{ callId: 'call_n', tool: 'pwsh', elapsedMs: 5000, phase: 'run' }], runningAgents: 1, counters: {} } });
  return it.poll();
})();
const killBtn = find(nodes.body_calls, (n) => n.tagName === 'BUTTON')[0];
check('在途行有 ⛔ 按钮', Boolean(killBtn));
await (async function () {
  const original = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).indexOf('/api/jingcha/kill') >= 0
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, reason: 'nested-parent-only' }) })
    : original(url, options);
  killBtn.onclick({ stopPropagation() {} });
  await sleep(60);
  globalThis.fetch = original;
})();
check('宿主拒绝强停 -> 右侧弹出人话提示', textAll(nodes.toasts).indexOf('父调用') >= 0, textAll(nodes.toasts).slice(0, 120));

// ── 设置界面 ───────────────────────────────────────────────────────────────
nodes.btnGear.click();
check('齿轮点开设置段', nodes.sec_settings.className.indexOf('jingcha-folded') < 0, nodes.sec_settings.className);

const sizeRange = find(nodes.body_settings, (n) => n.tagName === 'INPUT' && n.type === 'range' && n.getAttribute('aria-label') === '大小')[0];
check('大小滑块存在', Boolean(sizeRange));
const sizeNum = find(nodes.body_settings, (n) => n.tagName === 'INPUT' && n.type === 'number' && String(n.getAttribute('aria-label')).indexOf('大小') === 0)[0];
check('滑块后面有可直接输入的数字框', Boolean(sizeNum));
const beforeChildren = nodes.body_settings.children.length;
calls.length = 0;                     // 清掉前面拖动测试产生的 POST，只看滑块这一段
sizeRange.value = '1.4';
sizeRange.oninput();
await sleep(40);                       // 拖动中是按帧节流的
check('拖动滑块：数值即时生效（同一帧内节流）', Math.abs(it.state().settings.size - 1.4) < 1e-6, String(it.state().settings.size));
check('拖动滑块不会重建设置区（这是"顿挫"的根因）', nodes.body_settings.children.length === beforeChildren && attached(nodes.body_settings, sizeRange), String(nodes.body_settings.children.length));
check('拖动中不落盘（松手才存）', !calls.some((c) => c.method === 'POST'), JSON.stringify(calls.filter((c) => c.method === 'POST').map((c) => c.url)));
sizeRange.onchange();
await sleep(420);
check('松手后落盘', calls.some((c) => c.method === 'POST' && c.url.indexOf('/api/jingcha/settings') >= 0));

sizeNum.value = '0.9';
sizeNum.oninput();
await sleep(40);
check('数字框可直接输入并即时生效', Math.abs(it.state().settings.size - 0.9) < 1e-6, String(it.state().settings.size));

// 主题三段
const themeButtons = find(nodes.body_settings, (n) => n.getAttribute && n.getAttribute('data-theme'));
check('主题是三段按钮（跟随界面/深/浅）', themeButtons.length === 3 && find(nodes.body_settings, (n) => n.tagName === 'SELECT').length === 0, String(themeButtons.length));
themeButtons.find((b) => b.getAttribute('data-theme') === 'light').onclick();
check('点「浅色」立刻切主题', it.state().settings.theme === 'light' && nodes.root.className.indexOf('jingcha-theme-light') >= 0, nodes.root.className);
themeButtons.find((b) => b.getAttribute('data-theme') === 'dark').onclick();
check('点「深色」立刻切主题', it.state().settings.theme === 'dark' && nodes.root.className.indexOf('jingcha-theme-dark') >= 0, nodes.root.className);
find(nodes.body_settings, (n) => n.getAttribute && n.getAttribute('data-theme') === 'auto')[0].onclick();
check('切回「跟随界面」', it.state().settings.theme === 'auto');

// 跟随 DSH 界面主题
documentStub.body.setAttribute('data-ds-dark-theme', '');
check('uiIsDark 认 DSH 的 body[data-ds-dark-theme]', it.uiIsDark() === true && it.resolveTheme() === 'dark');
check('没有 getComputedStyle 时采样底色安全返回 null', (function () { try { return it.uiSurfaceColor() === null; } catch (error) { return false; } })());
await it.poll();
check('poll 时界面主题变了会跟上', nodes.root.className.indexOf('jingcha-theme-dark') >= 0, nodes.root.className);
documentStub.body.removeAttribute('data-ds-dark-theme');
check('去掉标记后回到浅色', it.uiIsDark() === false && it.resolveTheme() === 'light');

// 配色统一：胶囊与面板同一个基底色，文字色按底色选
const rgbTriple = (text) => {
  const m = /rgba?\((\d+),(\d+),(\d+)/.exec(String(text || ''));
  return m ? m[1] + ',' + m[2] + ',' + m[3] : null;
};
const darkPalette = it.paletteFor('dark');
const lightPalette = it.paletteFor('light');
check('深色调色板：胶囊与面板同色', rgbTriple(darkPalette.surface) === rgbTriple(darkPalette.surfaceSolid) && darkPalette.isDark === true,
  darkPalette.surface + ' / ' + darkPalette.surfaceSolid);
check('浅色调色板：胶囊与面板同色且判为浅色', rgbTriple(lightPalette.surface) === rgbTriple(lightPalette.surfaceSolid) && lightPalette.isDark === false);
check('文字色随底色：深色用浅字、浅色用深字', darkPalette.fg === '#e8eaed' && lightPalette.fg === '#1b1f24', darkPalette.fg + ' / ' + lightPalette.fg);
find(nodes.body_settings, (n) => n.getAttribute && n.getAttribute('data-theme') === 'dark')[0].onclick();
check('切到深色后：--j-surface 与 --j-surface-solid 同色、文字浅色',
  rgbTriple(nodes.root.style['--j-surface']) === rgbTriple(nodes.root.style['--j-surface-solid']) && nodes.root.style['--j-fg'] === '#e8eaed',
  String(nodes.root.style['--j-surface']) + ' / ' + String(nodes.root.style['--j-fg']));
check('切到浅色后：文字变深色', (function () {
  find(nodes.body_settings, (n) => n.getAttribute && n.getAttribute('data-theme') === 'light')[0].onclick();
  return nodes.root.style['--j-fg'] === '#1b1f24';
})(), String(nodes.root.style['--j-fg']));
find(nodes.body_settings, (n) => n.getAttribute && n.getAttribute('data-theme') === 'auto')[0].onclick();

// 面板直接内联上色（不依赖 CSS 变量兜底）
find(nodes.body_settings, (n) => n.getAttribute && n.getAttribute('data-theme') === 'dark')[0].onclick();
check('深色下面板直接拿到深底 + 浅字（内联，不看 CSS 兜底）',
  rgbTriple(nodes.panel.style.background) === rgbTriple(darkPalette.surfaceSolid) && nodes.panel.style.color === '#e8eaed',
  String(nodes.panel.style.background) + ' / ' + String(nodes.panel.style.color));
check('深浅两套的滑块轨道/控制色不同（深色下不再是原生灰）',
  darkPalette.track !== lightPalette.track && darkPalette.controlAccent !== lightPalette.controlAccent,
  darkPalette.track + ' vs ' + lightPalette.track);
const cssText = (documentStub.getElementById('jingcha-style') || {}).textContent || '';
check('滑块自绘轨道与滑块头（覆盖原生灰）',
  cssText.indexOf('::-webkit-slider-runnable-track') >= 0 && cssText.indexOf('::-webkit-slider-thumb') >= 0 && cssText.indexOf('::-moz-range-thumb') >= 0);
check('滑块控制色有兜底（--j-control-accent）', cssText.indexOf('--j-control-accent') >= 0);

// 回归：界面给了深色信号，但页面 body 底色是白的 —— 绝不能把面板刷成白底白字
windowStub.getComputedStyle = () => ({ backgroundColor: 'rgb(255,255,255)' });
documentStub.body.setAttribute('data-ds-dark-theme', '');
check('有主题信号时不采样页面底色', it.uiThemeSignal() === true);
find(nodes.body_settings, (n) => n.getAttribute && n.getAttribute('data-theme') === 'auto')[0].onclick();
check('回归：深色信号 + 白 body -> 面板仍是深底浅字',
  /27,29,33/.test(String(nodes.panel.style.background)) && nodes.panel.style.color === '#e8eaed',
  String(nodes.panel.style.background) + ' / ' + String(nodes.panel.style.color));
documentStub.body.removeAttribute('data-ds-dark-theme');
delete windowStub.getComputedStyle;

// 主色色板
const accentBtn = find(nodes.body_settings, (n) => n.className && n.className.indexOf('jingcha-accent-btn') >= 0)[0];
check('主色是可点的色板按钮（不是原生取色器）', Boolean(accentBtn) && find(nodes.body_settings, (n) => n.tagName === 'INPUT' && n.type === 'color').length === 0);
accentBtn.onclick({ stopPropagation() {} });
check('点开主色 -> 出现色板浮层', Boolean(it.state().palette), String(Boolean(it.state().palette)));
const swatches = find(it.state().palette, (n) => n.tagName === 'BUTTON');
check('色板里有预设色', swatches.length >= 8, String(swatches.length));
swatches[1].onclick({ stopPropagation() {} });
check('选一个预设色即生效', it.state().settings.accent === it.PRESET_COLORS[1], String(it.state().settings.accent));
check('色板选完不消失（要等点外面）', Boolean(it.state().palette));
await it.poll();
check('轮询（1-2 秒一次）不会把色板关掉/重建设置区', Boolean(it.state().palette) && attached(it.state().nodes.body_settings, find(it.state().nodes.body_settings, (n) => n.getAttribute && n.getAttribute('aria-label') === '大小')[0]),
  String(Boolean(it.state().palette)));
check('主色作用到胶囊强调（--j-accent）', nodes.root.style['--j-accent'] === it.PRESET_COLORS[1], String(nodes.root.style['--j-accent']));
check('主色淡色底是 8 位十六进制', /^#[0-9a-f]{8}$/.test(String(nodes.root.style['--j-accent-soft'])), String(nodes.root.style['--j-accent-soft']));
documentStub.dispatch('pointerdown', { target: nodes.root });
check('点浮层外面才关闭', !it.state().palette);
statusReply = baseStatus({ work: { inflight: [{ callId: 'call_x', tool: 'pwsh', elapsedMs: 25000 }], runningAgents: 1, counters: {} } });
await it.poll();
check('主色不覆盖灯色（红灯仍是红）', nodes.dot.getAttribute('data-level') === 'red' && String(nodes.dot.style['--j-dot']) === it.LEVEL_COLOR.red,
  nodes.dot.getAttribute('data-level') + ' / ' + String(nodes.dot.style['--j-dot']));

// 五宫格复位
const expected = {
  'top-left': (p) => p.mode === 'free' && p.left === 14 && p.top === 14,
  'top-right': (p) => p.mode === 'free' && p.left === 1280 - 120 - 14 && p.top === 14,
  'bottom-left': (p) => p.mode === 'free' && p.left === 14 && p.top === 800 - 28 - 14,
  'center': (p) => p.mode === 'free' && p.left === Math.round((1280 - 120) / 2) && p.top === Math.round((800 - 28) / 2),
  'bottom-right': (p) => p.mode === 'docked' && p.right === 14 && p.bottom === 14,
};
for (const name of Object.keys(expected)) {
  const button = find(nodes.body_settings, (n) => n.getAttribute && n.getAttribute('aria-label') === name)[0];
  if (!button) { check('复位按钮 ' + name + ' 存在', false); continue; }
  button.onclick();
  check('复位到 ' + name, expected[name](it.state().settings.position), JSON.stringify(it.state().settings.position));
}

// 折叠 / 面板高度
if (nodes.sec_findings.className.indexOf('jingcha-folded') >= 0) nodes.head_findings.onclick();
nodes.head_findings.onclick();
check('点标题折叠该段', nodes.sec_findings.className.indexOf('jingcha-folded') >= 0, nodes.sec_findings.className);
nodes.head_findings.onclick();
check('再点一次展开', nodes.sec_findings.className.indexOf('jingcha-folded') < 0);
const heightRange = find(nodes.body_settings, (n) => n.tagName === 'INPUT' && n.type === 'range' && n.getAttribute('aria-label') === '面板高度')[0];
heightRange.value = '400';
heightRange.oninput();
await sleep(40);
check('面板高度生效（--j-panel-h=400px）', String(nodes.root.style['--j-panel-h']) === '400px', String(nodes.root.style['--j-panel-h']));

// ── 恢复默认设置 ───────────────────────────────────────────────────────────
const resetBtn = find(nodes.body_settings, (n) => n.tagName === 'BUTTON' && textAll(n).indexOf('恢复默认设置') >= 0)[0];
check('设置里有「恢复默认设置」按钮', Boolean(resetBtn));
resetBtn.onclick();
check('恢复默认：主题回 auto、主色清空、大小回 1',
  it.state().settings.theme === 'auto' && it.state().settings.accent === '' && Math.abs(it.state().settings.size - 1) < 1e-6,
  JSON.stringify({ theme: it.state().settings.theme, accent: it.state().settings.accent, size: it.state().settings.size }));
check('恢复默认：阈值回 30/120', it.state().settings.thresholds.yellowSec === 30 && it.state().settings.thresholds.redSec === 120,
  JSON.stringify(it.state().settings.thresholds));
check('恢复默认：位置回右下角停靠', it.state().settings.position.mode === 'docked' && it.state().settings.position.right === 14);
check('恢复默认：面板高度回 340', it.state().local.maxHeight === 340, String(it.state().local.maxHeight));

// ── 隐藏 / 找回 ────────────────────────────────────────────────────────────
const hideBtn = find(nodes.body_settings, (n) => n.tagName === 'BUTTON' && textAll(n).indexOf('隐藏胶囊') >= 0)[0];
hideBtn.onclick();
check('隐藏后胶囊不可见', nodes.root.className.indexOf('jingcha-hidden') >= 0);
const chip = it.chip();
check('隐藏后出现「鲸察」找回胶囊', Boolean(chip) && chip.className.indexOf('jingcha-chip-restore') >= 0);
const chipCss = (documentStub.getElementById('jingcha-style') || {}).textContent || '';
check('找回胶囊是 fixed 定位', /\.jingcha-chip-restore\{[^}]*position:fixed/.test(chipCss));
chip.onclick();
check('点找回胶囊即恢复', it.state().settings.hidden === false && it.chip() === null);
documentStub.dispatch('keydown', { key: 'j', ctrlKey: true, shiftKey: true, preventDefault() {} });
check('Ctrl+Shift+J 能隐藏', it.state().settings.hidden === true && Boolean(it.chip()));
documentStub.dispatch('keydown', { key: 'J', ctrlKey: true, shiftKey: true, preventDefault() {} });
check('Ctrl+Shift+J 能恢复', it.state().settings.hidden === false && it.chip() === null);

// ── 降级 / 清理 ────────────────────────────────────────────────────────────
failStatus = true;
await it.poll();
check('接口挂掉 -> 灯灰 off', nodes.dot.getAttribute('data-level') === 'off');
check('接口挂掉 -> 文案提示未运行', textAll(nodes.text).indexOf('未运行') >= 0);
failStatus = false;
for (const dispose of effects) { try { dispose(); } catch (error) { check('清理不抛异常', false, error && error.message); } }
check('清理后 body 里不留节点', documentStub.body.children.length === 0, String(documentStub.body.children.length));
const styleNode = documentStub.getElementById('jingcha-style');
check('清理后样式标签从 head 摘掉', !styleNode || styleNode.parentNode === null);

console.log('\n挂件自检：检查项 ' + checks + ' 个，失败 ' + failures + ' 个');
if (failures > 0) process.exitCode = 1;
else console.log('全部通过 ✓（浏览器刷新即可，不需要重启 dsh）');
