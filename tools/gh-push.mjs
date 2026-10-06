/**
 * 通用推送：用 GitHub App 会话 token 走 HTTPS 推送（受限沙箱内也能用）
 *
 * 为什么需要它：Git for Windows 把 ssh 命令交给自己的 sh.exe 执行，而在受限沙箱里
 * MSYS 运行时会因为拿不到信号管道直接 fatal（"couldn't create signal pipe, Win32 error 5"），
 * schannel 后端也会在 AcquireCredentialsHandle 处失败。HTTPS + openssl 后端 + App 会话 token
 * 这三样都不需要 sh.exe、不需要长期凭据，所以在同样的沙箱里可用。
 *
 * 凭据只活在这个进程的环境变量里：token 不进 argv、不落盘、不进 git config、不打印。
 *
 * 用法（在仓库根目录跑）：
 *   node --use-system-ca tools/gh-push.mjs --check                  # 试推 + 打印将要推送的引用（不更新远端）
 *   node --use-system-ca tools/gh-push.mjs --verify-write           # 真验证写权限：推一个临时分支再删掉
 *   node --use-system-ca tools/gh-push.mjs main                     # 推 main
 *   node --use-system-ca tools/gh-push.mjs main v0.5.0              # 推分支 + 标签
 *   node --use-system-ca tools/gh-push.mjs --dir <仓库路径> main    # 指定仓库目录（默认 dist/publish）
 *
 * 退出码：0 成功 / 1 推送失败 / 2 配置缺失。
 */
import { spawnSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const KEY_DIR = process.env.JINGCHA_GH_APP_DIR || "C:\\dsh-jingcha\\.gh-app";   // 换机/换目录可用环境变量覆盖
const KEY_PATH = path.join(KEY_DIR, "private-key.pem");
const CFG_PATH = path.join(KEY_DIR, "app.json");
const API = "https://api.github.com";

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("--"));
const positional = argv.filter((a) => !a.startsWith("--"));
const checkOnly = flags.includes("--check");
const verifyWrite = flags.includes("--verify-write");
const dirFlag = argv.indexOf("--dir");
const repoDir = path.resolve(dirFlag >= 0 ? (argv[dirFlag + 1] || "") : path.join(import.meta.dirname, "..", "dist", "publish"));
const refs = positional.length ? positional : ["main"];

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function die(message, code) {
  console.error("✗ " + message);
  process.exitCode = code;
  return null;
}

function setupHint(reason) {
  console.error("✗ GitHub App 还没配好（" + reason + "）。先跑 node --use-system-ca tools/gh-app.mjs whoami 看引导。");
  process.exitCode = 2;
  return null;
}

function readConfig() {
  if (!existsSync(KEY_PATH)) return setupHint("缺少 " + KEY_PATH);
  let appId = process.env.GH_APP_ID || "";
  if (!appId && existsSync(CFG_PATH)) {
    try { appId = String(JSON.parse(readFileSync(CFG_PATH, "utf8")).appId || ""); } catch { /* ignore */ }
  }
  if (!appId) return setupHint("缺少 App ID（" + CFG_PATH + " 或 GH_APP_ID）");
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
  const headers = Object.assign({ Accept: "application/vnd.github+json", "User-Agent": "jingcha-gh-push" }, options.headers || {});
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(API + pathname, Object.assign({}, options, { headers, signal: AbortSignal.timeout(20000) }));
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    if (tolerate404 && res.status === 404) return null;
    throw new Error(options.method + " " + pathname + " -> HTTP " + res.status + " " + String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 200));
  }
  return body;
}

async function installationToken() {
  const config = readConfig();
  if (!config) return null;
  const jwt = appJwt(config.appId, config.privateKey);
  const installations = await api("/app/installations", {}, jwt);
  if (!Array.isArray(installations) || installations.length === 0) return setupHint("App 还没安装到任何账号");
  const wanted = process.env.GH_INSTALLATION_ID;
  let installation = wanted ? installations.find((i) => String(i.id) === String(wanted)) : null;
  if (wanted && !installation) return setupHint("GH_INSTALLATION_ID=" + wanted + " 不在安装列表里");
  if (!installation) installation = installations[0];
  const minted = await api("/app/installations/" + installation.id + "/access_tokens", { method: "POST" }, jwt);
  return { token: minted.token, installation };
}

/** 从 .git/config 里读 origin 的 URL（不 spawn 子进程，避开管道的坑）。 */
function originUrl(dir) {
  const file = path.join(dir, ".git", "config");
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  const section = text.split(/^\[/m).find((block) => block.startsWith('remote "origin"'));
  if (!section) return "";
  const match = section.match(/^\s*url\s*=\s*(.+)$/m);
  return match ? match[1].trim() : "";
}

/** 任意远端形式 -> https://github.com/<owner>/<repo>.git（token 不放 URL 里）。 */
function toHttps(url) {
  if (!url) return "";
  let m = url.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (m) return "https://github.com/" + m[1] + ".git";
  m = url.match(/^ssh:\/\/[^@]+@([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return "https://" + m[1] + "/" + m[2] + ".git";
  if (/^https?:\/\//.test(url)) return url.replace(/\/\/[^@/]*@/, "//");
  return "";
}

function run(label, args, options) {
  console.log("\n▶ " + label);
  const result = spawnSync("git", args, Object.assign({ cwd: repoDir, stdio: "inherit", env: process.env }, options));
  return result.status === null ? 1 : result.status;
}

if (!existsSync(path.join(repoDir, ".git"))) { die("不是 git 仓库：" + repoDir, 2); }
else if (!checkOnly && refs.length === 0) { die("没给要推的引用（例如 main）", 2); }
else {
  const url = toHttps(originUrl(repoDir));
  if (!url) die("读不到 origin 的 URL（" + repoDir + "/.git/config）", 2);
  else {
    console.log("鲸察推送 · " + repoDir);
    console.log("  远端  : " + url);
    console.log("  引用  : " + refs.join(", ") + (checkOnly ? "（试推，不更新远端）" : ""));
    const session = await installationToken();
    if (session) {
      const basic = Buffer.from("x-access-token:" + session.token, "utf8").toString("base64");
      // 关键：token 只进环境变量（GIT_CONFIG_* 注入配置），不进 argv、不进 git config、不打印。
      const env = Object.assign({}, process.env, {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "http.sslBackend",
        GIT_CONFIG_VALUE_0: process.env.JINGCHA_SSL_BACKEND || "openssl",
        GIT_CONFIG_KEY_1: "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_1: "Authorization: Basic " + basic,
        GIT_CONFIG_KEY_2: "core.askPass",
        GIT_CONFIG_VALUE_2: "",
      });
      if (verifyWrite) {
        // 真正验证"写权限"：推一个临时分支再删掉（远端 ref 会先出现再消失）。
        const probe = "refs/heads/jingcha-push-probe-" + Date.now();
        const pushCode = run("写权限探测：推临时分支 " + probe, ["push", url, "HEAD:" + probe], { env });
        if (pushCode !== 0) die("写权限探测失败（退出码 " + pushCode + "）。检查 App 的 Contents=write 与安装范围。", 1);
        else {
          const delCode = run("写权限探测：删除临时分支", ["push", url, "--delete", probe], { env });
          if (delCode !== 0) console.log("（临时分支 " + probe + " 删除失败，请手动删）");
          else console.log("\n✓ 写权限验证通过：能推能删（" + probe + " 已清理）");
        }
      } else {
        const args = ["push", url].concat(refs);
        if (checkOnly) args.splice(1, 0, "--dry-run");
        const code = run("git push " + (checkOnly ? "--dry-run " : "") + refs.join(" "), args, { env });
        if (code !== 0) die("推送失败（退出码 " + code + "）。若是证书问题，确认用了 --use-system-ca；若是权限问题，确认 App 的 Contents=write。", 1);
        else console.log("\n✓ 推送完成：" + url.replace(/\.git$/, "") + " ← " + refs.join(", "));
      }
    }
  }
}
