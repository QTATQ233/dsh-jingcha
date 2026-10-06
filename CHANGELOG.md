# 更新日志

## 0.5.1

首个公开版本。运行时监察 + 强制停止 + 右下角红绿灯挂件：

安全加固（0.3.0 同期）：接口只监听回环 + Host 白名单（挡 DNS rebinding）+ 拒跨站 Origin/Sec-Fetch-Site + 变更类只收 POST JSON + 可选 apiToken；日志默认对 token/password 打码。

- 观察 `tools/pre-execute` / `tools/execute` / `tools/result`，记录每次调用（工具、参数摘要、耗时、结果、错误分类）；
- 判定：慢 / 挂起 / 卡住 / 没有输出 / 等待审批 / 错误风暴 / 插件自身报错，产出 `status.json` + `events.jsonl`；
- 强制停止：按 `callId` 或范围中止调用（**含嵌套 `:ptc:` 子调用**），并有「停止所有轮次」；
- 挂件：可拖动记位置、阈值分级变色、异常右侧提示、**悬停省略号看全文**、五宫格复位、深浅色统一、隐藏后原位置可找回；
- 接口只监听回环，带跨站栅栏（Host 白名单 / 拒跨站 Origin / 变更类只收 POST JSON / 可选 token）；
- 默认不注册模型工具 → **0 token**。

自检：`node test/verify.mjs`、`node test/verify-cordis.mjs`、`node test/verify-client.mjs`。
