# 鲸察 (dsh-jingcha) · DSH 运行时监察插件

> **名字**：鲸察（jīngchá）——鲸，呼应工作区里的小鲸鱼；察，就是监察。
> 包名 `@local/dsh-jingcha`，目录名可自取，下文示例统一用 `C:\dsh-jingcha`。

给 DSH 装一块仪表盘：**工具调用 / 模型输出 / 事件循环 / 错误循环** 四路都看得见。
它只回答一句话就能说清的问题——**现在是在正常干活，还是卡住了，还是出了 bug？**

| 判定 | 含义 | 典型触发 |
|---|---|---|
| ✅ `ok` | 正常（空闲） | 没有在途调用、没有 agent 在跑、没有异常 |
| 🟢 `busy` | 运行中（有进展） | 有调用在跑 / agent 在跑，且还在产出 |
| 🟡 `degraded` | 偏慢 / 降级 | 单次调用 > 30s、事件循环延迟 > 500ms、长时间没有新输出、等审批太久 |
| 🟠 `erroring` | 出现错误（疑似 bug） | 同一工具 2 分钟内失败 ≥3 次（错误风暴）、连续失败、模型层反复报错 |
| 🔴 `stalled` | 疑似卡住 | 在途调用 > 2min（挂起）/> 5min（卡住）、有 agent 在跑但 90s 没有任何输出、事件循环被占住 |

---

## 一、它观察什么（全部只读，绝不改写被观察的东西）

| 宿主事件 / 数据源 | 拿它干什么 |
|---|---|
| `tools/pre-execute` | 调用入口：开始计时；记录裁决（allow / ask / deny / cancel）与**审批等待时长** |
| `tools/execute` | 真正的派发窗口：在途时长、工具体抛没抛异常；读出工具声明的 `timeoutMs` 上限 |
| `tools/result` | 最终结果：错误码 / 错误信息 / **结果字节数与内容块数**（输出面靠它）；也补全被策略直接拒绝、没进派发的调用 |
| `agent/status` | 谁在跑、谁闲着 |
| `agent/assistant-stream` | 模型流式帧（只数 `chunk`）——模型还在吐字的最直接证据 |
| `session/event` | 会话还在追事件——还有输出的第二路证据 |
| `agent/error` / `agent/request-error` | 步骤级失败与请求级重试（两者分级不同：重试只记 info，不判 bug） |
| `subagent/start` / `subagent/end` | 子智能体起止 |
| `ctx.jobs`（有才用） | 后台 job 总数 / 运行中数量 |
| 1 秒心跳 | 事件循环延迟、RSS/堆内存、活跃资源数、判定推进 |

拿到的事实会折算成这几种理由（reason kind），报告里逐条列出：

`tool-slow` `tool-hang` `tool-stall` `error-storm` `failure-loop` `agent-error` `agent-error-loop`
`no-progress` `progress-slow` `event-loop-lag` `event-loop-blocked` `host-suspend` `approval-wait`
`tool-denied` `empty-result` `plugin-error`

> 关于 `host-suspend`：如果事件循环一口气停了 ≥30s（笔记本休眠、宿主被挂起、一个超长同步任务），
> 只记一条 warn 并说清原因，**不会**据此把它算成卡住。

---

## 二、产出：快照 / 事件流 / 控制台 / 本机接口（+ 可选的模型工具）

### 1. `status.json` —— 实时快照（原子替换，默认每 5s 或状态翻转时写）

字段：`verdict`（判定 + 理由）、`runtime`（事件循环延迟 / 内存）、`work`（在途调用、agent、计数器、错误率）、
`tools`（各工具调用次数 / 失败 / 平均 / 最长 / 结果字节）、`recentCalls`、`findings`、`thresholds`。

### 2. `events.jsonl` —— 追加式事件流（超 8MB 自动轮转为 `.1`）

每行一个 JSON：`tool.call`（每次调用结算一行）、`tool.hang` / `tool.stall`、`finding`、
`state.change`（判定翻转）、`agent.error`、`loop.suspend`、`plugin.error`。

### 3. `jingcha_status` 工具 —— 让会话里就能体检

模型（或用户说一句「看看监察」）调用它，得到中文 Markdown 报告：判定、判定理由、正在跑什么、
工具使用统计表、最近调用、最近告警、输出面统计。参数：`windowMinutes`（窗口分钟数）、`includeSnapshot`（是否附原始快照）。

### 4. 控制台一行

只在判定**翻转**时往宿主那个黑窗口打一行（形如 `[鲸察] 判定 -> 疑似卡住（stalled）：…`）；
长调用期间每 `consoleProgressMs` 还会打一行「仍在跑」。

## 二·五、零 token 模式 + 紧急停止（默认就是这样）

**0 token**：默认 `toolEnabled: false` —— 插件不注册任何模型可见的工具，因此**每个请求 0 常驻开销**；
它只写 `status.json` / `events.jsonl` / 控制台，以及给右下角挂件用的本机 HTTP 接口。
想让模型也能直接问「鲸察看下」，把 patch 里的 `toolEnabled` 改成 `true`（代价约 176 tokens/请求）。

**紧急停止 / 强制停止**（这才是"有问题时有用"的部分）：

| 动作 | 怎么做 | 效果 |
|---|---|---|
| 停单个卡住的调用 | `POST /api/jingcha/kill` body `{"callId":"call_x"}` | 掐断该调用的中止信号；`pwsh` 这类子进程工具**真的被杀掉** |
| 停掉所有超阈值的调用 | `POST /api/jingcha/kill` body `{"scope":"stalled"}` | 按 `stuckCallMs`（默认 5 分钟）批量停 |
| 全部停止在途调用 | `POST /api/jingcha/kill` body `{"scope":"all"}` | 一个不留 |
| 停止所有正在跑的轮次 | `POST /api/jingcha/stop` | 等价于界面上那个停止按钮（`agent.cancel({kind:"user"})`） |
| 自动停止 | patch 里 `autoKillAfterMs: 300000` | 在途超过 5 分钟自动掐断（默认 0 = 关闭） |
| 看状态（挂件/脚本用） | `GET /api/jingcha/status` | 判定 + 在途调用 + 计数器 + 最近告警的紧凑 JSON |
| 读/写挂件设置 | `GET` / `POST /api/jingcha/settings` | 位置、大小、不透明度、主色、主题、阈值、提示开关；宿主夹紧取值并落盘 `widget-settings.json` |

接口只接受本机回环请求（非回环 403）。每次停止都会写一条 `kill.done` 事件 + 一条 `kill` 告警，
所以"谁在什么时候停了什么"在 `events.jsonl` 里有据可查。

> 诚实说明：掐断是**协作式**的——响应取消的工具会立刻停（子进程会被杀），
> 但同进程里不理会 `exec.signal` 的死循环停不下来（宿主没有硬杀同进程代码的能力）。

---
### 5. 右下角红绿灯挂件（客户端面 `lib/client.js`，v6）

**胶囊**：状态点 + 判定文字（有在途调用时显示「pwsh 1m33s」）+ tooltip；接口不可用时灰显「鲸察未运行」。
**灯色按调用时长分级**（客户端即时算）：`≤黄灯秒 → 绿`、`≤红灯秒 → 黄`、`>红灯秒 → 红（呼吸）`；空闲时看判定状态。
灯色**永远是状态色**，不会被主色覆盖——主色只负责"它长什么样"。

**位置＝上次的位置**：按住胶囊拖动（4px 内算点击），松手**立刻**写盘，页面关闭前再补一次；本地 `savedAt` 与宿主设置合并时取更新的那份。
复位给全五宫格：**左上 / 右上 / 左下 / 右下 / 居中**（设置里一排小按钮）。

**面板**：默认紧凑（宽 320 / 高 340），四个分段（判定 / 在途调用 / 最近告警 / 设置）点标题可折叠且本地记住；
长文本一律省略号 + `title`；面板宽度与最大高度都可在设置里调。

**设置界面（v4 重做）**：

- **滑块顺滑**：拖动中只更新样式与数值、**不重建 DOM**（v3 每次 input 都重建设置区，range 被替换 → 顿挫难拖），松手才落盘；
- 每个滑块**后面跟一个数字框**，可直接键入精确值（如 `1.35×`、`87%`、`418px`）；
- **主题三段按钮**：跟随界面 / 深 / 浅；「跟随界面」读的是 **DSH 客户端主题**（`body[data-ds-dark-theme]`、`html[data-ds-theme-source]`），
  再退回 `prefers-color-scheme`，并订阅客户端 `theme/change` 事件 + 轮询兜底，界面换主题它立刻跟上；
- **主色＝自绘色板浮层**：12 个预设色 + 十六进制输入 + 「跟随主题」；**只有点击浮层外面或 Esc 才关闭**（不会点一下就消失）；
  主色真正生效在：胶囊描边与内描边、面板标题条、按钮悬停、滑块轨道与选中态；
- 提示开关与停留时长、是否显示文字、面板宽/高、五宫格复位、隐藏胶囊。

**v5 打磨（手感 / 配色 / 恢复默认）**：

- **滑块真的顺了**：拖动中按帧（rAF）节流、只改视觉变量，**并且轮询不再重建设置区**——v4 每 1–2 秒就重建设置区，
  等于把用户正按着的滑块换成新元素，这就是"顿挫、拖一半跑掉"的根因；同时去掉胶囊 `transform` 过渡（尺寸拖动的橡皮筋感）并加 `will-change`。
- **恢复默认设置**按钮：位置 / 主题 / 主色 / 阈值 / 外观一键回厂（并立刻落盘）。
- **主色色板挂在面板上**（不在设置区里）→ 设置区怎么重画都不会把色板拆掉；**只有点浮层外面或 Esc 才关闭**。
- **胶囊与面板共用同一套配色**：只有一个**基底色**，由它派生 `--j-surface`（胶囊）/ `--j-surface-solid`（面板）/ 边框 / 控件底色；
  文字色（`--j-fg` / `--j-sub`）按基底色亮度自动选（深底浅字、浅底深字）——所以深色下不会再"胶囊深、面板白"或字看不清；
- **深色不再"白深色"**：所有控件显式使用 `--j-field` 底色、面板继承 `color-scheme`；
  「跟随界面」还会**采样 DSH 页面的真实底色**（`getComputedStyle(body).backgroundColor`）来决定深浅、并让挂件底色与界面同色，自定义主题也贴得住。
**悬停看全文（不闪烁）**：所有被省略号截断的文本（在途调用参数预览、判定理由、告警内容）**鼠标停 500ms（可调）弹出完整内容的小框**；
轮询每 1–2 秒重画面板时，它**按文本认领同一个提示框**（不会闪掉、也不会重新计时），换到另一条省略文本是即时切换；
鼠标移开后再留 **1.5 秒（可调）** 才消失；只有真的被截断才弹；设置里可关（关掉则退回原生 title）。
**隐藏能找回**：隐藏后在**原位置**留一个半透明「鲸察」小胶囊（固定定位、带状态灯），点一下就地恢复；另有 `Ctrl+Shift+J` 快捷键兜底。
**「🛑 停止所有轮次」带二次确认。** 每 2 秒拉一次 `GET /api/jingcha/status`（面板打开 1 秒 / 页面隐藏 5 秒），**不消耗任何模型 token**。

客户端改动**不需要重启 dsh**：客户端加载器按文件 mtime 生成版本号，浏览器刷新页面即可拿到新 bundle。
自检：`node test/verify-client.mjs`（DOM 桩下 **90 项**：形态/懒加载、阈值分级、拖动与立即持久化、五宫格复位、异常 toast、悬停看全文、
滑块按帧节流且不重建 + 数字直填、轮询不重建设置区/不关色板、主题三段与跟随 DSH 界面、主色色板（选完不关 / 点外面才关 / 不覆盖灯色）、
恢复默认设置、隐藏与原位置找回、降级、清理）。

---

## 三、安装

前提：插件目录 `C:\dsh-jingcha`（本仓库），profile 默认 `web`。

### 方式 A：免 pnpm（推荐，本机已验证）

```powershell
powershell -ExecutionPolicy Bypass -File C:\dsh-jingcha\tools\install.ps1
```

它做三件事（先备份到 `dsh-jingcha\.backup\`，可整体回滚）：

1. 备份 profile 的 `package.json`；
2. 往 profile manifest 里加依赖 `"@local/dsh-jingcha": "link:C:/dsh-jingcha"` 与 `dsh.profile.bundles` 条目；
3. 在 `%DSH_HOME%\profiles\web\node_modules\@local\` 下建 **junction** 指向插件目录。

为什么 junction 就够：profile 的模块解析是「先安装目录、再 profile 目录」，
并且会把 `node_modules` 下指向外部目录的链接当作额外解析根（`linkedProfileRoots`）。
这与官方 `dsh plugin add link:<目录>` 的效果一致，只是不经过 pnpm。

### 方式 B：官方 pnpm 通道

```powershell
cd C:\dsh-jingcha
dsh plugin --profile web add link:C:/dsh-jingcha
```

（在沙箱内跑会撞 pnpm 全局操作锁；要么放宽授权，要么用方式 A。）

### 方式 C：不改 profile，临时试跑

```powershell
dsh --profile web --patch C:\dsh-jingcha\cordis.patch.yml
```

补丁里写的插件名是 `@local/dsh-jingcha`，仍需要 profile 能解析到它（即方式 A/B 的 junction 或 link），
所以它只适合「已经装过、想换个 patch 层」的场景。

### 装完必须重启

bundle 列表在**启动时**装配；`patchReload: live` 只热更 patch 文件本身。
关掉当前 dsh 窗口，重新运行 `启动dsh.bat`（或 `dsh web`）。

### 重启后的验证清单

```powershell
# 1) profile 层面：bundle 是否被装配（无头、不起服务）
dsh --profile web --dump-config | Select-String dsh-jingcha

# 2) 插件是否真在跑：数据文件是否在刷新
Get-Item $env:DSH_HOME\data\dsh-jingcha\status.json | Select-Object LastWriteTime,Length

# 3) 判定读一眼
Get-Content $env:DSH_HOME\data\dsh-jingcha\status.json -Raw | ConvertFrom-Json | Select-Object -ExpandProperty verdict
```

4) 在会话里让模型调用 `jingcha_status`（或直接问「现在正常吗」）。

---

## 四、卸载

```powershell
powershell -ExecutionPolicy Bypass -File C:\dsh-jingcha\tools\uninstall.ps1 -Restore
```

`-Restore` 用**同一 profile** 的最新备份覆盖回 `package.json`（备份名带 profile 标签，演练/别的 profile 的备份不会被误用）；不加就逐项移除依赖与 bundle 条目。
数据目录 `$env:DSH_HOME\data\dsh-jingcha\` 不会被删——想留证据就留着。

---

## 五、配置（`cordis.patch.yml` 里的 `config:`）

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `%DSH_HOME%\data\dsh-jingcha` | 数据目录；本仓库的 patch 里显式指到 `$env:DSH_HOME\data\dsh-jingcha` |
| `console` | `true` | 判定翻转时往控制台打一行 |
| `slowCallMs` | 30000 | 单次调用超过它记「慢」 |
| `hangCallMs` | 120000 | 在途超过它记「挂起」 |
| `stuckCallMs` | 300000 | 在途超过它升级为「卡住」 |
| `silenceMs` | 90000 | 有 agent 在跑但这么久没有任何输出 → 「没有输出」 |
| `lagWarnMs` / `lagStuckMs` | 500 / 5000 | 事件循环延迟告警 / 判卡死 |
| `approvalWarnMs` | 20000 | 等用户审批超过它 → 提示「像卡住，其实在等人点确认」 |
| `errorStormCount` / `errorStormWindowMs` | 3 / 120000 | 同一工具窗口内失败这么多次 → 错误风暴 |
| `emptyResultBytes` | 0 | >0 时，成功但结果小于它的调用记「空结果」（默认关闭） |
| `heartbeatMs` / `statusEveryMs` | 1000 / 5000 | 心跳与快照节奏 |
| `progressEveryMs` / `consoleProgressMs` | 30000 / 60000 | 长调用期间的进度心跳间隔、控制台「仍在跑」间隔 |
| `maxLogBytes` | 8000000 | 日志轮转阈值 |
| `toolEnabled` | `false` | 是否注册 `jingcha_status` 工具。**默认 false = 0 token**；改 true 才能让模型直接问（约 +176 tokens/请求） |
| `autoKillAfterMs` | 0 | >0 时自动掐断超过该时长的在途调用（自动强制停止） |
| `enabled` | `true` | `false` 时完全不挂载（一行日志说明后退出） |

---

## 六、自检（不依赖宿主，随时可跑）

```powershell
cd C:\dsh-jingcha
node test/verify.mjs            # 107 项：判定逻辑 + 假 ctx 接线 + 落盘 + 跨站栅栏 + 强停（含嵌套调用）+ 契约一致性
node test/verify-cordis.mjs     # 13 项：真 cordis 的 inject 握手 / waterfall 透传 / fiber 卸载
node test/verify-client.mjs     # 81 项：挂件（DOM 桩，无需浏览器）
node tools/pack.mjs             # 打包成 dist/dsh-jingcha-<版本>.zip（分享用）
```

第二个脚本解析不到 `@deepseek-ai/cordis` 时会自动跳过（退出码 0）。想在任意位置跑，给它路径：

```powershell
$env:DSH_CORDIS='C:\...\node_modules\@deepseek-ai\cordis\lib\index.js'; node test/verify-cordis.mjs
```

自检产物落在 `.selftest-out\`（status.json / events.jsonl），可以直接打开看监察长什么样。

---

## 六·五、安全边界（2026-09-28 加固）

四个挂件接口（status/kill/stop/settings）统一过 `guard()`：

- **只认回环地址**，并且 **Host 必须在 `127.0.0.1` / `localhost` / `::1` 白名单里** —— 挡 DNS rebinding；
- 拒绝带 `Origin` 或 `Sec-Fetch-Site: cross-site|same-site` 的请求 —— 挡"随手打开的网页"；
- **变更类接口只接受 `POST` + `content-type: application/json`** —— 挡 `<img>` 一发即杀、跨站表单；
- 可选 `apiToken`（或环境变量 `JINGCHA_API_TOKEN`）：配了就要求 `x-jingcha-token` 头；
- `events.jsonl` / `status.json` 里的参数摘要默认**对 token/password 一类片段打码**，可用 `previewArgs: false` 整个关掉；
- `readBody` 上限 8KB 按剩余额度切片，`reason` 限长 200 且过滤控制字符。

已知残余风险：回环 = 本机全体（同机其它账号/进程仍可访问，除非配 `apiToken`）；`events.jsonl` 仍含工具名与路径，分享前先看一眼。

## 六·六、分享给别人

```powershell
node C:\dsh-jingcha\tools\pack.mjs      # 产出 dist\dsh-jingcha-<版本>.zip
```

对方解压 → 改 `cordis.patch.yml` 的 `dataDir` → 跑 `tools\install.ps1` → **重启 DSH**。细节与安全须知见 `docs/SHARING.md`，
二次开发（加判定规则 / 路由 / 面板分区 / 设置项 / 换语言换配色）见 `docs/EXTENDING.md`。
## 七、已知限制（写清楚，免得误会）

1. **只观察，不干预**。它不会杀进程、不会超时中断、不会改写任何工具结果——那是 `dsh-tool-call-timeout-policy` 的活。
2. **事件循环被占死时它自己也转不动**。那种情况下「最后一次快照」就是证据：恢复后会补一条 `host-suspend` 或 `event-loop-blocked`。
3. **同一 callId 的时间线以 `pre-execute` 为起点**，因此「卡住」包含等审批的时间（这恰恰是用户感知的卡住）。
   想排除审批等待，看 `approval-wait` 告警即可。
4. **PTC 嵌套子调用**（`run_code` 里派发的工具）也会被记录，靠 `nested: true` 区分。
5. **日志不会无限长**：单文件超过 `maxLogBytes` 轮转一份 `.1`；内存队列超过 20000 条丢最旧的（计数可见）。
6. **`ctx.on('dispose')` 在这个 cordis 版本里不会触发**，所以生命周期用 `ctx.effect()` 绑定（本仓库实测）。

---

## 八、文件结构

```
dsh-jingcha/
├─ package.json          # DSH bundle 声明（dsh.bundle.patch）
├─ cordis.patch.yml      # 挂载声明 + 全部阈值配置（中文注释）
├─ lib/
│  ├─ core.js            # 零依赖纯逻辑：记账 / 判定 / 快照 / 报告（可单测）
│  ├─ index.js           # 宿主接线：事件监听 / 心跳 / 查询工具 / 生命周期
│  └─ sink.js            # 落盘：events.jsonl 追加 + status.json 原子替换 + 轮转
├─ test/
│  ├─ verify.mjs         # 离线自检（假 ctx + 真 JSON Schema 校验器）
│  └─ verify-cordis.mjs  # 真 cordis 集成测试
└─ tools/
   ├─ install.ps1        # 安装（junction + profile manifest，自动备份）
   └─ uninstall.ps1      # 卸载（可 -Restore 回滚）
```

> `tools/*.ps1` 故意写成纯 ASCII：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 脚本按 ANSI 读，
> 中文会把引号吃坏、脚本直接解析失败。中文说明都放在这份 README 里。
