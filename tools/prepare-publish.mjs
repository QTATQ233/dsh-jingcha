/**
 * 生成「可公开发布」的干净副本：node tools/prepare-publish.mjs
 *
 * 做三件事：
 *   1) 把运行所需文件复制到 dist/publish/（排除 dist、备份、自检输出等）；
 *   2) 把所有本机绝对路径 / 个人信息替换成中性值；
 *   3) 补 LICENSE / .gitignore / CHANGELOG.md / README.en.md（缺才补），最后打印隐私自检报告。
 *
 * 每次要发布新版本，先改 package.json 的 version，再跑这个脚本，然后在 dist/publish 里 git 提交。
 */
import { mkdirSync, rmSync, cpSync, readdirSync, statSync, lstatSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

/** 隐私针文件的候选位置：仓库根目录（新）与上一级目录（旧位置，向后兼容）。 */
function NEEDLES_CANDIDATES(base) {
  return [path.join(base, '.privacy-needles.json'), path.join(base, '..', '.privacy-needles.json')].find((candidate) => existsSync(candidate));
}
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'publish');
const KEEP_FILES = ['cordis.patch.yml', 'package.json', 'README.md', 'README.en.md', 'CONTRIBUTING.md', 'SECURITY.md', '.gitattributes', 'ROADMAP.md', 'CODE_OF_CONDUCT.md'];
const KEEP_DIRS = ['lib', 'test', 'tools', 'docs', 'examples', '.github'];
const TEXT_FILE = /\.(js|mjs|cjs|ps1|yml|yaml|json|md|txt)$/i;

/** 顺序敏感：长的、具体的放前面。 */
const REPLACEMENTS = [
  // 版权署名占位符：换成中性署名，作者可自行改成自己的名字
  ['dsh-jingcha contributors', 'dsh-jingcha contributors'],
  // 数据目录：源码里的显式路径改成注释示例（默认值为 %DSH_HOME%\\data\\dsh-jingcha）
  ["        dataDir: '$env:DSH_HOME\\data\\dsh-jingcha'", "        # dataDir: 'D:\\dsh-jingcha-data'   # 默认 %DSH_HOME%\\data\\dsh-jingcha；要改就写绝对路径"],
  // 插件目录
  // 数据目录（文档里的其它出现）
  // 老包名残留
  // 个人信息兜底：从仓库根目录的 .privacy-needles.json 读（该文件不进发布副本，也不入库）
  ...personalNeedles(),
];

/**
 * 读本机隐私替换表：[[from, to], ...]。
 * 安全审查 B-Q1：文件存在但读不了/JSON 坏掉时**直接失败**（否则脱敏与自检会一起静默失效）；
 * 文件不存在（例如别人克隆后首次发布）只警告，并用通用形态规则兜底。
 */
function personalNeedles() {
  const file = NEEDLES_CANDIDATES(root);
  if (!file) {
    console.warn('[warn] 没有 .privacy-needles.json：跳过本机个人信息替换，仅用通用形态规则（C:\\Users\\you 之类）。');
    return [];
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    console.error('[fail] 隐私针文件存在但读不出来或不是合法 JSON：' + file);
    console.error('       ' + (error && error.message ? error.message : error));
    console.error('       修好再发布 —— 否则脱敏与隐私自检会一起失效。');
    process.exit(1);
  }
  if (!Array.isArray(parsed)) { console.error('[fail] 隐私针文件必须是数组：' + file); process.exit(1); }
  return parsed.filter((pair) => Array.isArray(pair) && pair.length === 2);
}

/** 通用形态兜底：不依赖任何本机文件也能挡住的个人信息形态（安全审查 B-Q1）。 */
const GENERIC_SCRUB = [
  [/C:\\\\Users\\\\[^\\\\\s"'`]+/g, 'C:\\\\Users\\\\you'],
  [/C:\\Users\\you\\\s"'`]+/g, 'C:\\Users\\you'],
  [/C:\/Users\/[^\/\s"'`]+/g, 'C:/Users/you'],
];

const HITS = new Map();   // 每条规则的替换次数（安全审查 B-Q2：让替换可见）

function scrub(text) {
  let result = String(text);
  for (const [from, to] of REPLACEMENTS) {
    if (!from) continue;
    const parts = result.split(from);
    if (parts.length > 1) HITS.set(from, (HITS.get(from) || 0) + (parts.length - 1));
    result = parts.join(to);
  }
  for (const [pattern, to] of GENERIC_SCRUB) {
    result = result.replace(pattern, (match) => { HITS.set(String(pattern), (HITS.get(String(pattern)) || 0) + 1); return to; });
  }
  result = result.replace('仓库目录沿用 `C:\\dsh-jingcha`（历史文档/知识库引用太多，目录名不再改）。', '目录名可自取，下文示例统一用 `C:\\dsh-jingcha`。');
  return result;
}

function copyTree(from, to) {
  const st = lstatSync(from);            // 用 lstat：符号链接/junction 一律不跟随（安全审查 B-Q1）
  if (st.isSymbolicLink()) { console.warn('[warn] 跳过符号链接：' + from); return; }
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      copyTree(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  if (TEXT_FILE.test(from)) { writeFileSync(to, scrub(readFileSync(from, 'utf8')), 'utf8'); return; }
  cpSync(from, to);
}

// 只清内容，保留 .git（否则每次都把仓库自己删掉，历史与暂存全丢）
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(out)) {
  if (entry === '.git') continue;
  rmSync(path.join(out, entry), { recursive: true, force: true });
}
for (const dir of KEEP_DIRS) copyTree(path.join(root, dir), path.join(out, dir));
for (const file of KEEP_FILES) copyTree(path.join(root, file), path.join(out, file));

const pkg = JSON.parse(readFileSync(path.join(out, "package.json"), "utf8"));
const version = String(pkg.version || "0.0.0");

if (!existsSync(path.join(out, '.gitignore'))) {
  writeFileSync(path.join(out, '.gitignore'), [
    'node_modules/',
    'dist/',
    '.backup/',
    '.selftest-*/',
    '.tmp-*',
    '*.tmp',
    '*.log',
    '.dsh-jingcha/',
    'status.json',
    'events.jsonl',
    'widget-settings.json',
    '',
  ].join('\n'), 'utf8');
}

if (!existsSync(path.join(out, 'LICENSE'))) {
  const year = new Date().getFullYear();
  const holder = process.env.JINGCHA_COPYRIGHT || 'dsh-jingcha contributors';
  writeFileSync(path.join(out, 'LICENSE'), [
    'MIT License',
    '',
    'Copyright (c) ' + year + ' ' + holder,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
    '',
  ].join('\n'), 'utf8');
}

if (!existsSync(path.join(out, 'CHANGELOG.md'))) {
  writeFileSync(path.join(out, 'CHANGELOG.md'), [
    '# 更新日志',
    '',
    '## ' + version,
    '',
    '首个公开版本。运行时监察 + 强制停止 + 右下角红绿灯挂件：',
    '',
    '安全加固（0.3.0 同期）：接口只监听回环 + Host 白名单（挡 DNS rebinding）+ 拒跨站 Origin/Sec-Fetch-Site + 变更类只收 POST JSON + 可选 apiToken；日志默认对 token/password 打码。',
    '',
    '- 观察 `tools/pre-execute` / `tools/execute` / `tools/result`，记录每次调用（工具、参数摘要、耗时、结果、错误分类）；',
    '- 判定：慢 / 挂起 / 卡住 / 没有输出 / 等待审批 / 错误风暴 / 插件自身报错，产出 `status.json` + `events.jsonl`；',
    '- 强制停止：按 `callId` 或范围中止调用（**含嵌套 `:ptc:` 子调用**），并有「停止所有轮次」；',
    '- 挂件：可拖动记位置、阈值分级变色、异常右侧提示、**悬停省略号看全文**、五宫格复位、深浅色统一、隐藏后原位置可找回；',
    '- 接口只监听回环，带跨站栅栏（Host 白名单 / 拒跨站 Origin / 变更类只收 POST JSON / 可选 token）；',
    '- 默认不注册模型工具 → **0 token**。',
    '',
    '自检：`node test/verify.mjs`、`node test/verify-cordis.mjs`、`node test/verify-client.mjs`。',
    '',
  ].join('\n'), 'utf8');
}

// ── 隐私自检：发布前必须为 0 命中 ─────────────────────────────────────────
// 安全审查 B-Q1：自检必须独立于脱敏是否生效 —— 除隐私针外，再加通用形态（用户名路径、邮箱）
const GENERIC_FORBIDDEN = [/C:\\\\Users\\\\[^\\\\\s"'`]+/, /C:\\Users\\you\\\s"'`]+/, /C:\/Users\/[^\/\s"'`]+/];
const FORBIDDEN = ['C:\\dsh-jingcha', 'C:/dsh-jingcha', ...personalNeedles().map((pair) => String(pair[0]))];
const PATTERN_CARRIERS = new Set(['tools/prepare-publish.mjs', 'tools/pack.mjs', 'tools/gh-app.mjs']);   // 这些文件本身就是规则的载体
const hits = [];
function scan(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git') continue;
    const full = path.join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) { hits.push(path.relative(out, full) + ' 是符号链接（不跟随，需人工确认）'); continue; }
    if (st.isDirectory()) { scan(full); continue; }
    const buffer = readFileSync(full);
    const relative = path.relative(out, full);
    // 文本文件解码后按子串找；二进制（图片等）直接按字节找 —— 安全审查 B-Q1：扩展名白名单不再限制扫描范围
    const text = buffer.subarray(0, 8000).includes(0) ? buffer.toString('latin1') : buffer.toString('utf8');
    for (const needle of FORBIDDEN) if (needle && text.indexOf(needle) >= 0) hits.push(relative + ' 含 ' + needle);
    const generic = PATTERN_CARRIERS.has(relative.split(path.sep).join('/')) ? [] : GENERIC_FORBIDDEN;
    for (const pattern of generic) if (pattern.test(text)) hits.push(relative + ' 命中通用个人信息形态 ' + pattern);
  }
}
scan(out);
// 安全审查 B-Q2：把每条规则替换了多少次打出来（0 次也打），让脱敏可审计
if (HITS.size === 0) console.log('脱敏命中：本机隐私针 0 条命中（通用形态规则也未触发）');
else for (const [rule, count] of HITS) console.log('脱敏命中：' + count + ' 次  ' + rule.slice(0, 60));
console.log('发布副本 -> ' + out);
console.log('文件数：' + (function count(dir) { let n = 0; for (const e of readdirSync(dir)) { if (e === '.git') continue; const f = path.join(dir, e); n += statSync(f).isDirectory() ? count(f) : 1; } return n; })(out));
console.log(hits.length === 0 ? '隐私自检：通过（没有本机路径 / 个人信息残留）' : ('隐私自检：仍有 ' + hits.length + ' 处命中\n' + hits.join('\n')));
if (hits.length > 0) process.exitCode = 1;
