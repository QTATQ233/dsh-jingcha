/**
 * 鲸察挂件（@local/dsh-jingcha 的客户端面）· v4
 * ============================================================================
 * v4 针对反馈继续打磨：
 *   1) 滑块顺滑：拖动过程中**只更新样式与数值，不重建 DOM**（v3 每次 input 都重建设置区，
 *      导致 range 被替换、指针丢失 = 顿挫难拖）；松手（change）才落盘。滑块更大更好抓。
 *   2) 每个滑块后面跟一个数字输入框，可直接键入精确值（双向同步）。
 *   3) 主题「跟随系统」改成**跟随 DSH 界面主题**：以 body[data-ds-dark-theme] /
 *      html[data-ds-theme-source] 为准（这是 DSH 客户端主题真正落到的 DOM 标记），
 *      再退回 prefers-color-scheme；并订阅客户端 theme/change 事件与轮询兜底。
 *   4) 主色真正生效：胶囊描边/面板标题条/按钮悬停/滑块轨道都用它；**灯色永远是状态色**
 *      （绿/黄/红/橙），不被主色覆盖——两者各司其职。
 *   5) 主色改成自绘色板浮层：点开后有预设色 + 十六进制输入 + 「跟随主题」，
 *      **只有点击浮层外面（或 Esc）才关闭**，不会点一下就消失。
 *   6) 位置复位给全：左上 / 右上 / 左下 / 右下 / 居中，各一个按钮；位置仍然"记住上次"。
 *
 * 形态与约束不变：IIFE + window.__ModuleLoader__.load({ id, factory })；id 等于包名；
 * factory 懒执行；零 require；纯 DOM；副作用由 ctx.effect 交回清理。
 */
(function () {
  'use strict';

  var sink = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined;
  if (!sink || typeof sink.load !== 'function') return;

  var PACKAGE_ID = '@local/dsh-jingcha';

  sink.load({
    id: PACKAGE_ID,
    factory: function factory(require) { // eslint-disable-line no-unused-vars
      var API = { status: '/api/jingcha/status', kill: '/api/jingcha/kill', stop: '/api/jingcha/stop', settings: '/api/jingcha/settings' };
      var STORE_KEY = 'jingcha.widget.settings.v1';
      var SEEN_KEY = 'jingcha.widget.lastSeenAt';
      var LOCAL_KEY = 'jingcha.widget.local.v1';
      var DRAG_THRESHOLD = 4;
      var SNAP = 16;
      var PRESET_COLORS = ['#2fbf71', '#3aa7f0', '#8b5cf6', '#e5484d', '#ef8f3a', '#e2b93b', '#14b8a6', '#ec4899', '#64748b', '#0ea5e9', '#84cc16', '#f97316'];
      // 迷你时间线（ROADMAP 0.5）：全部在客户端本地累积，轮询顺手采样，不新增宿主接口。
      var TL_SLOTS = 30;          // 最近 5 分钟 ÷ 10 秒 = 30 段
      var TL_SPAN_MS = 300000;
      var HISTORY_MAX = 150;      // 采样上限（≈5 分钟 @2s 轮询）：内存有界，超出从头裁
      var TL_REASON_MAX = 4;      // 每个采样点最多留几条理由
      var TL_TEXT_MAX = 90;       // 每条理由最长多少字
      var LEVEL_RANK = { off: 0, idle: 0, green: 1, yellow: 2, orange: 3, red: 4 };   // 同一段里取最严重的

      var STR = {
        name: '鲸察', off: '鲸察未运行',
        idle: '空闲', busy: '运行中', degraded: '偏慢', erroring: '出错', stalled: '疑似卡住',
        state: '判定', inflight: '在途调用', findings: '最近告警', settings: '设置', none: '暂无',
        kill: '停', killTitle: '强制停止这个调用', killStalled: '停掉卡住的',
        stopAll: '停止所有轮次', stopAllConfirm: '确定停止所有正在跑的轮次？（包括其它会话）',
        yellowSec: '黄灯秒', redSec: '红灯秒', size: '大小', opacity: '不透明度', accent: '主色',
        accentFollow: '跟随主题', labels: '显示文字', theme: '主题', themeAuto: '跟随界面', themeDark: '深色', themeLight: '浅色',
        popups: '异常提示', popupMs: '提示停留', panelWidth: '面板宽度', panelHeight: '面板高度',
        tips: '悬停看全文', tipDelay: '悬停延迟', tipLinger: '提示停留',
        preset: '位置复位', resetPos: '右下角', center: '居中',
        hide: '隐藏胶囊', saved: '已保存', localOnly: '本地生效',
        loopLag: '事件循环延迟', agents: '运行中轮次', calls: '调用/失败',
        resetAll: '恢复默认设置', resetAllHint: '位置/主题/主色/阈值/外观全部回到出厂',
        hint: '拖动胶囊可移动；位置会自动记住', foldHint: '点标题可折叠',
        accentHint: '主色影响胶囊描边与面板强调；灯色始终表示状态',
        timeline: '时间线', tlSlots: '5 分钟 · 30 段', tlNow: '现在', tlBefore: '前',
        tlGap: '空档', tlGapWhy: '这一段没有采样', tlEmpty: '还没有采样', tlOk: '正常', tlPoints: '采样'
      };

      var DEFAULTS = {
        version: 2,
        position: { mode: 'docked', right: 14, bottom: 14, left: null, top: null },
        size: 1, opacity: 0.92, accent: '', labels: true,
        thresholds: { yellowSec: 30, redSec: 120 },
        popups: true, popupDurationMs: 6000,
        panel: { defaultOpen: false, width: 320 },
        theme: 'auto', hidden: false
      };
      var LOCAL_DEFAULTS = { savedAt: 0, maxHeight: 340, tips: true, tipDelayMs: 500, tipLingerMs: 1500, fold: { state: false, timeline: false, calls: false, findings: true, settings: true } };
      var LEVEL_COLOR = { green: '#2fbf71', yellow: '#e2b93b', orange: '#ef8f3a', red: '#e5484d', idle: '#7a8698', off: '#9aa3af' };

      // ── 纯函数 ─────────────────────────────────────────────────────────
      function clampNum(value, min, max, fallback) {
        var n = Number(value);
        if (!isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
      }
      function clampPos(value, fallback) {
        if (value === null || value === undefined) return fallback;
        var n = Number(value);
        if (!isFinite(n)) return fallback;
        return Math.round(Math.min(20000, Math.max(-20000, n)));
      }
      function sanitize(input) {
        var src = input && typeof input === 'object' ? input : {};
        var pos = src.position && typeof src.position === 'object' ? src.position : {};
        var thr = src.thresholds && typeof src.thresholds === 'object' ? src.thresholds : {};
        var pan = src.panel && typeof src.panel === 'object' ? src.panel : {};
        var yellow = clampNum(thr.yellowSec, 1, 3600, DEFAULTS.thresholds.yellowSec);
        var red = clampNum(thr.redSec, 2, 7200, DEFAULTS.thresholds.redSec);
        var left = clampPos(pos.left, null);
        var top = clampPos(pos.top, null);
        var mode = pos.mode === 'free' ? 'free' : 'docked';
        if (mode === 'free' && left === null && top === null) mode = 'docked';
        return {
          version: 2,
          position: { mode: mode, right: clampPos(pos.right, DEFAULTS.position.right), bottom: clampPos(pos.bottom, DEFAULTS.position.bottom), left: left, top: top },
          size: clampNum(src.size, 0.6, 2, DEFAULTS.size),
          opacity: clampNum(src.opacity, 0.2, 1, DEFAULTS.opacity),
          accent: typeof src.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(src.accent) ? src.accent.toLowerCase() : '',
          labels: src.labels !== false,
          thresholds: { yellowSec: yellow, redSec: Math.max(red, yellow + 1) },
          popups: src.popups !== false,
          popupDurationMs: clampNum(src.popupDurationMs, 1500, 60000, DEFAULTS.popupDurationMs),
          panel: { defaultOpen: pan.defaultOpen === true, width: clampNum(pan.width, 260, 620, DEFAULTS.panel.width) },
          theme: src.theme === 'dark' || src.theme === 'light' ? src.theme : 'auto',
          hidden: src.hidden === true
        };
      }
      function sanitizeLocal(input) {
        var src = input && typeof input === 'object' ? input : {};
        var fold = src.fold && typeof src.fold === 'object' ? src.fold : {};
        return {
          savedAt: clampNum(src.savedAt, 0, 4102444800000, LOCAL_DEFAULTS.savedAt),
          maxHeight: clampNum(src.maxHeight, 200, 640, LOCAL_DEFAULTS.maxHeight),
          tips: src.tips !== false,
          tipDelayMs: clampNum(src.tipDelayMs, 150, 3000, LOCAL_DEFAULTS.tipDelayMs),
          tipLingerMs: clampNum(src.tipLingerMs, 0, 8000, LOCAL_DEFAULTS.tipLingerMs),
          fold: { state: fold.state === true, timeline: fold.timeline === true, calls: fold.calls === true, findings: fold.findings !== false, settings: fold.settings !== false }
        };
      }
      function levelOfCall(elapsedMs, thresholds) {
        var thr = thresholds || DEFAULTS.thresholds;
        var ms = Number(elapsedMs) || 0;
        if (ms > Number(thr.redSec) * 1000) return 'red';
        if (ms > Number(thr.yellowSec) * 1000) return 'yellow';
        return 'green';
      }
      function pickLight(status, settings) {
        var cfg = settings || DEFAULTS;
        if (!status || !status.verdict) return { level: 'off', text: STR.off, tool: '', elapsedMs: 0, state: 'off' };
        var inflight = status.work && status.work.inflight ? status.work.inflight : [];
        var worst = '';
        var longest = { ms: -1, tool: '' };
        for (var i = 0; i < inflight.length; i++) {
          var call = inflight[i] || {};
          var level = levelOfCall(call.elapsedMs, cfg.thresholds);
          if (level === 'red') worst = 'red';
          else if (level === 'yellow' && worst !== 'red') worst = 'yellow';
          else if (!worst) worst = 'green';
          if ((call.elapsedMs || 0) > longest.ms) longest = { ms: call.elapsedMs || 0, tool: call.tool || '' };
        }
        var state = status.verdict.state || 'ok';
        var out = worst;
        if (state === 'stalled') out = 'red';
        else if (state === 'erroring') out = out === 'red' ? 'red' : 'orange';
        else if (!out) out = state === 'busy' ? 'green' : state === 'degraded' ? 'yellow' : 'idle';
        var text = longest.tool ? longest.tool + ' ' + fmtDur(longest.ms) : (status.verdict.label || '');
        return { level: out, text: text, tool: longest.tool, elapsedMs: Math.max(0, longest.ms), state: state };
      }

      // ── 迷你时间线（纯逻辑） ───────────────────────────────────────────
      // 采样点形状：{ at: 本地毫秒时间戳, state: 判定状态, label: 判定文字, reasons: [短文本] }。
      // 只活在内存里（刷新即清空），条数由 HISTORY_MAX 夹紧 —— 不会无界增长。
      /** 判定状态 -> 灯色级别：借道 pickLight，和胶囊/色点共用同一套映射，不另立配色表。 */
      function stateLevel(state) {
        if (!state || state === 'off') return 'off';
        return pickLight({ verdict: { state: state, label: '', reasons: [] } }, DEFAULTS).level;
      }
      function sampleLevel(sample) { return sample ? stateLevel(sample.state) : 'off'; }
      /** 采样点的判定文字：优先用宿主给的 label，退回挂件词表。 */
      function sampleLabel(sample) {
        if (!sample || sample.state === 'off') return STR.off;
        if (sample.label) return String(sample.label);
        return STR[sample.state] || (sample.state === 'ok' ? STR.tlOk : String(sample.state || ''));
      }
      /** 理由压成有界短文本（条数 + 单条长度都夹紧），长时间运行也不会把内存吃满。 */
      function sampleReasons(verdict) {
        var list = (verdict && verdict.reasons) || [];
        var out = [];
        for (var i = 0; i < list.length && out.length < TL_REASON_MAX; i++) {
          var reason = list[i] || {};
          var text = reason.text === undefined || reason.text === null || reason.text === '' ? reason.kind : reason.text;
          if (!text) continue;
          text = String(text);
          out.push(text.length > TL_TEXT_MAX ? text.slice(0, TL_TEXT_MAX - 1) + '…' : text);
        }
        return out;
      }
      /**
       * 采样点 -> slots 个等宽段：index 0 = 最新（渲染时靠右），落在 5 分钟窗口外的直接丢。
       * 返回定长数组：没采样的段是 null；同一段里多个采样取最严重的当代表（同级取更新的那个）。
       */
      function bucketize(samples, now, slots, spanMs) {
        var count = Math.max(1, Math.floor(Number(slots) || 1));
        var width = Math.max(1, Number(spanMs) || 1) / count;
        var at = Number(now);
        if (!isFinite(at)) at = Date.now();
        var out = [];
        var i;
        for (i = 0; i < count; i++) out.push(null);
        var list = samples || [];
        for (i = 0; i < list.length; i++) {
          var sample = list[i];
          if (!sample) continue;
          var when = Number(sample.at);
          if (!isFinite(when)) continue;
          var age = at - when;
          if (age < 0) age = 0;                      // 时钟回拨/未来时间：算作「刚刚」
          var index = Math.floor(age / width);
          if (index < 0 || index >= count) continue;
          var level = sampleLevel(sample);
          var slot = out[index];
          if (!slot) {
            out[index] = { index: index, level: level, at: when, state: sample.state, label: sample.label, reasons: sample.reasons || [], count: 1 };
          } else {
            slot.count++;
            if (level === slot.level ? when > slot.at : (LEVEL_RANK[level] || 0) > (LEVEL_RANK[slot.level] || 0)) {
              slot.level = level; slot.at = when; slot.state = sample.state; slot.label = sample.label; slot.reasons = sample.reasons || [];
            }
          }
        }
        return out;
      }
      function fmtDur(ms) {
        var s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60);
        if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
        return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
      }
      function timeOf(iso) { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); } catch (error) { return ''; } }
      function textOf(node, text) { if (node) node.textContent = text === undefined || text === null ? '' : String(text); }
      function el(tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
      }
      /** #rrggbb + 透明度 -> #rrggbbaa（主色的淡色底）。 */
      function withAlpha(hex, alpha) {
        if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return 'transparent';
        var a = Math.round(clampNum(alpha, 0, 1, 0.15) * 255).toString(16).padStart(2, '0');
        return hex + a;
      }
      /** 解析 rgb()/rgba() 颜色文本。 */
      function parseColor(text) {
        var m = /rgba?\(([^)]+)\)/.exec(String(text || ''));
        if (!m) return null;
        var parts = m[1].split(',').map(function (piece) { return parseFloat(piece); });
        if (parts.length < 3) return null;
        for (var i = 0; i < 3; i++) if (!isFinite(parts[i])) return null;
        return { r: Math.round(parts[0]), g: Math.round(parts[1]), b: Math.round(parts[2]), a: parts.length > 3 && isFinite(parts[3]) ? parts[3] : 1 };
      }
      /** 采样页面真正在用的底色（DSH 用自定义主题时属性可能不可靠，底色最诚实）。 */
      function uiSurfaceColor() {
        try {
          if (!window.getComputedStyle) return null;
          var list = [document.body, document.documentElement];
          for (var i = 0; i < list.length; i++) {
            var node = list[i];
            if (!node || !node.tagName) continue;
            var color = parseColor(window.getComputedStyle(node).backgroundColor);
            if (color && color.a > 0.5) return color;
          }
        } catch (error) { /* ignore */ }
        return null;
      }
      /** 当前界面到底是不是深色：DSH 主题属性 → 页面底色亮度 → 系统偏好。 */
      function uiIsDark() {
        try {
          if (document.body && document.body.hasAttribute && document.body.hasAttribute('data-ds-dark-theme')) return true;
          if (document.documentElement && document.documentElement.hasAttribute && document.documentElement.hasAttribute('data-ds-dark-theme')) return true;
          var ds = document.documentElement && document.documentElement.dataset ? document.documentElement.dataset : {};
          if (ds.dsThemeSource === 'dark') return true;
          if (ds.dsThemeSource === 'light') return false;
        } catch (error) { /* ignore */ }
        var surface = uiSurfaceColor();
        if (surface) {
          var luminance = (0.2126 * surface.r + 0.7152 * surface.g + 0.0722 * surface.b) / 255;
          return luminance < 0.5;
        }
        try { if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true; } catch (error) { /* ignore */ }
        return false;
      }

      // ── 状态 ───────────────────────────────────────────────────────────
      var settings = sanitize(DEFAULTS);
      var local = sanitizeLocal(LOCAL_DEFAULTS);
      var lastStatus = null;
      var lastError = false;
      var seenAt = 0;
      var timer = null;
      var panelOpen = false;
      var nodes = null;
      var chip = null;
      var toasts = [];
      var saveTimer = null;
      var disposed = false;
      var dragCleanup = null;
      var mediaCleanup = null;
      var paletteEl = null;
      var lastTheme = '';
      var controlBusy = false;   // 用户正在拖滑块/输入数字时为 true：禁止任何重建设置区 */
      var history = [];          // 迷你时间线：客户端本地采样（不新增宿主接口），上限 HISTORY_MAX
      var tlNodes = null;        // 时间线那一条的 DOM 引用：轮询里只改色/标题，绝不重建

      function storeGet(key) { try { return window.localStorage.getItem(key); } catch (error) { return null; } }
      function storeSet(key, value) { try { window.localStorage.setItem(key, value); } catch (error) { /* ignore */ } }
      function loadLocal() {
        var raw = storeGet(STORE_KEY);
        if (raw) { try { settings = sanitize(JSON.parse(raw)); } catch (error) { /* ignore */ } }
        var rawLocal = storeGet(LOCAL_KEY);
        if (rawLocal) { try { local = sanitizeLocal(JSON.parse(rawLocal)); } catch (error) { /* ignore */ } }
        var seen = Number(storeGet(SEEN_KEY));
        if (isFinite(seen) && seen > 0) seenAt = seen;
      }
      function persistLocal() { storeSet(LOCAL_KEY, JSON.stringify(local)); }
      /** 每次轮询顺手记一个采样点（拿不到宿主就记 off）；超出上限从头裁掉，内存有界。 */
      function recordSample(status, at) {
        var when = Number(at);
        if (!isFinite(when)) when = Date.now();
        var verdict = status && status.verdict ? status.verdict : null;
        history.push({
          at: when,
          state: verdict && verdict.state ? String(verdict.state) : 'off',
          label: verdict && verdict.label ? String(verdict.label).slice(0, 40) : '',
          reasons: sampleReasons(verdict)
        });
        if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
      }

      function httpJson(method, url, body) {
        var options = { method: method, headers: { accept: 'application/json' }, credentials: 'same-origin' };
        if (body !== undefined) {
          options.headers['content-type'] = 'application/json';
          options.body = JSON.stringify(body);
        }
        return fetch(url, options).then(function (res) {
          return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; },
            function () { return { ok: res.ok, status: res.status, json: null }; });
        });
      }
      function savePositionNow() {
        local.savedAt = Date.now();
        persistLocal();
        storeSet(STORE_KEY, JSON.stringify(settings));
        httpJson('POST', API.settings, settings).then(function (res) {
          if (nodes && nodes.saveNote) textOf(nodes.saveNote, res && res.ok ? STR.saved : STR.localOnly);
        }).catch(function () { if (nodes && nodes.saveNote) textOf(nodes.saveNote, STR.localOnly); });
      }
      function saveSettings(immediate) {
        storeSet(STORE_KEY, JSON.stringify(settings));
        persistLocal();
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        var push = function () {
          saveTimer = null;
          httpJson('POST', API.settings, settings).then(function (res) {
            if (res && res.ok && res.json && res.json.settings) {
              settings = sanitize(Object.assign({}, settings, res.json.settings));
              storeSet(STORE_KEY, JSON.stringify(settings));
            }
            if (nodes && nodes.saveNote) textOf(nodes.saveNote, res && res.ok ? STR.saved : STR.localOnly);
          }).catch(function () { if (nodes && nodes.saveNote) textOf(nodes.saveNote, STR.localOnly); });
        };
        if (immediate) push();
        else saveTimer = setTimeout(push, 350);
      }
      function loadRemote() {
        httpJson('GET', API.settings).then(function (res) {
          if (!res || !res.ok || !res.json || !res.json.settings) return;
          var remote = sanitize(res.json.settings);
          if (local.savedAt > 0) {
            remote.position = settings.position;
          } else {
            local.savedAt = Date.now();
            persistLocal();
          }
          settings = sanitize(Object.assign({}, remote, { position: remote.position, panel: { defaultOpen: settings.panel.defaultOpen, width: remote.panel.width } }));
          storeSet(STORE_KEY, JSON.stringify(settings));
          layout(); renderPod(); renderPanel(); renderSettings();
        }).catch(function () { /* ignore */ });
      }

      // ── 样式 ───────────────────────────────────────────────────────────
      function ensureStyle() {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.getElementById && document.getElementById('jingcha-style')) return;
        var css = [
          '.jingcha-root{position:fixed;z-index:2147483000;font:12px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--j-fg);-webkit-font-smoothing:antialiased}',
          '.jingcha-root *{box-sizing:border-box}',
          '.jingcha-theme-light{color-scheme:light;--j-surface:rgba(255,255,255,.94);--j-surface-solid:rgba(255,255,255,.985);--j-bg:rgba(255,255,255,.94);--j-panel:rgba(255,255,255,.985);--j-field:rgba(0,0,0,.05);--j-fg:#1b1f24;--j-sub:rgba(27,31,36,.62);--j-border:rgba(0,0,0,.13);--j-row:rgba(0,0,0,.04);--j-track:rgba(0,0,0,.18);--j-control-accent:#3b82f6;--j-shadow:0 10px 28px rgba(15,20,30,.18)}',
          '.jingcha-theme-dark{color-scheme:dark;--j-surface:rgba(27,29,33,.94);--j-surface-solid:rgba(27,29,33,.985);--j-bg:rgba(27,29,33,.94);--j-panel:rgba(27,29,33,.985);--j-field:rgba(255,255,255,.09);--j-fg:#e8eaed;--j-sub:rgba(232,234,237,.62);--j-border:rgba(255,255,255,.16);--j-row:rgba(255,255,255,.06);--j-track:rgba(255,255,255,.22);--j-control-accent:#6ea8fe;--j-shadow:0 10px 28px rgba(0,0,0,.5)}',
          '.jingcha-pod{display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;background:var(--j-surface,var(--j-bg));border:1px solid var(--j-accent,var(--j-border));box-shadow:var(--j-shadow),inset 0 0 0 3px var(--j-accent-soft,transparent);cursor:grab;user-select:none;touch-action:none;opacity:var(--j-opacity,1);transform:scale(var(--j-size,1));transform-origin:bottom right;will-change:transform,opacity}',
          '.jingcha-pod:active{cursor:grabbing}.jingcha-pod:hover{transform:scale(calc(var(--j-size,1) * 1.04))}',
          '.jingcha-dot{width:9px;height:9px;border-radius:50%;background:var(--j-dot,#7a8698);box-shadow:0 0 0 3px rgba(122,134,152,.2);flex:0 0 auto}',
          '.jingcha-dot--red{animation:jingcha-breathe 1.5s ease-in-out infinite}',
          '.jingcha-dot--yellow{animation:jingcha-breathe 2.6s ease-in-out infinite}',
          '@keyframes jingcha-breathe{0%,100%{opacity:1}50%{opacity:.5}}',
          '.jingcha-text{white-space:nowrap;font-variant-numeric:tabular-nums}',
          '.jingcha-sub{color:var(--j-sub)}',
          '.jingcha-panel{position:absolute;right:0;bottom:calc(100% + 8px);width:var(--j-panel-w,320px);max-width:min(var(--j-panel-w,320px),92vw);background:var(--j-surface-solid,var(--j-panel));color:var(--j-fg);border:1px solid var(--j-border);border-radius:12px;box-shadow:var(--j-shadow);opacity:var(--j-opacity,1);overflow:hidden;display:flex;flex-direction:column;color-scheme:inherit}',
          '.jingcha-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--j-border);background:var(--j-accent-soft,transparent)}',
          '.jingcha-title{font-weight:600}.jingcha-chip{margin-left:auto;font-size:11px;color:var(--j-sub);font-variant-numeric:tabular-nums}',
          '.jingcha-x{border:none;background:transparent;color:var(--j-sub);cursor:pointer;font:inherit;padding:0 2px}',
          '.jingcha-btn{border:1px solid var(--j-border);background:transparent;color:inherit;border-radius:7px;padding:2px 7px;font:inherit;cursor:pointer;line-height:1.5}',
          '.jingcha-btn:hover{background:var(--j-accent-soft,var(--j-field));border-color:var(--j-accent,var(--j-border))}',
          '.jingcha-btn[aria-pressed=true]{background:var(--j-accent-soft,var(--j-field));border-color:var(--j-accent,var(--j-fg));font-weight:600}',
          '.jingcha-body{overflow:auto;padding:6px 10px;max-height:var(--j-panel-h,340px)}',
          '.jingcha-sec{margin:2px 0 6px}',
          '.jingcha-sec>h4{margin:0;padding:3px 0;font-size:11px;font-weight:600;color:var(--j-sub);cursor:pointer;display:flex;align-items:center;gap:5px;user-select:none}',
          '.jingcha-sec>h4:before{content:"▾";font-size:9px;opacity:.7}',
          '.jingcha-sec.jingcha-folded>h4:before{content:"▸"}',
          '.jingcha-sec.jingcha-folded>.jingcha-sec-body{display:none}',
          '.jingcha-row{display:grid;grid-template-columns:10px auto auto 1fr auto;align-items:center;gap:7px;padding:4px 6px;border-radius:7px;min-height:22px}',
          '.jingcha-row:hover{background:var(--j-row)}',
          '.jingcha-mono{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--j-sub);font-variant-numeric:tabular-nums}',
          '.jingcha-ellipsis{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--j-sub)}',
          '.jingcha-actions{display:flex;flex-wrap:wrap;gap:6px;padding:7px 10px;border-top:1px solid var(--j-border)}',
          '.jingcha-foot{display:flex;align-items:center;gap:8px;padding:0 10px 8px;color:var(--j-sub);font-size:11px}',
          '.jingcha-field{display:grid;grid-template-columns:76px 1fr;align-items:center;gap:8px;margin:6px 0}',
          '.jingcha-field>label{color:var(--j-sub)}',
          '.jingcha-slider{display:flex;align-items:center;gap:8px}',
          '.jingcha-slider input[type=range]{flex:1;min-width:70px;height:20px;margin:0;background:transparent;-webkit-appearance:none;appearance:none;cursor:pointer;touch-action:none;accent-color:var(--j-accent,var(--j-control-accent))}',
          '.jingcha-slider input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:var(--j-track,rgba(127,127,127,.3))}',
          '.jingcha-slider input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-4px;border-radius:50%;background:var(--j-accent,var(--j-control-accent));border:2px solid var(--j-surface-solid,transparent);box-shadow:0 1px 3px rgba(0,0,0,.35)}',
          '.jingcha-slider input[type=range]::-moz-range-track{height:6px;border-radius:999px;background:var(--j-track,rgba(127,127,127,.3))}',
          '.jingcha-slider input[type=range]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--j-accent,var(--j-control-accent));border:2px solid var(--j-surface-solid,transparent)}',
          '.jingcha-slider input[type=number],.jingcha-field input[type=number]{width:62px;background:var(--j-field);color:inherit;border:1px solid var(--j-border);border-radius:7px;padding:2px 6px;font:inherit;text-align:right}',
          '.jingcha-num-wrap{display:inline-flex;align-items:center;gap:3px}',
          '.jingcha-seg{display:inline-flex;border:1px solid var(--j-border);border-radius:8px;overflow:hidden}',
          '.jingcha-seg button{border:none;background:transparent;color:inherit;font:inherit;padding:3px 9px;cursor:pointer}',
          '.jingcha-seg button+button{border-left:1px solid var(--j-border)}',
          '.jingcha-seg button[aria-pressed=true]{background:var(--j-accent-soft,var(--j-field));font-weight:600}',
          '.jingcha-accent-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--j-border);border-radius:8px;background:transparent;color:inherit;font:inherit;padding:3px 8px;cursor:pointer}',
          '.jingcha-accent-btn i{width:14px;height:14px;border-radius:4px;display:inline-block;border:1px solid var(--j-border)}',
          '.jingcha-palette{position:absolute;left:8px;right:8px;bottom:42px;z-index:10;padding:8px;border:1px solid var(--j-border);border-radius:10px;background:var(--j-surface-solid,var(--j-panel));color:var(--j-fg);box-shadow:var(--j-shadow);display:grid;grid-template-columns:repeat(6, 22px);gap:6px;justify-content:start}',
          '.jingcha-palette button{width:20px;height:20px;border-radius:5px;border:1px solid var(--j-border);cursor:pointer;padding:0}',
          '.jingcha-palette .jingcha-hex{grid-column:1 / -1;display:flex;gap:6px;align-items:center}',
          '.jingcha-palette input{width:96px;background:var(--j-field);color:inherit;border:1px solid var(--j-border);border-radius:7px;padding:2px 6px;font:inherit}',
          '.jingcha-chip-restore{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:5px;padding:4px 9px;border-radius:999px;background:var(--j-surface,var(--j-bg));color:var(--j-fg);border:1px dashed var(--j-accent,var(--j-border));box-shadow:var(--j-shadow);opacity:.62;cursor:pointer;transition:opacity .15s ease;font:12px/1.4 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
          '.jingcha-chip-restore:hover{opacity:1}',
          '.jingcha-chip-restore:focus-visible{outline:2px solid var(--j-fg);outline-offset:2px}',
          '.jingcha-toasts{position:absolute;left:calc(100% + 8px);bottom:0;display:flex;flex-direction:column;gap:6px;width:250px}',
          '.jingcha-toasts.jingcha-left{left:auto;right:calc(100% + 8px)}',
          '.jingcha-tip{position:fixed;z-index:2147483001;padding:6px 8px;border:1px solid var(--j-border);border-radius:8px;background:var(--j-surface-solid,var(--j-panel));color:var(--j-fg);box-shadow:var(--j-shadow);font:11px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;pointer-events:none}',
          '.jingcha-toast{background:var(--j-surface-solid,var(--j-panel));border:1px solid var(--j-border);border-left:3px solid var(--j-dot,#e2b93b);border-radius:9px;box-shadow:var(--j-shadow);padding:6px 8px;cursor:pointer}',
          '.jingcha-toast b{font-weight:600}',
          '.jingcha-timeline{display:flex;gap:2px;height:16px;margin:4px 0 2px;padding:2px;border-radius:6px;background:var(--j-field,transparent)}',
          '.jingcha-timeline>span{flex:1 1 0;min-width:2px;border-radius:2px;background:var(--j-dot,var(--j-track,rgba(127,127,127,.3)))}',
          '.jingcha-timeline>span.jingcha-tl-empty{background:var(--j-track,rgba(127,127,127,.3));opacity:.45}',
          '.jingcha-tl-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--j-sub);font-variant-numeric:tabular-nums;margin-bottom:2px}',
          '.jingcha-hidden{display:none!important}',
          '@media (prefers-reduced-motion: reduce){.jingcha-pod,.jingcha-dot{animation:none!important;transition:none!important}}',
          '@media (max-width: 420px){.jingcha-panel{right:auto;left:0;width:min(92vw,var(--j-panel-w,320px))}}'
        ].join('');
        var tag = document.createElement('style');
        tag.id = 'jingcha-style';
        tag.textContent = css;
        document.head.appendChild(tag);
      }

      function resolveTheme() {
        if (settings.theme === 'dark') return 'dark';
        if (settings.theme === 'light') return 'light';
        return uiIsDark() ? 'dark' : 'light';
      }

      // ── DOM ────────────────────────────────────────────────────────────
      function section(key, title) {
        var wrap = el('div', 'jingcha-sec');
        var head = el('h4', null, title);
        head.setAttribute('title', STR.foldHint);
        var body = el('div', 'jingcha-sec-body');
        head.onclick = function () { local.fold[key] = !local.fold[key]; persistLocal(); applyFold(); };
        wrap.appendChild(head); wrap.appendChild(body);
        wrap.setAttribute('data-sec', key);
        return { wrap: wrap, body: body, head: head };
      }
      function applyFold() {
        if (!nodes) return;
        ['state', 'timeline', 'calls', 'findings', 'settings'].forEach(function (key) {
          var wrap = nodes['sec_' + key];
          if (wrap) wrap.className = 'jingcha-sec' + (local.fold[key] ? ' jingcha-folded' : '');
        });
      }

      function build() {
        var root = el('div', 'jingcha-root');
        var pod = el('div', 'jingcha-pod');
        pod.setAttribute('role', 'button');
        pod.setAttribute('tabindex', '0');
        pod.setAttribute('aria-label', STR.name);
        var dot = el('span', 'jingcha-dot');
        var text = el('span', 'jingcha-text');
        pod.appendChild(dot); pod.appendChild(text);

        var panel = el('div', 'jingcha-panel jingcha-hidden');
        panel.setAttribute('role', 'dialog');
        var head = el('div', 'jingcha-head');
        var chipText = el('span', 'jingcha-chip', '');
        var close = el('button', 'jingcha-x', '✕');
        close.setAttribute('aria-label', '关闭面板');
        close.onclick = function (event) { if (event && event.stopPropagation) event.stopPropagation(); setPanel(false); };
        head.appendChild(el('span', 'jingcha-title', STR.name)); head.appendChild(chipText); head.appendChild(close);

        var body = el('div', 'jingcha-body');
        var secState = section('state', STR.state);
        var secTimeline = section('timeline', STR.timeline);
        var secCalls = section('calls', STR.inflight);
        var secFindings = section('findings', STR.findings);
        var secSettings = section('settings', STR.settings);
        body.appendChild(secState.wrap); body.appendChild(secTimeline.wrap);
        body.appendChild(secCalls.wrap);
        body.appendChild(secFindings.wrap); body.appendChild(secSettings.wrap);

        var actions = el('div', 'jingcha-actions');
        var btnStalled = el('button', 'jingcha-btn', '⛔ ' + STR.killStalled);
        btnStalled.onclick = function () { kill({ scope: 'stalled' }); };
        var btnStop = el('button', 'jingcha-btn', '🛑 ' + STR.stopAll);
        btnStop.onclick = function () {
          var ok = true;
          try { ok = window.confirm(STR.stopAllConfirm); } catch (error) { ok = true; }
          if (ok) stopTurns();
        };
        var btnGear = el('button', 'jingcha-btn', '⚙ ' + STR.settings);
        btnGear.onclick = function () { local.fold.settings = !local.fold.settings; persistLocal(); applyFold(); if (!local.fold.settings) renderSettings(); };
        actions.appendChild(btnStalled); actions.appendChild(btnStop); actions.appendChild(btnGear);

        var foot = el('div', 'jingcha-foot');
        var footNote = el('span', null, STR.hint);
        var saveNote = el('span', 'jingcha-sub', '');
        foot.appendChild(footNote); foot.appendChild(saveNote);

        panel.appendChild(head); panel.appendChild(body); panel.appendChild(actions); panel.appendChild(foot);
        var toastsBox = el('div', 'jingcha-toasts jingcha-hidden');

        root.appendChild(panel); root.appendChild(toastsBox); root.appendChild(pod);
        if (document.body) document.body.appendChild(root);

        nodes = {
          root: root, pod: pod, dot: dot, text: text, panel: panel, chip: chipText,
          sec_state: secState.wrap, sec_timeline: secTimeline.wrap, sec_calls: secCalls.wrap, sec_findings: secFindings.wrap, sec_settings: secSettings.wrap,
          head_state: secState.head, head_timeline: secTimeline.head, head_calls: secCalls.head, head_findings: secFindings.head, head_settings: secSettings.head,
          body_state: secState.body, body_timeline: secTimeline.body, body_calls: secCalls.body, body_findings: secFindings.body, body_settings: secSettings.body,
          saveNote: saveNote, footNote: footNote, toasts: toastsBox,
          btnGear: btnGear, btnStalled: btnStalled, btnStop: btnStop
        };
        installDrag();
        pod.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPanel(!panelOpen); }
        });
        applyFold();
        return nodes;
      }

      function setPanel(open) {
        panelOpen = open;
        if (!nodes) return;
        nodes.panel.className = 'jingcha-panel' + (open ? '' : ' jingcha-hidden');
        if (!open) { closePalette(); hideTip(); }
      }

      // ── 位置 ───────────────────────────────────────────────────────────
      function applyPosition() {
        if (!nodes) return;
        var root = nodes.root;
        var pos = settings.position;
        root.style.left = ''; root.style.top = ''; root.style.right = ''; root.style.bottom = '';
        if (pos.mode === 'docked') {
          root.style.right = pos.right + 'px';
          root.style.bottom = pos.bottom + 'px';
        } else {
          root.style.left = (pos.left === null ? 14 : pos.left) + 'px';
          root.style.top = (pos.top === null ? 14 : pos.top) + 'px';
        }
        if (chip) {
          var vw = window.innerWidth || 1280;
          var vh = window.innerHeight || 800;
          if (pos.mode === 'free') {
            chip.style.left = Math.max(0, Math.min(vw - 90, pos.left === null ? 14 : pos.left)) + 'px';
            chip.style.top = Math.max(0, Math.min(vh - 26, pos.top === null ? 14 : pos.top)) + 'px';
            chip.style.right = ''; chip.style.bottom = '';
          } else {
            chip.style.left = ''; chip.style.top = '';
            chip.style.right = Math.max(0, pos.right) + 'px';
            chip.style.bottom = Math.max(0, pos.bottom) + 'px';
          }
        }
      }

      /** 单一基底色派生整套配色：胶囊与面板共用同一个 surface，文字色按底色亮度选，保证统一且可读。 */
      function paletteFor(theme, surfaceRgb) {
        var base = theme === 'dark' ? { r: 27, g: 29, b: 33 } : { r: 255, g: 255, b: 255 };
        if (surfaceRgb) base = { r: surfaceRgb.r, g: surfaceRgb.g, b: surfaceRgb.b };
        var luminance = (0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b) / 255;
        var isDark = luminance < 0.5;
        var rgb = base.r + ',' + base.g + ',' + base.b;
        return {
          isDark: isDark,
          surface: 'rgba(' + rgb + ',0.94)',
          surfaceSolid: 'rgba(' + rgb + ',0.985)',
          fg: isDark ? '#e8eaed' : '#1b1f24',
          sub: isDark ? 'rgba(232,234,237,.62)' : 'rgba(27,31,36,.62)',
          border: isDark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.13)',
          field: isDark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.05)',
          row: isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)',
          track: isDark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.18)',
          controlAccent: isDark ? '#6ea8fe' : '#3b82f6',
          shadow: isDark ? '0 10px 28px rgba(0,0,0,.5)' : '0 10px 28px rgba(15,20,30,.18)'
        };
      }
      /** 界面是否给了明确的深浅信号（DSH 属性 / 客户端主题）。给了就不该再猜页面底色。 */
      function uiThemeSignal() {
        try {
          if (document.body && document.body.hasAttribute && document.body.hasAttribute('data-ds-dark-theme')) return true;
          if (document.documentElement && document.documentElement.hasAttribute && document.documentElement.hasAttribute('data-ds-dark-theme')) return true;
          var ds = document.documentElement && document.documentElement.dataset ? document.documentElement.dataset : {};
          if (ds.dsThemeSource === 'dark' || ds.dsThemeSource === 'light') return true;
        } catch (error) { /* ignore */ }
        return false;
      }
      function applyPalette() {
        if (!nodes) return;
        var theme = lastTheme || resolveTheme();
        var surfaceRgb = null;
        // 跟随界面时优先信主题信号；只有拿不到信号才采样页面底色（页面 body 常常是白的，
        // 直接用会把深色界面里的面板刷成白底 —— 这正是之前"白底白字"的原因）
        if (settings.theme === 'auto' && !uiThemeSignal()) surfaceRgb = uiSurfaceColor();
        var palette = paletteFor(theme, surfaceRgb);
        var root = nodes.root.style;
        root.setProperty('--j-surface', palette.surface);
        root.setProperty('--j-surface-solid', palette.surfaceSolid);
        root.setProperty('--j-bg', palette.surface);
        root.setProperty('--j-panel', palette.surfaceSolid);
        root.setProperty('--j-fg', palette.fg);
        root.setProperty('--j-sub', palette.sub);
        root.setProperty('--j-border', palette.border);
        root.setProperty('--j-field', palette.field);
        root.setProperty('--j-row', palette.row);
        root.setProperty('--j-track', palette.track);
        root.setProperty('--j-control-accent', palette.controlAccent);
        root.setProperty('--j-shadow', palette.shadow);
        // 关键元素直接内联上色：不依赖 CSS 变量兜底链，任何环境都不会再出现"白底白字"
        if (nodes.panel) { nodes.panel.style.background = palette.surfaceSolid; nodes.panel.style.color = palette.fg; }
        if (nodes.toasts) { nodes.toasts.style.color = palette.fg; }
        if (paletteEl) { paletteEl.style.background = palette.surfaceSolid; paletteEl.style.color = palette.fg; }
        if (chip) { chip.style.background = palette.surface; chip.style.color = palette.fg; }
      }
      /** 只做"便宜"的视觉变量更新：拖滑块时每帧只走这里，不碰位置/主题类/DOM 结构。 */
      function applyVisual() {
        if (!nodes) return;
        nodes.root.style.setProperty('--j-size', String(settings.size));
        nodes.root.style.setProperty('--j-opacity', String(settings.opacity));
        nodes.root.style.setProperty('--j-panel-w', settings.panel.width + 'px');
        nodes.root.style.setProperty('--j-panel-h', local.maxHeight + 'px');
        nodes.root.style.setProperty('--j-accent', settings.accent || '');
        nodes.root.style.setProperty('--j-accent-soft', settings.accent ? withAlpha(settings.accent, 0.16) : '');
        updateAccentUi();
      }
      function layout() {
        if (!nodes) return;
        var theme = resolveTheme();
        lastTheme = theme;
        nodes.root.className = 'jingcha-root jingcha-theme-' + theme + (settings.hidden ? ' jingcha-hidden' : '');
        applyPalette();
        applyVisual();
        applyPosition();
        nodes.text.style.display = settings.labels ? '' : 'none';
      }

      /** 只更新主色按钮本身（swatch + 文案），不重建整个设置区。 */
      function updateAccentUi() {
        if (!nodes) return;
        if (nodes.accentSwatch) nodes.accentSwatch.style.background = settings.accent || 'transparent';
        if (nodes.accentButton) {
          var label = nodes.accentButton.children && nodes.accentButton.children.length > 1 ? nodes.accentButton.children[1] : null;
          textOf(label, settings.accent || STR.accentFollow);
        }
      }

      function installDrag() {
        var pod = nodes.pod;
        var dragging = null;
        function rectOf(node) {
          try { return node.getBoundingClientRect(); } catch (error) { return { left: 0, top: 0, width: 120, height: 26 }; }
        }
        function onDown(event) {
          if (event.button !== undefined && event.button !== 0) return;
          var rect = rectOf(pod);
          dragging = { x0: event.clientX, y0: event.clientY, left0: rect.left || 0, top0: rect.top || 0, w: rect.width || 120, h: rect.height || 26, moved: false };
          try { if (pod.setPointerCapture && event.pointerId !== undefined) pod.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
          if (event.preventDefault) event.preventDefault();
        }
        function onMove(event) {
          if (!dragging || !nodes) return;
          var dx = (event.clientX || 0) - dragging.x0;
          var dy = (event.clientY || 0) - dragging.y0;
          if (!dragging.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
          dragging.moved = true;
          nodes.root.style.right = ''; nodes.root.style.bottom = '';
          nodes.root.style.left = (dragging.left0 + dx) + 'px';
          nodes.root.style.top = (dragging.top0 + dy) + 'px';
        }
        function onUp() {
          if (!dragging) return;
          var state = dragging;
          dragging = null;
          if (!state.moved) { setPanel(!panelOpen); return; }
          if (!nodes) return;
          var rect = rectOf(nodes.root);
          var vw = window.innerWidth || 1280;
          var vh = window.innerHeight || 800;
          var width = rect.width || state.w;
          var height = rect.height || state.h;
          var left = Math.max(0, Math.min(vw - width, rect.left || 0));
          var top = Math.max(0, Math.min(vh - height, rect.top || 0));
          var rightGap = vw - left - width;
          var bottomGap = vh - top - height;
          if (rightGap <= SNAP || left <= SNAP || bottomGap <= SNAP) {
            settings.position = { mode: 'docked', right: Math.max(0, Math.round(rightGap)), bottom: Math.max(0, Math.round(bottomGap)), left: null, top: null };
          } else {
            settings.position = { mode: 'free', right: settings.position.right, bottom: settings.position.bottom, left: Math.round(left), top: Math.round(top) };
          }
          layout();
          savePositionNow();
        }
        pod.addEventListener('pointerdown', onDown);
        if (typeof document.addEventListener === 'function') {
          document.addEventListener('pointermove', onMove);
          document.addEventListener('pointerup', onUp);
          document.addEventListener('pointercancel', onUp);
        }
        dragCleanup = function () {
          if (typeof document.removeEventListener === 'function') {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
          }
        };
      }

      /** 五宫格复位：左上/右上/左下/右下（停靠）/居中。 */
      function setPreset(name) {
        var vw = window.innerWidth || 1280;
        var vh = window.innerHeight || 800;
        var w = (nodes && nodes.root && nodes.root.getBoundingClientRect ? (nodes.root.getBoundingClientRect().width || 120) : 120);
        var h = (nodes && nodes.root && nodes.root.getBoundingClientRect ? (nodes.root.getBoundingClientRect().height || 26) : 26);
        if (name === 'top-left') settings.position = { mode: 'free', right: 14, bottom: 14, left: 14, top: 14 };
        else if (name === 'top-right') settings.position = { mode: 'free', right: 14, bottom: 14, left: Math.max(0, Math.round(vw - w - 14)), top: 14 };
        else if (name === 'bottom-left') settings.position = { mode: 'free', right: 14, bottom: 14, left: 14, top: Math.max(0, Math.round(vh - h - 14)) };
        else if (name === 'center') settings.position = { mode: 'free', right: 14, bottom: 14, left: Math.max(0, Math.round((vw - w) / 2)), top: Math.max(0, Math.round((vh - h) / 2)) };
        else settings.position = { mode: 'docked', right: 14, bottom: 14, left: null, top: null };
        layout();
        savePositionNow();
        renderSettings();
      }

      // ── 动作 ───────────────────────────────────────────────────────────
      /** 解释宿主为什么没停掉：把 reason 翻成人话弹出来，别再"点了没反应"。 */
      function explainKill(body) {
        var reason = body && body.reason;
        if (reason === 'nested-parent-only') return '这个调用在父调用里面，框架不允许单独停它';
        if (reason === 'not-live') return '这个调用已经结束了';
        if (reason === 'empty-callId') return '缺少调用 id';
        if (reason === 'ambiguous') return '有多个同名调用在跑，请按范围停';
        return '宿主拒绝了这次停止请求';
      }
      function kill(payload) {
        httpJson('POST', API.kill, payload).then(function (res) {
          var body = res && res.json ? res.json : null;
          if (body && body.ok === false) pushToast('没能停掉', explainKill(body), 'yellow');
        }).catch(function () { /* ignore */ });
      }
      function stopTurns() { httpJson('POST', API.stop, {}).catch(function () { /* ignore */ }); }

      // ── 渲染 ───────────────────────────────────────────────────────────
      var warned = {};
      function warnOnce(tag, error) {
        if (warned[tag]) return;
        warned[tag] = true;
        try { if (window.console && window.console.warn) window.console.warn('[jingcha-widget] 渲染 ' + tag + ' 出错：', error); } catch (e) { /* ignore */ }
      }
      /** 轮询期间的渲染：只重画胶囊与面板；**绝不**重建设置区
       *  （v4 每次轮询都 renderSettings，等于把用户正拖着的滑块和打开的色板一起换掉）。 */
      function safeRender() {
        try { renderPod(); } catch (error) { warnOnce('pod', error); }
        try { renderPanel(); } catch (error) { warnOnce('panel', error); }
        try { renderTimeline(); } catch (error) { warnOnce('timeline', error); }
      }

      function renderPod() {
        if (!nodes) return;
        var light = pickLight(lastStatus, settings);
        var level = lastError ? 'off' : light.level;
        nodes.dot.className = 'jingcha-dot' + (level === 'red' ? ' jingcha-dot--red' : level === 'yellow' ? ' jingcha-dot--yellow' : '');
        nodes.dot.style.setProperty('--j-dot', LEVEL_COLOR[level] || LEVEL_COLOR.idle);   // 灯色永远是状态色
        nodes.dot.setAttribute('data-level', level);
        var label = lastError ? STR.off : (light.text || STR[light.state] || STR.name);
        textOf(nodes.text, label);
        nodes.pod.title = lastError ? STR.off : (STR.name + ' · ' + light.state + (light.text ? ' · ' + light.text : ''));
        if (chip) {
          var chipDot = chip.children && chip.children[0];
          if (chipDot && chipDot.style) chipDot.style.setProperty('--j-dot', LEVEL_COLOR[level] || LEVEL_COLOR.idle);
        }
      }

      // ── 迷你时间线（渲染） ─────────────────────────────────────────────
      /** 刻度文案：左 = 5 分钟前，中 = 2m30s 前，右 = 现在（时间用 fmtDur，不另写一套）。 */
      function timelineAxisTexts() {
        return [fmtDur(TL_SPAN_MS) + STR.tlBefore, fmtDur(TL_SPAN_MS / 2) + STR.tlBefore, STR.tlNow];
      }
      function timelineTitle(bucket) {
        var parts = [timeOf(bucket.at), sampleLabel(bucket)];
        var reasons = bucket.reasons || [];
        for (var i = 0; i < reasons.length; i++) parts.push(reasons[i]);
        if (bucket.count > 1) parts.push(STR.tlPoints + ' ' + bucket.count);
        return parts.join(' · ');
      }
      /** 色块只建一次：之后每次轮询只改颜色与 title —— 不重建 DOM，悬停的 title 就不会闪。 */
      function buildTimelineSlots() {
        var box = nodes.body_timeline;
        box.textContent = '';
        var strip = el('div', 'jingcha-timeline');
        strip.setAttribute('role', 'img');
        strip.setAttribute('tabindex', '0');
        strip.setAttribute('aria-label', STR.timeline + '（' + STR.tlSlots + '）');
        var slots = [];
        for (var i = 0; i < TL_SLOTS; i++) {
          var slot = el('span', 'jingcha-tl-slot jingcha-tl-empty');
          slot.setAttribute('data-level', 'empty');
          strip.appendChild(slot);
          slots.push(slot);
        }
        var axis = el('div', 'jingcha-tl-axis');
        timelineAxisTexts().forEach(function (text) { axis.appendChild(el('span', null, text)); });
        var note = el('div', 'jingcha-sub', STR.tlEmpty);
        box.appendChild(strip); box.appendChild(axis); box.appendChild(note);
        tlNodes = { strip: strip, slots: slots, axis: axis, note: note };
      }
      function renderTimeline() {
        if (!nodes || !nodes.body_timeline) return;
        if (!tlNodes || !tlNodes.strip || tlNodes.strip.parentNode !== nodes.body_timeline) buildTimelineSlots();
        var now = Date.now();
        var buckets = bucketize(history, now, TL_SLOTS, TL_SPAN_MS);
        var width = TL_SPAN_MS / TL_SLOTS;
        var filled = 0;
        for (var i = 0; i < TL_SLOTS; i++) {
          var slotIndex = TL_SLOTS - 1 - i;          // 左 = 最老，右 = 最新
          var bucket = buckets[slotIndex];
          var slot = tlNodes.slots[i];
          if (!slot) continue;
          if (bucket) {
            filled++;
            slot.className = 'jingcha-tl-slot';
            slot.style.setProperty('--j-dot', LEVEL_COLOR[bucket.level] || LEVEL_COLOR.idle);   // 色块用状态色
            slot.setAttribute('data-level', bucket.level);
            slot.title = timelineTitle(bucket);
          } else {
            slot.className = 'jingcha-tl-slot jingcha-tl-empty';
            slot.style.removeProperty('--j-dot');                 // 空档交给 CSS 用 --j-track 弱色
            slot.setAttribute('data-level', 'empty');
            slot.title = timeOf(now - slotIndex * width) + ' · ' + STR.tlGap + '（' + STR.tlGapWhy + '）';
          }
        }
        var newest = buckets[0];
        tlNodes.strip.title = STR.timeline + '（' + STR.tlSlots + '）' + (newest ? ' · ' + timelineTitle(newest) : ' · ' + STR.tlEmpty);
        textOf(nodes.head_timeline, STR.timeline + '（' + filled + '/' + TL_SLOTS + '）');
        textOf(tlNodes.note, history.length === 0
          ? STR.tlEmpty
          : STR.tlPoints + ' ' + history.length + '/' + HISTORY_MAX + ' · ' + STR.tlGap + ' ' + (TL_SLOTS - filled) + '/' + TL_SLOTS);
      }

      function renderPanel() {
        if (!nodes) return;
        reclaimTip();              // 行被重建：同一段文字就把提示框挪过去继续显示，别闪
        var status = lastStatus;
        var light = pickLight(status, settings);
        textOf(nodes.chip, lastError ? STR.off : (light.state + (light.elapsedMs ? ' · ' + fmtDur(light.elapsedMs) : '')));

        var stateBox = nodes.body_state;
        stateBox.textContent = '';
        if (lastError) {
          stateBox.appendChild(el('div', 'jingcha-sub', STR.off + '（接口不可用）'));
        } else if (status) {
          var line = el('div', 'jingcha-row');
          line.appendChild(el('span', 'jingcha-dot'));
          line.appendChild(el('b', null, status.verdict.label || status.verdict.state));
          line.appendChild(el('span', 'jingcha-sub', status.verdict.state));
          stateBox.appendChild(line);
          (status.verdict.reasons || []).forEach(function (reason) {
            var rtext = reason.text || reason.kind;
            var rnode = el('div', 'jingcha-sub jingcha-ellipsis', '· ' + rtext);
            bindTip(rnode, rtext);
            stateBox.appendChild(rnode);
          });
          var rt = status.runtime || {};
          var counters = (status.work && status.work.counters) || {};
          stateBox.appendChild(el('div', 'jingcha-mono',
            STR.loopLag + ' ' + (rt.eventLoopLagMs || 0) + '/' + (rt.maxLagMs || 0) + 'ms · ' +
            STR.agents + ' ' + ((status.work && status.work.runningAgents) || 0) + ' · ' +
            STR.calls + ' ' + (counters.toolCalls || 0) + '/' + (counters.toolErrors || 0)));
        }

        var callsBox = nodes.body_calls;
        callsBox.textContent = '';
        var inflight = (status && status.work && status.work.inflight) || [];
        textOf(nodes.head_calls, STR.inflight + '（' + inflight.length + '）');
        if (inflight.length === 0) callsBox.appendChild(el('div', 'jingcha-sub', STR.none));
        inflight.forEach(function (call) {
          var level = levelOfCall(call.elapsedMs, settings.thresholds);
          var node = el('div', 'jingcha-row');
          var badge = el('span', 'jingcha-dot');
          badge.style.setProperty('--j-dot', LEVEL_COLOR[level]);
          badge.setAttribute('data-level', level);
          node.appendChild(badge);
          node.appendChild(el('b', null, call.tool || '?'));
          var silent = Number(call.silentMs || 0);
          var timing = call.phase === 'run' ? fmtDur(call.elapsedMs) : '待派发';
          if (call.phase === 'run' && silent > 120000) timing += ' 静默' + fmtDur(silent);
          var timingNode = el('span', 'jingcha-mono', timing);
          timingNode.title = call.phase === 'run' ? '已跑 ' + fmtDur(call.elapsedMs) + '，静默 ' + fmtDur(silent) : '还没派发（等待裁决/审批）';
          node.appendChild(timingNode);
          var preview = el('span', 'jingcha-ellipsis', call.preview || '');
          bindTip(preview, call.preview || '');
          node.appendChild(preview);
          var killBtn = el('button', 'jingcha-btn', '⛔');
          killBtn.title = STR.killTitle;
          killBtn.setAttribute('aria-label', STR.killTitle + ' ' + (call.tool || ''));
          killBtn.onclick = function (event) { if (event && event.stopPropagation) event.stopPropagation(); kill({ callId: call.callId }); };
          node.appendChild(killBtn);
          callsBox.appendChild(node);
        });

        var findBox = nodes.body_findings;
        findBox.textContent = '';
        var findings = (status && status.findings) || [];
        textOf(nodes.head_findings, STR.findings + '（' + findings.length + '）');
        if (findings.length === 0) findBox.appendChild(el('div', 'jingcha-sub', STR.none));
        findings.slice(-5).reverse().forEach(function (finding) {
          var node = el('div', 'jingcha-row');
          var badge = el('span', 'jingcha-dot');
          badge.style.setProperty('--j-dot', finding.severity === 'critical' ? LEVEL_COLOR.red : finding.severity === 'warn' ? LEVEL_COLOR.yellow : LEVEL_COLOR.idle);
          node.appendChild(badge);
          node.appendChild(el('span', 'jingcha-mono', timeOf(finding.at)));
          var text = el('span', 'jingcha-ellipsis', finding.text || '');
          bindTip(text, finding.text || '');
          node.appendChild(text);
          node.appendChild(el('span', null, ''));
          findBox.appendChild(node);
        });
      }

      // ── 控件 ───────────────────────────────────────────────────────────
      /** 滑块 + 数字框：拖动中只改样式（不重建 DOM），松手才落盘。 */
      function sliderRow(labelText, opts) {
        var wrap = el('div', 'jingcha-field');
        wrap.appendChild(el('label', null, labelText));
        var mid = el('div', 'jingcha-slider');
        var range = document.createElement('input');
        range.type = 'range';
        range.min = String(opts.min); range.max = String(opts.max); range.step = String(opts.step);
        range.value = String(opts.value);
        range.setAttribute('aria-label', labelText);
        var num = document.createElement('input');
        num.type = 'number';
        num.min = String(opts.min); num.max = String(opts.max); num.step = String(opts.step);
        num.value = String(opts.value);
        num.setAttribute('aria-label', labelText + '（可直接输入）');
        var apply = function (value, commit) {
          var v = clampNum(value, opts.min, opts.max, opts.value);
          range.value = String(v);
          num.value = String(v);
          opts.onLive(v);
          if (commit) opts.onCommit(v);
        };
        // 拖动中按帧节流：一帧最多更新一次视觉，指针不会被自己的重排打断
        var rafId = 0;
        var pending = null;
        var schedule = function (value, commit) {
          if (commit) {
            if (rafId && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(rafId);
            rafId = 0; pending = null;
            apply(value, true);
            return;
          }
          pending = value;
          if (rafId) return;
          var run = function () {
            rafId = 0;
            if (pending === null) return;
            var v = pending; pending = null;
            apply(v, false);
          };
          rafId = typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(run) : setTimeout(run, 16);
        };
        range.onpointerdown = function () { controlBusy = true; };
        range.onpointerup = function () { controlBusy = false; };
        range.onblur = function () { controlBusy = false; };
        num.onfocus = function () { controlBusy = true; };
        num.onblur = function () { controlBusy = false; };
        range.oninput = function () { controlBusy = true; schedule(Number(range.value), false); };   // 拖动中
        range.onchange = function () { controlBusy = false; schedule(Number(range.value), true); };  // 松手
        num.oninput = function () { controlBusy = true; schedule(Number(num.value), false); };
        num.onchange = function () { controlBusy = false; schedule(Number(num.value), true); };
        mid.appendChild(range); mid.appendChild(num);
        wrap.appendChild(mid);
        return wrap;
      }

      function segmented(options, current, onPick, aria) {
        var wrap = el('span', 'jingcha-seg');
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', aria || '');
        options.forEach(function (pair) {
          var button = el('button', null, pair[1]);
          button.setAttribute('data-theme', pair[0]);
          button.setAttribute('aria-pressed', current === pair[0] ? 'true' : 'false');
          button.onclick = function () { onPick(pair[0]); };
          wrap.appendChild(button);
        });
        return wrap;
      }

      function accentRowFor() {
        var wrap = el('div', 'jingcha-field');
        wrap.appendChild(el('label', null, STR.accent));
        var holder = el('div');
        holder.style.position = 'relative';
        var button = el('button', 'jingcha-accent-btn');
        button.setAttribute('aria-haspopup', 'true');
        button.setAttribute('aria-label', STR.accent);
        var swatch = el('i');
        swatch.style.background = settings.accent || 'transparent';
        button.appendChild(swatch);
        button.appendChild(el('span', null, settings.accent || STR.accentFollow));
        button.onclick = function (event) {
          if (event && event.stopPropagation) event.stopPropagation();
          togglePalette(holder);
        };
        holder.appendChild(button);
        wrap.appendChild(holder);
        nodes.accentButton = button;
        nodes.accentSwatch = swatch;
        return wrap;
      }

      /** 色板浮层：预设 + 十六进制输入 + 跟随主题；点外面或 Esc 才关。 */
      function togglePalette(holder) {
        if (paletteEl) { closePalette(); return; }
        var box = el('div', 'jingcha-palette');
        box.setAttribute('role', 'dialog');
        PRESET_COLORS.forEach(function (color) {
          var cell = el('button', null, '');
          cell.style.background = color;
          cell.title = color;
          cell.setAttribute('aria-label', color);
          cell.onclick = function (event) {
            if (event && event.stopPropagation) event.stopPropagation();
            settings.accent = color;
            layout(); renderPod(); saveSettings(false); updateAccentUi();   // 只更新主色那两处，不重建设置区（色板要留着）
          };
          box.appendChild(cell);
        });
        var hexWrap = el('div', 'jingcha-hex');
        var hex = document.createElement('input');
        hex.type = 'text';
        hex.value = settings.accent || '';
        hex.placeholder = '#rrggbb';
        hex.setAttribute('aria-label', '十六进制颜色');
        hex.oninput = function () { /* 输入中不关浮层 */ };
        hex.onchange = function () {
          var value = String(hex.value || '').trim();
          if (/^#?[0-9a-fA-F]{6}$/.test(value)) {
            settings.accent = (value.charAt(0) === '#' ? value : '#' + value).toLowerCase();
            layout(); renderPod(); saveSettings(false); updateAccentUi();
          }
        };
        var follow = el('button', 'jingcha-btn', STR.accentFollow);
        follow.onclick = function (event) {
          if (event && event.stopPropagation) event.stopPropagation();
          settings.accent = '';
          layout(); renderPod(); saveSettings(false); closePalette(); renderSettings();
        };
        hexWrap.appendChild(hex); hexWrap.appendChild(follow);
        box.appendChild(hexWrap);
        if (nodes && nodes.panel) nodes.panel.appendChild(box);   // 挂面板而非设置区：重建设置区不会拆掉它
        else if (holder) holder.appendChild(box);
        paletteEl = box;
      }
      function closePalette() {
        if (paletteEl && paletteEl.parentNode) paletteEl.parentNode.removeChild(paletteEl);
        paletteEl = null;
      }
      function onDocPointerDown(event) {
        if (!paletteEl) return;
        var target = event && event.target;
        var inside = false;
        var node = target;
        while (node) { if (node === paletteEl) { inside = true; break; } node = node.parentNode; }
        if (!inside) closePalette();
      }

      function renderSettings() {
        if (!nodes) return;
        if (controlBusy) return;      // 用户正按着滑块/在数字框里输入：不许重建
        var box = nodes.body_settings;
        box.textContent = '';
        textOf(nodes.head_settings, STR.settings + (local.fold.settings ? '（已折叠）' : ''));

        var thrRow = el('div', 'jingcha-field');
        thrRow.appendChild(el('label', null, STR.yellowSec + ' / ' + STR.redSec));
        var thrWrap = el('div', 'jingcha-slider');
        var yInput = document.createElement('input');
        yInput.type = 'number'; yInput.min = '1'; yInput.max = '3600';
        yInput.value = String(settings.thresholds.yellowSec);
        yInput.setAttribute('aria-label', STR.yellowSec);
        yInput.onchange = function () {
          settings.thresholds.yellowSec = clampNum(yInput.value, 1, 3600, settings.thresholds.yellowSec);
          if (settings.thresholds.redSec <= settings.thresholds.yellowSec) settings.thresholds.redSec = settings.thresholds.yellowSec + 1;
          saveSettings(false); renderPod(); renderPanel(); renderSettings();
        };
        var rInput = document.createElement('input');
        rInput.type = 'number'; rInput.min = '2'; rInput.max = '7200';
        rInput.value = String(settings.thresholds.redSec);
        rInput.setAttribute('aria-label', STR.redSec);
        rInput.onchange = function () {
          settings.thresholds.redSec = clampNum(rInput.value, settings.thresholds.yellowSec + 1, 7200, settings.thresholds.redSec);
          saveSettings(false); renderPod(); renderPanel(); renderSettings();
        };
        thrWrap.appendChild(yInput); thrWrap.appendChild(rInput);
        thrRow.appendChild(thrWrap);
        box.appendChild(thrRow);

        box.appendChild(sliderRow(STR.size, {
          value: settings.size, min: 0.6, max: 2, step: 0.05,
          onLive: function (v) { settings.size = v; layout(); },
          onCommit: function () { saveSettings(false); }
        }));
        box.appendChild(sliderRow(STR.opacity, {
          value: settings.opacity, min: 0.2, max: 1, step: 0.02,
          onLive: function (v) { settings.opacity = v; layout(); },
          onCommit: function () { saveSettings(false); }
        }));
        box.appendChild(accentRowFor());
        box.appendChild(el('div', 'jingcha-sub', STR.accentHint));
        box.appendChild(segmentedField(STR.theme, [['auto', STR.themeAuto], ['dark', STR.themeDark], ['light', STR.themeLight]], settings.theme, function (value) {
          settings.theme = value;
          layout(); renderPod(); saveSettings(false); renderSettings();
        }));

        var labelsRow = el('div', 'jingcha-field');
        labelsRow.appendChild(el('label', null, STR.labels));
        var labelsToggle = document.createElement('input');
        labelsToggle.type = 'checkbox'; labelsToggle.checked = settings.labels;
        labelsToggle.setAttribute('aria-label', STR.labels);
        labelsToggle.onchange = function () { settings.labels = labelsToggle.checked; layout(); saveSettings(false); };
        labelsRow.appendChild(labelsToggle);
        box.appendChild(labelsRow);

        var popupRow = el('div', 'jingcha-field');
        popupRow.appendChild(el('label', null, STR.popups));
        var popupWrap = el('div', 'jingcha-slider');
        var popupToggle = document.createElement('input');
        popupToggle.type = 'checkbox'; popupToggle.checked = settings.popups;
        popupToggle.setAttribute('aria-label', STR.popups);
        popupToggle.onchange = function () { settings.popups = popupToggle.checked; saveSettings(false); };
        popupWrap.appendChild(popupToggle);
        box.appendChild(popupRow);
        popupRow.appendChild(popupWrap);
        box.appendChild(sliderRow(STR.popupMs, {
          value: settings.popupDurationMs / 1000, min: 1.5, max: 60, step: 0.5,
          onLive: function (v) { settings.popupDurationMs = Math.round(v * 1000); },
          onCommit: function () { saveSettings(false); }
        }));

        box.appendChild(sliderRow(STR.panelWidth, {
          value: settings.panel.width, min: 260, max: 620, step: 10,
          onLive: function (v) { settings.panel.width = v; layout(); },
          onCommit: function () { saveSettings(false); }
        }));
        var tipRow = el('div', 'jingcha-field');
        tipRow.appendChild(el('label', null, STR.tips));
        var tipToggle = document.createElement('input');
        tipToggle.type = 'checkbox';
        tipToggle.checked = local.tips !== false;
        tipToggle.setAttribute('aria-label', STR.tips);
        tipToggle.onchange = function () { local.tips = tipToggle.checked; persistLocal(); };
        tipRow.appendChild(tipToggle);
        tipRow.appendChild(el('span', null, ''));
        box.appendChild(tipRow);
        box.appendChild(sliderRow(STR.tipDelay, {
          value: local.tipDelayMs, min: 150, max: 3000, step: 50,
          onLive: function (v) { local.tipDelayMs = v; },
          onCommit: function () { persistLocal(); }
        }));
        box.appendChild(sliderRow(STR.tipLinger, {
          value: local.tipLingerMs, min: 0, max: 8000, step: 100,
          onLive: function (v) { local.tipLingerMs = v; },
          onCommit: function () { persistLocal(); }
        }));
        box.appendChild(sliderRow(STR.panelHeight, {
          value: local.maxHeight, min: 200, max: 640, step: 20,
          onLive: function (v) { local.maxHeight = v; persistLocal(); layout(); },
          onCommit: function () { persistLocal(); }
        }));

        var presetRow = el('div', 'jingcha-field');
        presetRow.appendChild(el('label', null, STR.preset));
        var presetWrap = el('span', 'jingcha-seg');
        [['top-left', '↖'], ['top-right', '↗'], ['bottom-left', '↙'], ['bottom-right', '↘'], ['center', '◎']].forEach(function (pair) {
          var button = el('button', null, pair[1]);
          button.title = pair[0] === 'center' ? STR.center : pair[0];
          button.setAttribute('aria-label', pair[0]);
          button.onclick = function () { setPreset(pair[0]); };
          presetWrap.appendChild(button);
        });
        presetRow.appendChild(presetWrap);
        box.appendChild(presetRow);

        var resetRow = el('div', 'jingcha-field');
        var resetBtn = el('button', 'jingcha-btn', '↺ ' + STR.resetAll);
        resetBtn.setAttribute('aria-label', STR.resetAll);
        resetBtn.onclick = function () {
          settings = sanitize(DEFAULTS);
          local.maxHeight = LOCAL_DEFAULTS.maxHeight;
          local.fold = sanitizeLocal(LOCAL_DEFAULTS).fold;
          local.savedAt = Date.now();
          persistLocal();
          closePalette();
          layout(); renderPod(); renderPanel(); renderSettings();
          savePositionNow();          // 位置也立刻落盘
        };
        resetRow.appendChild(resetBtn);
        resetRow.appendChild(el('span', 'jingcha-sub', STR.resetAllHint));
        box.appendChild(resetRow);

        var hideRow = el('div', 'jingcha-field');
        var hideBtn = el('button', 'jingcha-btn', STR.hide);
        hideBtn.onclick = function () { settings.hidden = true; saveSettings(true); showChip(); layout(); };
        hideRow.appendChild(hideBtn);
        hideRow.appendChild(el('span', 'jingcha-sub', '恢复：点原位置的小胶囊或 Ctrl+Shift+J'));
        box.appendChild(hideRow);
      }

      function segmentedField(labelText, options, current, onPick) {
        var wrap = el('div', 'jingcha-field');
        wrap.appendChild(el('label', null, labelText));
        wrap.appendChild(segmented(options, current, onPick, labelText));
        return wrap;
      }

      // ── 悬停提示：省略号上停一会儿，弹出完整内容的小框（替代原生 title） ──────
      // 关键点：**不闪烁**。轮询每 1–2 秒会重画面板，如果重画时把提示框删掉，
      // 鼠标没动就不会再触发 pointerenter —— 看起来就是闪一下不见了。
      // 所以：① 重画后按"文本"重新认领同一个提示框；② 换目标时直接切内容不再等延迟；
      // ③ 鼠标移开不立刻收，先留 tipLingerMs（默认 1.5 秒）让人看完。
      var tipEl = null;
      var tipShowTimer = null;
      var tipHideTimer = null;
      var tipText = "";
      var tipTarget = null;

      /** 拿不到尺寸（老浏览器/测试桩）时按"可能被截断"处理，宁可多提示。 */
      function isTruncated(node) {
        if (!node) return false;
        var sw = Number(node.scrollWidth || 0);
        var cw = Number(node.clientWidth || 0);
        if (!sw || !cw) return true;
        return sw > cw + 1;
      }

      function clearTipTimers() {
        if (tipShowTimer) { clearTimeout(tipShowTimer); tipShowTimer = null; }
        if (tipHideTimer) { clearTimeout(tipHideTimer); tipHideTimer = null; }
      }

      /** 立刻收掉提示框（真要收的时候才用：关面板、Esc、卸载）。 */
      function hideTip() {
        clearTipTimers();
        tipText = "";
        tipTarget = null;
        if (tipEl && tipEl.parentNode) tipEl.parentNode.removeChild(tipEl);
        tipEl = null;
      }

      /** 等一会儿再收：鼠标移开不代表要马上消失。 */
      function scheduleHideTip() {
        if (tipHideTimer) clearTimeout(tipHideTimer);
        tipHideTimer = setTimeout(function () { tipHideTimer = null; hideTip(); }, Math.max(0, Number(local.tipLingerMs || 0)));
      }

      function placeTip(node) {
        if (!tipEl || !node) return;
        var vw = window.innerWidth || 1280;
        var vh = window.innerHeight || 800;
        var width = Math.min(360, Math.max(160, vw - 24));
        tipEl.style.width = width + "px";
        var rect = { left: 8, top: 8, bottom: 28 };
        try { if (node.getBoundingClientRect) rect = node.getBoundingClientRect() || rect; } catch (error) { /* ignore */ }
        var left = Math.max(8, Math.min(Number(rect.left || 8), vw - width - 8));
        var below = Number(rect.bottom || 0) + 6;
        var estimatedHeight = Math.min(220, 22 + Math.ceil(String(tipEl.textContent || "").length / Math.max(20, width / 6.6)) * 16);
        var top = below + estimatedHeight > vh - 8 ? Math.max(8, Number(rect.top || 8) - estimatedHeight - 6) : below;
        tipEl.style.left = left + "px";
        tipEl.style.top = top + "px";
      }

      /** 显示（或就地把已有提示框挪到新目标上——这就是"不闪烁"的关键）。 */
      function showTip(node, text) {
        if (!nodes || !text) return;
        if (tipHideTimer) { clearTimeout(tipHideTimer); tipHideTimer = null; }
        tipTarget = node;
        if (tipEl && tipText === String(text)) { placeTip(node); return; }   // 同一段文字：只挪位置，不重建
        if (tipEl && tipEl.parentNode) tipEl.parentNode.removeChild(tipEl);
        tipEl = null;
        var box = el("div", "jingcha-tip");
        box.textContent = text;
        nodes.root.appendChild(box);
        tipEl = box;
        tipText = String(text);
        placeTip(node);
      }

      /** 让一个（可能被省略的）元素支持"停一会儿看全文"。 */
      function bindTip(node, text) {
        if (!node) return node;
        var full = text === undefined || text === null ? "" : String(text);
        if (!full) return node;
        if (local.tips === false) { node.title = full; return node; }   // 关掉提示就退回原生 title
        if (node.removeAttribute) node.removeAttribute("title");
        if (node.setAttribute) node.setAttribute("data-tip", full);     // 重画后靠它认领
        var enter = function () {
          if (tipHideTimer) { clearTimeout(tipHideTimer); tipHideTimer = null; }
          tipTarget = node;
          if (tipEl) { showTip(node, full); return; }                   // 已经开着：直接切过去，不再等延迟
          if (tipShowTimer) clearTimeout(tipShowTimer);
          tipShowTimer = setTimeout(function () {
            tipShowTimer = null;
            if (tipTarget === node && isTruncated(node)) showTip(node, full);
          }, Math.max(0, Number(local.tipDelayMs || 0)));
        };
        var leave = function () { if (tipTarget === node) { tipTarget = null; scheduleHideTip(); } };
        node.addEventListener("pointerenter", enter);
        node.addEventListener("pointerleave", leave);
        node.addEventListener("focus", enter);
        node.addEventListener("blur", leave);
        return node;
      }

      /** 面板重画之后调用：如果同一段文字还在，就把提示框挪过去继续显示（不闪）。 */
      function reclaimTip() {
        if (!tipEl || !tipText || !nodes) return;
        var candidates = [];
        (function walk(node) {
          if (!node) return;
          if (node.getAttribute && node.getAttribute("data-tip") === tipText) candidates.push(node);
          var children = node.children || [];
          for (var i = 0; i < children.length; i++) walk(children[i]);
        })(nodes.panel);
        if (candidates.length === 0) { hideTip(); return; }
        placeTip(candidates[0]);
      }

      function pushToast(title, text, level) {
        if (!settings.popups || !nodes) return;
        var card = el('div', 'jingcha-toast');
        card.style.setProperty('--j-dot', LEVEL_COLOR[level] || LEVEL_COLOR.yellow);
        var head = el('div');
        head.appendChild(el('b', null, title));
        head.appendChild(el('span', 'jingcha-mono', ' ' + new Date().toLocaleTimeString('zh-CN', { hour12: false })));
        card.appendChild(head);
        var body = el('div', 'jingcha-sub jingcha-ellipsis', text);
        body.title = text;
        card.appendChild(body);
        card.onclick = function () { setPanel(true); renderPanel(); };
        nodes.toasts.appendChild(card);
        nodes.toasts.className = 'jingcha-toasts' + (settings.position.mode === 'docked' && settings.position.right <= 220 ? ' jingcha-left' : '');
        toasts.push(card);
        while (toasts.length > 3) { var old = toasts.shift(); if (old && old.parentNode) old.parentNode.removeChild(old); }
        setTimeout(function () {
          if (card && card.parentNode) card.parentNode.removeChild(card);
          var at = toasts.indexOf(card);
          if (at >= 0) toasts.splice(at, 1);
          if (nodes && toasts.length === 0) nodes.toasts.className = 'jingcha-toasts jingcha-hidden';
        }, settings.popupDurationMs);
      }

      function noticeNewFindings(status) {
        if (!status || !settings.popups) return;
        var findings = status.findings || [];
        var newest = seenAt;
        for (var i = 0; i < findings.length; i++) {
          var f = findings[i];
          var at = Date.parse(f.at || '') || 0;
          if (at > newest) newest = at;
          if (at <= seenAt) continue;
          if (f.severity === 'warn' || f.severity === 'critical') {
            pushToast(f.severity === 'critical' ? '告警' : '留意', f.text || f.kind || '', f.severity === 'critical' ? 'red' : 'yellow');
          }
        }
        if (newest > seenAt) { seenAt = newest; storeSet(SEEN_KEY, String(seenAt)); }
      }

      // ── 轮询 ───────────────────────────────────────────────────────────
      function intervalMs() {
        if (typeof document !== 'undefined' && document.hidden) return 5000;
        return panelOpen ? 1000 : 2000;
      }
      function schedule() {
        if (disposed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(poll, intervalMs());
      }
      function poll() {
        if (disposed) return Promise.resolve();
        return httpJson('GET', API.status).then(function (res) {
          lastError = !(res && res.ok && res.json);
          lastStatus = lastError ? null : res.json;
          try { recordSample(lastStatus, Date.now()); } catch (error) { warnOnce('timeline', error); }
          if (settings.theme === 'auto' && nodes) {
            var theme = resolveTheme();
            if (theme !== lastTheme) layout();     // 界面主题变了（DSH 或系统）就跟上
          }
          safeRender();
          if (!lastError) { try { noticeNewFindings(res.json); } catch (error) { warnOnce('findings', error); } }
        }).catch(function () {
          lastError = true; lastStatus = null;
          try { recordSample(null, Date.now()); } catch (error) { warnOnce('timeline', error); }
          try { renderPod(); } catch (error) { warnOnce('pod', error); }
          try { renderTimeline(); } catch (error) { warnOnce('timeline', error); }
        }).then(schedule, schedule);
      }

      // ── 隐藏与恢复 ─────────────────────────────────────────────────────
      function showChip() {
        if (chip || !document.body) return;
        chip = el('div', 'jingcha-chip-restore');
        chip.setAttribute('role', 'button');
        chip.setAttribute('tabindex', '0');
        chip.setAttribute('aria-label', STR.name);
        chip.title = STR.name + '（点击恢复，或按 Ctrl+Shift+J）';
        chip.appendChild(el('span', 'jingcha-dot'));
        chip.appendChild(el('span', null, STR.name));
        chip.onclick = function () { settings.hidden = false; saveSettings(true); hideChip(); layout(); renderPod(); };
        chip.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chip.onclick(); }
        });
        document.body.appendChild(chip);
        applyPosition();
        renderPod();
      }
      function hideChip() { if (chip && chip.parentNode) chip.parentNode.removeChild(chip); chip = null; }

      // ── 生命周期 ───────────────────────────────────────────────────────
      function teardown() {
        disposed = true;
        hideTip();
        if (timer) { clearTimeout(timer); timer = null; }
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (dragCleanup) { try { dragCleanup(); } catch (error) { /* ignore */ } dragCleanup = null; }
        if (mediaCleanup) { try { mediaCleanup(); } catch (error) { /* ignore */ } mediaCleanup = null; }
        closePalette();
        if (typeof document.removeEventListener === 'function') {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('pagehide', onHide);
          document.removeEventListener('pointerdown', onDocPointerDown, true);
        }
        for (var i = 0; i < toasts.length; i++) { var t = toasts[i]; if (t && t.parentNode) t.parentNode.removeChild(t); }
        toasts = [];
        hideChip();
        var styleNode = document.getElementById ? document.getElementById('jingcha-style') : null;
        if (styleNode && styleNode.parentNode) styleNode.parentNode.removeChild(styleNode);
        if (nodes && nodes.root && nodes.root.parentNode) nodes.root.parentNode.removeChild(nodes.root);
        nodes = null;
      }
      function onKey(event) {
        if (!event) return;
        if (event.key === 'Escape') {
          if (paletteEl) { closePalette(); return; }
          if (tipEl) { hideTip(); return; }
          if (panelOpen) setPanel(false);
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'J' || event.key === 'j')) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          settings.hidden = !settings.hidden;
          saveSettings(true);
          if (settings.hidden) showChip(); else hideChip();
          layout(); renderPod();
        }
      }
      function onHide() { try { storeSet(STORE_KEY, JSON.stringify(settings)); persistLocal(); } catch (error) { /* ignore */ } }

      function apply(ctx) {
        loadLocal();
        ensureStyle();
        build();
        layout();
        if (settings.hidden) showChip();
        renderPod();
        renderTimeline();          // 先把 30 段网格画出来：第一次轮询回来前也有刻度
        if (typeof document.addEventListener === 'function') {
          document.addEventListener('keydown', onKey);
          document.addEventListener('pagehide', onHide);
          document.addEventListener('pointerdown', onDocPointerDown, true);
        }
        try {
          if (window.matchMedia) {
            var media = window.matchMedia('(prefers-color-scheme: dark)');
            var onChange = function () { if (settings.theme === 'auto') layout(); };
            if (media.addEventListener) { media.addEventListener('change', onChange); mediaCleanup = function () { media.removeEventListener('change', onChange); }; }
          }
        } catch (error) { /* ignore */ }
        // DSH 客户端主题事件（community 做法）：界面换主题时立刻跟上
        try { if (ctx && typeof ctx.on === 'function') ctx.on('theme/change', function () { if (settings.theme === 'auto') layout(); }); } catch (error) { /* ignore */ }
        loadRemote();
        if (!seenAt) seenAt = Date.now();
        poll();
        if (settings.panel.defaultOpen) setPanel(true);
        if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { return teardown; }, 'jingcha-widget');
        else if (ctx && typeof ctx.on === 'function') ctx.on('dispose', teardown);
        return teardown;
      }

      return {
        name: 'jingcha-widget',
        apply: apply,
        __internals: {
          DEFAULTS: DEFAULTS, LOCAL_DEFAULTS: LOCAL_DEFAULTS, STR: STR, LEVEL_COLOR: LEVEL_COLOR, PRESET_COLORS: PRESET_COLORS,
          sanitize: sanitize, sanitizeLocal: sanitizeLocal, levelOfCall: levelOfCall, pickLight: pickLight, fmtDur: fmtDur,
          TL_SLOTS: TL_SLOTS, TL_SPAN_MS: TL_SPAN_MS, HISTORY_MAX: HISTORY_MAX,
          stateLevel: stateLevel, sampleLevel: sampleLevel, sampleLabel: sampleLabel, sampleReasons: sampleReasons, bucketize: bucketize,
          recordSample: recordSample, renderTimeline: function () { renderTimeline(); }, history: function () { return history; },
          withAlpha: withAlpha, uiIsDark: uiIsDark, uiSurfaceColor: uiSurfaceColor, parseColor: parseColor, paletteFor: paletteFor, uiThemeSignal: uiThemeSignal,
          resolveTheme: function () { return resolveTheme(); },
          poll: poll, setPreset: setPreset, closePalette: function () { closePalette(); },
          state: function () { return { settings: settings, local: local, lastStatus: lastStatus, lastError: lastError, panelOpen: panelOpen, nodes: nodes, chip: chip, palette: paletteEl }; },
          chip: function () { return chip; }
        }
      };
    }
  });
})();
