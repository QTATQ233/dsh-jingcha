/**
 * 通用 GitHub API 自动化（零依赖，Node 18+）
 *
 * 认证方式：GitHub App —— 用本机私钥签一个 RS256 JWT（有效期 10 分钟），
 * 换成 installation access token（有效期 1 小时），用完即弃。**没有长期 Token、不写任何凭据到仓库**。
 *
 * 一次性准备（网页 5 分钟）：
 *   1) https://github.com/settings/apps/new  建 App（名字随意，例如 jingcha-release-bot）
 *      - Webhook：取消勾选 Active（不需要）
 *      - Repository permissions：Contents = Read and write（代码/Release/标签）
 *                                Administration = Read and write（改 topics / 描述等元数据）
 *                                Metadata = Read-only（默认，必需）
 *   2) 建好后在 App 页面点 Generate a private key → 把下载的 .pem 放到 C:\dsh-jingcha\.gh-app\private-key.pem
 *   3) 把 App ID（页面顶部那串数字）写进 C:\dsh-jingcha\.gh-app\app.json：{"appId": 123456}
 *   4) App 页面 → Install App → 选 All repositories（这就是"通用"）或只选部分仓库
 *
 * 用法：
 *   node tools/gh-app.mjs whoami                            # 验证配置：App 名称 / 安装 ID / 可访问仓库数
 *   node tools/gh-app.mjs repos                             # 列出这个安装能操作的仓库（证明"通用"）
 *   node tools/gh-app.mjs status   <owner/repo>             # 看描述 / topics / 最近 Release
 *   node tools/gh-app.mjs topics   <owner/repo> a b c ...   # 覆盖设置 topics
 *   node tools/gh-app.mjs describe <owner/repo> "描述文本"   # 改仓库描述
 *   node tools/gh-app.mjs release  <owner/repo> v0.4.2      # 用 CHANGELOG 里对应段落建 Release
 */
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const KEY_DIR = process.env.JINGCHA_GH_APP_DIR || "C:\\dsh-jingcha\\.gh-app";   // 换机/换目录可用环境变量覆盖
const KEY_PATH = path.join(KEY_DIR, "private-key.pem");
const CFG_PATH = path.join(KEY_DIR, "app.json");
const API = "https://api.github.com";

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function setupHint(reason) {
  console.log("还差一步：GitHub App 还没配好（" + reason + "）。");
  console.log("");
  console.log("1) 建 App          https://github.com/settings/apps/new");
  console.log("   - Webhook 取消勾选 Active");
  console.log("   - Repository permissions: Contents = Read and write, Administration = Read and write, Metadata = Read-only");
  console.log("2) Generate a private key → 保存为 " + KEY_PATH);
  console.log("3) 把 App ID 写进 " + CFG_PATH + "，内容形如 {\"appId\": 123456}");
  console.log("4) Install App → 选 All repositories（通用）或指定仓库");
  console.log("");
  console.log("做完这四步再跑同一条命令即可；私钥只在本机，我不会读它的内容，也不会把它写进任何仓库。");
  process.exitCode = 2;
  return null;
}

function readConfig() {
  if (!existsSync(KEY_PATH)) setupHint("缺少 " + KEY_PATH);
  let appId = process.env.GH_APP_ID || "";
  if (!appId && existsSync(CFG_PATH)) {
    try { appId = String(JSON.parse(readFileSync(CFG_PATH, "utf8")).appId || ""); } catch { /* ignore */ }
  }
  if (!appId) setupHint("缺少 App ID（" + CFG_PATH + " 或 GH_APP_ID）");
  return { appId, privateKey: readFileSync(KEY_PATH, "utf8") };
}

function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(header + "." + payload);
  return header + "." + payload + "." + base64url(signer.sign(privateKey));
}

async function api(pathname, options = {}, token, tolerate404 = false) {
  const headers = Object.assign({ Accept: "application/vnd.github+json", "User-Agent": "jingcha-gh-app" }, options.headers || {});
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(API + pathname, Object.assign({}, options, { headers, signal: AbortSignal.timeout(20000) }));   // 不给 GitHub 无限等待的机会
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    if (tolerate404 && res.status === 404) return null;
    console.error("✗ " + options.method + " " + pathname + " -> HTTP " + res.status);
    console.error("  " + (typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)));
    process.exitCode = 1;
    throw new Error("api failed: " + res.status);
  }
  return body;
}

async function installationToken() {
  const config = readConfig();
  if (!config) return { skip: true };
  const { appId, privateKey } = config;
  const jwt = appJwt(appId, privateKey);
  const installations = await api("/app/installations", {}, jwt);
  if (!Array.isArray(installations) || installations.length === 0) {
    console.log("App 已配置，但还没有安装到任何账号/仓库。");
    console.log("下一步：打开 https://github.com/settings/apps/jingcha-release-bot/installations -> Install -> 选 All repositories -> Install");
    process.exitCode = 2;
    return { skip: true };
  }
  const wanted = process.env.GH_INSTALLATION_ID;
  let installation = wanted ? installations.find((i) => String(i.id) === String(wanted)) : null;
  if (wanted && !installation) { console.error("✗ GH_INSTALLATION_ID=" + wanted + " 不在这个 App 的安装列表里。"); process.exitCode = 2; return { skip: true }; }
  if (!installation) {
    if (installations.length > 1) {
      console.error("✗ 这个 App 有 " + installations.length + " 个安装，请用 GH_INSTALLATION_ID 指定一个：");
      for (const item of installations) console.error("   " + item.id + "  " + (item.account ? item.account.login : '?'));
      process.exitCode = 2;
      return { skip: true };
    }
    installation = installations[0];
  }
  const token = await api("/app/installations/" + installation.id + "/access_tokens", { method: "POST" }, jwt);
  return { token: token.token, installation, installations, appId };
}

/** 从 CHANGELOG.md 里抽某个版本号后面的段落，作为 Release 说明。 */
function changelogSection(tag) {
  const version = String(tag).replace(/^v/, "");
  const file = path.resolve(import.meta.dirname, "..", "CHANGELOG.md");
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === "## " + version);
  if (start < 0) return "";
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

process.on("unhandledRejection", (error) => {
  const message = String((error && error.message) || error);
  if (/certificate|UNABLE_TO_VERIFY|self-signed|fetch failed/i.test(message)) {
    console.error("✗ HTTPS 证书校验失败 —— 本机装了 HTTPS 加速（Steam++/Watt Toolkit）会替换证书。");
    console.error("  用这个跑：node --use-system-ca tools/gh-app.mjs ...（让它信任系统证书库）");
    process.exitCode = 1;
    return;
  }
  console.error("✗ " + message);
  process.exitCode = process.exitCode || 1;
});

const [command, ...rest] = process.argv.slice(2);
if (!command) { setupHint("没给命令"); }

const session = await installationToken();
if (!session || session.skip) { /* 已打印引导，直接退出 */ }
else {
const { token, installation, installations, appId } = session;
const account = installation && installation.account ? installation.account.login : "?";

if (command === "whoami") {
  const app = await api("/app", {}, appJwt(appId, readConfig().privateKey));
  console.log("✓ GitHub App 已就绪（会话级 token，1 小时后自动失效）");
  console.log("  App       : " + app.name + " (id " + app.id + ")");
  console.log("  安装数量  : " + installations.length + "（当前用 " + account + " / installation " + installation.id + "）");
  const repos = await api("/installation/repositories?per_page=100", {}, token);
  console.log("  可操作仓库: " + repos.total_count + " 个" + (repos.total_count > 0 ? "（前几个：" + repos.repositories.slice(0, 5).map((r) => r.full_name).join(", ") + "）" : ""));
  console.log("  权限      : " + Object.entries(installation.permissions || {}).map(([k, v]) => k + "=" + v).join(", "));
} else if (command === "repos") {
  const repos = await api("/installation/repositories?per_page=100", {}, token);
  console.log("可操作仓库（" + repos.total_count + "）：");
  for (const repo of repos.repositories) console.log("  - " + repo.full_name + (repo.private ? " (private)" : ""));
} else if (command === "status") {
  const [target] = rest;
  if (!target) { console.error("用法: node tools/gh-app.mjs status <owner/repo>"); process.exit(2); }
  const repo = await api("/repos/" + target, {}, token);
  console.log(target + "：" );
  console.log("  描述  : " + (repo.description || "（空）"));
  console.log("  topics: " + ((repo.topics || []).join(", ") || "（空）"));
  console.log("  可见性: " + repo.visibility + " | 默认分支 " + repo.default_branch);
  const releases = await api("/repos/" + target + "/releases", {}, token);
  console.log("  Release: " + releases.length + " 条" + (releases.length ? "（" + releases.map((r) => r.tag_name).join(", ") + "）" : ""));
} else if (command === "topics") {
  const [target, ...topics] = rest;
  if (!target || topics.length === 0) { console.error("用法: node tools/gh-app.mjs topics <owner/repo> a b c"); process.exit(2); }
  const res = await api("/repos/" + target + "/topics", { method: "PUT", body: JSON.stringify({ names: topics }) }, token);
  console.log("✓ topics 已设为: " + res.names.join(", "));
} else if (command === "describe") {
  const [target, ...words] = rest;
  const text = words.join(" ");
  if (!target || !text) { console.error("用法: node tools/gh-app.mjs describe <owner/repo> \"描述\""); process.exit(2); }
  const res = await api("/repos/" + target, { method: "PATCH", body: JSON.stringify({ description: text }) }, token);
  console.log("✓ 描述已更新: " + res.description);
} else if (command === "release") {
  const [target, tag] = rest;
  if (!target || !tag) { console.error("用法: node tools/gh-app.mjs release <owner/repo> v0.4.2"); process.exit(2); }
  const existing = await api("/repos/" + target + "/releases/tags/" + tag, {}, token, true);
  const body = changelogSection(tag) || ("Release " + tag);
  if (existing) {
    const res = await api("/repos/" + target + "/releases/" + existing.id, { method: "PATCH", body: JSON.stringify({ body }) }, token);
    console.log("✓ Release " + tag + " 已存在，已更新说明: " + res.html_url);
  } else {
    const res = await api("/repos/" + target + "/releases", { method: "POST", body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false }) }, token);
    console.log("✓ Release 已创建: " + res.html_url);
  }
} else {
  console.error("未知命令: " + command + "（可用: whoami / repos / status / topics / describe / release）");
  process.exitCode = 2;
}
}
