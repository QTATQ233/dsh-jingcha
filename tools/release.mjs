/**
 * 通用发布管线：改版本 → 跑自检 → 脱敏发布副本 → 打包自检 → 提交 → 打标签 → 推送（走 SSH 别名，不用任何 Token）
 *
 * 用法：
 *   node tools/release.mjs --check                     # 只做检查（自检 + 脱敏 + 隐私自检 + 打包自检），不改任何文件、不推送
 *   node tools/release.mjs 0.4.3 "一句话说明"           # 完整发布并推送
 *   node tools/release.mjs 0.4.3 "说明" --no-push       # 走完流程但停在提交（人工确认后再 push）
 *   node tools/release.mjs --push-only                  # 只把当前 HEAD 与已有标签推上去
 *
 * 安全设计：
 *   - 全程只用 SSH（仓库级 deploy key），不读写任何 Token/环境变量；
 *   - 推送前必须通过：三套自检 + 隐私自检 + 打包自检，任何一项失败立即中止；
 *   - 提交身份固定为 noreply 邮箱，不暴露真人邮箱；
 *   - 只改 package.json / CHANGELOG.md 与发布副本，绝不碰 lib/ 里的实现。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, "..");
const publish = path.join(root, "dist", "publish");
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));
const checkOnly = flags.includes("--check");
const pushOnly = flags.includes("--push-only");
const noPush = flags.includes("--no-push") || checkOnly;
const version = positional[0];
const note = positional[1] || "";

function run(label, command, commandArgs, options = {}) {
  console.log("\n▶ " + label);
  const result = spawnSync(command, commandArgs, { cwd: options.cwd || root, stdio: "inherit", env: process.env });
  const code = result.status === null ? 1 : result.status;
  if (code !== 0 && options.allowFail !== true) {
    console.error("✗ " + label + " 失败（退出码 " + code + "），已中止。");
    process.exit(code);
  }
  return code;
}

function git(label, gitArgs, options = {}) {
  return run(label, "git", gitArgs, Object.assign({ cwd: publish }, options));
}

/** 只读的 git 查询（拿不到就返回空串，不因为管道失败而中断）。 */
function gitOut(gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: publish, encoding: "utf8" });
  return (result.stdout || "").trim();
}

console.log("鲸察发布管线 · " + (checkOnly ? "检查模式（不改文件、不推送）" : pushOnly ? "仅推送" : "完整发布 " + version));

if (!pushOnly) {
  // 1) 版本号（检查模式跳过写入）
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (checkOnly) {
    console.log("\n当前版本: " + pkg.version + "（检查模式不改）");
  } else {
    if (!/^\d+\.\d+\.\d+$/.test(version || "")) { console.error("✗ 版本号要形如 0.4.3"); process.exit(2); }
    if (pkg.version === version) console.log("\n版本号已是 " + version + "，跳过写入");
    else { pkg.version = version; writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8"); console.log("\n版本号 -> " + version); }
    const clPath = path.join(root, "CHANGELOG.md");
    let changelog = readFileSync(clPath, "utf8");
    if (changelog.indexOf("## " + version) < 0) {
      changelog = changelog.replace(/^(# .*\n\n)/, "$1## " + version + "\n\n" + (note || "（待补充）") + "\n\n");
      writeFileSync(clPath, changelog, "utf8");
      console.log("CHANGELOG 已加 " + version + " 段落（记得补充说明）");
    }
  }
  // 2) 三套自检
  run("离线自检", process.execPath, ["test/verify.mjs"]);
  run("挂件自检", process.execPath, ["test/verify-client.mjs"]);
  const cordis = process.env.DSH_CORDIS || "";
  if (cordis && existsSync(cordis)) run("真 cordis 集成自检", process.execPath, ["test/verify-cordis.mjs"]);
  else console.log("\n（跳过真 cordis 自检：没设 DSH_CORDIS）");
  // 3) 脱敏发布副本 + 打包自检
  run("生成脱敏发布副本（含隐私自检）", process.execPath, ["tools/prepare-publish.mjs"]);
  run("打包并自检", process.execPath, ["tools/pack.mjs"]);
}

if (checkOnly) { console.log("\n✓ 检查全部通过（没有改动任何文件、没有推送）"); process.exit(0); }

// 4) 提交
git("暂存发布副本改动", ["add", "-A"]);
const dirty = gitOut(["status", "--porcelain"]);
if (dirty) {
  git("提交", ["-c", "user.name=jingcha-publisher", "-c", "user.email=jingcha@users.noreply.github.com",
    "commit", "-q", "-m", "release: v" + version + (note ? " — " + note : "")]);
} else console.log("\n（发布副本没有变化，跳过提交）");

// 5) 标签
if (!pushOnly) {
  const tag = "v" + version;
  if (gitOut(["tag", "-l", tag])) console.log("标签已存在: " + tag);
  else git("打标签 " + tag, ["tag", "-a", tag, "-m", tag + (note ? " " + note : "")]);
}

// 6) 推送（SSH 别名，无 Token）
if (noPush) { console.log("\n（--no-push：停在提交，确认后自己跑 git push）"); process.exit(0); }
if (gitOut(["remote", "get-url", "origin"]).indexOf("github-") < 0) {
  console.log("\n提示：远端还不是 SSH 别名形式。推荐（仓库级 deploy key，最小权限）：");
  console.log("   git remote set-url origin git@github-<项目名>:<owner>/<repo>.git");
  console.log("   git config core.sshCommand \"ssh -F C:/dsh-jingcha/.ssh/config\"");
  console.log("   （生成密钥与别名：powershell -File tools/setup-repo-key.ps1 -Repo <owner>/<repo> -Name <项目名>）");
}
git("推送 main", ["push", "origin", "main"]);
if (!pushOnly) git("推送标签", ["push", "origin", "v" + version]);

console.log("\n✓ 已推送。剩下三件只能网页做的事（我可以事后用公开 API 复核）：");
console.log("   1) Release : https://github.com/<owner>/<repo>/releases/new?tag=v" + version);
console.log("   2) Topics  : 仓库 Settings -> General -> Topics（≥8 个更易被发现）");
console.log("   3) 社交预览 : Settings -> General -> Social preview（docs/assets/social-preview.png）");
