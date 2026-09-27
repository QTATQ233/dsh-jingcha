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
