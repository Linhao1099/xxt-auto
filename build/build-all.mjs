// 把字形表注入源码，生成油猴脚本 dist/xxt-auto.user.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src', 'xxt-all.js');
const TABLE = path.join(ROOT, 'dist', 'font-table.txt');
const OUT = path.join(ROOT, 'dist', 'xxt-auto.user.js');

// 发布到 GitHub 之后，Tampermonkey 靠这两个地址检查更新。
// 想换成别的用户名/仓库名：XXT_REPO=用户名/仓库名 npm run build
const REPO = process.env.XXT_REPO || 'Linhao1099/xxt-auto';
const RAW = 'https://raw.githubusercontent.com/' + REPO + '/main/dist/xxt-auto.user.js';

const src = fs.readFileSync(SRC, 'utf8');
const table = fs.readFileSync(TABLE, 'utf8').trim();

if (!table || table.length < 1000) throw new Error('字形表是空的：' + TABLE);
if (table.includes("'") || table.includes('\\')) throw new Error('字形表里有引号或反斜杠，不能直接内联');
if (!src.includes("'__GLYPH_TABLE__'")) throw new Error('源码里没找到 __GLYPH_TABLE__ 占位符');
if (table.length % 11 !== 0) throw new Error('字形表长度 ' + table.length + ' 不是 11 的倍数');

const verMatch = /var VERSION = '([^']+)'/.exec(src);
if (!verMatch) throw new Error('源码里没找到版本号');
const version = verMatch[1];

const header = [
  '// ==UserScript==',
  '// @name         学习通全自动（刷课 + 做题）',
  '// @namespace    xxt-v4',
  '// @version      ' + version,
  '// @description  一页上的视频/长图/章节测验全清完再跳到下一个有任务点的小节；题干还原 + AI 出答案 + 自动勾选 + 自动暂存（永不点提交）',
  '// @author       Linhao1099',
  '// @homepageURL  https://github.com/' + REPO,
  '// @supportURL   https://github.com/' + REPO + '/issues',
  '// @downloadURL  ' + RAW,
  '// @updateURL    ' + RAW,
  '// @match        *://*.chaoxing.com/*',
  '// @match        *://*.chaoxing.cn/*',
  '// @match        *://*.edu.cn/*',
  '// @run-at       document-idle',
  '// @grant        GM_xmlhttpRequest',
  '// @grant        GM_getValue',
  '// @grant        GM_setValue',
  '// @grant        GM_deleteValue',
  '// @grant        unsafeWindow',
  '// @connect      *',
  '// @noframes',
  '// ==/UserScript==',
  '',
].join('\n');

const body = src.replace("'__GLYPH_TABLE__'", JSON.stringify(table));
const out = header + body;

fs.writeFileSync(OUT, out, 'utf8');
console.log('[build-all] v' + version + ' -> ' + path.relative(ROOT, OUT));
console.log('[build-all] ' + Buffer.byteLength(out, 'utf8') + ' 字节（字形表 ' + table.length +
  ' 字符 / ' + (table.length / 11) + ' 条）');
console.log('[build-all] 更新地址指向 ' + REPO + '（用环境变量 XXT_REPO=用户名/仓库名 覆盖）');
