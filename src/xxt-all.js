/**
 * 学习通一站式任务机 v3.0
 *
 * 一个脚本管一页上的所有任务点：
 *   ① 视频       —— 自动起播、1.5x、静音、播完接着播下一个（同页多个视频连着放）
 *   ② 长图任务   —— 从上往下一格一格翻到底
 *   ③ 章节测验   —— 还原加密字体的题干 → AI 出答案 → 自动勾选 → 自动点「暂存」（绝不点提交）
 *
 * 一页上的任务全清完，再按左侧目录跳到下一个「有任务点」的小节；
 * 目录里没标任务点的小节直接越过。
 *
 * 用法：课程页面 → 安装脚本 → 刷新。右上角出现面板。
 * 停止：面板上的「停止」或控制台 xxt.stop()
 *
 * ── 和前两个单件版的关系 ──
 *   视频/长图部分 = 刷课版 v1.11 的全部逻辑
 *   测验部分     = 题干还原 v2.3 的全部逻辑（含 74KB 字形指纹表）
 *   新增的是调度：判断这一页还剩哪些任务，全清完才走。
 *
 * ── 死规矩 ──
 *   脚本永远不点「提交 / 交卷」。暂存可以代点，提交必须人来。
 */
(function () {
  'use strict';

  var VERSION = '3.3';
  var TEST = (typeof window !== 'undefined' && window.__XXT_TEST__) || {};
  var PANEL_ID = 'xxt-all-panel';

  // 重复安装（比如更新了脚本）时，先把上一份停掉，别两个循环互相抢
  try {
    if (window.xxt && typeof window.xxt.stop === 'function') window.xxt.stop();
  } catch (e) { }

  // 老的「题干还原」和「刷视频」如果还装着，会各自起一份面板、各自抢视频。
  // 这里占住它们的入口标记（老脚本看到这个标记会自己退出），并拔掉老面板。
  // 彻底干净的做法还是去 Tampermonkey 里把这两个旧脚本停用。
  var PAGE = window;
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow) PAGE = unsafeWindow;
  } catch (e0) { }
  try {
    PAGE.__XXT_QUIZ_DECODE__ = 'merged-into-xxt-all-v' + VERSION;
    var oldPanel = document.getElementById('xxt-quiz-decode-panel') ||
      document.getElementById('xxt-quiz-decode');
    if (oldPanel && oldPanel.parentNode) oldPanel.parentNode.removeChild(oldPanel);
  } catch (e2) { }

  /* ==================== 配置 ==================== */

  var RATE = (function () {
    if (TEST.rate) return TEST.rate;
    try {
      var r = Number(kvGet('xxt-all:rate'));
      if (r > 0 && r <= 4) return r;
    } catch (e) { }
    return 1.5;
  })();                                          // 倍速（xxt.rate(2) 可以改，会记住）
  var TICK = TEST.tick || 1000;                 // 每秒检查一次
  var TOL = Math.max(0.8, RATE + 0.3);          // 剩余多少秒算播完
  var SCAN_ROUNDS = TEST.scanRounds || 12;      // 确认阶段最多往下推几轮
  var STUCK_LIMIT = 40;                         // 同一个视频拉不起来这么多次就放弃
  var SKIP_NO_TASK = !TEST.keepEmpty;           // 越过没标任务点的小节
  var IMG_SCROLL = !TEST.noImgScroll;           // 长图自动往下翻
  var EMPTY_WAIT = (TEST.emptyWait != null) ? TEST.emptyWait : 20000;  // 一点动静都没有时，等多久才判定这页做完了
  var PROBE_GAP = (TEST.probeGap != null) ? TEST.probeGap : 700;       // 确认阶段两次往下推之间隔多久
  var QUIZ_WAIT_MS = TEST.quizWait || 300000;   // 勾了「等交卷再走」时，最多等多久（5 分钟）
  var QUIZ_COOLDOWN = TEST.quizCooldown || 1500; // 保存完停一下再走，给页面把请求发出去
  var QUIZ_SLOW = TEST.quizSlow || 10000;        // 自动暂存关着时，多等一会儿给人自己点保存
  var QUIZ_IDLE_MS = TEST.quizIdle || 180000;    // 题目读出来了却迟迟没有答案，这么久就先跳过
  var GO_COOLDOWN = 2000;                       // 两次点「下一个」的最小间隔

  var GLYPH_TABLE = '__GLYPH_TABLE__';
  var HASH_LEN = 10;

  /* ==================== 0. 通用小工具 ==================== */

  function log() {
    var a = ['[xxt]'];
    for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
    try { console.log.apply(console, a); } catch (e) { }
  }

  function mk(tag, css, txt) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      var cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (e) { return false; }
  }

  // 有的元素 .click() 不认，退一步带坐标自己派发事件
  function clickEl(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (e) { }
    try {
      var r = el.getBoundingClientRect();
      var opt = {
        bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
      };
      el.dispatchEvent(new MouseEvent('mousedown', opt));
      el.dispatchEvent(new MouseEvent('mouseup', opt));
      el.dispatchEvent(new MouseEvent('click', opt));
      return true;
    } catch (e2) { }
    return false;
  }

  // 播放器可能藏在好几层 iframe 里，把能找到的 document 全收进来。
  // 一秒里会被问好几次，做个 300ms 的小缓存 —— iframe 不会在 300ms 内换了又换。
  var _docsCache = null;
  var _docsTs = 0;
  function collectDocs() {
    var now = Date.now();
    if (_docsCache && now - _docsTs < 300) return _docsCache;

    var out = [];
    var seen = [];
    function walk(root, depth) {
      if (!root || depth > 6) return;
      if (seen.indexOf(root) >= 0) return;
      seen.push(root);
      out.push(root);
      var frames;
      try { frames = root.querySelectorAll('iframe, frame'); } catch (e) { frames = []; }
      for (var i = 0; i < frames.length; i++) {
        var d = null;
        try { d = frames[i].contentDocument; } catch (e) { d = null; }
        if (d) walk(d, depth + 1);
      }
    }
    walk(document, 0);
    _docsCache = out;
    _docsTs = now;
    return out;
  }

  // 完整地址算个短哈希（同一批视频的地址尾巴常常长得一样，不能用末尾几位当指纹）
  function h32(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function copyText(t) {
    try {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (e) { }
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(t);
    } catch (e2) { }
    return false;
  }

  // 面板自己也挂在 body 上，找按钮/找文字时必须把它排除，
  // 否则会把面板里那个「暂存」当成页面按钮点，或者把面板文案当成已交卷的证据
  function inOwnPanel(el) {
    var p = el;
    for (var i = 0; i < 14 && p; i++) {
      if (p.id === PANEL_ID) return true;
      p = p.parentElement;
    }
    return false;
  }

  function bodyTextWithoutPanel() {
    if (!document.body) return '';
    var txt = document.body.textContent || '';
    var p = document.getElementById(PANEL_ID);
    if (!p) return txt;
    var pt = p.textContent || '';
    if (!pt) return txt;
    var i = txt.indexOf(pt);
    if (i < 0) return txt;
    return txt.slice(0, i) + txt.slice(i + pt.length);
  }

  /* ==================== 0b. 存储 ==================== */
  /**
   * 为什么不能用页面的 localStorage 存配置：
   *   ① 它按 origin 隔离。mooc1.chaoxing.com / mooc2-ans.chaoxing.com / i.chaoxing.com
   *      是三个不同的 origin，在这边填的设置到那边就读不到。
   *   ② Firefox 的隐私设置、清站点数据、Clear-Site-Data 响应头都会把它带走。
   *   ③ 关浏览器、关机重启，浏览器一清会话数据它就没了 —— 这就是"设置老是丢"。
   *
   * 油猴自己的存储（GM_setValue）存在扩展里，不跟页面走：跨 origin、跨会话、重启都还在。
   * 所以：两边都写；读的时候优先油猴那份，读不到再退回页面存储（顺带兼容老版本的数据）。
   */
  function hasGM() {
    return (typeof GM_setValue === 'function' && typeof GM_getValue === 'function');
  }

  function kvGet(key) {
    if (hasGM()) {
      try {
        var v = GM_getValue(key, null);
        if (v !== null && v !== undefined && v !== '') return String(v);
      } catch (e) { }
    }
    try {
      var s = localStorage.getItem(key);
      if (s !== null && s !== '') return s;
    } catch (e2) { }
    return null;
  }

  function kvSet(key, val) {
    var ok = false;
    if (hasGM()) {
      try { GM_setValue(key, String(val)); ok = true; } catch (e) { }
    }
    try { localStorage.setItem(key, String(val)); ok = true; } catch (e2) { }
    return ok;
  }

  function kvDel(key) {
    if (hasGM()) {
      try { if (typeof GM_deleteValue === 'function') GM_deleteValue(key); } catch (e) { }
    }
    try { localStorage.removeItem(key); } catch (e2) { }
  }

  function storageName() {
    return hasGM() ? '油猴存储（重启不丢）' : '页面存储（可能被清）';
  }

  // 老版本只写了页面存储。第一次跑新版时，把还能读到的搬进油猴存储。
  var _migrated = false;
  function migrateStorage() {
    if (_migrated) return 0;
    _migrated = true;
    if (!hasGM()) return 0;
    var keys = ['xxt-quiz:api', 'xxt-quiz:opts', 'xxt-all:rate', 'xxt-all:skipped'];
    var n = 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      try {
        var gv = GM_getValue(k, null);
        if (gv !== null && gv !== undefined && gv !== '') continue;
        var lv = null;
        try { lv = localStorage.getItem(k); } catch (e) { lv = null; }
        if (lv) {
          GM_setValue(k, lv);
          n++;
          log('把旧设置搬进油猴存储：' + k);
        }
      } catch (e2) { }
    }
    return n;
  }

  /* ==================== 1. MD5 ==================== */
  // crypto.subtle 不支持 MD5，只能自己算
  function md5hex(bytes) {
    var S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    var K = new Int32Array(64);
    for (var i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

    var len = bytes.length;
    var nlen = (((len + 8) >> 6) + 1) * 64;
    var msg = new Uint8Array(nlen);
    msg.set(bytes);
    msg[len] = 0x80;
    var bits = len * 8;
    msg[nlen - 8] = bits & 0xff;
    msg[nlen - 7] = (bits >>> 8) & 0xff;
    msg[nlen - 6] = (bits >>> 16) & 0xff;
    msg[nlen - 5] = (bits >>> 24) & 0xff;

    var a0 = 0x67452301 | 0;
    var b0 = 0xefcdab89 | 0;
    var c0 = 0x98badcfe | 0;
    var d0 = 0x10325476 | 0;
    var M = new Int32Array(16);

    for (var off = 0; off < nlen; off += 64) {
      for (var j = 0; j < 16; j++) {
        var p = off + j * 4;
        M[j] = msg[p] | (msg[p + 1] << 8) | (msg[p + 2] << 16) | (msg[p + 3] << 24);
      }
      var A = a0;
      var B = b0;
      var C = c0;
      var D = d0;
      for (var k = 0; k < 64; k++) {
        var F;
        var g;
        if (k < 16) {
          F = (B & C) | (~B & D);
          g = k;
        } else if (k < 32) {
          F = (D & B) | (~D & C);
          g = (5 * k + 1) & 15;
        } else if (k < 48) {
          F = B ^ C ^ D;
          g = (3 * k + 5) & 15;
        } else {
          F = C ^ (B | ~D);
          g = (7 * k) & 15;
        }
        var t = (A + F + K[k] + M[g]) | 0;
        var s = S[k];
        t = (t << s) | (t >>> (32 - s));
        t = (t + B) | 0;
        A = D;
        D = C;
        C = B;
        B = t;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }

    function w(x) {
      var out = '';
      for (var i2 = 0; i2 < 4; i2++) {
        var b = (x >>> (i2 * 8)) & 0xff;
        out += (b < 16 ? '0' : '') + b.toString(16);
      }
      return out;
    }
    return w(a0) + w(b0) + w(c0) + w(d0);
  }

  /* ==================== 2. TTF 解析 ==================== */

  function Reader(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  Reader.prototype.u8 = function (o) { return this.v.getUint8(o); };
  Reader.prototype.u16 = function (o) { return this.v.getUint16(o, false); };
  Reader.prototype.i16 = function (o) { return this.v.getInt16(o, false); };
  Reader.prototype.u32 = function (o) { return this.v.getUint32(o, false); };
  Reader.prototype.len = function () { return this.b.length; };

  function asciiAt(r, off, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(r.u8(off + i));
    return s;
  }

  function ttcBase(r, index) {
    var head = asciiAt(r, 0, 4);
    if (head === 'ttcf') {
      var n = r.u32(8);
      var i = Math.min(index || 0, Math.max(0, n - 1));
      return r.u32(12 + i * 4);
    }
    if (head === 'wOFF' || head === 'wOF2') throw new Error('字体被压成了 WOFF，需要先解压');
    var m = r.u32(0);
    if (!(m === 0x00010000 || head === 'true' || head === 'OTTO')) {
      throw new Error('不是 TTF 字体，头四个字节是 ' + asciiAt(r, 0, 4));
    }
    return 0;
  }

  function readTables(r, base) {
    var numTables = r.u16(base + 4);
    var tables = {};
    var off = base + 12;
    for (var i = 0; i < numTables; i++) {
      if (off + 16 > r.len()) break;
      tables[asciiAt(r, off, 4)] = { offset: r.u32(off + 8), length: r.u32(off + 12) };
      off += 16;
    }
    return tables;
  }

  function readFormat4(r, off, map) {
    var segCountX2 = r.u16(off + 6);
    var segCount = segCountX2 >> 1;
    var endBase = off + 14;
    var startBase = endBase + segCountX2 + 2;
    var deltaBase = startBase + segCountX2;
    var rangeBase = deltaBase + segCountX2;

    for (var s = 0; s < segCount; s++) {
      var end = r.u16(endBase + s * 2);
      var start = r.u16(startBase + s * 2);
      var delta = r.i16(deltaBase + s * 2);
      var rangeOff = r.u16(rangeBase + s * 2);
      if (start === 0xffff) break;
      for (var c = start; c <= end && c !== 0x10000; c++) {
        var g;
        if (rangeOff === 0) {
          g = (c + delta) & 0xffff;
        } else {
          var p = rangeBase + s * 2 + rangeOff + (c - start) * 2;
          if (p + 2 > r.len()) continue;
          g = r.u16(p);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g !== 0) map.set(c, g);
      }
    }
  }

  function readFormat12(r, off, map) {
    var nGroups = r.u32(off + 12);
    var p = off + 16;
    for (var i = 0; i < nGroups; i++) {
      if (p + 12 > r.len()) break;
      var startChar = r.u32(p);
      var endChar = r.u32(p + 4);
      var startGlyph = r.u32(p + 8);
      for (var c = startChar; c <= endChar; c++) map.set(c, startGlyph + (c - startChar));
      p += 12;
    }
  }

  function readFormat6(r, off, map) {
    var first = r.u16(off + 6);
    var count = r.u16(off + 8);
    for (var i = 0; i < count; i++) {
      var g = r.u16(off + 10 + i * 2);
      if (g !== 0) map.set(first + i, g);
    }
  }

  function parseCmap(r, t) {
    var base = t.offset;
    var numSub = r.u16(base + 2);
    var subs = [];
    for (var i = 0; i < numSub; i++) {
      var p = base + 4 + i * 8;
      if (p + 8 > r.len()) break;
      var platformID = r.u16(p);
      var encodingID = r.u16(p + 2);
      var subOff = base + r.u32(p + 4);
      if (subOff + 2 > r.len()) continue;
      subs.push({ platformID: platformID, encodingID: encodingID, subOff: subOff, format: r.u16(subOff) });
    }
    function score(s) {
      if (s.platformID === 3 && s.encodingID === 10) return 100;
      if (s.platformID === 3 && s.encodingID === 1) return 90;
      if (s.platformID === 0) return 50;
      if (s.platformID === 3) return 30;
      return 0;
    }
    var usable = [];
    for (var j = 0; j < subs.length; j++) {
      var f = subs[j].format;
      if (f === 4 || f === 12 || f === 6) usable.push(subs[j]);
    }
    if (!usable.length) throw new Error('字体里没有能用的字符映射表');
    usable.sort(function (a, b) {
      return score(b) - score(a) || (b.format === 12) - (a.format === 12);
    });

    var map = new Map();
    for (var k = 0; k < usable.length; k++) {
      var s2 = usable[k];
      if (s2.format === 12) readFormat12(r, s2.subOff, map);
      else if (s2.format === 4) readFormat4(r, s2.subOff, map);
      else readFormat6(r, s2.subOff, map);
      if (map.size > 100) break;
    }
    return map;
  }

  function makeGlyphReader(r, tables) {
    var maxp = tables['maxp'];
    var numGlyphs = maxp ? r.u16(maxp.offset + 4) : 0;
    var head = tables['head'];
    var longLoca = head ? r.i16(head.offset + 50) === 1 : true;
    var loca = tables['loca'];
    var glyf = tables['glyf'];
    if (!loca || !glyf) throw new Error('字体里没有 loca/glyf 表，可能不是 TrueType 轮廓');

    function range(gid) {
      var start;
      var end;
      if (longLoca) {
        start = r.u32(loca.offset + gid * 4);
        end = r.u32(loca.offset + (gid + 1) * 4);
      } else {
        start = r.u16(loca.offset + gid * 2) * 2;
        end = r.u16(loca.offset + (gid + 1) * 2) * 2;
      }
      return { start: start, end: end };
    }

    function readGlyph(gid) {
      if (gid < 0 || gid >= numGlyphs) return null;
      var rg = range(gid);
      if (rg.end <= rg.start) return { contours: [] };
      var p0 = glyf.offset + rg.start;
      var p1 = glyf.offset + rg.end;
      if (p0 + 10 > r.len()) return null;

      var numberOfContours = r.i16(p0);
      if (numberOfContours < 0) return { composite: true, contours: [] };

      var p = p0 + 10;
      var endPts = [];
      for (var i = 0; i < numberOfContours; i++) {
        endPts.push(r.u16(p));
        p += 2;
      }
      var numPoints = numberOfContours ? endPts[numberOfContours - 1] + 1 : 0;
      var instrLen = r.u16(p);
      p += 2 + instrLen;

      var flags = new Array(numPoints);
      for (var i2 = 0; i2 < numPoints;) {
        if (p >= p1) break;
        var f = r.u8(p++);
        flags[i2++] = f;
        if (f & 0x08) {
          var rep = r.u8(p++);
          while (rep-- > 0 && i2 < numPoints) flags[i2++] = f;
        }
      }

      var xs = new Array(numPoints);
      var x = 0;
      for (var i3 = 0; i3 < numPoints; i3++) {
        var fx = flags[i3] || 0;
        if (fx & 0x02) {
          var d = r.u8(p++);
          x += fx & 0x10 ? d : -d;
        } else if (!(fx & 0x10)) {
          x += r.i16(p);
          p += 2;
        }
        xs[i3] = x;
      }

      var ys = new Array(numPoints);
      var y = 0;
      for (var i4 = 0; i4 < numPoints; i4++) {
        var fy = flags[i4] || 0;
        if (fy & 0x04) {
          var d2 = r.u8(p++);
          y += fy & 0x20 ? d2 : -d2;
        } else if (!(fy & 0x20)) {
          y += r.i16(p);
          p += 2;
        }
        ys[i4] = y;
      }

      var contours = [];
      var last = 0;
      for (var c = 0; c < numberOfContours; c++) {
        var pts = [];
        for (var j = last; j <= endPts[c]; j++) {
          pts.push({ x: xs[j], y: ys[j], on: (flags[j] || 0) & 0x01 });
        }
        contours.push(pts);
        last = endPts[c] + 1;
      }
      return { contours: contours };
    }

    return { readGlyph: readGlyph, numGlyphs: numGlyphs };
  }

  // 复现原项目的指纹算法：每个点的 x、y、是否在曲线上依次拼接（无分隔符）再算 MD5
  function hashGlyph(glyph) {
    if (!glyph || !glyph.contours || !glyph.contours.length) return null;
    var s = '';
    for (var i = 0; i < glyph.contours.length; i++) {
      var pts = glyph.contours[i];
      for (var j = 0; j < pts.length; j++) {
        s += String(pts[j].x) + String(pts[j].y) + String(pts[j].on);
      }
    }
    if (!s) return null;
    var bytes = new Uint8Array(s.length);
    for (var k = 0; k < s.length; k++) {
      var c = s.charCodeAt(k);
      bytes[k] = c < 128 ? c : 63;
    }
    return md5hex(bytes);
  }

  /* ==================== 3. 字形表 ==================== */
  // 表的结构：每 11 个字符一条 —— 前 10 位是 md5 十六进制前缀，第 11 位是真字
  var lookupCache = null;
  function lookup() {
    if (lookupCache) return lookupCache;
    lookupCache = new Map();
    var t = GLYPH_TABLE;
    for (var i = 0; i + HASH_LEN + 1 <= t.length; i += HASH_LEN + 1) {
      lookupCache.set(t.slice(i, i + HASH_LEN), t.charAt(i + HASH_LEN));
    }
    log('字形表 ' + lookupCache.size + ' 条');
    return lookupCache;
  }

  /* ==================== 4. 从页面里拿加密字体 ==================== */

  function findFontB64(docs) {
    for (var i = 0; i < docs.length; i++) {
      var nodes;
      try { nodes = docs[i].querySelectorAll('style, script'); } catch (e) { continue; }
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        var txt = n.textContent || '';
        if (txt.indexOf('base64,') < 0) continue;
        if (n.id !== 'cxSecretStyle' && txt.indexOf('@font-face') < 0) continue;
        var re = /base64,([A-Za-z0-9+/=\r\n ]+)/g;
        var m;
        while ((m = re.exec(txt))) {
          var b = m[1].replace(/\s/g, '');
          if (b.length > 200) return b;
        }
      }
    }
    return null;
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function buildDecodeMap(bytes) {
    var r = new Reader(bytes);
    var base = ttcBase(r, 0);
    var tables = readTables(r, base);
    if (!tables['cmap']) throw new Error('字体里没有字符映射表（cmap）');
    var cmap = parseCmap(r, tables['cmap']);
    var gr = makeGlyphReader(r, tables);
    var table = lookup();
    var map = new Map();
    var hit = 0;
    var miss = 0;

    cmap.forEach(function (gid, code) {
      var g = gr.readGlyph(gid);
      var h = hashGlyph(g);
      if (!h) { miss++; return; }
      var ch = table.get(h.slice(0, HASH_LEN));
      if (ch) {
        map.set(code, ch);
        hit++;
      } else {
        miss++;
      }
    });

    return { map: map, hit: hit, miss: miss, total: cmap.size, bytes: bytes.length };
  }

  function decodeText(text, map) {
    if (!text || !map || !map.size) return text;
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      var real = map.get(code);
      out += real || text.charAt(i);
    }
    return out;
  }

  /* ==================== 5. 读题目 ==================== */

  // 填空/简答题的输入框：排除 hidden、选项用的 radio/checkbox，以及各种按钮
  function findBlankInputs(el) {
    var out = [];
    var nodes;
    try { nodes = el.querySelectorAll('input, textarea'); } catch (e) { return out; }
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var tag = String(n.tagName || '').toUpperCase();
      var type = String(n.getAttribute('type') || (tag === 'TEXTAREA' ? 'textarea' : 'text')).toLowerCase();
      if (type === 'hidden' || type === 'radio' || type === 'checkbox') continue;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'file') continue;
      if (type === 'image') continue;
      out.push(n);
    }
    return out;
  }

  // 一页上有几道题（用来判断「这一页是不是做题页」和「题有没有换」）
  function countQuestions() {
    var docs = collectDocs();
    var n = 0;
    var first = '';
    for (var i = 0; i < docs.length; i++) {
      var items;
      try { items = docs[i].querySelectorAll('div.singleQuesId'); } catch (e) { items = []; }
      if (items.length && !first) first = items[0].getAttribute('data') || items[0].getAttribute('data-id') || '';
      n += items.length;
    }
    return { n: n, first: first };
  }

  function collectQuiz(docs) {
    var out = [];
    for (var i = 0; i < docs.length; i++) {
      var items;
      try { items = docs[i].querySelectorAll('div.singleQuesId'); } catch (e) { items = []; }
      for (var j = 0; j < items.length; j++) {
        var el = items[j];
        var id = el.getAttribute('data') || el.getAttribute('data-id') || '';
        if (!id) {
          var hid = el.querySelector('input[name^="answer"]');
          if (hid) id = hid.name.replace(/\D/g, '');
        }
        var title = '';
        var t = el.querySelector('div.Zy_TItle');
        if (t) title = (t.textContent || '').replace(/\s+/g, ' ').trim();
        var opts = [];
        var els = [];
        var raw;
        try { raw = el.querySelectorAll('ul li'); } catch (e) { raw = []; }
        for (var k = 0; k < raw.length; k++) {
          var s = (raw[k].textContent || '').replace(/\s+/g, ' ').trim();
          if (!s) continue;
          opts.push(s);
          els.push(raw[k]);
        }
        if (!title && !opts.length) continue;

        var kind = 'single';
        if (/【\s*多选|多选题/.test(title)) kind = 'multi';
        else if (/【\s*判断|判断题/.test(title)) kind = 'judge';
        else if (/【\s*填空|填空题/.test(title)) kind = 'blank';
        else if (/【\s*简答|【\s*问答|【\s*主观|【\s*论述|简答题|论述题|主观题/.test(title)) kind = 'short';

        // 没选项但底下有输入框的，按填空处理
        var ins = findBlankInputs(el);
        if (!opts.length && kind === 'single' && ins.length > 0) kind = 'blank';
        if (kind !== 'blank' && kind !== 'short') ins = [];

        out.push({
          id: id || ('q' + (out.length + 1)),
          title: title,
          opts: opts,
          els: els,
          kind: kind,
          inputs: ins
        });
      }
    }
    return out;
  }

  /* ==================== 6. 解析 / 填写答案 ==================== */

  // 往输入框里写字，并触发框架能听到的事件（学习通有些页面是 Vue/React 渲染的）
  function setInputValue(el, val) {
    if (!el) return false;
    try { el.focus(); } catch (e) { }
    try {
      var proto = Object.getPrototypeOf(el);
      var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (desc && desc.set) desc.set.call(el, val);
      else el.value = val;
    } catch (e2) {
      try { el.value = val; } catch (e3) { return false; }
    }
    var kinds = ['input', 'change', 'keyup', 'blur'];
    for (var i = 0; i < kinds.length; i++) {
      try { el.dispatchEvent(new Event(kinds[i], { bubbles: true })); } catch (e4) { }
    }
    return true;
  }

  /**
   * 解析答案串。
   *   选择题：字母（D / ABD）
   *   填空/简答：直接写文字
   * 题与题之间的分隔符：换行 > 分号 > 逗号（先用最不容易误伤的）
   * 第二参既可以传题目数组（能知道哪题是填空），也可以传题数（老用法）。
   */
  function parseAnswers(s, quiz) {
    var list = Array.isArray(quiz) ? quiz : null;
    var n = list ? list.length : (Number(quiz) || 0);

    var raw = String(s || '').trim();
    if (!raw) return [];

    // 只传了题数（不知道题型）时按纯选择题处理，空格也算分隔符
    if (!list) {
      var ps = raw.split(/[,，;；\s]+/);
      var os = [];
      for (var a = 0; a < ps.length; a++) {
        var q2 = ps[a].replace(/^[0-9]+\s*[.、)）]\s*/, '').toUpperCase().replace(/[^A-Z]/g, '');
        if (q2) os.push(q2);
      }
      if (n && os.length === 1 && os[0].length === n) return os[0].split('');
      return os;
    }

    var parts;
    if (/\r?\n/.test(raw)) parts = raw.split(/\r?\n+/);
    else if (/[;；]/.test(raw)) parts = raw.split(/[;；]+/);
    else parts = raw.split(/[,，]+/);

    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = String(parts[i]).trim();
      if (!p) continue;
      p = p.replace(/^[0-9]+\s*[.、)）]\s*/, '');

      var kind = '';
      if (list && list[out.length]) kind = list[out.length].kind;

      if (kind === 'blank' || kind === 'short') {
        out.push(p);
      } else {
        var ab = p.toUpperCase().replace(/[^A-Z]/g, '');
        if (ab) out.push(ab);
        else if (/[\u4e00-\u9fff]/.test(p)) out.push(p); // 题型判错了，也别把中文答案扔掉
        else out.push('');
      }
    }

    if (n && out.length === n) return out;
    if (n && out.length === 1 && out[0].length === n) return out[0].split('');
    return out;
  }

  function fillAnswers(quiz, letters) {
    var res = { filled: 0, total: quiz.length, missed: [] };
    for (var i = 0; i < quiz.length; i++) {
      var q = quiz[i];
      var L = letters[i];
      if (!L) {
        res.missed.push(i + 1);
        continue;
      }
      if (q.kind === 'blank' || q.kind === 'short') {
        var ins = q.inputs && q.inputs.length ? q.inputs : null;
        if (!ins) {
          res.missed.push(i + 1);
          continue;
        }
        var chunks = String(L).split('|');
        var okFill = true;
        for (var bi = 0; bi < ins.length; bi++) {
          var v = chunks[bi] != null ? String(chunks[bi]).trim() : (chunks[0] || '');
          if (!setInputValue(ins[bi], v)) okFill = false;
        }
        if (okFill) res.filled++;
        else res.missed.push(i + 1);
        continue;
      }
      if (q.kind === 'judge') {
        var idx = L.charAt(0) === 'A' ? 0 : (L.charAt(0) === 'B' ? 1 : -1);
        if (idx >= 0 && q.els && q.els[idx] && clickEl(q.els[idx])) res.filled++;
        else res.missed.push(i + 1);
        continue;
      }
      var allOk = true;
      for (var k = 0; k < L.length; k++) {
        var j = L.charCodeAt(k) - 65;
        if (j < 0 || !q.els || !q.els[j]) {
          allOk = false;
          continue;
        }
        if (!clickEl(q.els[j])) allOk = false;
      }
      if (allOk) res.filled++;
      else res.missed.push(i + 1);
    }
    return res;
  }

  /* ==================== 7. 暂存（绝不提交） ==================== */

  // 只在做题的那个文档里找，避免点到页面别处的「保存」（比如笔记、讨论）
  function quizDocs() {
    var all = collectDocs();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var n = 0;
      try { n = all[i].querySelectorAll('div.singleQuesId').length; } catch (e) { n = 0; }
      if (n > 0) out.push(all[i]);
    }
    return out.length ? out : all;
  }

  /**
   * 找「暂存 / 保存」按钮。
   * 死规矩：按钮文字里只要带「提交」或「交卷」，一律不碰。
   * 找法：先在最后一题往上三层的盒子里找（那儿才是测验自己的按钮），
   *      找不到再退回整个文档 —— 免得点到笔记、讨论区的「保存」。
   */
  function findSaveBtn() {
    var NAMES = ['暂存', '暂时保存', '保存答案', '保存草稿', '保存'];
    var DANGER = /提交|交卷|交答案/;
    var SEL = 'button, a, input[type="button"], input[type="submit"], div[role="button"], span[role="button"]';
    var docs = quizDocs();

    function scanIn(root, name) {
      if (!root) return null;
      var nodes;
      try { nodes = root.querySelectorAll(SEL); } catch (e) { return null; }
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (inOwnPanel(el)) continue;
        var raw = el.tagName === 'INPUT' ? (el.value || '') : (el.textContent || '');
        var txt = String(raw).replace(/\s+/g, '');
        if (txt !== name) continue;
        if (DANGER.test(txt)) continue;
        if (!isVisible(el)) continue;
        return { el: el, name: txt };
      }
      return null;
    }

    // 窄范围：题目容器周围
    var scopes = [];
    for (var di = 0; di < docs.length; di++) {
      var qs = [];
      try { qs = docs[di].querySelectorAll('div.singleQuesId'); } catch (e) { qs = []; }
      if (!qs.length) { scopes.push(docs[di]); continue; }
      var box = qs[qs.length - 1];
      for (var up = 0; up < 3 && box && box.parentElement; up++) box = box.parentElement;
      scopes.push(box || docs[di]);
    }
    for (var k = 0; k < NAMES.length; k++) {
      for (var s = 0; s < scopes.length; s++) {
        var r = scanIn(scopes[s], NAMES[k]);
        if (r) return r;
      }
    }
    // 宽范围：整份文档
    for (var k2 = 0; k2 < NAMES.length; k2++) {
      for (var d = 0; d < docs.length; d++) {
        var r2 = scanIn(docs[d], NAMES[k2]);
        if (r2) return r2;
      }
    }
    return null;
  }

  // 点完「暂存」如果弹出确认框，顺手点「确定」；文案里出现「提交/交卷」就绝不点
  function confirmSaveDialog(status) {
    var DANGER = /提交|交卷/;
    var CONFIRM = ['.layui-layer-btn0', '#popok', '.con_ok', '.dialog-ok', '.btn-ok', '.confirm-ok'];
    var docs = quizDocs();
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      var layer = null;
      try { layer = d.querySelector('.layui-layer, .dialog, .modal, .layui-layer-content'); } catch (e) { layer = null; }
      if (!layer || !isVisible(layer)) continue;
      var t = layer.textContent || '';
      if (DANGER.test(t)) {
        if (status) {
          status.textContent = '⚠ 弹窗里写着「提交」，我不动它 —— 你自己看清楚再点';
          status.style.color = '#ffa657';
        }
        return false;
      }
      for (var k = 0; k < CONFIRM.length; k++) {
        var b = null;
        try { b = d.querySelector(CONFIRM[k]); } catch (e) { b = null; }
        if (b && isVisible(b)) {
          clickEl(b);
          if (status) status.textContent += '（顺手点了保存确认框）';
          return true;
        }
      }
    }
    return false;
  }

  function clickSave(status) {
    var btn = findSaveBtn();
    if (!btn) {
      if (status) {
        status.textContent = '⚠ 没找到「暂存/保存」按钮 —— 勾好了，请自己点一下页面上的保存';
        status.style.color = '#ffa657';
      }
      return null;
    }
    clickEl(btn.el);
    if (status) {
      status.textContent = '✅ 已勾选，并点了「' + btn.name + '」 —— 提交那一步仍然你自己来';
      status.style.color = '#7ee787';
    }
    setTimeout(function () { confirmSaveDialog(status); }, 700);
    return btn.name;
  }

  /**
   * 交没交卷？
   * 不看按钮（太不可靠），只看硬信号：
   *   「已提交 / 提交成功 / 本次成绩 / 重新答题」这类字样出现，说明这一页的活已经了结。
   * 注意不能只凭「查看答案」判断 —— 有些页面没提交也能点它。
   */
  function isQuizSubmitted() {
    var c = countQuestions();
    if (c.n === 0) return true;
    var txt = '';
    var ds = collectDocs();
    for (var i = 0; i < ds.length; i++) {
      if (!ds[i].body) continue;
      txt += (ds[i] === document ? bodyTextWithoutPanel() : (ds[i].body.textContent || '')) + '\n';
    }
    if (!txt) return false;
    // 只认硬信号。以前这里还写了「重新答题」「已作答」，
    // 结果题目卡片上自带的"已作答"标记会让脚本以为整页已交卷 —— 一道题都没做就跳走。
    return /(已提交|已交卷|提交成功|交卷成功|本次成绩|本次得分|总得分)/.test(txt);
  }

  /* ==================== 8. AI 出答案 ==================== */

  var API_KEY = 'xxt-quiz:api';

  function loadApiCfg() {
    try {
      var s = kvGet(API_KEY);
      if (!s) return { url: '', key: '', model: 'deepseek-chat' };
      var o = JSON.parse(s);
      return { url: o.url || '', key: o.key || '', model: o.model || 'deepseek-chat' };
    } catch (e) {
      return { url: '', key: '', model: 'deepseek-chat' };
    }
  }

  function saveApiCfg(cfg) {
    return kvSet(API_KEY, JSON.stringify(cfg));
  }

  /**
   * 发一个最小请求，验证地址/密钥/模型是不是真的能用。
   * 面板上那个「测试连接」按钮走这里 —— 设好之后当场验一下，比等到做题时才发现强。
   */
  function testApi(cfg, cb) {
    if (!cfg || !cfg.url) { cb(new Error('还没填接口地址'), null); return; }
    var body = {
      model: cfg.model || 'deepseek-chat',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 4,
      temperature: 0
    };
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.key) headers['Authorization'] = 'Bearer ' + cfg.key;
    var payload = JSON.stringify(body);
    var done = false;
    function fin(err, text) {
      if (done) return;
      done = true;
      if (err) { cb(err, null); return; }
      try {
        var j = JSON.parse(text);
        if (j.error) { cb(new Error(j.error.message || '接口报错'), null); return; }
        if (!j.choices || !j.choices.length) { cb(new Error('接口没返回 choices'), null); return; }
        cb(null, j.model || cfg.model || 'ok');
      } catch (e) {
        cb(new Error('回话解析不了：' + String(text).slice(0, 80)), null);
      }
    }
    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST', url: cfg.url, headers: headers, data: payload,
        onload: function (r) { fin(null, r.responseText); },
        onerror: function () { fin(new Error('网络错误（跨域或地址写错了）')); },
        ontimeout: function () { fin(new Error('超时')); },
        timeout: 30000
      });
      return;
    }
    fetch(cfg.url, { method: 'POST', headers: headers, body: payload })
      .then(function (r) { return r.text(); })
      .then(function (t) { fin(null, t); })
      .catch(function (e) { fin(e); });
  }

  function buildPrompt(data) {
    var KIND_NAME = { single: '单选题', multi: '多选题', judge: '判断题', blank: '填空题', short: '简答题' };
    var lines = [];
    for (var i = 0; i < data.quiz.length; i++) {
      var q = data.quiz[i];
      var kn = KIND_NAME[q.kind] || '题目';
      lines.push((i + 1) + '. [' + kn + '] ' + decodeText(q.title, data.map));
      for (var j = 0; j < q.opts.length; j++) {
        lines.push('   ' + optLine(q.opts[j], j, data.map).replace(/^\s+/, ''));
      }
      if (q.kind === 'blank' || q.kind === 'short') {
        var cnt = q.inputs && q.inputs.length ? q.inputs.length : 1;
        lines.push('   （这题有 ' + cnt + ' 个空，请直接给答案文字' + (cnt > 1 ? '，用 | 分隔' : '') + '）');
      }
      lines.push('');
    }
    return '下面是一份试卷，请逐题作答。\n\n' + lines.join('\n');
  }

  function askAI(cfg, data, cb) {
    var sys = '你是答题助手。用户给出一份试卷，你要为每道题给出答案。' +
      '只输出 JSON，格式为 {"answers":["D","熵增原理","AB"]}，数组长度必须等于题目数量。' +
      '单选题：一个字母；多选题：多个字母连写；判断题：A 表示"对"，B 表示"错"；' +
      '填空题/简答题：直接给出要填的文字，多个空之间用竖线 | 分隔，不要加引号、不要解释。';

    var body = {
      model: cfg.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: buildPrompt(data) }
      ],
      temperature: 0
    };

    var headers = { 'Content-Type': 'application/json' };
    if (cfg.key) headers['Authorization'] = 'Bearer ' + cfg.key;
    var payload = JSON.stringify(body);

    function handle(err, text) {
      if (err) { cb(err, null); return; }
      try {
        var j = JSON.parse(text);
        if (j.error) { cb(new Error(j.error.message || '接口报错'), null); return; }
        var content = j.choices && j.choices[0] && j.choices[0].message
          ? j.choices[0].message.content : '';
        var m = String(content).match(/\{[\s\S]*\}/);
        if (!m) {
          cb(new Error('AI 没按格式回话：' + String(content).slice(0, 120)), null);
          return;
        }
        var obj = JSON.parse(m[0]);
        if (!obj.answers || !obj.answers.length) {
          cb(new Error('AI 返回里没有 answers'), null);
          return;
        }
        cb(null, obj.answers.map(function (x) { return String(x).toUpperCase(); }));
      } catch (e) {
        cb(new Error('回话解析不了：' + String(text).slice(0, 120)), null);
      }
    }

    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: cfg.url,
        headers: headers,
        data: payload,
        onload: function (r) { handle(null, r.responseText); },
        onerror: function () { handle(new Error('网络错误')); },
        ontimeout: function () { handle(new Error('超时')); },
        timeout: 90000
      });
      return;
    }

    fetch(cfg.url, { method: 'POST', headers: headers, body: payload })
      .then(function (r) { return r.text(); })
      .then(function (t) { handle(null, t); })
      .catch(function (e) { handle(e); });
  }

  /* ==================== 9. 视频台账 ==================== */

  /**
   * 已看完的视频台账。
   *
   * 键 = 「当前小节 + 页面地址」+ 视频指纹。
   * 必须带上小节：不同章节点常常挂同一段视频（地址、时长一模一样），
   * 只按视频本身记账的话，第一节看完，第二节那个就会被当成"已经看过"直接跳过 —— 漏视频。
   */
  var doneSigs = new Set();
  var blocked = new Set();      // 认不出来 / 拉不起来的那些，按元素记
  var stuckTry = new Map();     // 拉不起来的次数

  function sectionKey() {
    var cur = '';
    try { cur = (S && S.curKey) || ''; } catch (e) { cur = ''; }
    var loc = '';
    try { loc = String(location.pathname || '') + String(location.search || ''); } catch (e2) { loc = ''; }
    return (cur || '(无目录)') + '@' + loc;
  }

  function srcOf(v) {
    var src = '';
    try { src = String(v.currentSrc || v.src || ''); } catch (e) { src = ''; }
    if (!src && v.querySelector) {
      var s = v.querySelector('source');
      if (s) src = String(s.getAttribute('src') || '');
    }
    return src;
  }

  // 认出「这是哪一个视频」。认不出来就返回 null ——
  // 页面刚打开时后面几个视频地址还没填上，以前它们都叫「#0」，
  // 一个被记成看完，剩下的全跟着被跳过。
  function sigOf(v) {
    if (!v) return null;
    var src = srcOf(v);
    if (!src) return null;
    return h32(src) + '#' + Math.round(Number(v.duration) || 0);
  }

  // 台账用的键：小节 + 视频。认不出视频就返回 null（这种绝不记账）
  function keyOf(v) {
    var s = sigOf(v);
    return s ? sectionKey() + '|' + s : null;
  }

  function allVideos() {
    var out = [];
    var ds = collectDocs();
    for (var i = 0; i < ds.length; i++) {
      var vs;
      try { vs = ds[i].querySelectorAll('video'); } catch (e) { vs = []; }
      for (var j = 0; j < vs.length; j++) {
        if (out.indexOf(vs[j]) < 0) out.push(vs[j]);
      }
    }
    return out;
  }

  function isFinished(v) {
    var dur = Number(v.duration) || 0;
    var cur = Number(v.currentTime) || 0;
    if (v.ended) return true;
    if (dur > 0 && cur > 0 && dur - cur <= TOL) return true;
    return false;
  }

  // 该播哪一个：正在播的优先；否则从上往下找第一个没看完的
  function pickVideo() {
    var vs = allVideos();
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      // 正在播的才算「当前」，已经播到尾的不算（不然会在最后一秒反复停住）
      if (!v.paused && !v.ended && Number(v.currentTime) > 0 && !isFinished(v)) return v;
    }
    for (var j = 0; j < vs.length; j++) {
      var v2 = vs[j];
      if (blocked.has(v2)) continue;
      var k = keyOf(v2);
      if (k && doneSigs.has(k)) continue;
      if (isFinished(v2)) {
        if (k) doneSigs.add(k); else blocked.add(v2);
        continue;
      }
      return v2;
    }
    return null;
  }

  // 视频没播过的时候，得滚到它跟前、帮它点一下播放按钮
  var PLAY_BTN = [
    '.vjs-big-play-button', '.vjs-big-play-btn', '.prism-big-play-btn',
    '.pv-play-btn', '.play-btn', '.video-play', '.vjs-play-control',
    '.controls-play', '.player-play'
  ].join(',');

  function poke(v) {
    var box = v;
    for (var i = 0; i < 4 && box; i++) {
      var btn = null;
      try { btn = box.querySelector(PLAY_BTN); } catch (e) { btn = null; }
      if (btn && btn !== v) { if (clickEl(btn)) return '按钮'; }
      box = box.parentElement;
    }
    if (clickEl(v)) return '视频本身';
    return null;
  }

  function safePlay(v) {
    try {
      var p = v.play();
      if (p && p.catch) {
        p.catch(function () {
          try { v.muted = true; } catch (e) { }
          try {
            var p2 = v.play();
            if (p2 && p2.catch) p2.catch(function () { });
          } catch (e2) { }
        });
      }
    } catch (e3) { }
  }

  // 提示浮层经常正好盖在「下一个」按钮上
  var POPUPS = ['.layui-layer-close', '.layui-layer-btn0', '.pop_close', '#popClose', '.close_btn'];
  function closePopups() {
    for (var i = 0; i < POPUPS.length; i++) {
      var el = document.querySelector(POPUPS[i]);
      if (isVisible(el)) { if (clickEl(el)) return POPUPS[i]; }
    }
    return null;
  }

  /* ==================== 10. 长图任务 ==================== */

  /**
   * 有些任务点是一张特别长的图，得从上往下一直滚到底才算看完。
   * 翻法是慢慢滚：每次滚大半屏、停一下、再滚。一下跳到底容易被判成没看，
   * 滚到底之后也留两秒给平台记账。
   */
  var lastScrollTs = 0;

  /**
   * 算不算「大图」。
   * 关键：懒加载的图在真正取到之前 naturalHeight 是 0，以前直接判成小图标，
   * 结果整页长图任务被当成"没有长图"跳过 —— 漏长图就是这么来的。
   */
  function isBigImg(img) {
    try {
      var nh = Number(img.naturalHeight) || 0;
      var nw = Number(img.naturalWidth) || 0;
      var h = Number(img.height) || 0;
      if (nh >= 200 || h >= 200) return true;
      var r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
      if (r && r.height >= 260) return true;
      // 长条图：明显"高瘦"，整体尺码不大也算长图
      if (nh > 0 && nw > 0 && nh / nw >= 2.5) return true;
      return false;
    } catch (e) { return false; }
  }

  /**
   * 找「装着大图、而且装不下」的滚动区域。
   * isBigImg 里的 getBoundingClientRect 会强制同步布局，一秒问好几次太贵 —— 500ms 内复用结果。
   */
  var _boxCache = null;
  var _boxTs = 0;

  function findScrollBoxes() {
    var now0 = Date.now();
    if (_boxCache && now0 - _boxTs < 500) return _boxCache;

    var out = [];
    var seen = new Set();
    function add(el) { if (el && !seen.has(el)) { seen.add(el); out.push(el); } }

    var ds = collectDocs();
    for (var di = 0; di < ds.length; di++) {
      var d = ds[di];
      var imgs = [];
      try { imgs = d.querySelectorAll('img'); } catch (e) { imgs = []; }
      var bigs = [];
      for (var i = 0; i < imgs.length; i++) if (isBigImg(imgs[i])) bigs.push(imgs[i]);
      if (!bigs.length) continue;

      // 情况一：整张页面自己就能滚 —— 图片得撑起大半张页面
      try {
        var se = d.scrollingElement || d.documentElement;
        if (se && se.scrollHeight > se.clientHeight + 80) {
          var imgH = 0;
          var tall = false;
          for (var b = 0; b < bigs.length; b++) {
            var ih = Number(bigs[b].height) || Number(bigs[b].naturalHeight) || 0;
            imgH += ih;
            var nw = Number(bigs[b].naturalWidth) || 0;
            var nh = Number(bigs[b].naturalHeight) || 0;
            if (nh > 0 && nw > 0 && nh / nw >= 2.5) tall = true;
            if (ih >= 800) tall = true;
          }
          // 0.5 太苛刻：页面有导航栏、其它文字时永远够不上。降到 0.35，另加「有一张长条图就算」
          if (tall || imgH >= se.scrollHeight * 0.35) add(se);
        }
      } catch (e2) { }

      // 情况二：图片外面套了个带滚动条的盒子（注意图片可能被塞进很深的一层）
      for (var k = 0; k < bigs.length; k++) {
        var box = bigs[k].parentElement;
        for (var s = 0; s < 8 && box; s++) {
          try {
            if (box.scrollHeight > box.clientHeight + 80) { add(box); break; }
          } catch (e3) { }
          box = box.parentElement;
        }
      }
    }
    _boxCache = out;
    _boxTs = Date.now();
    return out;
  }

  /**
   * 所有"还能往下滚"的地方（整页 + 带滚动条的容器）。
   * 用途：长图和视频常常是懒加载的，不推它就不出现 —— 光等是等不来的。
   * getComputedStyle 一秒扫几百个元素太贵，元素清单缓存 1 秒；滚动位置照旧实时读。
   */
  var _scrollCache = null;
  var _scrollTs = 0;

  function findScrollers() {
    var now0 = Date.now();
    if (_scrollCache && now0 - _scrollTs < 1000) return _scrollCache;

    var out = [];
    var seen = new Set();
    function add(el) {
      if (!el || seen.has(el)) return;
      try {
        if (el.scrollHeight > el.clientHeight + 80) { seen.add(el); out.push(el); }
      } catch (e) { }
    }

    var ds = collectDocs();
    for (var di = 0; di < ds.length; di++) {
      var d = ds[di];
      try { add(d.scrollingElement || d.documentElement); } catch (e) { }
      var all;
      try { all = d.querySelectorAll('div, section, article, main, ul'); } catch (e2) { all = []; }
      for (var i = 0; i < all.length && out.length < 30; i++) {
        var el = all[i];
        try {
          var oy = getComputedStyle(el).overflowY;
          if (oy !== 'auto' && oy !== 'scroll') continue;
          add(el);
        } catch (e3) { }
      }
    }
    _scrollCache = out;
    _scrollTs = Date.now();
    return out;
  }

  // 把还能往下滚的地方各推大半屏。返回推了多少处（0 = 已经全部到底了）
  function scrollEverything() {
    var moved = 0;
    var list = findScrollers();
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var top = Number(el.scrollTop) || 0;
      var view = Number(el.clientHeight) || 0;
      var full = Number(el.scrollHeight) || 0;
      if (full <= view + 80) continue;
      if (top + view >= full - 20) continue;
      var step = Math.max(160, Math.round(view * 0.75));
      try {
        el.scrollTop = Math.min(full, top + step);
        moved++;
      } catch (e) { }
    }
    return moved;
  }

  // 往下翻一屏。返回 true = 还有没翻完的，这一轮别去点下一节
  function scrollLong() {
    if (!IMG_SCROLL) return false;
    var boxes = findScrollBoxes();
    if (!boxes.length) return false;

    var now = Date.now();
    var pending = false;

    for (var i = 0; i < boxes.length; i++) {
      var el = boxes[i];
      var top = Number(el.scrollTop) || 0;
      var view = Number(el.clientHeight) || 0;
      var full = Number(el.scrollHeight) || 0;
      if (full <= view + 80) continue;            // 这点内容不用滚
      if (top + view >= full - 20) continue;      // 已经到底
      pending = true;
      if (now - lastScrollTs < 300) break;        // 滚太快没意义
      el.scrollTop = Math.min(full, top + Math.max(120, Math.round(view * 0.8)));
      lastScrollTs = now;
      log('长图往下翻：' + Math.round((el.scrollTop / full) * 100) + '%');
      break;
    }
    return pending;
  }

  /* ==================== 11. 左侧目录 / 跳节 ==================== */

  function catalog() {
    var tree = document.querySelector('#coursetree');
    if (!tree) return null;
    var active = tree.querySelector('.posCatalog_active');
    var all = tree.querySelectorAll('.posCatalog_select');
    var units = [];
    for (var i = 0; i < all.length; i++) {
      if (!all[i].classList.contains('firstLayer')) units.push(all[i]);   // 去掉「第一章」这种标题行
    }
    if (!units.length) return null;
    var idx = -1;
    if (active) {
      for (var k = 0; k < units.length; k++) {
        if (units[k] === active || units[k].contains(active) || active.contains(units[k])) { idx = k; break; }
      }
    }
    // 页面到底有没有给小节标任务点？没标就别乱跳
    var marked = false;
    for (var m = 0; m < units.length; m++) {
      if (units[m].querySelector('input.jobUnfinishCount, .catalog_points_yi')) { marked = true; break; }
    }
    return { units: units, i: idx, marked: marked };
  }

  function unitName(u) {
    if (!u) return '';
    var n = u.querySelector('.posCatalog_name');
    return ((n && (n.getAttribute('title') || n.textContent)) || u.getAttribute('title') || '').trim();
  }

  /**
   * 学习通会在已完成的小节上挂对勾图标。
   * 有它就不用再进去 —— 但这只用来"排除"，不能单独用来"确认有任务"。
   */
  function looksDone(unit) {
    if (!unit) return false;
    try {
      if (unit.querySelector('.icon_Completed, .icon_completed, [class*="ompleted"], [class*="inished"]')) return true;
    } catch (e) { }
    var t = '';
    try { t = unit.getAttribute('title') || ''; } catch (e2) { t = ''; }
    return /已完成|已学完|已通过/.test(t);
  }

  /**
   * 这一节要不要做。
   * 学习通只在「还有没做完的任务点」的小节上挂标记：
   *   <input class="jobUnfinishCount" value="4">   ← 还剩 4 个
   *   <span class="catalog_points_yi">4个待完成任务点</span>
   * 干净的小节两个都没有。
   */
  function needDo(unit) {
    if (!unit) return false;
    if (looksDone(unit)) return false;
    var cnt = unit.querySelector('input.jobUnfinishCount');
    if (cnt && Number(cnt.value) > 0) return true;
    var tip = unit.querySelector('.catalog_points_yi');
    if (tip && /待完成|未完成|未学/.test(tip.textContent || '')) return true;
    var tit = unit.getAttribute('title');
    if (tit && /待完成|未完成|未学/.test(tit)) return true;
    var inner = unit.querySelector('[title]');
    if (inner) {
      var t2 = inner.getAttribute('title');
      if (t2 && /待完成|未完成|未学/.test(t2)) return true;
    }
    return false;
  }

  function findNextBtn() {
    var sels = ['#prevNextFocusNext', '#right1', '.nextChapter', '.prev_next_next', '#prevNextFocus'];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (isVisible(el)) return el;
    }
    var cands = document.querySelectorAll('a, button, span');
    for (var j = 0; j < cands.length; j++) {
      var t = (cands[j].textContent || '').replace(/\s+/g, '');
      if (/^(下一节|下一章|下一个|下一讲)$/.test(t) && isVisible(cands[j]) && !inOwnPanel(cands[j])) return cands[j];
    }
    return null;
  }

  /**
   * 往下一个走。
   * 顺序：先按左侧目录往下找「有任务点的下一个」，走不通才点页面上的「下一节」。
   * 没有章节目录的页面（独立作业页/考试页）不自动跳，免得乱点。
   *
   * 挑节的规矩是「宁可多做一节，不可漏掉一节」：
   * 只有连续两个候选都明确没任务点时，才继续往后翻；第三个不管标记如何都进去看看。
   * 标记系统偶尔会延迟更新，按老阈值（8）一路跳下去就会把有任务的小节跳过去。
   */
  var skipMiss = 0;

  function goNext() {
    if (!document.querySelector('#coursetree')) {
      if (!warnedNoTree) {
        warnedNoTree = true;
        log('这一页没有章节目录 —— 不自动跳节');
      }
      return false;
    }
    var c = catalog();
    if (c && c.i >= 0) {
      for (var k = c.i + 1; k < c.units.length; k++) {
        var unit = c.units[k];

        if (SKIP_NO_TASK && c.marked && !needDo(unit) && skipMiss < 2) {
          skipMiss++;
          log('越过（没标任务点）：' + (unitName(unit) || '#' + k));
          continue;
        }

        var target = unit.querySelector('.posCatalog_name') || unit;
        if (clickEl(target)) {
          skipMiss = 0;
          log('点目录 →「' + unitName(unit) + '」');
          return true;
        }
        if (target !== unit && clickEl(unit)) {
          skipMiss = 0;
          log('点目录（父节点）→「' + unitName(unit) + '」');
          return true;
        }
      }
      log('目录后面没有要做的了');
    }
    var btn = findNextBtn();
    if (btn) {
      clickEl(btn);
      log('目录走不通，点页面「下一节」');
      return true;
    }
    log('没找到下一个（可能已是最后一节，或页面结构变了）');
    return false;
  }

  /* ==================== 12. 开关 ==================== */

  var OPT_KEY = 'xxt-quiz:opts';

  /**
   * 开关。默认：保存完就走，不等交卷。
   * waitSubmit 打开后才回到「等你交卷，交完才走」的老行为。
   */
  function loadOpts() {
    var d = {
      autoFill: true,
      autoSave: true,
      autoAsk: true,
      autoNext: true,
      waitSubmit: false   // false = 暂存完就跳下一节（默认）
    };
    try {
      var s = kvGet(OPT_KEY);
      if (!s) return d;
      var o = JSON.parse(s);
      for (var k in d) if (typeof o[k] === 'boolean') d[k] = o[k];
      return d;
    } catch (e) { return d; }
  }

  function saveOpts(o) {
    return kvSet(OPT_KEY, JSON.stringify(o));
  }

  /* ==================== 13. 运行状态 ==================== */

  var S = {
    running: true,
    bootTries: 0,
    curKey: '',
    enterTs: Date.now(),
    clickTs: 0,
    lastSig: '',
    // 确认阶段：一点动静都没有之后，还要往下推几屏才认定这页真做完了
    idleSince: 0,
    probeRound: 0,
    probeTs: 0,
    didWork: false,   // 这一节到底有没有干过活（用来记"疑似漏掉的小节"）
    msg: ''
  };

  // 做题状态机
  var QZ = {
    sig: '',          // 题目指纹（小节 + 题数 + 第一题 id）
    phase: 'none',    // none | wait | ready | asking | saved | done | gaveup
    data: null,       // { map, quiz, text, stats }
    err: '',
    letters: null,    // 待填的答案
    askStart: 0,
    readyAt: 0,       // 题目读出来、开始等答案的时刻
    saveStart: 0,
    tried: 0,
    lastTry: 0,
    fillRes: null,
    knownN: 0         // 上一次看到的题目数量
  };

  function quizReset(sig) {
    QZ.sig = sig || '';
    QZ.phase = 'none';
    QZ.data = null;
    QZ.err = '';
    QZ.letters = null;
    QZ.askStart = 0;
    QZ.readyAt = 0;
    QZ.saveStart = 0;
    QZ.tried = 0;
    QZ.lastTry = 0;
    QZ.fillRes = null;
    QZ.knownN = 0;
  }

  /**
   * 把"这一页我跳过了"记到本地，事后能查。
   * 挂着跑一整晚，最怕的就是静悄悄漏掉几节 —— 至少留个账。
   */
  function markSkip(reason) {
    try {
      var k = 'xxt-all:skipped';
      var arr = JSON.parse(kvGet(k) || '[]');
      arr.push({
        t: new Date().toISOString(),
        section: S.curKey || '',
        url: String(location.href || ''),
        reason: String(reason || '')
      });
      if (arr.length > 80) arr = arr.slice(arr.length - 80);
      kvSet(k, JSON.stringify(arr));
    } catch (e) { }
    log('记录跳过：' + reason);
  }

  function skippedList() {
    try { return JSON.parse(kvGet('xxt-all:skipped') || '[]'); } catch (e) { return []; }
  }

  function phaseName(p) {
    return {
      none: '待识别', wait: '等题目渲染', ready: '等答案', asking: 'AI 正在作答',
      saved: '已处理', done: '已完成', gaveup: '跳过'
    }[p] || p;
  }

  /* ==================== 14. 做题流程 ==================== */

  /**
   * 拼一行选项。
   * 学习通的 <li> 有时自己带「A 」前缀（有时序号在单独的 span 里），
   * 已经带了就不再重复加，否则面板上会出现「A. A 不变」这种。
   */
  function optLine(opt, idx, map) {
    var t = decodeText(opt, map);
    var lead = String.fromCharCode(65 + idx);
    var hasPrefix = new RegExp('^\\s*' + lead + '[\\s.、)）]').test(t);
    return '    ' + (hasPrefix ? '' : lead + '. ') + t;
  }

  function plainText(quiz, map) {
    var lines = [];
    for (var i = 0; i < quiz.length; i++) {
      var q = quiz[i];
      lines.push('[' + (i + 1) + '] ' + decodeText(q.title, map));
      for (var j = 0; j < q.opts.length; j++) {
        lines.push(optLine(q.opts[j], j, map));
      }
      if (q.kind === 'blank' || q.kind === 'short') {
        lines.push('    （' + (q.inputs && q.inputs.length ? q.inputs.length : 1) + ' 个空）');
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * 读题目 + 还原加密题干。
   * 注意：没有加密字体不算失败 —— 有些测验题本来就是明文，照样能做。
   */
  function buildQuizData() {
    var docs = collectDocs();
    var quiz = collectQuiz(docs);
    if (!quiz.length) return { ok: false, err: '还没读到题目（等渲染）' };

    var b64 = findFontB64(docs);
    if (!b64) {
      return {
        ok: true,
        data: { map: new Map(), quiz: quiz, text: plainText(quiz, null), stats: '明文题目 ' + quiz.length + ' 道' }
      };
    }

    var bytes;
    try { bytes = b64ToBytes(b64); } catch (e) { return { ok: false, err: '字体数据解不开：' + e.message }; }

    var built;
    try { built = buildDecodeMap(bytes); } catch (e2) { return { ok: false, err: '字体解析失败：' + e2.message }; }
    if (!built.hit) {
      return {
        ok: true,
        data: {
          map: new Map(), quiz: quiz, text: plainText(quiz, null),
          stats: '字体 ' + built.total + ' 个字形全没对上表 · 题目 ' + quiz.length + ' 道'
        }
      };
    }

    return {
      ok: true,
      data: {
        map: built.map,
        quiz: quiz,
        text: plainText(quiz, built.map),
        stats: '字形 ' + built.hit + '/' + built.total + ' 已还原 · 题目 ' + quiz.length + ' 道'
      }
    };
  }

  // 真正去勾选。只跑一次，靠 QZ.phase 挡住重复点击。
  function doFillNow(letters) {
    if (!QZ.data) return { filled: 0, total: 0, missed: [], err: '题目还没读出来' };
    var opts = loadOpts();
    var res = fillAnswers(QZ.data.quiz, letters);
    QZ.fillRes = res;

    if (res.filled !== res.total) {
      QZ.phase = 'ready';
      QZ.letters = null;
      QZ.readyAt = Date.now();     // 重新开始算「等答案」的时间
      QZ.err = '第 ' + res.missed.join('、') + ' 题没勾上，请核对';
      return res;
    }

    QZ.letters = null;
    QZ.saveStart = Date.now();

    if (!opts.autoSave) {
      QZ.phase = 'saved';
      QZ.err = '自动暂存关着 —— 请自己点页面上的保存';
      return res;
    }

    // 找不到暂存按钮也算「填完了」：照样往下走，只是留句话在面板上
    var nm = clickSave(null);
    QZ.phase = 'saved';
    if (!nm) QZ.err = '没找到「暂存/保存」按钮，答案已勾好 —— 先记为已完成';
    else QZ.err = '';
    return res;
  }

  function doAsk(manual) {
    var cfg = loadApiCfg();
    if (!cfg.url) {
      QZ.err = '还没配 AI 接口 —— 展开下面「AI 设置」填一下，或自己填答案';
      return false;
    }
    if (!QZ.data) {
      QZ.err = '题目还没读出来';
      return false;
    }
    QZ.phase = 'asking';
    QZ.askStart = Date.now();
    QZ.err = manual ? '手动重问 AI...' : '';
    askAI(cfg, QZ.data, function (err, letters) {
      // AI 回来之前可能已经翻到别的章节了，这份结果就作废
      if (QZ.phase !== 'asking' || !QZ.data) return;
      if (err) {
        QZ.phase = 'ready';
        QZ.err = 'AI 失败：' + err.message;
        updatePanel();
        return;
      }
      if (letters.length !== QZ.data.quiz.length) {
        QZ.phase = 'ready';
        QZ.err = 'AI 给了 ' + letters.length + ' 个答案，题目 ' + QZ.data.quiz.length + ' 道，对不上 —— 请自己核对';
        updatePanel();
        return;
      }
      QZ.letters = letters;
      QZ.phase = 'ready';
      QZ.err = '';
      updatePanel();
    });
    return true;
  }

  /**
   * 每轮问一次：这一页的测验处理到哪了。
   * 返回 'none'（这页没题）/ 'busy'（还没做完）/ 'done'（可以走了）
   */
  function quizTick() {
    var c = countQuestions();
    if (!c.n) {
      if (QZ.sig) quizReset('');
      return 'none';
    }

    // 指纹必须带小节：不同章节的测验常常都是 data="1" 开头的十几道题，
    // 只按"题数 + 第一题 id"认的话，做完前一节跳到下一节测验时指纹没变，
    // 状态机还停在 done —— 新的一页题就这么漏了。
    var sig = sectionKey() + '|' + c.n + '|' + c.first;
    if (sig !== QZ.sig) {
      quizReset(sig);
      QZ.knownN = c.n;
      log('发现测验：' + c.n + ' 道题');
    }

    if (QZ.phase === 'done' || QZ.phase === 'gaveup') return 'done';

    // 已经交卷了 → 这页的活干完了
    if (isQuizSubmitted()) {
      QZ.phase = 'done';
      log('这一页的测验已提交，可以走了');
      return 'done';
    }

    if (QZ.phase === 'none' || QZ.phase === 'wait') {
      var now = Date.now();
      if (now - QZ.lastTry < 1500) return 'busy';
      QZ.lastTry = now;
      QZ.tried++;
      var r = buildQuizData();
      if (!r.ok) {
        QZ.err = r.err;
        QZ.phase = QZ.tried > 30 ? 'gaveup' : 'wait';
        if (QZ.phase === 'gaveup') {
          QZ.err = '等了 45 秒还是读不出题目（' + r.err + '），先跳过这一页';
          markSkip('测验页读不出题目：' + r.err);
          return 'done';
        }
        return 'busy';
      }
      QZ.data = r.data;
      QZ.phase = 'ready';
      QZ.readyAt = Date.now();
      QZ.err = '';
      ensurePanel();
      log('题目读出来了：' + r.data.stats);

      var opts = loadOpts();
      if (opts.autoAsk) doAsk(false);
      return 'busy';
    }

    if (QZ.phase === 'asking') {
      if (Date.now() - QZ.askStart > 95000) {
        QZ.phase = 'ready';
        QZ.err = 'AI 超过 95 秒没回，先停手';
      }
      return 'busy';
    }

    if (QZ.phase === 'ready') {
      if (!QZ.letters) {
        // 题目早读出来了，可答案一直没来（没配 AI、AI 挂了、人也不在）。
        // 挂着跑一整晚最怕这种，等够时间就先跳过这一页。
        if (!QZ.readyAt) QZ.readyAt = Date.now();
        if (Date.now() - QZ.readyAt > QUIZ_IDLE_MS) {
          QZ.phase = 'gaveup';
          QZ.err = '题目读出来了但没有答案，等了 ' + Math.round(QUIZ_IDLE_MS / 1000) + ' 秒，先跳过这一页';
          markSkip('测验 ' + countQuestions().n + ' 道题没有答案，超时跳过');
          return 'done';
        }
        return 'busy';       // 等人填 / 等 AI
      }
      var opts2 = loadOpts();
      if (!opts2.autoFill) {
        // 用户关掉了自动勾选：答案摆出来，让他自己点「填入」
        QZ.err = '自动勾选关着 —— 答案已经出好，点「填入」';
        QZ.phase = 'ready';
        QZ.letters = null;
        QZ.readyAt = Date.now();
        return 'busy';
      }
      doFillNow(QZ.letters);
      return 'busy';
    }

    /**
     * 已经填好、暂存也点过了。默认行为：停一下就走，不等交卷。
     * 打开「等交卷再走」才回到老行为（见到交卷信号才走，最多等 5 分钟）。
     */
    if (QZ.phase === 'saved') {
      var o = loadOpts();

      if (!o.autoNext) {
        QZ.err = (o.waitSubmit ? '答案已暂存 —— 点完提交自己手动去下一节'
          : '答案已保存 —— 自己点提交，手动去下一节');
        return 'busy';
      }

      if (o.waitSubmit) {
        if (Date.now() - QZ.saveStart > QUIZ_WAIT_MS) {
          QZ.phase = 'gaveup';
          QZ.err = '等提交等了 ' + Math.round(QUIZ_WAIT_MS / 60000) + ' 分钟还没等到，先跳过这一页';
          markSkip('等交卷超时：' + (QZ.data ? QZ.data.stats : ''));
          return 'done';
        }
        QZ.err = '答案已暂存 —— 等你点提交，提交后我自动去下一节';
        return 'busy';
      }

      // 默认：保存完停 1.5 秒就跳。自动暂存关着的话多等 10 秒，给人点保存的时间。
      var need = o.autoSave ? QUIZ_COOLDOWN : QUIZ_SLOW;
      var waited = Date.now() - QZ.saveStart;
      if (waited < need) {
        if (!QZ.err) QZ.err = o.autoSave ? '已保存，准备去下一节...' : '答案已勾好 —— 请点保存，10 秒后去下一节';
        return 'busy';
      }
      QZ.phase = 'done';
      if (!QZ.err) QZ.err = '答案已保存，接着去下一节';
      log('测验处理完了（' + QZ.err + '），去下一节');
      return 'done';
    }

    return 'busy';
  }

  /* ==================== 15. 面板 ==================== */

  var BTN_CSS = 'background:#2d6cdf;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer;font:12px inherit;';
  var BTN2_CSS = 'background:#3a3d44;color:#dcdcdc;border:0;border-radius:4px;padding:4px 10px;cursor:pointer;font:12px inherit;';
  var INPUT_CSS = 'width:100%;margin:4px 0;background:#111317;color:#e8e8e8;border:1px solid #3a3d44;' +
    'border-radius:4px;padding:4px 8px;font:12px Consolas,monospace;outline:none;box-sizing:border-box;';

  var UI = { host: null, dot: null, sec: null, task: null, bodyEl: null, ta: null, inp: null, status: null, checks: {}, expanded: false };

  function setText(el, t) {
    if (el && el.textContent !== t) el.textContent = t;
  }

  function mkCheckRow(o, key, text) {
    var wrap = mk('label', 'display:flex;align-items:center;gap:5px;cursor:pointer;color:#9aa0a6;font-size:12px;');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!o[key];
    cb.onchange = function () {
      var cur = loadOpts();
      cur[key] = cb.checked;
      saveOpts(cur);
    };
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(text));
    UI.checks[key] = cb;
    return wrap;
  }

  function ensurePanel() {
    if (UI.host && document.getElementById(PANEL_ID)) return UI.host;
    if (!document.body) return null;
    var old = document.getElementById(PANEL_ID);
    if (old) old.parentNode.removeChild(old);

    var host = mk('div', 'position:fixed;top:10px;right:10px;width:470px;max-height:88vh;z-index:2147483647;' +
      'background:#1b1d21;color:#e8e8e8;border:1px solid #3a3d44;border-radius:8px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.55);font:12.5px/1.6 Consolas,Menlo,monospace;' +
      'display:flex;flex-direction:column;overflow:hidden;');
    host.id = PANEL_ID;

    // 标题条
    var bar = mk('div', 'display:flex;align-items:center;gap:7px;padding:7px 9px;border-bottom:1px solid #3a3d44;background:#20232a;');
    UI.dot = mk('span', 'width:8px;height:8px;border-radius:50%;background:#3fb950;flex:none;');
    bar.appendChild(UI.dot);
    bar.appendChild(mk('div', 'flex:1;font-weight:700;color:#7fd1ff;', '学习通全自动 v' + VERSION));

    var btnStop = mk('button', BTN2_CSS, '停止');
    btnStop.onclick = function () {
      S.running = !S.running;
      btnStop.textContent = S.running ? '停止' : '继续';
      btnStop.style.background = S.running ? '#3a3d44' : '#2ea043';
      updatePanel();
    };
    bar.appendChild(btnStop);

    var btnFold = mk('button', BTN2_CSS, '▸');
    btnFold.onclick = function () {
      UI.expanded = !UI.expanded;
      UI.bodyEl.style.display = UI.expanded ? 'flex' : 'none';
      btnFold.textContent = UI.expanded ? '▾' : '▸';
    };
    UI.foldBtn = btnFold;
    bar.appendChild(btnFold);

    var btnClose = mk('button', 'background:transparent;color:#aaa;border:0;font-size:17px;cursor:pointer;line-height:1;padding:0 2px;', '×');
    btnClose.onclick = function () { host.parentNode && host.parentNode.removeChild(host); UI.host = null; };
    bar.appendChild(btnClose);
    host.appendChild(bar);

    // 状态两条
    UI.sec = mk('div', 'padding:5px 10px 0;color:#cfd3d8;');
    UI.task = mk('div', 'padding:2px 10px 6px;color:#9aa0a6;font-size:12px;border-bottom:1px solid #2c2f35;');
    host.appendChild(UI.sec);
    host.appendChild(UI.task);

    // 折叠区
    var body = mk('div', 'display:none;flex-direction:column;flex:1;min-height:0;');
    UI.bodyEl = body;

    body.appendChild(mk('div', 'padding:6px 10px 3px;color:#7fd1ff;font-size:12px;', '题目明文'));
    var ta = mk('textarea', 'height:190px;margin:0 10px;background:#111317;color:#d6ffd6;border:1px solid #2c2f35;' +
      'border-radius:4px;padding:7px;font:12px/1.65 Consolas,Menlo,monospace;resize:vertical;outline:none;box-sizing:border-box;');
    ta.readOnly = true;
    UI.ta = ta;
    body.appendChild(ta);

    var row = mk('div', 'display:flex;gap:5px;padding:7px 10px 0;');
    var inp = mk('input', 'flex:1;background:#111317;color:#e8e8e8;border:1px solid #3a3d44;border-radius:4px;' +
      'padding:5px 8px;font:12.5px Consolas,monospace;outline:none;box-sizing:border-box;');
    inp.placeholder = '答案：D,B,A 或一行一个';
    UI.inp = inp;
    row.appendChild(inp);

    var btnFill = mk('button', BTN_CSS, '填入');
    btnFill.onclick = function () {
      if (!QZ.data) { QZ.err = '这一页还没读到题目'; updatePanel(); return; }
      var letters = parseAnswers(inp.value, QZ.data.quiz);
      if (!letters.length) { QZ.err = '先填答案'; updatePanel(); return; }
      if (letters.length !== QZ.data.quiz.length) {
        QZ.err = '读到 ' + letters.length + ' 个答案，题目有 ' + QZ.data.quiz.length + ' 道，对不上';
        updatePanel();
        return;
      }
      var res = doFillNow(letters);
      QZ.err = res.filled === res.total
        ? '已勾选 ' + res.filled + ' 题' + (findSaveBtn() ? '' : '（没找到暂存按钮）')
        : '第 ' + res.missed.join('、') + ' 题没勾上';
      updatePanel();
    };
    row.appendChild(btnFill);

    var btnAI = mk('button', 'background:#2ea043;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer;font:12px inherit;', '问 AI');
    btnAI.onclick = function () { doAsk(true); updatePanel(); };
    row.appendChild(btnAI);

    var btnSave = mk('button', BTN2_CSS, '暂存');
    btnSave.onclick = function () {
      var nm = clickSave(UI.status);
      QZ.err = nm ? '已点「' + nm + '」' : '没找到「暂存/保存」按钮';
      updatePanel();
    };
    row.appendChild(btnSave);
    body.appendChild(row);

    // 开关
    var o = loadOpts();
    var ck = mk('div', 'display:flex;flex-wrap:wrap;gap:4px 14px;padding:7px 10px 2px;');
    ck.appendChild(mkCheckRow(o, 'autoAsk', '自动问 AI'));
    ck.appendChild(mkCheckRow(o, 'autoFill', '自动勾选'));
    ck.appendChild(mkCheckRow(o, 'autoSave', '自动暂存'));
    ck.appendChild(mkCheckRow(o, 'autoNext', '清完自动去下一节'));
    ck.appendChild(mkCheckRow(o, 'waitSubmit', '等交卷再走'));
    body.appendChild(ck);
    body.appendChild(mk('div', 'padding:0 10px 2px;color:#6b7078;font-size:11px;',
      '默认：保存完就跳下一节（存不上也跳）。勾上「等交卷再走」才等你点提交。'));

    // 状态行
    var st = mk('div', 'padding:4px 10px 7px;color:#8b9099;font-size:12px;min-height:16px;');
    UI.status = st;
    body.appendChild(st);

    // AI 设置
    var det = mk('details', 'padding:0 10px 8px;font-size:12px;color:#8b9099;');
    det.appendChild(mk('summary', 'cursor:pointer;color:#7fd1ff;', 'AI 设置'));
    var cfg = loadApiCfg();
    if (!cfg.url) det.open = true;    // 还没配过就自动摊开，省得找不到

    var urlIn = mk('input', INPUT_CSS);
    urlIn.placeholder = '接口地址，如 https://api.deepseek.com/chat/completions';
    urlIn.value = cfg.url || '';
    var keyIn = mk('input', INPUT_CSS);
    keyIn.placeholder = '密钥 sk-...（存在油猴存储里，不跟页面走）';
    keyIn.value = cfg.key || '';
    var modelIn = mk('input', INPUT_CSS);
    modelIn.placeholder = '模型名，如 deepseek-chat';
    modelIn.value = cfg.model || 'deepseek-chat';

    var hint = mk('div', 'flex:1;color:#6b7078;font-size:11px;text-align:right;white-space:nowrap;overflow:hidden;',
      '存到 ' + storageName());

    var row2 = mk('div', 'display:flex;gap:6px;align-items:center;margin-top:4px;');
    var saveBtn = mk('button', BTN_CSS, '保存设置');
    saveBtn.onclick = function () {
      var ok = saveApiCfg({ url: urlIn.value.trim(), key: keyIn.value.trim(), model: modelIn.value.trim() });
      saveBtn.textContent = ok ? '已保存' : '保存失败';
      hint.style.color = ok ? '#7ee787' : '#ff7b72';
      hint.textContent = ok ? ('已存到' + storageName()) : '保存失败 —— 看看油猴有没有给存储权限';
      setTimeout(function () {
        saveBtn.textContent = '保存设置';
        hint.style.color = '#6b7078';
        hint.textContent = '存到 ' + storageName();
      }, 3000);
    };

    var testBtn = mk('button', BTN2_CSS, '测试连接');
    testBtn.onclick = function () {
      var c = { url: urlIn.value.trim(), key: keyIn.value.trim(), model: modelIn.value.trim() };
      if (!c.url) {
        hint.textContent = '先填接口地址';
        hint.style.color = '#ffa657';
        return;
      }
      hint.textContent = '测试中...';
      hint.style.color = '#8b9099';
      testApi(c, function (err, model) {
        if (err) {
          hint.textContent = '✗ ' + err.message;
          hint.style.color = '#ff7b72';
        } else {
          hint.textContent = '✓ 通了（' + model + '）';
          hint.style.color = '#7ee787';
        }
      });
    };

    row2.appendChild(saveBtn);
    row2.appendChild(testBtn);
    row2.appendChild(hint);

    det.appendChild(urlIn);
    det.appendChild(keyIn);
    det.appendChild(modelIn);
    det.appendChild(row2);
    body.appendChild(det);

    body.appendChild(mk('div', 'padding:0 10px 9px;color:#6b7078;font-size:11px;',
      '本脚本不点提交 · 填完请自己确认后点页面上的提交按钮'));

    host.appendChild(body);
    document.body.appendChild(host);
    UI.host = host;
    return host;
  }

  function videoStats() {
    var vs = allVideos();
    var done = 0;
    for (var i = 0; i < vs.length; i++) {
      var k = keyOf(vs[i]);
      if (k ? (doneSigs.has(k) || isFinished(vs[i])) : isFinished(vs[i])) done++;
    }
    return { done: done, all: vs.length };
  }

  function updatePanel() {
    if (!UI.host) return;
    if (UI.dot) UI.dot.style.background = S.running ? '#3fb950' : '#d29922';

    setText(UI.sec, '章节：' + (S.curKey || '(未识别)'));

    var parts = [];
    var vst = videoStats();
    if (vst.all) parts.push('视频 ' + vst.done + '/' + vst.all);
    var c = countQuestions();
    if (c.n) parts.push('测验 ' + c.n + ' 题 · ' + phaseName(QZ.phase));
    if (lastScrollTs) parts.push('长图翻阅中');
    if (S.probeRound > 0 && S.idleSince) parts.push('确认中 ' + S.probeRound);
    if (!parts.length) parts.push('本页暂无任务点');
    var sk = skippedList().length;
    if (sk) parts.push('已记录跳过 ' + sk);
    setText(UI.task, '任务：' + parts.join(' · '));

    // 有题目就把面板摊开
    if (c.n && QZ.data && !UI.expanded) {
      UI.expanded = true;
      UI.bodyEl.style.display = 'flex';
      if (UI.foldBtn) UI.foldBtn.textContent = '▾';
    }
    if (QZ.data && UI.ta && UI.ta.value !== QZ.data.text) UI.ta.value = QZ.data.text;

    var line = '';
    if (!S.running) line = '已暂停';
    else if (QZ.err) line = QZ.err;
    else if (QZ.phase === 'asking') line = 'AI 正在作答...';
    else if (QZ.phase === 'saved') line = '答案已保存，准备去下一节';
    else if (QZ.phase === 'done') line = '这一页做完了';
    else line = '运行中 · 倍速 ' + RATE + 'x';
    setText(UI.status, line);

    var color = '#8b9099';
    if (!S.running) color = '#d29922';
    else if (QZ.err) color = /失败|对不上|没勾上|跳过/.test(QZ.err) ? '#ff7b72' : '#ffa657';
    else if (QZ.phase === 'saved' || QZ.phase === 'done') color = '#7ee787';
    UI.status.style.color = color;
  }

  /* ==================== 16. 主循环 ==================== */

  function playVideo(v) {
    S.didWork = true;
    var realKey = keyOf(v);
    var idx = allVideos().indexOf(v);
    var sig = realKey || ('el#' + idx);

    if (sig !== S.lastSig) {
      S.lastSig = sig;
      log('播：第 ' + (idx + 1) + ' 个视频，时长 ' + Math.round(Number(v.duration) || 0) + ' 秒');
    }

    // 校正倍速和静音（平台会把它们改回去）
    if (Math.abs((v.playbackRate || 1) - RATE) > 0.01) {
      try { v.playbackRate = RATE; } catch (e) { }
    }
    if (!v.muted) {
      try { v.muted = true; } catch (e) { }
    }

    // 已经播完的，记进台账就不管它了
    if (isFinished(v)) {
      if (realKey) doneSigs.add(realKey); else blocked.add(v);
      log('这一个播完了（' + Math.round(Number(v.duration) || 0) + ' 秒）');
      return;                       // ← 关键：绝不往下走到 play()
    }

    // 在播就不打扰
    if (!v.paused) {
      stuckTry.delete(sig);
      return;
    }

    // 停住了：没开始过的先滚过去点一下，再拉起来
    var n = (stuckTry.get(sig) || 0) + 1;
    stuckTry.set(sig, n);

    if (n > STUCK_LIMIT) {
      if (realKey) doneSigs.add(realKey); else blocked.add(v);
      log('这个视频试了 ' + STUCK_LIMIT + ' 次都没播起来，先跳过它');
      markSkip('视频拉不起来（试了 ' + STUCK_LIMIT + ' 次）');
      return;
    }

    var cur = Number(v.currentTime) || 0;
    if (cur === 0) {
      try { v.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { }
      if (n % 3 === 1) {
        var how = poke(v);
        if (how) log('点了播放（' + how + '）');
      }
    }
    safePlay(v);
  }

  function updateSection() {
    var c = catalog();
    var key = c && c.i >= 0 ? unitName(c.units[c.i]) : '';
    if (key !== S.curKey) {
      S.curKey = key;
      S.enterTs = Date.now();
      S.clickTs = 0;
      S.idleSince = 0;
      S.probeRound = 0;
      S.probeTs = 0;
      S.didWork = false;
      S.lastSig = '';
      lastScrollTs = 0;
      _boxCache = null;      // 换了小节，前面的扫描结果作废
      _scrollCache = null;
      blocked.clear();
      stuckTry.clear();
      quizReset('');
      if (UI.ta) UI.ta.value = '';
      log('进入：' + (key || '(未识别)'));
    }
    return c;
  }

  /**
   * 测验页、作业页天生加载慢（iframe + 加密字体 + 几十道题），多给一倍耐心。
   * 不然刚进去还是白屏，脚本就当"空页面"跳走了 —— 漏题最典型的一种。
   */
  function emptyWaitMs() {
    var u = '';
    try { u = String(location.href || ''); } catch (e) { u = ''; }
    if (/work|quiz|exam|homework|test/i.test(u)) return EMPTY_WAIT * 2;
    return EMPTY_WAIT;
  }

  /**
   * 每轮把三类任务都推一把 —— 谁也不挡谁。
   *
   * 老写法是「先看完所有视频，再看长图，最后做题」，中间任何一类卡住
   * （视频起不来、长图没认出来、测验在等答案），后面的就永远轮不到。
   * 判定还都依赖"这一轮什么都没发生"，一个环节误判，整页就被当成做完了 —— 漏任务都是这么来的。
   */
  function pumpAll() {
    var busy = false;

    // 视频：静音在后台播，不耽误别的
    var v = pickVideo();
    if (v) { playVideo(v); busy = true; }

    // 长图：有没翻到底的就翻
    if (scrollLong()) { S.didWork = true; busy = true; }

    // 测验：推状态机
    var q = quizTick();
    if (q === 'busy') busy = true;

    return { busy: busy, quiz: q, video: !!v };
  }

  function tick() {
    if (!S.running) { updatePanel(); return; }

    var c = updateSection();

    // 1. 这一节本身没标任务点 → 不用做，直接往下找
    if (SKIP_NO_TASK && c && c.marked && c.i >= 0 && !needDo(c.units[c.i])) {
      if (Date.now() - S.clickTs > 2500) {
        log('当前这节没标任务点，不用做');
        if (goNext()) S.clickTs = Date.now();
      }
      updatePanel();
      return;
    }

    // 2. 三类任务一起推，谁有活谁干
    if (pumpAll().busy) {
      S.idleSince = 0;
      S.probeRound = 0;
      updatePanel();
      return;
    }

    // 3. 一点动静都没有了 —— 先别走。往下推几屏，把懒加载的视频/长图/题目逼出来
    if (!S.idleSince) {
      S.idleSince = Date.now();
      S.probeRound = 0;
      S.probeTs = 0;
    }

    var idle = Date.now() - S.idleSince;
    var waitFor = emptyWaitMs();

    if (idle < waitFor) {
      if (S.probeRound < SCAN_ROUNDS && Date.now() - S.probeTs > PROBE_GAP) {
        S.probeTs = Date.now();
        S.probeRound++;
        var moved = scrollEverything();
        if (moved) log('确认阶段第 ' + S.probeRound + ' 轮：往下推了 ' + moved + ' 处');
        // 推完立刻再问一遍：冒出视频/长图/题目就回去接着干
        if (pumpAll().busy) {
          S.idleSince = 0;
          S.probeRound = 0;
          updatePanel();
          return;
        }
        // 已经哪儿都滚不动了，而且推过几轮 —— 不用把剩下的时间耗完
        if (!moved && S.probeRound >= 3) {
          log('哪里都推不动了，这一页确实没别的任务');
          S.idleSince = Date.now() - waitFor;
        }
      }
      updatePanel();
      return;
    }

    // 4. 确认过真的没活了 → 去下一个有任务点的小节
    if (Date.now() - S.clickTs > GO_COOLDOWN) {
      var closed = closePopups();
      if (closed) log('关掉挡住按钮的浮层：' + closed);
      if (goNext()) S.clickTs = Date.now();
    }
    updatePanel();
  }

  /* ==================== 17. 启动 ==================== */

  var loopTimer = null;
  var bootTimer = null;
  var warnedNoTree = false;

  function start() {
    S.running = true;
    migrateStorage();
    ensurePanel();
    S.enterTs = Date.now();
    S.clickTs = 0;
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(tick, TICK);
    tick();
    log('v' + VERSION + ' 开跑 · 倍速 ' + RATE + 'x · 判定容差 ' + TOL.toFixed(1) + ' 秒');
  }

  function stop() {
    S.running = false;
    clearInterval(bootTimer);
    clearInterval(loopTimer);
    loopTimer = null;
    updatePanel();
    log('已停止');
  }

  bootTimer = setInterval(function () {
    var hasTree = !!document.querySelector('#coursetree');
    var hasQuiz = countQuestions().n > 0;
    if (!hasTree && !hasQuiz) {
      if (++S.bootTries > 40) {
        clearInterval(bootTimer);
        ensurePanel();
        updatePanel();
        log('等了 20 秒还没看到章节目录或题目 —— 确认一下是不是在课程页/测验页');
      }
      return;
    }
    clearInterval(bootTimer);
    start();
  }, 500);

  var PUB = PAGE;

  PUB.xxt = {
    version: VERSION,
    stop: stop,
    start: start,
    tick: tick,
    next: goNext,
    videos: videoStats,
    show: function () {
      ensurePanel();
      if (UI.bodyEl) { UI.bodyEl.style.display = 'flex'; UI.expanded = true; }
      updatePanel();
      return UI.host;
    },
    state: function () {
      return {
        version: VERSION,
        running: S.running,
        section: S.curKey,
        videos: videoStats(),
        quizPhase: QZ.phase,
        quizStats: QZ.data ? QZ.data.stats : '',
        err: QZ.err,
        probeRound: S.probeRound,
        idleMs: S.idleSince ? Date.now() - S.idleSince : 0,
        didWork: S.didWork,
        skipped: skippedList().length
      };
    },
    // 这一页到底还剩什么任务 —— 排查"漏了"的时候先看这个
    tasks: function () {
      var vs = allVideos();
      var rows = [];
      for (var i = 0; i < vs.length; i++) {
        var k = keyOf(vs[i]);
        rows.push({
          n: i + 1,
          key: k,
          dur: Math.round(Number(vs[i].duration) || 0),
          cur: Math.round(Number(vs[i].currentTime) || 0),
          ended: !!vs[i].ended,
          done: !!(k && doneSigs.has(k))
        });
      }
      return {
        videos: rows,
        imgBoxes: findScrollBoxes().length,
        scrollers: findScrollers().length,
        questions: countQuestions().n
      };
    },
    // 回头查账：哪些小节被跳过了、为什么
    skipped: skippedList,
    clearSkipped: function () {
      kvDel('xxt-all:skipped');
    },
    // 倍速：xxt.rate(2) 设成 2 倍，xxt.rate() 看现在多少。会记在本机
    rate: function (v) {
      if (v == null) return RATE;
      var n = Number(v);
      if (!(n > 0 && n <= 4)) return RATE;
      RATE = n;
      TOL = Math.max(0.8, RATE + 0.3);
      kvSet('xxt-all:rate', String(n));
      log('倍速改成 ' + n + 'x');
      return RATE;
    },
    // AI 配置：xxt.cfg() 看现在存的什么，xxt.cfg({url,key,model}) 写进去
    cfg: function (c) {
      if (!c) return loadApiCfg();
      saveApiCfg({ url: c.url || '', key: c.key || '', model: c.model || 'deepseek-chat' });
      return loadApiCfg();
    },
    // 存储体检：配置到底存在哪、会不会丢
    storage: function () {
      return {
        backend: storageName(),
        hasGM: hasGM(),
        api: !!loadApiCfg().url,
        migrated: _migrated
      };
    },
    testApi: testApi,
    quiz: function () { return QZ; },
    decode: buildQuizData,
    fill: fillAnswers,
    parse: parseAnswers,
    save: clickSave,
    saved: doneSigs,
    // 下面几个是给测试和排查用的底层件
    md5: md5hex,
    decodeText: decodeText,
    findSave: findSaveBtn,
    findFont: function () { return findFontB64(collectDocs()); },
    glyphTableSize: function () { return lookup().size; }
  };
})();
