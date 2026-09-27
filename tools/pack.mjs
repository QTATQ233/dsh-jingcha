/**
 * 打包成可分发 zip：node tools/pack.mjs
 * 只带运行/自检/文档所需文件，排除备份、自检输出与 dist 自身。
 */
import { mkdirSync, rmSync, cpSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

/** 隐私针文件的候选位置：仓库根目录（新）与上一级目录（旧位置，向后兼容）。 */
function NEEDLES_CANDIDATES(base) {
  return [path.join(base, '.privacy-needles.json'), path.join(base, '..', '.privacy-needles.json')].find((candidate) => existsSync(candidate));
}
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = String(pkg.version || "0.0.0");
const slug = String(pkg.name).split("/").pop().replace(/[^a-z0-9._-]/gi, "-").replace(/^[^a-z0-9]+/i, "") || "dsh-plugin";
const stage = path.join(root, "dist", "stage", slug + "-" + version);
const zip = path.join(root, "dist", slug + "-" + version + ".zip");
const SKIP = new Set([".backup", ".selftest-out", "node_modules", "dist", ".git", ".privacy-needles.json"]);
const ALLOWED_DOTFILES = new Set([".gitattributes", ".gitignore"]);
const FORBIDDEN_NAMES = /(privacy-needles|gh-token|id_ed25519|ssh-config|widget-settings\.json|^status\.json$|^events\.jsonl$)/i;   // 大小写不敏感（安全审查 B-Q1）

// 只清暂存目录与旧 zip；**不要**动 dist/publish（那是 git 仓库）
rmSync(path.join(root, "dist", "stage"), { recursive: true, force: true });
for (const entry of existsSync(path.join(root, "dist")) ? readdirSync(path.join(root, "dist")) : []) {
  if (entry.endsWith(".zip")) rmSync(path.join(root, "dist", entry), { force: true });
}
mkdirSync(stage, { recursive: true });
// 先确保发布副本存在且是最新的（它才是脱敏后的内容，和仓库一致）
if (!existsSync(path.join(root, "dist", "publish", "package.json"))) {
  console.log("dist/publish 不存在，先跑 prepare-publish…");
  spawnSync(process.execPath, [path.join(root, "tools", "prepare-publish.mjs")], { stdio: "ignore" });
}
const SOURCE = path.join(root, "dist", "publish");
for (const entry of readdirSync(SOURCE)) {
  if (SKIP.has(entry) || entry.startsWith(".tmp")) continue;
  if (entry.startsWith(".") && !ALLOWED_DOTFILES.has(entry)) continue;
  const from = path.join(SOURCE, entry);
  if (statSync(from).isDirectory() && !["lib", "tools", "test", "docs"].includes(entry)) continue;
  cpSync(from, path.join(stage, entry), { recursive: true });
}
// 打包前自检：暂存目录里出现敏感文件名就直接失败（历史上漏过 .privacy-needles.json）
const leaked = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (FORBIDDEN_NAMES.test(entry)) leaked.push(path.relative(stage, full));
  }
})(stage);
if (leaked.length > 0) {
  console.error("打包自检失败，暂存目录里有敏感文件：" + leaked.join(", "));
  process.exit(1);
}
// 文本层自检：本机路径 / 个人标识不许出现在分发包里
/** 本机隐私针（取自 .privacy-needles.json 的 from 侧）；脚本本身不含任何个人信息。
 *  注意：必须区分大小写 —— 中性化后的路径是 C:\\dsh-jingcha / C:/dsh-jingcha。 */
/** 本机隐私针（取自 .privacy-needles.json 的 from 侧）；脚本本身不含任何个人信息。
 *  注意区分大小写：中性化后的路径是 C:\\dsh-jingcha / C:/dsh-jingcha。 */
const LOCAL_PATTERNS = (function patterns() {
  const out = [];
  try {
    const file = [NEEDLES_CANDIDATES(root), path.join(root, "..", ".privacy-needles.json")].find((candidate) => existsSync(candidate));
    if (existsSync(file)) {
      for (const pair of JSON.parse(readFileSync(file, "utf8"))) {
        const from = Array.isArray(pair) ? String(pair[0]) : "";
        if (from.length >= 4) {
          const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, function (ch) { return "\\" + ch; });
          out.push(new RegExp(escaped));
        }
      }
    }
  } catch { /* 没有针文件就只做通用检查 */ }
  return out;
})();
const textual = [];
(function walkText(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { walkText(full); continue; }
    if (!/\.(md|mjs|js|yml|yaml|json|ps1|txt)$/i.test(entry)) continue;
    const body = readFileSync(full, "utf8");
    for (const pattern of LOCAL_PATTERNS) if (pattern.test(body)) { textual.push(path.relative(stage, full) + " 命中 " + pattern); break; }
  }
})(stage);
if (textual.length > 0) {
  console.error("打包自检失败，文本里还有本机路径/个人信息：\n" + textual.join("\n"));
  process.exit(1);
}
console.log("staged ->", stage, "(敏感文件 " + leaked.length + " 个，文本命中 " + textual.length + " 处)");
const readme = [
  "# 鲸察（" + pkg.name + " " + version + "）安装说明",
  "",
  "1. 解压到任意目录，例如 C:\\dsh-jingcha",
  "2. 改 cordis.patch.yml 里的 dataDir 为你的数据目录（默认 %DSH_HOME%/data/dsh-jingcha，可不写）",
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
