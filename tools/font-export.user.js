// ==UserScript==
// @name         学习通 · 字体导出（解码用）
// @namespace    xxt-font
// @version      1.0
// @description  把加密题干的字体和题干原文导出来。只读，不提交。
// @match        *://*.chaoxing.com/*
// @match        *://*.chaoxing.cn/*
// @match        *://*.edu.cn/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/* eslint-disable no-var, prefer-const, no-eq-null */
(function () {
  'use strict';

  var VERSION = '1.0';

  if (window.__XXT_FONT_EXPORT__) return;

  var CFG = (typeof window !== 'undefined' && window.__XXT_FONT_EXPORT_CFG__) || {};
  var MAX_WAIT = CFG.maxWait || 14;
  var WAIT_STEP = CFG.waitStep || 1500;
  var FIRST_DELAY = CFG.firstDelay || 1200;
  var PANEL_ID = 'xxt-font-panel';

  var log = [];

  function say(s) {
    log.push(s);
    try {
      if (window.__XXT_FONT_LOG__) window.__XXT_FONT_LOG__.push(s);
      else window.__XXT_FONT_LOG__ = [s];
    } catch (e) {}
  }

  // ---------- 跨 iframe 收文档 ----------
  function collectDocs() {
    var out = [];
    var seen = [];

    function walk(doc, depth, src) {
      if (!doc || seen.indexOf(doc) >= 0) return;
      seen.push(doc);
      out.push({ doc: doc, depth: depth, src: src || '' });

      var frames;
      try {
        frames = doc.querySelectorAll('iframe, frame');
      } catch (e) {
        return;
      }
      for (var i = 0; i < frames.length; i++) {
        var sub = null;
        try {
          sub = frames[i].contentDocument;
        } catch (e) {
          sub = null;
        }
        if (sub) {
          walk(sub, depth + 1, frames[i].src || '');
        } else {
          var w = frames[i].src || frames[i].id || '';
          say('  · 跨域不可读 [' + (frames[i].id || '无名') + '] ' + short(w));
        }
      }
    }

    walk(document, 0, location.href);
    return out;
  }

  function short(s) {
    s = String(s || '');
    return s.length > 90 ? s.slice(0, 90) + '…' : s;
  }

  // ---------- 找字体 ----------
  function findFonts(docs) {
    var found = [];
    var seenB64 = [];

    function pushFont(b64, from) {
      var clean = String(b64).replace(/\s+/g, '');
      if (clean.length < 200) return;
      if (seenB64.indexOf(clean) >= 0) return;
      seenB64.push(clean);
      found.push({ b64: clean, from: from });
    }

    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i].doc;
      var tag = docs[i].depth + '@' + short(docs[i].src);

      var styles = null;
      try {
        styles = doc.querySelectorAll('style, script');
      } catch (e) {
        styles = null;
      }
      if (!styles) continue;

      for (var j = 0; j < styles.length; j++) {
        var el = styles[j];
        var txt = '';
        try {
          txt = el.textContent || '';
        } catch (e) {
          txt = '';
        }
        if (txt.indexOf('base64,') < 0) continue;

        var id = el.id || '';
        var isSecret = id === 'cxSecretStyle' || txt.indexOf('@font-face') >= 0;
        if (!isSecret) continue;

        var re = /base64,([A-Za-z0-9+/=\r\n ]+)/g;
        var m;
        var n = 0;
        while ((m = re.exec(txt)) !== null) {
          n++;
          pushFont(m[1], tag + (id ? ' #' + id : '') + ' 第' + n + '份');
        }
      }
    }

    return found;
  }

  // ---------- base64 → 字节 ----------
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  function magic(bytes) {
    if (!bytes || bytes.length < 4) return '空';
    var a = bytes[0], b = bytes[1], c = bytes[2], d = bytes[3];
    if (a === 0x00 && b === 0x01 && c === 0x00 && d === 0x00) return '0x00010000 TTF ✅';
    if (a === 0x74 && b === 0x72 && c === 0x75 && d === 0x65) return '"true" TTF ✅';
    if (a === 0x4f && b === 0x54 && c === 0x54 && d === 0x4f) return '"OTTO" CFF ✅';
    if (a === 0x74 && b === 0x74 && c === 0x63 && d === 0x66) return '"ttcf" 字体集 ✅';
    if (a === 0x77 && b === 0x4f && c === 0x46 && d === 0x46) return '"wOFF" 网页字体';
    if (a === 0x77 && b === 0x4f && c === 0x46 && d === 0x32) return '"wOF2" 网页字体';
    return '认不出（头 4 字节 ' + a + ',' + b + ',' + c + ',' + d + '）';
  }

  function sum32(bytes) {
    var h = 5381;
    for (var i = 0; i < bytes.length; i++) h = ((h * 33) ^ bytes[i]) >>> 0;
    return h.toString(16);
  }

  // ---------- 下载 ----------
  function downloadBytes(bytes, name) {
    try {
      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(function () {
        try {
          a.remove();
          URL.revokeObjectURL(url);
        } catch (e) {}
      }, 4000);
      return true;
    } catch (e) {
      say('❗ 下载失败：' + (e && e.message ? e.message : e));
      return false;
    }
  }

  // ---------- 收题干 ----------
  function collectQuizText(docs) {
    var lines = [];
    var idx = 0;

    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i].doc;
      var qs = null;
      try {
        qs = doc.querySelectorAll('div.singleQuesId');
      } catch (e) {
        qs = null;
      }
      if (!qs || !qs.length) continue;

      for (var j = 0; j < qs.length; j++) {
        idx++;
        var box = qs[j];
        var id = box.getAttribute('data') || box.getAttribute('data-id') || '?';
        var titleEl = box.querySelector('div.Zy_TItle');
        var title = titleEl ? titleEl.innerText || titleEl.textContent || '' : '';
        var opts = [];
        var lis = box.querySelectorAll('ul li');
        for (var k = 0; k < lis.length; k++) {
          var ot = lis[k].innerText || lis[k].textContent || '';
          opts.push(String(ot).replace(/\s+/g, ' ').trim());
        }
        lines.push('[' + idx + '] id=' + id);
        lines.push('  题干：' + String(title).replace(/\s+/g, ' ').trim());
        for (var o = 0; o < opts.length; o++) lines.push('  选项' + (o + 1) + '：' + opts[o]);
        lines.push('');
      }
      if (idx > 0) break;
    }

    return { text: lines.join('\n'), count: idx };
  }

  // ---------- 面板 ----------
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function mountPanel(report, fonts, quiz) {
    var old = document.getElementById(PANEL_ID);
    if (old) old.remove();

    var box = el(
      'div',
      'position:fixed;top:10px;right:10px;width:480px;max-height:86vh;overflow:auto;' +
        'background:#12161c;color:#dfe6ef;border:1px solid #2c3542;border-radius:10px;' +
        'font:12px/1.6 Consolas,Menlo,monospace;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,.5);'
    );
    box.id = PANEL_ID;

    var head = el(
      'div',
      'display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'padding:8px 10px;border-bottom:1px solid #2c3542;position:sticky;top:0;background:#12161c;'
    );
    head.appendChild(el('span', 'font-weight:700;color:#7fd1ff;', '字体导出 v' + VERSION));

    var btns = el('span', 'display:flex;gap:6px;');

    if (fonts.length) {
      var b1 = el(
        'button',
        'background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font:12px Consolas,monospace;',
        '下载字体'
      );
      b1.onclick = function () {
        for (var i = 0; i < fonts.length; i++) {
          try {
            var bytes = b64ToBytes(fonts[i].b64);
            downloadBytes(bytes, fonts.length === 1 ? 'cxsecret.ttf' : 'cxsecret-' + (i + 1) + '.ttf');
          } catch (e) {
            say('❗ 第' + (i + 1) + '份解码失败：' + e);
          }
        }
      };
      btns.appendChild(b1);
    }

    if (quiz.count) {
      var b2 = el(
        'button',
        'background:#2ea043;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font:12px Consolas,monospace;',
        '复制题干'
      );
      b2.onclick = function () {
        copyText(quiz.text, b2);
      };
      btns.appendChild(b2);
    }

    var b3 = el(
      'button',
      'background:#30363d;color:#dfe6ef;border:0;border-radius:6px;padding:4px 8px;cursor:pointer;font:12px Consolas,monospace;',
      '复制报告'
    );
    b3.onclick = function () {
      copyText(report, b3);
    };
    btns.appendChild(b3);

    var close = el(
      'button',
      'background:transparent;color:#8b98a8;border:0;font-size:16px;cursor:pointer;padding:0 4px;',
      '×'
    );
    close.onclick = function () {
      box.remove();
    };
    btns.appendChild(close);

    head.appendChild(btns);
    box.appendChild(head);

    var body = el('div', 'padding:8px 10px;');
    var pre = el('pre', 'margin:0 0 8px;white-space:pre-wrap;word-break:break-all;color:#b9c6d6;', report);
    body.appendChild(pre);

    if (quiz.count) {
      body.appendChild(el('div', 'color:#7fd1ff;margin:8px 0 4px;', '题干原文（乱码，点上面「复制题干」拿走）'));
      var ta1 = el('textarea', 'width:100%;height:150px;background:#0b0f14;color:#dfe6ef;border:1px solid #2c3542;border-radius:6px;font:11px/1.5 Consolas,monospace;padding:6px;box-sizing:border-box;');
      ta1.readOnly = true;
      ta1.value = quiz.text;
      body.appendChild(ta1);
    }

    body.appendChild(el('div', 'color:#8b98a8;margin-top:8px;', '只读 · 不提交任何东西 · 不发请求'));
    box.appendChild(body);

    (document.body || document.documentElement).appendChild(box);
    return box;
  }

  function copyText(text, btn) {
    function done(ok) {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () {
        btn.textContent = old;
      }, 1200);
    }

    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      if (ok) return done(true);
    } catch (e) {}

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            done(true);
          },
          function () {
            done(false);
          }
        );
        return;
      }
    } catch (e) {}

    done(false);
  }

  // ---------- 主流程 ----------
  function buildAll() {
    say('===== 字体导出 v' + VERSION + ' =====');
    say('地址：' + location.href);
    say('');

    var docs = collectDocs();
    say('--- 一、文档层 ---');
    say('可读 document 共 ' + docs.length + ' 层');
    say('');

    var fonts = findFonts(docs);
    say('--- 二、字体 ---');
    if (!fonts.length) {
      say('❌ 没找到任何内嵌字体（没有 #cxSecretStyle 或含 base64 的 @font-face）');
      say('   可能这页的题干没加密，或者题还没加载出来');
    } else {
      say('找到 ' + fonts.length + ' 份字体：');
      for (var i = 0; i < fonts.length; i++) {
        say('  #' + (i + 1) + ' 来自 ' + fonts[i].from);
        say('     base64 长度 ' + fonts[i].b64.length);
        var bytes = null;
        var err = '';
        try {
          bytes = b64ToBytes(fonts[i].b64);
        } catch (e) {
          err = String(e && e.message ? e.message : e);
        }
        if (bytes) {
          say('     字节数 ' + bytes.length + '（约 ' + (bytes.length / 1024).toFixed(1) + ' KB）');
          say('     文件头 ' + magic(bytes));
          say('     校验和 ' + sum32(bytes));
        } else {
          say('     解码失败：' + err);
        }
      }
    }
    say('');

    var quiz = collectQuizText(docs);
    say('--- 三、题干 ---');
    if (!quiz.count) {
      say('❌ 没读到题目（div.singleQuesId 为 0）');
      say('   要去点开章节测验再刷新');
    } else {
      say('读到 ' + quiz.count + ' 道题');
      say('已抓取原文，点「复制题干」拿走');
    }
    say('');

    say('--- 结论 ---');
    if (fonts.length && quiz.count) {
      say('✅ 字体和题干都拿到了');
      say('   ① 点「下载字体」→ 浏览器会存一个 cxsecret.ttf');
      say('   ② 点「复制题干」→ 粘到记事本存成 quiz-raw.txt');
      say('   ③ 把 ttf 和 txt 放到 workspace 文件夹，告诉我一声');
    } else if (fonts.length) {
      say('⚠️ 有字体但没题干 —— 先点开章节测验，等题出来再刷新');
    } else if (quiz.count) {
      say('⚠️ 有题干但没字体 —— 这页可能没加密，直接读文本就行');
    } else {
      say('❌ 两样都没有 —— 页面不对，去播放页点开任务点里的测验');
    }

    var report = log.join('\n');
    try {
      window.__xxtFontReport = report;
      window.__xxtFontList = fonts;
      window.__xxtQuizRaw = quiz.text;
    } catch (e) {}

    mountPanel(report, fonts, quiz);
    return report;
  }

  function count(sel) {
    var n = 0;
    var docs = collectDocs();
    for (var i = 0; i < docs.length; i++) {
      try {
        n += docs[i].doc.querySelectorAll(sel).length;
      } catch (e) {}
    }
    return n;
  }

  var tries = 0;

  function attempt() {
    tries++;
    var hasQ = count('div.singleQuesId') > 0;
    var hasF = count('style') > 0;

    if ((hasQ && hasF) || tries >= MAX_WAIT) {
      buildAll();
      return;
    }
    setTimeout(attempt, WAIT_STEP);
  }

  function start() {
    window.__XXT_FONT_EXPORT__ = { version: VERSION, run: buildAll };
    setTimeout(attempt, FIRST_DELAY);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})();
