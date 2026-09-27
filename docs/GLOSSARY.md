# 术语表

| 术语 | 英文 / 代码里的名字 | 含义 |
|---|---|---|
| 鲸察 | jingcha / dsh-jingcha | 本插件的名字（鲸 + 监察） |
| 判定 | verdict | 某一时刻的整体结论：state + reasons + 若干计量（在途数、延迟、静默时长…） |
| 状态 | state | 五档：ok 正常 · busy 运行中 · degraded 偏慢 · erroring 出错 · stalled 疑似卡住 |
| 理由 | reason / reason kind | 支撑判定的单条依据，如 tool-stall、memory-leak；带 severity 与可读文本 |
| 告警 | finding | 需要留下痕迹的事件（比 reason 更"事件化"，写进快照的 findings 与挂件的「最近告警」） |
| 在途 | inflight | 已经开始但还没结束的工具调用 |
| 卡住 | stuck | 在途时间超过 stuckCallMs（默认 5 分钟）**且**期间没有产出 |
| 挂起 | hang | 在途时间超过 hangCallMs（默认 2 分钟），程度轻于"卡住" |
| 静默 | silent / silenceMs | 有 agent 在跑，但这么长时间没有任何流式帧 / 会话事件 / 工具结果 |
| 进度心跳 | progressEveryMs | 长调用期间每隔这么久往事件流写一条 tool.progress，让"还在动"可见 |
| 心跳 | heartbeat / heartbeatMs | 宿主的定时器（默认 1 秒）：采样延迟与 RSS、推进判定、写快照 |
| 事件循环延迟 | event-loop lag | 定时器本该 1 秒触发却晚了多少毫秒；大了说明有同步长任务 |
| 强制停止 | force stop / kill | 中止一次在途调用：中止鲸察融合出来的 AbortController 信号 |
| 融合信号 | fused signal | 把"上游 callerSignal"和"鲸察的信号"合成一个：上游取消照旧、我们也能主动掐断 |
| 调用 id | callId | 一次工具调用的标识；嵌套子调用形如「父id:ptc:序号」 |
| 嵌套子调用 | nested / ptc | run_code 里发起的工具调用；它不一定会走 tools/execute，所以登记提前到 pre-execute |
| 轮次 | turn | 模型的一次完整回合；「停止所有轮次」= 取消所有在跑的 agent |
| 挂件 | widget | 右下角的悬浮 UI（胶囊 + 面板 + 提示框 + 找回胶囊） |
| 胶囊 | capsule | 挂件的收起形态：状态点 + 判定文字 |
| 面板 | panel | 点开胶囊后的浮层：判定 / 在途调用 / 最近告警 / 设置 |
| 灯色 | light level | 胶囊状态点的颜色：绿 / 黄 / 橙 / 红 / 灰（由**调用时长**分级，阈值可调） |
| 数据目录 | dataDir | status.json、events.jsonl、widget-settings.json 所在目录（默认 %DSH_HOME%/data/dsh-jingcha） |
| 快照 | snapshot / status.json | 原子替换的实时状态文件（schema: jingcha/status@1） |
| 事件流 | events.jsonl | 追加式事件日志，超 8MB 轮转保留一份 |
| 零 token | 0 model tokens | 默认 toolEnabled: false：不注册任何模型可见工具，观测数据不进模型上下文 |
| 栅栏 | guard | 四个 HTTP 端点的统一准入：回环 + Host 白名单 + 拒跨站来源 + 变更类只收 POST JSON |
