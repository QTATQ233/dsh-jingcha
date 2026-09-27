# 安全说明

## 设计立场

鲸察是**只读观察者 + 一个受控的停止开关**：

- 只监听工具流水线事件，不改写被观察的调用、结果或取消语义；
- 唯一的「执法」动作是把一个属于鲸察的 AbortController 融合进 exec.signal，调用结束时还原；
- 不联网、无第三方运行时依赖、不做动态执行。

## 攻击面与已做的加固

| 面 | 状态 |
|---|---|
| HTTP 接口（status / kill / stop / settings） | 只监听回环；Host 白名单（挡 DNS rebinding）；拒绝跨站 Origin / Sec-Fetch-Site；变更类只接受 POST + application/json（挡 img 标签与跨站表单）；可选 apiToken |
| 请求体 | 8KB 上限并按剩余额度切片；字段白名单 + 数值夹紧；reason 限长 200 并过滤控制字符 |
| 落盘 | status.json 走临时文件 + rename 原子替换；events.jsonl 追加并有轮转上限；路径只来自配置，不参与请求拼接 |
| 日志内容 | 参数摘要默认截断 120 字符，并对 token / password / authorization / api_key / cookie 一类片段打码（redactPatterns 可配） |
| 客户端 | 全程 textContent，无 innerHTML、无 eval；只请求四个常量路径 |
| 安装脚本 | 不需要管理员；改 profile manifest 前自动备份；卸载可按备份还原 |

## 残余风险（请知情）

- **回环 = 本机全体**：同机其它账号或进程仍可访问这些接口，除非设置 apiToken；
- **events.jsonl / status.json 是敏感文件**：里面有工具名与参数摘要（即使已打码），分享日志前请自行检查；
- **强停是协作式的**：忽略 exec.signal 的同进程死循环无法被硬杀；能响应取消的（如 pwsh 子进程）会被真的中止。

## 报告问题

发现安全问题时请**不要**开公开 issue，直接在 GitHub 上用 Security → Report a vulnerability 提交。
请附：复现步骤、影响面、你期望的行为。确认后我们会尽快修复并在 CHANGELOG 里致谢（如果你愿意署名）。

## 观测数据的敏感性（0.4.3 独立审查结论）

- `events.jsonl` / `status.json` 里有**工具参数摘要**（≤120 字、默认脱敏）——它们等价于敏感文件，分享前请先看一眼，或用 `previewArgs: false` 关掉；
- 脱敏默认规则覆盖 `token/secret/password/pwd/key/sig/cookie`、`Bearer …`、`--password x` 这类空格分隔形式；**过脱敏是刻意的安全方向**（例如 `-p 8080` 也会被遮掉），嫌碍事就改 `redactPatterns`；
- `apiToken` 默认空：**单机单用户可以用默认**；多用户 / 共享机器请设 `apiToken`（比较走常量时间，避免时序侧信道）；
- 已知边界（设计取舍，非漏洞）：① 在途列表里若某调用没登记到 controller（`exec.callId` 缺失等），⛔ 会明确回 `not-live` 而不是乱杀；② 接口没有速率限制，本机进程可以高频打（回环前提）；③ 同进程死循环无法硬杀，只能中止信号。
