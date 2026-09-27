# 鲸察挂件（lib/client.js）· 升级规格 v2

> **实现状态（2026-09-28 02:0x）**：本文档是 v2 规格；此后又迭代到 v5（拖动即时落盘、五宫格复位、色板浮层、
> 统一调色板、滑块按帧节流 + 数字直填、恢复默认）。当前 `node test/verify-client.mjs` **81 项全绿**
> （形态/懒加载、阈值分级、拖动与位置持久化、异常 toast、设置界面改阈值、接口降级、清理），
> 另有离线 93 项 + 真 cordis 13 项。规格第 4 节的 a)–f) 均已覆盖。

> 目标：把右下角胶囊从"会闪的灯"升级为**可拖动、可配置、可持久化、会主动提示异常**的运行时仪表。
> 实现者：客户端面只改 lib/client.js 与 test/verify-client.mjs（可另写 lib/WIDGET-NOTES.md 记录取舍）。

## 0. 现有形态与硬约束（不要破坏）

- 文件形态：IIFE + window.__ModuleLoader__.load({ id, factory })，id 必须等于包名 @local/dsh-jingcha。
- factory 必须懒：调用 factory 之前不许碰 DOM；factory 返回 { name: 'jingcha-widget', apply }。
- apply(ctx) 里挂 DOM 与定时器，并用 ctx.effect(() => teardown, 'label') 交回清理；缺失 ctx.effect 时退回 ctx.on('dispose', teardown)。
- 零依赖：factory 的 require 一次都不要用（平台模块表外的依赖会加载失败）。纯原生 DOM + fetch，无 JSX、无构建步骤。
- 只读接口，失败降级：任何接口 4xx/5xx/网络错误都不能抛错，胶囊变灰显示「鲸察未运行」。
- 现有自检必须继续通过：node test/verify-client.mjs（登记 / 懒加载 / 挂载 / 轮询 GET /api/jingcha/status / 清理后从 DOM 摘干净）。

## 1. 宿主接口（已实现，照此消费）

GET /api/jingcha/status -> 200 JSON
  {
    "generatedAt": "ISO",
    "verdict": { "state": "ok|busy|degraded|erroring|stalled", "label": "中文", "reasons": [ { "kind": "tool-hang", "severity": "warn|critical|info", "text": "..." } ] },
    "runtime": { "eventLoopLagMs": 12, "maxLagMs": 74, "rssBytes": 123456 },
    "work": { "inflight": [ { "callId": "call_x", "tool": "pwsh", "sessionId": "session-y", "elapsedMs": 93000, "preview": "command=...", "declaredTimeoutMs": 30000 } ],
              "runningAgents": 1,
              "counters": { "toolCalls": 42, "toolErrors": 1, "toolTimeouts": 0, "toolAborted": 0 } },
    "findings": [ { "at": "ISO", "kind": "tool-hang", "severity": "warn", "text": "..." } ],
    "thresholds": { "slowCallMs": 30000, "hangCallMs": 120000, "stuckCallMs": 300000, "silenceMs": 90000 },
    "capabilities": { "kill": true, "stopTurns": true, "autoKillAfterMs": 0 }
  }

POST /api/jingcha/kill    body {"callId":"call_x"} 或 {"scope":"stalled"|"all"} -> {"ok":true,"killed":["call_x"]}
POST /api/jingcha/stop    -> {"ok":true,"agents":["session-y"]}
GET  /api/jingcha/settings -> {"ok":true,"settings":{...},"defaults":{...},"path":"..."}
POST /api/jingcha/settings body = 完整 settings 或 {"settings":{...}} -> {"ok":true,"settings":{...}}

settings 字段（宿主会夹紧取值，客户端仍应先自行校验）：
  version: 1
  position: { mode: 'free'|'docked', right: 14, bottom: 14, left: null|number, top: null|number }   // px
  size: 0.6–2（默认 1）          opacity: 0.2–1（默认 0.92）
  accent: '' 或 '#rrggbb'（空 = 用主题色）
  labels: true                    // 胶囊上是否显示文字
  thresholds: { yellowSec: 30, redSec: 120 }   // 调用时长分级
  popups: true,  popupDurationMs: 6000
  panel: { defaultOpen: false, width: 340 }
  theme: 'auto'|'dark'|'light'
  hidden: false

## 2. 交互需求（用户原话逐条落地）

1) 拖动：按住胶囊即可拖，跟手（pointer events + setPointerCapture），松手后记住位置。
   位置写进 settings.position（free 模式存 left/top，靠近边缘 12px 内可吸附为 docked 并存 right/bottom）。
   拖动时不要触发"点开面板"（移动阈值 4px）。
2) 位置预设：设置面板里给四个角 + 居中底部 + 恢复默认的按钮；点一下立即移动并存盘。每次打开都停在记住的位置。
3) 指示灯按调用时长变色（客户端算，不用等宿主）：
   在途调用逐个比 thresholds：elapsed <= yellowSec -> 绿；<= redSec -> 黄；> redSec -> 红（红时呼吸）。
   聚合 = 最严重的那个；没有在途调用时：verdict ok -> 暗绿，busy -> 青绿，erroring -> 橙，stalled -> 红，degraded -> 黄。
   胶囊上显示最久在途调用的「工具名 + 时长」（labels 打开时）。
4) 阈值可在界面里改：设置页两个数字框（黄灯秒、红灯秒）+ 滑块，改完即时生效（本地先应用，再 POST settings，失败也不回滚，只标红提示）。
5) 异常右侧弹出提示：出现新的 finding（severity warn/critical）或 verdict 翻到 stalled/erroring 时，
   在胶囊**右侧**（右侧贴边则左侧）弹出一条小卡片：图标 + 一句话 + 时间；最多同时 3 条，自动消失（popupDurationMs），点它展开主面板。
   记住 lastSeenFindingAt（写进 localStorage），避免刷新后重复弹。
6) 外观设置：大小（滑块 0.6–2）、不透明度（0.2–1）、主色（颜色选择器 + 恢复默认）、是否显示文字、
   主题（跟随系统/深/浅）、面板宽度、提示开关与停留时长、隐藏胶囊（隐藏后如何恢复：设置里存 hidden=true 时，
   在页面右下角留一个 4px 的极简触发点，hover 时展开，避免用户把自己关在外面）。
7) 界面与文案全面优化（对齐社区标准）：
   - 胶囊：状态点 + 判定中文 + 最久在途（如 pwsh 1m33s）；hover 显示 tooltip（判定理由一句话）。
   - 面板：分四段——判定（state/label/理由/事件循环延迟/内存）、在途调用（每条：工具、时长、参数预览、[⛔ 停]）、
     最近告警（最多 5 条，带 severity 色点）、设置（齿轮页签）。
   - 键盘可达：Esc 关面板，Tab 焦点可见，按钮有 aria-label；尊重 prefers-reduced-motion（关呼吸动画）。
   - 主题：auto 跟随 prefers-color-scheme；深色/浅色都好看；所有样式一次性注入 <style>，class 前缀 jingcha-。
   - 文案：zh 为主，留 en 字典接口（不强求英文 UI，但字符串集中在 STRINGS 表里）。
   - 面板宽度默认 340，最大不超视口 92%；小屏（<420px）自动全宽贴底。

## 3. 数据与状态

- 启动流程：先读 localStorage 缓存渲染（首屏不闪）-> GET settings 合并（宿主权威）-> GET status 起轮询（2s，面板打开时 1s；页面不可见 document.hidden 时 5s）。
- 每次改动设置：立即本地生效 -> POST settings（防抖 400ms）；POST 失败只在设置页显示一行「未保存到宿主（本地已生效）」。
- 不写 cookie、不引入第三方、不请求非 /api/jingcha/* 的地址（除当前页面）。

## 4. 验收与自检

- node test/verify-client.mjs 必须继续全绿，并新增覆盖：
  a) 拖动：合成 pointerdown/pointermove/pointerup 后 settings.position 更新且触发了 POST /api/jingcha/settings；
  b) 颜色分级：给 yellowSec=10/redSec=20 的 settings + elapsedMs=5000/15000/25000 三种 status，胶囊 class 或 dataset 上能读出 green/yellow/red；
  c) 异常弹提示：第二次 status 带一条新的 warn finding 时，DOM 里出现提示卡片；
  d) 设置面板：改阈值后本地状态与 POST body 一致；
  e) 接口挂掉（fetch reject）时胶囊变灰且不抛错；
  f) 清理：ctx.effect 的 disposer 跑完后 body 里不留任何 jingcha- 节点、也没有残留定时器。
- 代码内自测友好：把纯逻辑（选颜色、夹紧设置、算时长文案）拆成小函数并挂在 apply 返回的 teardown 之外暴露给测试（例如 window.__jingchaInternals = {...}，仅在 factory 作用域内赋值，便于 Node 桩测试）。
- 写 lib/WIDGET-NOTES.md：字符串表位置、设置字段、已知取舍、无法在无浏览器下验证的部分。

## 5. 环境

Windows + PowerShell 7 + Node 24（任何目录都能跑；数据目录默认 %DSH_HOME%\data\dsh-jingcha）。
写文件用 UTF-8 无 BOM；命令用 pwsh；不要重启 dsh、不要动 profile、不要改宿主侧文件（lib/core.js、lib/index.js、lib/sink.js、cordis.patch.yml、package.json）。
