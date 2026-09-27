# 发布与更新（维护者用）

公开仓库是从 `dist/publish/` 推出去的，而不是直接推开发目录 —— 这样能保证：

- 只带运行/自检/文档所需的文件（不含 `.backup`、`.selftest-*`、`dist`、日志）；
- 所有本机绝对路径与个人信息在复制时被替换成中性值（`C:\dsh-jingcha`、`$env:DSH_HOME\data\dsh-jingcha`）；
- `LICENSE` / `CHANGELOG.md` / `.gitignore` 缺了就自动补。

## 一次性准备（已在本机做过）

```powershell
cd <开发目录>\dist\publish
git init -b main
git config --local user.name  "<你的名字>"
git config --local user.email "<你的 GitHub noreply 邮箱>"   # 别用真实邮箱，避免公开泄露
git remote add origin <仓库地址>
```

## 每次发新版（三步）

```powershell
# 1) 先改版本号：改 package.json 的 version（用编辑器或 node，别用 PowerShell 5.1 的 Set-Content —— 它会把 UTF-8 中文写坏）
# 2) 复制 + 清洗 + 隐私自检（必须显示「通过」）
node tools/prepare-publish.mjs
# 3) 提交（.git 会被保留，不会把仓库自己删掉）
cd dist\publish
git add -A
git commit -m "feat: 这次改了什么"
```

推送按网络情况选一条：

| 通道 | 命令 | 本机实测 |
| --- | --- | --- |
| HTTPS | `git push -u origin main` | 不通（github.com:443 超时） |
| SSH | 换成 `git@github.com:<你>/<仓库>.git` 后 push（必要时走 ssh.github.com:443） | 通 |
| GitHub API | 用 token 走 api.github.com 的 Git Data API 提交 | 通 |

推完去仓库设置加 topic：`dsh-plugin`（网页 Settings → Topics，或 `gh repo edit --add-topic dsh-plugin`），这样才会被 dsh plugin 检索到。

## 本机 SSH 推送配置（已配置好，以后直接 push）

这台机器上 `github.com:22` 被拒（Steam++ 改 hosts 后 22 不通），所以走 GitHub 官方的 SSH-over-443 通道：

```
# 仓库里已经设好（只写进 .git/config，不会提交）：
git config core.sshCommand "ssh -F C:/dsh-jingcha/tools/ssh-config-jingcha"
# 该配置文件内容：Host github.com -> HostName ssh.github.com / Port 443 / IdentityFile 指向专用密钥
```

之后 `git push` 直接可用；换机器时把 `tools/ssh-config-jingcha` 里的路径改成自己的即可。

## 提交前的隐私检查清单

- [ ] `node tools/prepare-publish.mjs` 末尾打印「隐私自检：通过」；
- [ ] 不要把 `$env:DSH_HOME\data\dsh-jingcha\`（status.json / events.jsonl / widget-settings.json）拷进仓库 —— 里面有工具参数摘要；
- [ ] 不要把 token 文件、SSH 私钥放进仓库；
- [ ] commit 用 noreply 邮箱，用 `git log -1 --format=%an <%ae>` 自查；
- [ ] 新增文件里如果写了本机路径，把它加进 `tools/prepare-publish.mjs` 的 REPLACEMENTS（或本机 .privacy-needles.json）。
