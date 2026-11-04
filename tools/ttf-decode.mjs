// TTF 字形指纹解码器：把学习通 cxsecret 字体的乱码字还原成真字
//
// 用法：
//   node tools/ttf-decode.mjs <字体.ttf> [--map 输出.json] [--text 乱码文本]
//
// 原理（照抄 SuperAutoStudy FontDecoder）：
//   1. 解析 TTF 的 cmap，拿到「码位 → 字形编号」
//   2. 解析 loca/glyf，把每个字形的轮廓点序列拼成字符串：x、y、(flags & 1)
//   3. 对该字符串算 MD5 → 得到「形状指纹」
//   4. 用 font_map_table.json 反查指纹 → 真字的 uniXXXX
//   5. 顺便过一遍康熙部首替换表（U+2E80–U+2FDF 段 → 正常汉字）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TABLE_PATH = path.resolve(
  ROOT,
  '..',
  'sas',
  'SuperAutoStudy-master',
  'src',
  'main',
  'resources',
  'font_map_table.json'
);

// ---------- 康熙部首替换表 ----------
const KX_KEYS =
  '⼀⼁⼂⼃⼄⼅⼆⼇⼈⼉⼊⼋⼌⼍⼎⼏⼐⼑⼒⼓⼔⼕⼖⼗⼘⼙⼚⼛⼜⼝⼞⼟⼠⼡⼢⼣⼤⼥⼦⼧⼨⼩⼪⼫⼬⼭⼮⼯⼰⼱⼲⼳⼴⼵⼶⼷⼸⼹⼺⼻⼼⼽⼾⼿⽀⽁⽂⽃⽄⽅⽆⽇⽈⽉⽊⽋⽌⽍⽎⽏⽐⽑⽒⽓⽔⽕⽖⽗⽘⽙⽚⽛⽜⽝⽞⽟⽠⽡⽢⽣⽤⽥⽦⽧⽨⽩⽪⽫⽬⽭⽮⽯⽰⽱⽲⽳⽴⽵⽶⽷⽸⽹⽺⽻⽼⽽⽾⽿⾀⾁⾂⾃⾄⾅⾆⾇⾈⾉⾊⾋⾌⾍⾎⾏⾐⾑⾒⾓⾔⾕⾖⾗⾘⾙⾚⾛⾜⾝⾞⾟⾠⾡⾢⾣⾤⾥⾦⾧⾨⾩⾪⾫⾬⾭⾮⾯⾰⾱⾲⾳⾴⾵⾶⾷⾸⾹⾺⾻⾼髙⾽⾾⾿⿀⿁⿂⿃⿄⿅⿆⿇⿈⿉⿊⿋⿌⿍⿎⿏⿐⿑⿒⿓⿔⿕⺠⻬⻩⻢⻜⻅⺟⻓';
const KX_VALS =
  '一丨丶丿乙亅二亠人儿入八冂冖冫几凵刀力勹匕匚匸十卜卩厂厶又口囗土士夂夊夕大女子宀寸小尢尸屮山巛工己巾干幺广廴廾弋弓彐彡彳心戈戶手支攴文斗斤方无日曰月木欠止歹殳毋比毛氏气水火爪父爻爿片牙牛犬玄玉瓜瓦甘生用田疋疒癶白皮皿目矛矢石示禸禾穴立竹米糸缶网羊羽老而耒耳聿肉臣自至臼舌舛舟艮色艸虍虫血行衣襾見角言谷豆豕豸貝赤走足身車辛辰辵邑酉采里金長門阜隶隹雨青非面革韋韭音頁風飛食首香馬骨高高髟鬥鬯鬲鬼魚鳥鹵鹿麥麻黃黍黑黹黽鼎鼓鼠鼻齊齒龍龜龠民齐黄马飞见母长';

const KX = new Map();
for (let i = 0; i < KX_KEYS.length; i++) KX.set(KX_KEYS.charCodeAt(i), KX_VALS[i]);

// ---------- TTF 结构 ----------
function ttcBase(buf, index = 0) {
  const ascii = buf.toString('ascii', 0, 4);
  if (ascii === 'ttcf') {
    const n = buf.readUInt32BE(8);
    const i = Math.min(index, Math.max(0, n - 1));
    return buf.readUInt32BE(12 + i * 4);
  }
  const m = buf.readUInt32BE(0);
  if (!(m === 0x00010000 || ascii === 'true' || ascii === 'OTTO')) {
    throw new Error('不是 TTF/OTF 字体，头 4 字节 = ' + buf.slice(0, 4).toString('hex'));
  }
  return 0;
}

function readTables(buf, base = 0) {
  const numTables = buf.readUInt16BE(base + 4);
  const tables = {};
  let off = base + 12;
  for (let i = 0; i < numTables; i++) {
    if (off + 16 > buf.length) break;
    const tag = buf.toString('ascii', off, off + 4);
    tables[tag] = {
      offset: buf.readUInt32BE(off + 8),
      length: buf.readUInt32BE(off + 12),
    };
    off += 16;
  }
  return tables;
}

function parseCmap(buf, t) {
  const base = t.offset;
  const numSub = buf.readUInt16BE(base + 2);
  const subs = [];

  for (let i = 0; i < numSub; i++) {
    const p = base + 4 + i * 8;
    if (p + 8 > buf.length) break;
    const platformID = buf.readUInt16BE(p);
    const encodingID = buf.readUInt16BE(p + 2);
    const subOff = base + buf.readUInt32BE(p + 4);
    if (subOff + 2 > buf.length) continue;
    const format = buf.readUInt16BE(subOff);
    subs.push({ platformID, encodingID, subOff, format });
  }

  // 优先级：Windows Unicode 全字符(3,10) > Windows BMP(3,1) > Unicode 平台
  const score = (s) => {
    if (s.platformID === 3 && s.encodingID === 10) return 100;
    if (s.platformID === 3 && s.encodingID === 1) return 90;
    if (s.platformID === 0) return 50;
    if (s.platformID === 3) return 30;
    return 0;
  };

  const usable = subs.filter((s) => s.format === 4 || s.format === 12 || s.format === 6);
  usable.sort((a, b) => score(b) - score(a) || (b.format === 12) - (a.format === 12));

  if (!usable.length) throw new Error('cmap 里没有可用的 format 4/6/12 子表');

  const map = new Map(); // codePoint → glyphIndex
  for (const s of usable) {
    if (s.format === 12) readFormat12(buf, s.subOff, map);
    else if (s.format === 4) readFormat4(buf, s.subOff, map);
    else if (s.format === 6) readFormat6(buf, s.subOff, map);
    if (map.size > 100) break; // 优先子表已有内容就够了
  }
  return map;
}

function readFormat4(buf, off, map) {
  const segCountX2 = buf.readUInt16BE(off + 6);
  const segCount = segCountX2 >> 1;
  const endBase = off + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;

  for (let s = 0; s < segCount; s++) {
    const end = buf.readUInt16BE(endBase + s * 2);
    const start = buf.readUInt16BE(startBase + s * 2);
    const delta = buf.readInt16BE(deltaBase + s * 2);
    const rangeOff = buf.readUInt16BE(rangeBase + s * 2);
    if (start === 0xffff) break;

    for (let c = start; c <= end && c !== 0x10000; c++) {
      let g;
      if (rangeOff === 0) {
        g = (c + delta) & 0xffff;
      } else {
        const p = rangeBase + s * 2 + rangeOff + (c - start) * 2;
        if (p + 2 > buf.length) continue;
        g = buf.readUInt16BE(p);
        if (g !== 0) g = (g + delta) & 0xffff;
      }
      if (g !== 0) map.set(c, g);
    }
  }
}

function readFormat12(buf, off, map) {
  const nGroups = buf.readUInt32BE(off + 12);
  let p = off + 16;
  for (let i = 0; i < nGroups; i++) {
    if (p + 12 > buf.length) break;
    const startChar = buf.readUInt32BE(p);
    const endChar = buf.readUInt32BE(p + 4);
    const startGlyph = buf.readUInt32BE(p + 8);
    for (let c = startChar; c <= endChar; c++) {
      map.set(c, startGlyph + (c - startChar));
    }
    p += 12;
  }
}

function readFormat6(buf, off, map) {
  const first = buf.readUInt16BE(off + 6);
  const count = buf.readUInt16BE(off + 8);
  for (let i = 0; i < count; i++) {
    const g = buf.readUInt16BE(off + 10 + i * 2);
    if (g !== 0) map.set(first + i, g);
  }
}

// ---------- 字形轮廓 ----------
function makeGlyphReader(buf, tables) {
  const maxp = tables['maxp'];
  const numGlyphs = maxp ? buf.readUInt16BE(maxp.offset + 4) : 0;

  const head = tables['head'];
  const longLoca = head ? buf.readInt16BE(head.offset + 50) === 1 : true;

  const loca = tables['loca'];
  const glyf = tables['glyf'];
  if (!loca || !glyf) throw new Error('字体里没有 loca/glyf 表（可能是 CFF 轮廓，OTTO 格式）');

  function glyphRange(gid) {
    let start;
    let end;
    if (longLoca) {
      start = buf.readUInt32BE(loca.offset + gid * 4);
      end = buf.readUInt32BE(loca.offset + (gid + 1) * 4);
    } else {
      start = buf.readUInt16BE(loca.offset + gid * 2) * 2;
      end = buf.readUInt16BE(loca.offset + (gid + 1) * 2) * 2;
    }
    return { start, end };
  }

  // 返回轮廓点数组 [{contours:[[{x,y,on}]], }] 或 null
  function readGlyph(gid) {
    if (gid < 0 || gid >= numGlyphs) return null;
    let { start, end } = glyphRange(gid);
    if (end <= start) return { contours: [], empty: true };

    const p0 = glyf.offset + start;
    const p1 = glyf.offset + end;
    if (p0 + 10 > buf.length) return null;

    const numberOfContours = buf.readInt16BE(p0);
    if (numberOfContours < 0) return { composite: true, contours: [] };

    let p = p0 + 10;
    const endPts = [];
    for (let i = 0; i < numberOfContours; i++) {
      endPts.push(buf.readUInt16BE(p));
      p += 2;
    }
    const numPoints = numberOfContours ? endPts[numberOfContours - 1] + 1 : 0;

    const instrLen = buf.readUInt16BE(p);
    p += 2 + instrLen;

    // flags
    const flags = new Array(numPoints);
    for (let i = 0; i < numPoints; ) {
      if (p >= p1) break;
      const f = buf[p++];
      flags[i++] = f;
      if (f & 0x08) {
        let rep = buf[p++];
        while (rep-- > 0 && i < numPoints) flags[i++] = f;
      }
    }

    // x
    const xs = new Array(numPoints);
    let x = 0;
    for (let i = 0; i < numPoints; i++) {
      const f = flags[i] || 0;
      if (f & 0x02) {
        const d = buf[p++];
        x += f & 0x10 ? d : -d;
      } else if (!(f & 0x10)) {
        x += buf.readInt16BE(p);
        p += 2;
      }
      xs[i] = x;
    }

    // y
    const ys = new Array(numPoints);
    let y = 0;
    for (let i = 0; i < numPoints; i++) {
      const f = flags[i] || 0;
      if (f & 0x04) {
        const d = buf[p++];
        y += f & 0x20 ? d : -d;
      } else if (!(f & 0x20)) {
        y += buf.readInt16BE(p);
        p += 2;
      }
      ys[i] = y;
    }

    // 按 contour 切分
    const contours = [];
    let last = 0;
    for (let c = 0; c < numberOfContours; c++) {
      const pts = [];
      for (let j = last; j <= endPts[c]; j++) {
        pts.push({ x: xs[j], y: ys[j], on: (flags[j] || 0) & 0x01 });
      }
      contours.push(pts);
      last = endPts[c] + 1;
    }
    return { contours };
  }

  return { readGlyph, numGlyphs };
}

// 复现 Java：sb.append(x).append(y).append(flags & 1)，无分隔符
function hashGlyph(glyph) {
  if (!glyph || !glyph.contours || !glyph.contours.length) return null;
  let s = '';
  for (const pts of glyph.contours) {
    for (const pt of pts) {
      s += String(pt.x) + String(pt.y) + String(pt.on);
    }
  }
  if (!s) return null;
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

// ---------- 主流程 ----------
function loadHashTable() {
  if (!fs.existsSync(TABLE_PATH)) {
    throw new Error('找不到全局字形表：' + TABLE_PATH);
  }
  const raw = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));
  const byHash = new Map();
  let uniCount = 0;
  for (const [name, h] of Object.entries(raw)) {
    if (!byHash.has(h)) byHash.set(h, name);
    if (/^uni[0-9A-F]{4}$/.test(name)) uniCount++;
  }
  return { byHash, uniCount, total: Object.keys(raw).length };
}

function buildFontMap(ttfBuf, fontIndex = 0, onlyCodes = null) {
  const base = ttcBase(ttfBuf, fontIndex);
  const tables = readTables(ttfBuf, base);
  const cmap = parseCmap(ttfBuf, tables['cmap']);
  const { readGlyph, numGlyphs } = makeGlyphReader(ttfBuf, tables);
  const { byHash, uniCount, total } = loadHashTable();

  const map = new Map(); // 码位(乱码) → 真字
  const detail = [];
  let hit = 0;
  let miss = 0;
  let noGlyph = 0;

  for (const [code, gid] of cmap) {
    if (code === 0) continue;
    if (onlyCodes && !onlyCodes.has(code)) continue;
    const g = readGlyph(gid);
    if (!g || g.composite) {
      noGlyph++;
      continue;
    }
    const h = hashGlyph(g);
    if (!h) {
      noGlyph++;
      continue;
    }
    const realName = byHash.get(h);
    if (realName && /^uni[0-9A-F]{4}$/.test(realName)) {
      const realCode = parseInt(realName.slice(3), 16);
      let realChar = String.fromCharCode(realCode);
      if (KX.has(realCode)) realChar = KX.get(realCode);
      map.set(code, realChar);
      detail.push({ from: String.fromCharCode(code), fromHex: code.toString(16), to: realChar, toHex: realCode.toString(16), gid, hash: h });
      hit++;
    } else {
      miss++;
      detail.push({ from: String.fromCharCode(code), fromHex: code.toString(16), to: null, gid, hash: h, realName: realName || null });
    }
  }

  return {
    map,
    detail,
    stats: {
      tables: Object.keys(tables).join(','),
      cmapEntries: cmap.size,
      numGlyphs,
      tableTotalKeys: total,
      tableUniKeys: uniCount,
      hit,
      miss,
      noGlyph,
    },
  };
}

// 不查表，只把字体里每个码位的字形指纹算出来：hash → { code, gid }
function hashIndex(buf, fontIndex = 0, onlyCodes = null) {
  const base = ttcBase(buf, fontIndex);
  const tables = readTables(buf, base);
  const cmap = parseCmap(buf, tables['cmap']);
  const { readGlyph, numGlyphs } = makeGlyphReader(buf, tables);

  const out = new Map();
  let noGlyph = 0;

  for (const [code, gid] of cmap) {
    if (code === 0) continue;
    if (onlyCodes && !onlyCodes.has(code)) continue;
    const g = readGlyph(gid);
    if (!g || g.composite) {
      noGlyph++;
      continue;
    }
    const h = hashGlyph(g);
    if (!h) {
      noGlyph++;
      continue;
    }
    if (!out.has(h)) out.set(h, { code, gid });
  }

  return { index: out, cmapEntries: cmap.size, numGlyphs, noGlyph };
}

function decodeText(text, map) {
  let out = '';
  let unknown = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (map.has(c)) out += map.get(c);
    else {
      out += ch;
      if (c > 0x2e80 && c < 0x9fff) unknown.push(ch);
    }
  }
  return { out, unknown };
}

// ---------- CLI ----------
function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.log('用法：node tools/ttf-decode.mjs <字体.ttf> [--map out.json] [--text "乱码"]');
    process.exit(1);
  }

  const file = argv[0];
  let outMap = null;
  let sampleText = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--map') outMap = argv[++i];
    else if (argv[i] === '--text') sampleText = argv[++i];
  }

  if (!fs.existsSync(file)) {
    console.error('找不到文件：' + file);
    process.exit(1);
  }

  const buf = fs.readFileSync(file);
  console.log('[ttf] 文件 ' + file);
  console.log('[ttf] 大小 ' + buf.length + ' 字节');

  const result = buildFontMap(buf);
  const s = result.stats;
  console.log('[ttf] 表：' + s.tables);
  console.log('[ttf] cmap 条目 ' + s.cmapEntries + ' / numGlyphs ' + s.numGlyphs);
  console.log('[ttf] 全局表 ' + s.tableTotalKeys + ' 键（其中 uni 键 ' + s.tableUniKeys + '）');
  console.log('[ttf] 命中 ' + s.hit + ' 个，未命中 ' + s.miss + ' 个，无轮廓 ' + s.noGlyph + ' 个');
  console.log('[ttf] 命中率 ' + ((s.hit / Math.max(1, s.hit + s.miss)) * 100).toFixed(1) + '%');

  if (s.hit > 0) {
    const sample = result.detail.filter((d) => d.to).slice(0, 20);
    console.log('[ttf] 前 20 条映射：');
    for (const d of sample) {
      console.log('      ' + d.from + ' (U+' + d.fromHex.toUpperCase().padStart(4, '0') + ') → ' + d.to + ' (U+' + d.toHex.toUpperCase().padStart(4, '0') + ')');
    }
  }

  if (s.miss > 0) {
    const missSample = result.detail.filter((d) => !d.to).slice(0, 10);
    console.log('[ttf] 未命中的前 10 个：');
    for (const d of missSample) {
      console.log('      ' + d.from + ' (U+' + d.fromHex.toUpperCase().padStart(4, '0') + ') gid=' + d.gid + ' hash=' + d.hash.slice(0, 12) + '… 表里=' + d.realName);
    }
  }

  if (sampleText) {
    const { out, unknown } = decodeText(sampleText, result.map);
    console.log('');
    console.log('[原文] ' + sampleText);
    console.log('[解码] ' + out);
    if (unknown.length) console.log('[没解出] ' + [...new Set(unknown)].join(''));
  }

  if (outMap) {
    const obj = {};
    for (const [code, ch] of result.map) {
      obj[String.fromCharCode(code)] = ch;
    }
    fs.writeFileSync(outMap, JSON.stringify(obj, null, 2), 'utf8');
    console.log('');
    console.log('[ttf] 映射表已写出 ' + outMap + '（' + result.map.size + ' 条）');
  }
}

const __isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch (e) {
    return false;
  }
})();
if (__isMain) main();

export { buildFontMap, hashIndex, loadHashTable, decodeText, readTables, parseCmap, ttcBase };
