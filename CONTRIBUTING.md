# 贡献指南

欢迎 PR / issue。这个插件的设计目标很小：**只观察、不改写被观察的东西**；动手前请先读这一页。

## 本地开发与自检

```powershell
# 三套自检（前两套零依赖，第三套也是 DOM 桩，不需要浏览器）
node test/verify.mjs         # 107 项：判定逻辑 / 假 ctx 接线 / 路由栅栏 / 强停（含嵌套调用）
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

## 加东西之前

[docs/EXTENDING.md](docs/EXTENDING.md) 里给了五类改动（判定规则 / 路由 / 面板分区 / 设置项 / 语言与配色）的最小改动清单，
照它改通常只需要动 2 到 6 处。

## 提交信息

用「类型: 一句话」，例如：

- feat: 支持按范围停掉卡住的调用
- fix: 嵌套调用的强停登记挪到 pre-execute
- docs: 补充分享与安全检查
- test: 覆盖跨站栅栏

## 许可

贡献即表示同意以 MIT 许可发布（见 [LICENSE](LICENSE)）。
