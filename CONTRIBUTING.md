# 贡献指南

欢迎 PR / issue。这个插件的设计目标很小：**只观察、不改写被观察的东西**；动手前请先读这一页。

## 本地开发与自检

```powershell
# 三套自检（前两套零依赖，第三套也是 DOM 桩，不需要浏览器）
node test/verify.mjs         # 121 项：判定逻辑 / 假 ctx 接线 / 路由栅栏 / 强停（含嵌套调用）
node test/verify-client.mjs  #  90 项：挂件
# 真 cordis 集成（需要 DSH 的 cordis 路径）
$env:DSH_CORDIS='<...>\node_modules\@deepseek-ai\cordis\lib\index.js'; node test/verify-cordis.mjs
```

**提交前请保证三套全绿**，并且 tools/prepare-publish.mjs 的隐私自检打印「通过」。

## 三条铁律

1. **绝不影响被观察的调用**：所有监控代码都包在 safe() 里，异常只记账，不改写 exec、结果或取消语义；
2. **改设置项要两端同步**：宿主 lib/index.js 的 WIDGET_DEFAULTS + sanitizeSettings，与挂件 lib/client.js 的
   DEFAULTS + sanitize 必须同名字段、同一套夹紧规则（历史上这里出过 mode 语义相反的真实 bug）；
3. **轮询里不要重建交互控件**：挂件的 poll 只重画数据视图；重建设置区会把用户正拖的滑块 / 打开的色板一起换掉。

## 想帮忙但不知从哪开始？（Good first issue）

先扫一眼这两个标签：

- [good first issue](https://github.com/you233/dsh-jingcha/labels/good%20first%20issue) —— 挑好的、范围明确的入门任务；
- [help wanted](https://github.com/you233/dsh-jingcha/labels/help%20wanted) —— 欢迎认领的活。

没有合适的？下面这些是我们自己列的「第一次上手」清单，**在 issue 里说一声就能认领**：

| 任务 | 改哪里 | 难度 | 提示 |
|---|---|---|---|
| 给「最危险但没测」的路径补测试 | test/verify.mjs | ★ | sink 日志轮转 / 控制台「仍在跑」心跳 / autoKillAfterMs / 路由 403 分支 |
| 把空 catch 变成可观测 | lib/index.js、lib/client.js | ★ | 抽一个 noteSwallowed(kind, err)：计数 + 写 events.jsonl，别静默吞 |
| 再加一个示例 | examples/ | ★ | 例如「监控子代理并在超时时打印」或「把 events.jsonl 转成 CSV」 |
| 挂件给 memory-leak 一个专用展示 | lib/client.js | ★★ | 判定区加一行 RSS 趋势（从 runtime.memoryLeak 读，别新增请求） |
| 文档计数自动化 | tools/、README | ★★ | 测试输出一份计数，README 里的「121 项」由脚本生成，杜绝漂移 |
| i18n 第一步：抽 core 的判定文案 | lib/core.js | ★★★ | 先把 verdict 的 text 抽成词表（zh），行为不变、测试照旧全绿 |
| 判定规则可编排 | lib/core.js | ★★★ | 把 verdict 的长 if 链拆成规则数组（见 ROADMAP 0.5），允许外部注册规则 |

认领方式：在对应 issue 下留言「我来试试」，或直接开 PR（PR 模板里有检查清单）。
不确定怎么做时，先把思路写在 issue 里，我们会给最小改动路径。

## 加东西之前

[docs/EXTENDING.md](docs/EXTENDING.md) 里给了五类改动（判定规则 / 路由 / 面板分区 / 设置项 / 语言与配色）的最小改动清单，
照它改通常只需要动 2 到 6 处。新判定规则请同时在 README 的判定表与 cordis.patch.yml 里补上阈值。

## 提交信息

用「类型: 一句话」，例如：

- feat: 支持按范围停掉卡住的调用
- fix: 嵌套调用的强停登记挪到 pre-execute
- docs: 补充分享与安全检查
- test: 覆盖跨站栅栏

## 许可

贡献即表示同意以 MIT 许可发布（见 [LICENSE](LICENSE)）；参与前请先读 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

