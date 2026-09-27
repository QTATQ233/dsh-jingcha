# 扩展指南（想加东西时看这一页）

鲸察刻意做成"四个面 + 一个纯逻辑核"：`lib/core.js`（纯逻辑，零依赖、可单测）· `lib/index.js`（宿主接线）· `lib/sink.js`（落盘）· `lib/client.js`（浏览器挂件）。
下面是最常见的五类改动，按"改哪几处"给出最小清单（行号会漂，函数名不会）。

## 1. 加一条判定规则（例如"同一工具连续失败 N 次"之外的新模式）

1. `lib/core.js` 的 `DEFAULTS`（阈值 + 开关）加字段；
2. `lib/core.js` 的 `verdict()`：在理由链里加分支，`reasons.push({ kind, severity, ... })`；
3. `lib/index.js` 的 `statusPayload()`：需要暴露给挂件就加进 payload；
4. `cordis.patch.yml` 的 `config:` 里同步默认值（用户可改）；
5. `test/verify.mjs` 加一个场景（构造 monitor → 断言 state/label/reasons）；
6. README 的判定表加一行。

## 2. 加一个 HTTP 路由（挂件要新接口时）

1. `lib/index.js` 里 `ctx.inject(['webServer'], ...)` 那段：照着现有四条 `add(path, handler)` 写，**第一行必须 `if (!guard(req, res, { mutation: ... })) return;`**
   （`guard` 统一做回环 + Host 白名单 + 跨站拒绝 + 变更类只收 POST JSON + 可选 token）；
2. `lib/client.js` 顶部 `API` 表加路径；
3. `test/verify.mjs` 加：同源放行、跨站/坏 Host/错 content-type 被拒。

## 3. 加一个挂件面板分区

1. `lib/client.js` 的 `section(key, title)` 工厂 + `build()` 里 append；
2. `local.fold` 默认值（`LOCAL_DEFAULTS.fold`）加 key；`applyFold()` 的数组加 key；
3. 写一个 `renderXxx()`，在 `renderPanel()` 里调用（**不要**在轮询里重建交互控件，见下）；
4. `test/verify-client.mjs` 加 DOM 桩断言。

## 4. 加一个设置项

- **宿主也认识的**（要跨浏览器共享）：`lib/index.js` 的 `WIDGET_DEFAULTS` + `sanitizeSettings()`，再在 `lib/client.js` 的 `DEFAULTS` + `sanitize()` 加同名字段（两边夹紧规则必须一致）；
- **只属于本浏览器的**：`lib/client.js` 的 `LOCAL_DEFAULTS` + `sanitizeLocal()`（宿主保存时会丢弃未知字段，属预期）；
- 最后在 `renderSettings()` 里加控件。滑块请用 `sliderRow()`（自带数字直填、按帧节流、拖动中不重建 DOM）。

## 5. 换语言 / 改配色

- 文案：`lib/client.js` 的 `STR` 表是挂件全部文案；`lib/core.js` 的判定标签与 report 正文目前是内联中文（要 i18n 需先抽词表）。
- 配色：`lib/client.js` 的 `paletteFor(theme, surfaceRgb)` 是**唯一**配色来源（胶囊/面板/文字/边框/控件底/轨道色都由它派生）；
  改颜色只改这里 + CSS 里的 `--j-*` 默认值，不要在别处硬编码。灯色是状态色，永远不要被主色覆盖。

## 三条容易踩的坑

1. **轮询里不要重建设置区**：`poll()` → `safeRender()` 只重画胶囊与面板；重建设置区会把用户正拖的滑块/打开的色板一起换掉（历史真 bug）。
2. **交互控件用 `controlBusy` 保护**：`pointerdown`/`focus` 期间 `renderSettings()` 直接返回。
3. **`package.json` 的 `exports["./client"]` 指向单文件**：真要拆多文件得先加一个极小打包步骤（把多文件内联成单个 bundle）。
