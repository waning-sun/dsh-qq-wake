#!/usr/bin/env node
/**
 * check-manifest.mjs —— 插件清单体检（0 依赖，纯 Node）
 *
 * 为什么要有这个：DSH 加载本地插件时对它自己的 package.json 做的是「干净」的
 * JSON.parse，一旦文件带了 UTF-8 BOM（EF BB BF），就会当场炸：
 *   Unexpected token '﻿', "﻿{ "name"... is not valid JSON
 * 插件代码根本跑不到，看门狗整个不生效，还得翻日志才知道是 BOM。
 *
 * v2.4.1 又踩了一次同一个位置：package.json 被 PowerShell 5.1 拿「ANSI 读 →
 * UTF-8 写」往返了一遍，中文变成双层乱码，最后一个字的残缺字节还把收尾引号吃掉，
 * 于是报 `Bad control character in string literal in JSON at position 899`。
 * 所以这个脚本现在管四件事：
 *   ① BOM；② 是不是合法 UTF-8；③ 有没有双重编码（乱码）；④ JSON 错在哪一行哪一列。
 * 外加核对「清单版本」和「代码里的 export const version」是否同步。
 *
 * 用法：
 *   node scripts/check-manifest.mjs          # 体检当前插件
 *   node scripts/check-manifest.mjs --fix    # 顺手抹掉 BOM（只动 BOM，不动内容）
 *   node scripts/check-manifest.mjs <dir>    # 体检别的插件目录
 *
 * 退出码：0 = 全部通过；1 = 有问题（发版前卡一道）
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const rootArg = args.find((a) => !a.startsWith('--'));
const ROOT = rootArg ? resolve(rootArg) : resolve(HERE, '..');

const fails = [];
const warns = [];
const oks = [];
const ok = (m) => oks.push(m);
const fail = (m) => fails.push(m);
const warn = (m) => warns.push(m);

// ── 0. 编码工具 ───────────────────────────────────────────────────────────

/** 豁免标记：写文档时要在注释里贴事故乱码原文，就在那一行带上它 */
const IGNORE_MARK = 'check-manifest:ignore-mojibake';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const gbkDecoder = new TextDecoder('gbk');

const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
/** 去掉 BOM 后重写：其余字节原样保留 */
const stripBom = (file, buf) => writeFileSync(file, buf.subarray(3));

/** UTF-8 字节序列里第一个非法位置的字节偏移；合法返回 -1 */
function firstInvalidUtf8(buf) {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    let need = 0;
    if (b < 0x80) need = 0;
    else if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return i;
    if (i + need >= buf.length) return i; // 尾巴被截断了
    for (let k = 1; k <= need; k += 1) {
      const c = buf[i + k];
      if (c < 0x80 || c > 0xbf) return i;
    }
    i += need + 1;
  }
  return -1;
}

/**
 * 反向表：字符 → GBK 字节。Node 只有 GBK 的解码器，没有编码器，
 * 所以这里把 0x81–0xFE / 0x40–0xFE 全解一遍倒过来建表（一次性，几十毫秒）。
 */
let gbkRev = null;
function gbkRevMap() {
  if (gbkRev) return gbkRev;
  const map = new Map();
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      const ch = gbkDecoder.decode(Buffer.from([lead, trail]));
      if (ch.length === 1 && ch !== '\uFFFD' && !map.has(ch)) map.set(ch, [lead, trail]);
    }
  }
  gbkRev = map;
  return map;
}

/** 按 GBK 编码成字节；有编不了的字就返回 null */
function encodeGbk(str) {
  const map = gbkRevMap();
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const pair = map.get(ch);
    if (!pair) return null;
    out.push(pair[0], pair[1]);
  }
  return Buffer.from(out);
}

const isCjk = (ch) => {
  const c = ch.codePointAt(0);
  return c >= 0x4e00 && c <= 0x9fff;
};
const countCjk = (s) => {
  let n = 0;
  for (const ch of s) if (isCjk(ch)) n += 1;
  return n;
};

function tryUtf8(bytes) {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 双重编码判定：把这段字按 GBK 编回字节，再按 UTF-8 解一次 ——
 * 如果能解出「成串的汉字」，说明它原本是 UTF-8 的汉字，被人按 ANSI(GBK) 读过又写成 UTF-8。
 *
 * 三个现实细节都得容下，否则会漏报：
 *   ① 事故里最后一个字的残缺字节会把后面的字符一起吞掉，段的尾巴是「半截 UTF-8」→ 允许从尾部裁掉 1–3 字节再试；
 *   ② 有些字在 GBK 里编不回去（被替换成 U+FFFD 或 '?'），它们就是天然断点；
 *   ③ 半角标点（位置 < 0x40）不可能是 GBK 的尾字节，也可以当断点 —— 只断取样，不改原文。
 * 正常中文过不了这一关：按 GBK 编出来的字节几乎不可能同时是合法 UTF-8。
 */
function mojibakeDecode(line) {
  if (!line || !/[^\x00-\x7f]/.test(line)) return null;
  // 文档里引用事故原文（比如注释/CHANGELOG 里贴那串乱码）不该被判死，带这个标记就跳过
  if (line.includes(IGNORE_MARK)) return null;
  const map = gbkRevMap();

  const segs = [];
  let cur = [];
  const flush = () => {
    if (cur.length) segs.push(cur);
    cur = [];
  };
  for (const ch of line) {
    const c = ch.codePointAt(0);
    if (c < 0x80) {
      if (c < 0x40) flush();
      else cur.push(ch);
      continue;
    }
    if (!map.has(ch)) {
      flush();
      continue;
    }
    cur.push(ch);
  }
  flush();

  for (const seg of segs) {
    const segText = seg.join('');
    if (countCjk(segText) < 2) continue;
    const bytes = encodeGbk(segText);
    if (!bytes) continue;
    for (let cut = 0; cut <= 3; cut += 1) {
      if (cut >= bytes.length) break;
      const text = tryUtf8(bytes.subarray(0, bytes.length - cut));
      if (text && countCjk(text) >= 2) return text;
    }
  }
  return null;
}

/** 把 JSON.parse 的报错变成「第几行第几列 + 那一行 + ^ 指过去」 */
function pinpointJson(text, error) {
  const msg = String((error && error.message) || error);
  let index = -1;
  const byPos = /position (\d+)/.exec(msg);
  const byLineCol = /line (\d+) column (\d+)/.exec(msg);
  if (byPos) index = Number(byPos[1]);
  else if (byLineCol) {
    const line = Number(byLineCol[1]);
    const col = Number(byLineCol[2]);
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i += 1) offset += lines[i].length + 1;
    index = offset + col - 1;
  }
  if (index < 0 || index > text.length) return '';
  const before = text.slice(0, index);
  const lineNo = before.split('\n').length;
  const colNo = index - before.lastIndexOf('\n');
  const lineText = text.split('\n')[lineNo - 1] ?? '';
  const caret = ' '.repeat(Math.max(0, Math.min(colNo - 1, lineText.length))) + '^';
  const code = text.charCodeAt(index);
  const show =
    code < 0x20
      ? `U+${code.toString(16).toUpperCase().padStart(4, '0')}（裸控制字符，字符串里不能直接出现）`
      : JSON.stringify(text[index]);
  return [
    `      出错位置：第 ${lineNo} 行第 ${colNo} 列，字符 ${show}`,
    `      ${lineText}`,
    `      ${caret}`,
    mojibakeDecode(lineText)
      ? '      提示：这一行像是被「ANSI 读 → UTF-8 写」往返过（双重编码），中文已经变乱码'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ── 1. package.json：存在 + 无 BOM + 合法 UTF-8 + 可解析 ────────────────────
const pkgPath = join(ROOT, 'package.json');
let pkg = null;

if (!existsSync(pkgPath)) {
  fail(`package.json 不存在：${pkgPath}`);
} else {
  let buf = readFileSync(pkgPath);
  if (hasBom(buf)) {
    if (FIX) {
      stripBom(pkgPath, buf);
      buf = readFileSync(pkgPath);
      ok('package.json 带 BOM —— 已抹掉（--fix）');
    } else {
      fail('package.json 带 UTF-8 BOM（DSH 的 JSON.parse 会失败）→ 跑 --fix，或另存为「UTF-8 无 BOM」');
    }
  }

  const badByte = firstInvalidUtf8(buf);
  const text = buf.toString('utf8');

  if (hasBom(buf)) {
    fail('package.json 仍带 BOM，跳过解析');
  } else if (badByte >= 0) {
    fail(`package.json 不是合法 UTF-8（第一个坏字节在第 ${badByte} 字节）→ 多半是被别的编码重写过，重写一遍`);
  } else {
    try {
      // 故意不做 replace(/\uFEFF/)：这里要模拟 DSH 的真实读法
      pkg = JSON.parse(text);
      ok(`package.json 可被 JSON.parse（name=${pkg.name}, version=${pkg.version}）`);
    } catch (e) {
      fail(`package.json 解析失败：${e.message}\n${pinpointJson(text, e)}`);
    }
  }

  const mojiLines = [];
  text.split('\n').forEach((line, i) => {
    const fixed = mojibakeDecode(line);
    if (fixed && fixed !== line) mojiLines.push([i + 1, line.trim().slice(0, 60), fixed.trim().slice(0, 60)]);
  });
  if (mojiLines.length) {
    fail(
      `package.json 有 ${mojiLines.length} 行是双重编码乱码（被「ANSI 读 → UTF-8 写」往返过）：\n` +
        mojiLines
          .map(([n, bad, good]) => `      - 第 ${n} 行：${bad}  ← 应该是：${good}`)
          .join('\n'),
    );
  }
}

// ── 2. 清单字段与实际文件对得上 ────────────────────────────────────────────
if (pkg) {
  const resolveRel = (p) => join(ROOT, String(p).replace(/^\.\//, ''));

  const entry = pkg.exports?.['.'] ?? pkg.main;
  if (!entry) warn('package.json 没有 exports["."] 也没有 main —— DSH 可能找不到入口');
  else if (existsSync(resolveRel(entry))) ok(`入口文件存在：${entry}`);
  else fail(`入口文件不存在：${entry}`);

  if (pkg.type !== 'module') warn(`type=${pkg.type ?? '(缺失)'} —— 本插件是 ESM，建议 "module"`);

  const patch = pkg.dsh?.bundle?.patch;
  if (patch) {
    if (existsSync(resolveRel(patch))) ok(`bundle patch 存在：${patch}`);
    else fail(`bundle patch 不存在：${patch}`);
  }

  const clientEntry = pkg.exports?.['./client'];
  if (clientEntry) {
    if (existsSync(resolveRel(clientEntry))) ok(`client 入口存在：${clientEntry}`);
    else fail(`client 入口不存在：${clientEntry}`);
  }

  // 版本对齐：清单写 2.4.0、代码里还留 2.3.2 这种漂移，日志和设置页会对不上号
  if (entry && existsSync(resolveRel(entry))) {
    const src = readFileSync(resolveRel(entry), 'utf8');
    const m = /export\s+const\s+version\s*=\s*['"]([^'"]+)['"]/.exec(src);
    if (!m) warn(`${entry} 里没找到 export const version —— 版本号无处核对`);
    else if (m[1] !== pkg.version) fail(`版本不同步：package.json=${pkg.version}，${entry}=${m[1]}`);
    else ok(`版本同步：${pkg.version}`);
  }

  // 市场索引（dsh-market）专用：这两项缺了，市场页会标红，用户看不出宿主要求
  const dsEngine = pkg.engines?.dsh;
  if (typeof dsEngine === 'string' && dsEngine.trim()) ok(`engines.dsh = ${dsEngine}`);
  else fail('package.json 缺 engines.dsh —— dsh-market 索引无法标出宿主版本要求（engines.dsh is missing）');

  const readmePath = join(ROOT, 'README.md');
  if (!existsSync(readmePath)) {
    fail('README.md 不存在 —— 市场页没有可读的说明');
  } else {
    const readme = readFileSync(readmePath, 'utf8');
    if (/^##\s+Requirements\s*$/m.test(readme)) {
      ok('README.md 有英文标题的 ## Requirements 段（市场索引能解析宿主要求）');
    } else {
      fail('README.md 没有英文标题的 ## Requirements 段 —— dsh-market 会报 README.md has no Requirements section');
    }
  }
}

// ── 3. 全目录扫 BOM / 非法 UTF-8 / 双重编码 ────────────────────────────────
const TEXT_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|json|yml|yaml|md|txt|ps1|bat|cmd|css|html)$/i;
const SKIP_DIR = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (st.size > 0 && TEXT_EXT.test(name)) out.push(full);
  }
  return out;
}

const bomFiles = [];
const badUtf8 = [];
const mojiFiles = [];
for (const file of walk(ROOT)) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue;
  }
  const rel = file.slice(ROOT.length + 1);

  if (hasBom(buf)) {
    // 豁免：给 PowerShell 5.1 吃的 .ps1 / .txt（没 BOM 会按 ANSI 解，中文全乱）
    if (/\.(ps1|txt)$/i.test(rel)) {
      warn(`带 BOM（PS 5.1 场景可接受）：${rel}`);
    } else if (FIX) {
      stripBom(file, buf);
      ok(`已抹掉 BOM：${rel}`);
    } else {
      bomFiles.push(rel);
    }
  }

  const body = hasBom(buf) ? buf.subarray(3) : buf;
  const badByte = firstInvalidUtf8(body);
  if (badByte >= 0) {
    badUtf8.push(`${rel}（第 ${badByte} 字节起）`);
    continue;
  }

  const text = body.toString('utf8');
  const hitLines = [];
  text.split('\n').forEach((line, i) => {
    if (mojibakeDecode(line)) hitLines.push(i + 1);
  });
  if (hitLines.length) {
    mojiFiles.push(`${rel}（${hitLines.length} 行，例如第 ${hitLines.slice(0, 5).join('/')} 行）`);
  }
}

if (bomFiles.length) {
  fail(`${bomFiles.length} 个文件带 BOM（Node/DSH 读它们会出问题）：\n      - ${bomFiles.join('\n      - ')}`);
} else {
  ok('除豁免项外，没有带 BOM 的文本文件');
}

if (badUtf8.length) {
  fail(`${badUtf8.length} 个文件不是合法 UTF-8（多半是拿 ANSI 码表重写过）：\n      - ${badUtf8.join('\n      - ')}`);
} else {
  ok('所有文本文件都是合法 UTF-8');
}

if (mojiFiles.length) {
  fail(
    `${mojiFiles.length} 个文件疑似双重编码乱码（UTF-8 → 按 ANSI 读 → 再写成 UTF-8）：\n      - ${mojiFiles.join('\n      - ')}\n` +
      '      修法：用 write/edit 工具按正确中文重写那几行，别拿 PowerShell 的 Get-Content / Set-Content 往返。',
  );
} else {
  ok('没有检测到双重编码乱码');
}

// ── 4. 报告 ───────────────────────────────────────────────────────────────
console.log(`\n插件体检：${ROOT}\n${'─'.repeat(64)}`);
for (const m of oks) console.log(`  [ OK ] ${m}`);
for (const m of warns) console.log(`  [WARN] ${m}`);
for (const m of fails) console.log(`  [FAIL] ${m}`);

if (fails.length) {
  console.log(`${'─'.repeat(64)}\n结论：${fails.length} 项有问题。是 BOM 的话跑：node scripts/check-manifest.mjs --fix\n`);
  process.exit(1);
}
console.log(`${'─'.repeat(64)}\n结论：清单健康，DSH 能正常读到这个插件。\n`);
process.exit(0);
