// 生成浏览器端用的精简字形表
//   输入：font_map_table.json（glyphName -> 字形指纹 md5）+ FontDecoder.java 的康熙部首表 + work/gb2312.txt
//   输出：dist/font-table.txt —— 每 11 个字符一组：10 位字形指纹 + 1 个真字
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAS = path.resolve(ROOT, '..', 'sas', 'SuperAutoStudy-master');
const TABLE_PATH = path.join(SAS, 'src', 'main', 'resources', 'font_map_table.json');
const JAVA_PATH = path.join(SAS, 'src', 'main', 'java', 'com', 'tihai', 'utils', 'FontDecoder.java');
const CHAR_PATH = path.join(ROOT, 'work', 'gb2312.txt');
const OUT_PATH = path.join(ROOT, 'dist', 'font-table.txt');

const HASH_LEN = 10;

// 1) 康熙部首 -> 正常汉字
const javaSrc = fs.readFileSync(JAVA_PATH, 'utf8');
const km = javaSrc.match(/String keys\s*=\s*"([^"]+)"/);
const vm = javaSrc.match(/String values\s*=\s*"([^"]+)"/);
if (!km || !vm) throw new Error('没从 FontDecoder.java 里取到部首表');
const kxKeys = km[1];
const kxVals = vm[1];
if (kxKeys.length !== kxVals.length) {
  throw new Error('部首表长度不一致：' + kxKeys.length + ' vs ' + kxVals.length);
}
const KX = new Map();
for (let i = 0; i < kxKeys.length; i++) KX.set(kxKeys.charCodeAt(i), kxVals[i]);

// 2) GB2312 汉字集合
const gbChars = fs.readFileSync(CHAR_PATH, 'utf8').replace(/\s/g, '');
const GB = new Set(gbChars);

// 3) 反查：字形指纹 -> 真字
const raw = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));
const byHash = new Map();
let scanned = 0;
let outOfGB = 0;
let radicalFixed = 0;

for (const [name, md5] of Object.entries(raw)) {
  const m = /^uni([0-9A-Fa-f]{4,5})$/.exec(name);
  if (!m) continue;
  scanned++;
  const code = parseInt(m[1], 16);
  let ch = String.fromCharCode(code);
  if (KX.has(code)) {
    ch = KX.get(code);
    radicalFixed++;
  }
  const c2 = ch.codePointAt(0);
  if (c2 < 0x4e00 || c2 > 0x9fff) {
    outOfGB++;
    continue;
  }
  if (!GB.has(ch)) {
    outOfGB++;
    continue;
  }
  const short = md5.slice(0, HASH_LEN);
  if (!byHash.has(short)) byHash.set(short, ch);
}

const parts = [];
for (const [h, ch] of byHash) parts.push(h + ch);
const table = parts.join('');

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, table, 'utf8');
const byHashRev = new Map();
for (const [h, ch] of byHash) if (!byHashRev.has(ch)) byHashRev.set(ch, h);

console.log('[font-table] 部首表 ' + KX.size + ' 条，其中修正 ' + radicalFixed + ' 个码位');
console.log('[font-table] 扫 uni 键 ' + scanned + ' 个，落在 GB2312 外/丢弃 ' + outOfGB + ' 个');
console.log('[font-table] 收录 ' + byHash.size + ' 条（覆盖 ' + byHashRev.size + ' 个汉字）');
console.log('[font-table] 输出 ' + OUT_PATH);
console.log('[font-table] 字符数 ' + table.length + '（约 ' + (Buffer.byteLength(table) / 1024).toFixed(1) + ' KB）');

// 4) 自检：54 个已知加密字
const known = '孤变温体生下立不减能小或可大总是标状质定态尔准的为氧时臭熵应个程过一反单考它参对于零系乱混美发凡自方着朝任何';
let knownMiss = '';
for (const ch of known) {
  if (!byHashRev.has(ch)) knownMiss += ch;
}
console.log('[font-table] 已知 54 字覆盖：' + (knownMiss ? '缺 ' + knownMiss : '全覆盖 ✅'));

// 5) 覆盖率
let gbCovered = 0;
for (const ch of GB) if (byHashRev.has(ch)) gbCovered++;
console.log('[font-table] GB2312 覆盖率 ' + gbCovered + '/' + GB.size + ' = ' + ((gbCovered / GB.size) * 100).toFixed(2) + '%');
