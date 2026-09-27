/**
 * 打包成可分发 zip：node tools/pack.mjs
 * 只带运行/自检/文档所需文件，排除备份、自检输出与 dist 自身。
 */
import { mkdirSync, rmSync, cpSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(pkg.version || "0.0.0");
const slug = String(pkg.name).split("/").pop().replace(/[^a-z0-9._-]/gi, "-").replace(/^[^a-z0-9]+/i, "") || "dsh-plugin";
const stage = path.join(root, "dist", "stage", slug + "-" + version);
const zip = path.join(root, "dist", slug + "-" + version + ".zip");
const SKIP = new Set([".backup", ".selftest-out", "node_modules", "dist", ".git"]);

rmSync(path.join(root, "dist"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const entry of readdirSync(root)) {
  if (SKIP.has(entry) || entry.startsWith(".tmp")) continue;
  const from = path.join(root, entry);
  if (statSync(from).isDirectory() && !["lib", "tools", "test", "docs"].includes(entry)) continue;
  cpSync(from, path.join(stage, entry), { recursive: true });
}
console.log("staged ->", stage);
const readme = [
  "# 鲸察（" + pkg.name + " " + version + "）安装说明",
  "",
  "1. 解压到任意目录，例如 C:\\dsh-jingcha",
  "2. 改 cordis.patch.yml 里的 dataDir 为你的路径（默认 $env:DSH_HOME\\data\\dsh-jingcha）",
  "3. powershell -ExecutionPolicy Bypass -File tools\\install.ps1",
  "4. 重启 DSH（宿主代码只在启动时加载）",
  "5. 自检：node test\\verify.mjs / node test\\verify-client.mjs",
  "6. 卸载：powershell -ExecutionPolicy Bypass -File tools\\uninstall.ps1",
  "",
  "详细说明见 docs\\SHARING.md（分享/安全须知）与 docs\\EXTENDING.md（二次开发）。",
  "",
].join("\n");
writeFileSync(path.join(stage, "INSTALL.md"), readme, "utf8");   // 文件名用 ASCII，内容仍是中文（免得跨机器编码出问题）
// 三种打包通道，谁通用谁：bsdtar（Win10+/macOS/Linux）→ PowerShell ZipFile → Compress-Archive
// 注意：本机沙箱下 spawnSync 用管道 stdio 会 EPERM，所以一律 stdio:'ignore'（结果靠 zip 是否存在判断）
const quiet = { stdio: "ignore" };
const attempts = [
  () => spawnSync("tar", ["-a", "-c", "-f", zip, "-C", stage, "."], quiet),
  () => spawnSync("powershell", ["-NoProfile", "-Command",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('" + stage + "','" + zip + "')"], quiet),
  () => spawnSync("powershell", ["-NoProfile", "-Command",
    "Compress-Archive -Path '" + stage + "\\*' -DestinationPath '" + zip + "' -Force"], quiet),
];
let packed = false;
for (const attempt of attempts) {
  try {
    const out = attempt();
    if (existsSync(zip) && statSync(zip).size > 0) { packed = true; break; }
    console.log("打包通道失败：", (out && (out.error ? String(out.error) : out.stderr || out.stdout) || "").slice(0, 200));
  } catch (error) { console.log("打包通道异常：", String(error).slice(0, 160)); }
}
if (!packed) { console.error("三种打包方式都没成功，请手动压缩：" + stage); process.exit(1); }
console.log("zip ->", zip, "(" + statSync(zip).size + " bytes)");
