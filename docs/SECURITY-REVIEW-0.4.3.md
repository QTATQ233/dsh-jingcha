# SECURITY REVIEW · 鲸察 v0.4.3

> 审查对象：`@local/dsh-jingcha` v0.4.3（DSH 运行时监察插件）
> 审查时间：2026-09-28
> 审查范围：两路独立审查 —— 运行时（runtime）与工具链 / 供应链（toolchain）
> 审查方式：每路各由一名**只读子代理**独立完成（只读不改代码）；修复由主会话落地并加回归断言
> 本文件是结论汇编（抽取自两路审查报告与 CHANGELOG），不复制原始报告全文

## 1. 结论

| 项 | 结果 |
|---|---|
| 严重 / 高危 | **0** |
| 中危 | **3（运行时） + 5（工具链）** |
| 低危 | **11** |
| 总评 | 运行时侧原评语：**能安全自用，但原样分发不妥**（四个路由原本只做回环判断）；加固后本机与分发两种场景均可 |
| 处置 | 逐条**修复**或**文档化为已知边界**（设计取舍，非漏洞） |

## 2. 审查范围

| 路径 | 覆盖对象 |
|---|---|
| 运行时 runtime | 宿主插件本体：HTTP 四路由与栅栏、判定与强制停止、快照 / 事件日志、挂件前端、安装脚本 |
| 工具链 toolchain | 发布与供应链：`tools/pack.mjs`、`tools/prepare-publish.mjs`、发布自检、CI、`tools/gh-app.mjs`、契约文档 |

两路均为只读子代理，结论互不共享、事后交叉比对。

## 3. 运行时路径：逐条发现与处置

> 条目代号沿用原审查报告；字母前缀是报告自身的编号，**不代表最终严重度分级**，中危合计数见 §1。

| 编号 | 问题 | 处置 |
|---|---|---|
| S1 | 四个路由只做回环判断，缺 Origin / Host / CSRF 校验：任意网页可杀调用 / 停轮次 / 改设置，DNS rebinding 可读 | **已修**：统一 `guard()` —— 回环 + Host 白名单 + 拒跨站 Origin / Sec-Fetch-Site + 变更类只收 POST JSON + 可选 `apiToken` |
| M1 | 状态变更走 GET（`<img>` 一发即杀） | **已修**：非 POST 返回 405；`scope` 白名单 |
| M2 · M4 | `stalled` / `autoKill` 只看时长、不看有没有产出 | **已修**：加静默门（`silentMs`，core 记 `lastProgressAt`） |
| M3 | 日志 / 快照未脱敏 | **已修**：`redactPatterns`（默认打码 token / password / bearer…），可 `previewArgs: false` 全关 |
| M5 | `readBody` 单 chunk 可突破 8KB；reason 原文进日志 | **已修**：按剩余额度切片；`sanitizeReason` 限长 200 并去控制字符 |
| L1 | `callId` 缺失时键退化成 `"undefined"`，可能杀错 | **已修**：空 / `"undefined"` 直接拒 |
| L3 | 返回本机绝对路径 | **已修**：只回文件名（`exposePaths` 可开） |
| L4 | 安装脚本删 junction 用 `Remove-Item -Recurse`、备份不清理 | 审查时**未修**，当时记为待办；后续 `jingcha-install-script` 已修（`cmd /c rmdir /q` 只删链接不递归 + 备份保留最新 10 个 + 往返测试 16/16 PASS） |

v0.4.3 同期落地的运行时 / 宿主侧修复（CHANGELOG §0.4.3 引用的审查编号）：

| 编号 | 修复 |
|---|---|
| M1 | 脱敏覆盖补齐：空格分隔的凭据（`--password hunter2`、`-p s3cret`）、带引号的 JSON 键（`"password":"x"`）、裸键（`pwd=` / `sig:` / `token=`）现在都会变成 `[已脱敏]` |
| M2 | `memoryLeakWindow` 夹紧到 [2,120] + 采样数组上限 240，配置写多大都不会无界增长 |
| L1 | `apiToken` 改为常量时间比较（各自 sha256 后 `timingSafeEqual`），消除时序侧信道 |
| L2 | Host 白名单接受 IPv4-mapped 写法（`[::ffff:127.0.0.1]:port`），避免把本机请求误判为外来 |
| L4 | 脱敏正则编译结果缓存，事件热路径不再反复 `new RegExp` |
| B-Q5 | 默认 `toolEnabled: false`：不再依赖仓库 patch 才是 0 token，编程加载也 0 token |

## 4. 工具链 / 供应链路径：逐条修复

| 编号 | 问题 | 处置 |
|---|---|---|
| B-Q1 | 隐私针读不出时脱敏与自检一起静默失效；扫描受扩展名白名单限制；复制跟随符号链接 / junction；敏感文件名大小写敏感 | **已修**：读不出直接失败（fail-closed）；隐私针不存在时警告并用通用形态兜底；全文件 + 二进制按字节扫描；`lstatSync` 不跟随链接并告警；打包自检文件名大小写不敏感 |
| B-Q2 | 脱敏不可审计 | **已修**：打印「每条规则替换了几次」（0 次也打） |
| B-Q3 | `gh-app.mjs` 无请求超时、多安装静默挑第一个、重复异常钩子 | **已修**：20 秒超时、多安装显式报错、`JINGCHA_GH_APP_DIR` 可覆盖、去掉重复钩子 |
| B-Q4 | CI 权限过宽 | **已修**：`permissions: contents: read`（最小权限） |
| B-Q5 | 契约文档与实现漂移（OpenAPI 版本 / PUT 语义、config schema 缺字段、`toolEnabled` 默认值、`JINGCHA_API_TOKEN` 兜底未注明） | **已修**：OpenAPI 版本与 PUT 语义同步；schema 补 `recentCalls` / `recentFindings` / `reportWindowMs`；`toolEnabled` 默认改 false；注明 `JINGCHA_API_TOKEN` 兜底 |

## 5. 低危项与分诊

低危共 **11 项**，按「能修就修、修不了就写明边界」处理。可追溯的已修复 / 加固项：

- 返回本机绝对路径（L3）→ 只回文件名；
- `callId` 退化键（L1）→ 拒绝空 / `"undefined"`；
- 脱敏正则热路径反复编译（L4）→ 结果缓存；
- 打包脚本早期版本 `rmSync(dist)` 会连 git 仓库（`dist/publish`）一起删 → 改为只清 stage 与旧 zip，恢复手段是从远端重新 clone；
- `readBody` 无 8KB 切片上限、`events.jsonl` 无轮转上限 → 补上限（本机接口 / 日志的慢速自伤）；
- 安装脚本 junction / 备份问题（L4）→ 后续待办 `jingcha-install-script` 闭环。

其余低危项作为**已知边界**保留，完整逐条清单见原始两路报告（§8）。

## 6. 已验证无问题 / 文档化的已知边界

**已验证无问题**（原报告明确核查过）：无第三方依赖、无网络出口、无动态执行、客户端全 `textContent`（无 XSS 面）、无路径穿越、原型污染不可行、`status.json` 原子替换、`events.jsonl` 有轮转上限、工具默认不暴露给模型（0 token）。

**已知边界（设计取舍，非漏洞）**：未登记 controller 的调用明确回 `not-live` 而不是乱杀；接口无速率限制（前提是只监听回环）；同进程死循环只能靠中止信号。

## 7. 验证

- 自检 **229 项全绿**：125 离线 + 14 真 cordis + 90 挂件；其中 **5 条**是针对本次安全审查修复的回归断言。

```powershell
node test/verify.mjs
node test/verify-cordis.mjs
node test/verify-client.mjs
```

## 8. 引用

- 变更日志：`CHANGELOG.md` §0.4.3「独立安全审查（两路：运行时 / 工具链）后的修复版」
- 发布提交：发布仓库 `dist/publish` 的 `3ebf582`（`release: v0.4.3 — 独立安全审查修复：脱敏覆盖/采样夹紧/token 常量时间比较/发布自检 fail-closed/默认 0 token`，tag `v0.4.3`，2026-09-28）
- 前置安全加固：`CHANGELOG.md` §0.3.0（回环 + Host 白名单 + 拒跨站 Origin / Sec-Fetch-Site + 变更类只收 POST JSON + 可选 token）
- 原始审查报告来源（会话档案，正文不在此复制）：
  - `跨会话信息/_archive/原始文件-20261006/12-鲸察实测与安全加固-2026-09-28.md` §二 安全审查
  - `跨会话信息/_archive/原始文件-20261006/17-鲸察v0.4.3-会话总结-2026-09-28.md` §成果 O4
