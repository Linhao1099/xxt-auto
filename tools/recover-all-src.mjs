// 从 dist/学习通全自动.user.js 反向还原 src/xxt-all.js（把注入的字形表换回占位符）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist', '学习通全自动.user.js');
const SRC = path.join(ROOT, 'src', 'xxt-all.js');
const TABLE = path.join(ROOT, 'dist', 'font-table.txt');

const out = fs.readFileSync(DIST, 'utf8');

// 脚本正文以块注释开头，header 里全是 // 注释，所以第一个 /** 就是正文起点
const k = out.indexOf('/**');
if (k < 0) throw new Error('dist 里找不到正文起点');
let body = out.slice(k);

const marker = 'var GLYPH_TABLE = ';
const i = body.indexOf(marker);
if (i < 0) throw new Error('正文里找不到 GLYPH_TABLE 赋值');

const start = i + marker.length;              // 指向开头的双引号
if (body[start] !== '"') throw new Error('GLYPH_TABLE 不是双引号字符串，起点：' + body.slice(start, start + 20));
const end = body.indexOf('"', start + 1);     // 表里没有引号和反斜杠，下一个双引号就是结尾
if (end < 0) throw new Error('GLYPH_TABLE 字符串没有闭合');

const inlined = JSON.parse(body.slice(start, end + 1));
const origin = fs.readFileSync(TABLE, 'utf8').trim();
if (inlined !== origin) {
  throw new Error('内联字形表和 font-table.txt 对不上：' + inlined.length + ' vs ' + origin.length);
}

body = body.slice(0, start) + "'__GLYPH_TABLE__'" + body.slice(end + 1);
if (!body.includes("'__GLYPH_TABLE__'")) throw new Error('占位符没写回去');
if (/__GLYPH_TABLE__/.test(body.replace("'__GLYPH_TABLE__'", ''))) throw new Error('出现了多处占位符');

fs.writeFileSync(SRC, body, 'utf8');

const lines = body.split('\n').length;
console.log('[recover-all] 已还原 src/xxt-all.js');
console.log('[recover-all] ' + Buffer.byteLength(body, 'utf8') + ' 字节 · ' + lines + ' 行 · 字形表 ' + origin.length + ' 字符');
console.log('[recover-all] 版本号：' + (/var VERSION = '([^']+)'/.exec(body) || [, '?'])[1]);
