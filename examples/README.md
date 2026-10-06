# 示例

全部零依赖（只用 Node 内置模块），可以直接跑：

| 示例 | 用途 | 一句话 |
|---|---|---|
| [01-read-status.mjs](01-read-status.mjs) | 读快照 | 打开 status.json，打印判定与在途调用；状态不是 ok/busy 时退出码为 1（方便进 CI/定时任务） |
| [02-watch-http.mjs](02-watch-http.mjs) | 盯接口 | 每 2 秒拉一次 /api/jingcha/status，只在"判定变差"时打印 |
| [03-kill-runaway.mjs](03-kill-runaway.mjs) | 强制停止 | 列出在途调用，停掉指定（或最久的）那个；**默认 dry-run**，加 --yes 才真停 |
| [04-custom-verdict.mjs](04-custom-verdict.mjs) | 二次开发 | 用 registerRule 注册一条自定义判定规则（启用/停用 + 升级语义） |
| [04-old-way.mjs](04-old-way.mjs) | 二次开发（兼容） | 0.5 之前的写法：直接用 lib/core.js 的纯逻辑自己造一条判定 |

```bash
node examples/01-read-status.mjs                      # 用默认数据目录
node examples/01-read-status.mjs D:/data/status.json  # 或指定文件
node examples/02-watch-http.mjs --once                # 只看一次
node examples/03-kill-runaway.mjs                     # 只预览要停谁
node examples/03-kill-runaway.mjs --oldest --yes      # 真停最久的那个
node examples/04-custom-verdict.mjs
node examples/04-old-way.mjs
```

注意：这些脚本只读写本机文件与 127.0.0.1 接口，不联网。
