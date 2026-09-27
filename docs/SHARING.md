# 分享给别人怎么用

## 0. 先决条件（对方机器）

- 装了 **DSH**（`dsh` 或 `npx @deepseek-ai/dsh` 能跑起来），有 **Node 18+**；
- Windows（安装脚本是 PowerShell 5.1 兼容写法；Linux/macOS 请走官方 `dsh plugin add link:<目录>`）；
- 插件目录**不需要**管理员权限，也**不会**联网、不装第三方依赖。

## 1. 一键打包（在你这台机器上）

```powershell
node C:\dsh-jingcha\tools\pack.mjs
```

产出：`C:\dsh-jingcha\dist\dsh-jingcha-<版本>.zip`（内含 `lib/`、`tools/`、`test/`、`docs/`、`cordis.patch.yml`、`package.json`、README 与两份说明）。
把 zip 发给对方即可。

## 2. 对方怎么装

1. 解压到任意目录，例如 `C:\dsh-jingcha`；
2. 改 `cordis.patch.yml` 里的 `dataDir`（默认写的是 `$env:DSH_HOME\data\dsh-jingcha`，改成对方自己的路径，例如 `C:\dsh-jingcha\.data`）；
3. 跑安装脚本（默认 profile `web`）：

```powershell
powershell -ExecutionPolicy Bypass -File C:\dsh-jingcha\tools\install.ps1
```

   它会：备份 profile 的 `package.json` → 加一条 `link:` 依赖 + `dsh.profile.bundles` 条目 → 在 profile 的 `node_modules\@local\` 下建 junction。
4. **重启 DSH**（宿主侧代码只在启动时加载）；
5. 自检：`node C:\dsh-jingcha\test\verify.mjs`（107 项）+ `node test\verify-client.mjs`（81 项）；
6. 打开 GUI → 右下角应出现胶囊；`curl http://127.0.0.1:3080/api/jingcha/status` 应有 JSON。

卸载：`powershell -ExecutionPolicy Bypass -File tools\uninstall.ps1`（按备份还原 profile manifest，数据目录保留）。

## 3. 分享前请检查（安全）

- 接口只监听回环（DSH 自身也拒绝 `--host 0.0.0.0`），且已加**跨站栅栏**：Host 白名单（挡 DNS rebinding）、拒绝 `Origin`/`Sec-Fetch-Site: cross-site`、变更类只接受 `POST` + `content-type: application/json`；
- 想更严可以在 `cordis.patch.yml` 里设 `apiToken: <一段随机串>`（或环境变量 `JINGCHA_API_TOKEN`），之后所有接口都要带 `x-jingcha-token` 头（挂件目前不带 —— 设了 token 就要自己改挂件或用 curl）；
- `events.jsonl` / `status.json` 里含**工具参数摘要**（命令、文件路径等，已截断到 120 字符，且默认对 token/password 一类片段打码）。分享日志前先看一眼，或把 `previewArgs` 设为 `false`；
- 默认 `toolEnabled: false`：模型看不到任何工具，**0 token**；打开它每个请求会多约 176 token 的工具说明。

## 4. 官方通道（可选）

如果对方也用 pnpm 管理 profile，可以走 DSH 自己的插件通道：

```powershell
dsh plugin add link:C:\dsh-jingcha
```

效果与安装脚本一致（都是往 profile manifest 加 link 依赖），只是不经过我们自己写的 junction 逻辑。
