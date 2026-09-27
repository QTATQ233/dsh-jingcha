<div align="center">

<img src="docs/assets/logo.svg" alt="鲸察 Logo" width="120" />

<h1>鲸察 · dsh-jingcha</h1>

<p><strong>DSH 运行时监察插件：工具调用 / 事件循环 / 错误风暴实时体检 + 按调用强制停止 + 右下角红绿灯挂件</strong></p>

<p>
<a href="https://github.com/you233/dsh-jingcha/actions/workflows/ci.yml"><img src="https://github.com/you233/dsh-jingcha/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
<a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/topic-dsh--plugin-blue.svg" alt="topic: dsh-plugin" /></a>
<img src="https://img.shields.io/badge/dependencies-0-brightgreen.svg" alt="0 dependencies" />
<a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
<img src="https://img.shields.io/badge/model%20tokens-0-brightgreen.svg" alt="0 model tokens" />
</p>

<p>
<a href="README.md">中文</a> · <a href="README.en.md">English</a> · <a href="docs/">文档</a> · <a href="CHANGELOG.md">更新日志</a>
</p>

<p>
<img src="docs/assets/screenshot-light.png" alt="浅色模式" width="45%" />
<img src="docs/assets/screenshot-dark.png" alt="深色模式" width="45%" />
</p>

<p>💡 <strong>如果这个项目帮到了你，点个 ⭐ 就是最大的支持！</strong></p>

</div>

---

## 📖 目录

- [它解决什么问题](#它解决什么问题)
- [它长什么样](#它长什么样)
- [30 秒上手](#30-秒上手)
- [功能一览](#功能一览)
- [判定规则](#判定规则)
- [配置](#配置)
- [安全边界](#安全边界)
- [零 token](#零-token)
- [它是怎么接进去的](#它是怎么接进去的)
- [二次开发](#二次开发)
- [常见问题](#常见问题)
- [文档](#文档)
- [贡献](#贡献)
- [许可](#许可)

---

<a id="它解决什么问题"></a>
## 🎯 它解决什么问题

| 痛点 | 以前的处境 | 有了鲸察 |
|---|---|---|
| 工具调用跑着没动静 | 界面只说「运行中」，分不清是慢、死了，还是在等你点审批 | 快照 + 事件流给出**判定与理由**（慢 / 挂起 / 卡住 / 没有输出 / 等待审批 / 错误风暴） |
| 想停掉某个跑飞的调用 | 只能停整个轮次，别的活一起陪葬 | **按 callId 强停**单个调用，或「停掉卡住的」「停止所有轮次」（带二次确认） |
| 出问题想复盘 | 没有现场 | 每次调用一条事件（工具、参数摘要、耗时、结果、错误分类）→ events.jsonl |
| 不想被插件吃 token | 工具一注册就占上下文 | 默认 <strong>toolEnabled: false</strong>，模型完全看不到它，<strong>0 token</strong> |

<a id="它长什么样"></a>
## 🖼️ 它长什么样

| 浅色 | 深色 |
|---|---|
| ![浅色模式](docs/assets/screenshot-light.png) | ![深色模式](docs/assets/screenshot-dark.png) |

- **胶囊**：状态点 + 判定文字（有在途调用时显示「pwsh 1m33s」）；拖动可移动，位置自动记住；
- **面板**：判定（含事件循环延迟与调用计数）/ 在途调用（每条带 ⛔ 强停）/ 最近告警 / 设置，四段可折叠；
- **灯色**：按调用时长分级 —— 不超过黄灯秒是绿、不超过红灯秒是黄、超过就是红（呼吸动画）；
- **深色与浅色**：胶囊、面板、色板共用**同一个基底色**派生，字色跟着底色走，不会出现「深底白字」。

<a id="30-秒上手"></a>
## 🚀 30 秒上手

```powershell
# 官方通道（装完需要重启 dsh）
dsh plugin --profile web add github:you233/dsh-jingcha

# 自检（零依赖，不需要 dsh 在跑）
node test/verify.mjs          # 107 项
node test/verify-client.mjs   #  90 项（挂件，DOM 桩）
```

不想走插件通道？仓库里也有 tools/install.ps1：建 junction + 改 profile manifest，**改前自动备份、可整体回滚**。
安装/卸载/分享前的安全检查见 [docs/SHARING.md](docs/SHARING.md)。

<a id="功能一览"></a>
## ✨ 功能一览

- **监察**：在 tools/pre-execute、tools/execute、tools/result 三层只读观察，记录耗时、结果字节、错误分类；
- **判定**：慢 / 挂起 / 卡住 / 静默（有 agent 在跑却没有输出）/ 等待审批 / 错误风暴 / 插件自身报错；
- **强停**：融合一个属于鲸察的 AbortController（**上游取消语义不变**），并且**在 pre-execute 就登记** ——
  所以嵌套子调用（父 id 加 :ptc: 序号）也能停；停不掉时返回人话原因，绝不错杀父调用；
- **挂件**：可拖动、按调用时长分级变色、异常右侧弹提示、悬停省略号看全文（**不闪烁**）、五宫格复位、
  深浅色统一、隐藏后原位置可找回、Ctrl+Shift+J 快捷键；
- **接口**：status / kill / stop / settings 四个端点，只监听回环 + Host 白名单 + 拒跨站来源 + 变更类只收 POST JSON；
- **落盘**：status.json（原子替换的快照）+ events.jsonl（追加式事件流，超 8MB 自动轮转）。

<a id="判定规则"></a>
## 🧭 判定规则

| 判定 | 触发条件（默认阈值） | 建议动作 |
|---|---|---|
| 慢 | 单次调用超过 30s（slowCallMs） | 看看是不是正常的长任务 |
| 挂起 | 在途超过 2min（hangCallMs） | 关注，可能要停 |
| **卡住** | 在途超过 5min（stuckCallMs）**且**期间没有产出 | 点「停掉卡住的」 |
| 没有输出 | 有 agent 在跑但 90s 内没有流式帧 / 会话事件 / 工具结果 | 检查模型侧 |
| 等待审批 | pre-execute 卡在审批超过 20s | 去界面点确认，别误判成卡死 |
| 错误风暴 | 连续 3 次失败（errorStormCount） | 停手，先看错误分类 |
| 插件自身报错 | 鲸察自己抛异常 | 报告 bug（它保证**不反过来搞坏工具调用**） |

<a id="配置"></a>
## ⚙️ 配置

全部在 [cordis.patch.yml](cordis.patch.yml)（每项都有中文注释）：

| 键 | 默认 | 说明 |
|---|---|---|
| dataDir | %DSH_HOME%\data\dsh-jingcha | 数据目录（status.json / events.jsonl / widget-settings.json） |
| displayName | 鲸察 | 控制台前缀与报告标题 |
| toolEnabled | false | 是否注册模型可见的查询工具（打开后每请求多约 176 token） |
| slowCallMs / hangCallMs / stuckCallMs | 30s / 2min / 5min | 慢 / 挂起 / 卡住 |
| silenceMs | 90s | 「没有输出」判定 |
| approvalWarnMs | 20s | 等待审批提示 |
| autoKillAfterMs | 0（关） | 自动强停阈值；**同时要求没有产出**，避免误杀慢任务 |
| previewArgs / redactPreviews | true / true | 是否记录参数摘要 / 是否对 token、password 一类片段打码 |
| apiToken | 空 | 设了就要求 x-jingcha-token 头（多用户机器建议设） |

<a id="安全边界"></a>
## 🔒 安全边界

- 四个接口**统一过栅栏**：只认回环地址、Host 必须在 127.0.0.1 / localhost / ::1 白名单（挡 DNS rebinding）、
  拒绝带 Origin 或 Sec-Fetch-Site: cross-site 的请求、**变更类接口只接受 POST + application/json**
  （挡 img 标签一发即杀与跨站表单）、可选 apiToken；
- 插件**不联网、无第三方依赖、不做动态执行**；客户端全程 textContent（无 XSS 面）；
- events.jsonl / status.json 含**工具参数摘要**（默认截断 120 字符并对敏感片段打码），分享前先看一眼，或用 previewArgs: false 关掉；
- 残余风险：回环等于「本机全体」，同机其它账号/进程仍可访问 —— 多用户环境请设 apiToken。

细节见 [SECURITY.md](SECURITY.md)。

<a id="零-token"></a>
## 🪙 零 token

默认不注册任何模型可见的工具（status.json 里 extras.tool 为 null），事件流与挂件都不进模型上下文 —— 不花一分钱 token。
如果你希望会话里能直接问「现在卡在哪」，再把 toolEnabled 打开（代价：每请求多约 176 token 的工具说明 + 每次查询约 0.5k token 的报告）。

<a id="它是怎么接进去的"></a>
## 🧩 它是怎么接进去的

```
lib/core.js    纯逻辑：判定、统计、状态机（零依赖，可单测）
lib/index.js   宿主接线：工具流水线观察、融合强停信号、HTTP 路由、心跳
lib/sink.js    落盘：status.json 原子写 + events.jsonl 追加与轮转
lib/client.js  浏览器挂件（单文件 bundle，零 require）
```

- **强停原理**：在 pre-execute 给一次调用装上属于鲸察的 AbortController 并替换 exec.signal，DSH 派发时会把
  「上游 callerSignal」与「我们的信号」融合 —— 因此**上游取消照旧、我们也能主动掐断**；调用结束再还原并摘掉登记；
- **挂件灯色**按调用时长在客户端即时计算（不等宿主），判定状态另走一路；
- 规格与验收清单：[lib/WIDGET-SPEC.md](lib/WIDGET-SPEC.md)。

<a id="二次开发"></a>
## 🛠️ 二次开发

[docs/EXTENDING.md](docs/EXTENDING.md) 给了五类改动的最小清单（加判定规则 / 加路由 / 加面板分区 / 加设置项 / 换语言换配色），
通常只需要动 2 到 6 处；三条必踩的坑也写在里面（例如**轮询里不要重建交互控件**）。

<a id="常见问题"></a>
## ❓ 常见问题

- **停不下来？** 忽略 exec.signal 的同进程死循环无法硬杀（插件只能中止信号），但 pwsh 之类的子进程会被真的杀掉；
  嵌套调用若只有父调用在跑，插件会明确拒绝，而不是误杀父调用；
- **会不会反过来搞坏工具调用？** 所有监控路径都包在 safe() 里，异常自己吞掉并计入 pluginErrors，不影响工具结果；
- **数据长多大？** events.jsonl 超 8MB 自动轮转保留一份（约 16MB 上限），status.json 始终只有一份快照；
- **要重启吗？** 宿主侧代码改动需要重启 dsh；只改挂件（lib/client.js）刷新页面即可。

<a id="文档"></a>
## 📚 文档

| 文件 | 内容 |
|---|---|
| [docs/SHARING.md](docs/SHARING.md) | 装给别人 / 卸载 / 分享前的安全检查 |
| [docs/EXTENDING.md](docs/EXTENDING.md) | 加判定规则 / 路由 / 面板分区 / 设置项的最小改动清单 |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | 维护者发布流程（复制脱敏 + 隐私自检 + 推送） |
| [lib/WIDGET-SPEC.md](lib/WIDGET-SPEC.md) | 挂件规格与验收清单 |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

<a id="贡献"></a>
## 🤝 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。简单说：提交前保证三套自检全绿、隐私自检「通过」，
并且守住三条铁律（只观察不改写 / 设置项两端同步 / 轮询里不重建交互控件）。Issue 与 PR 都欢迎。

<a id="许可"></a>
## 📄 许可

MIT —— 见 [LICENSE](LICENSE)。
