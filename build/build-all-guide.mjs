// 生成「学习通全自动」安装向导页：一键复制 + 手动导入步骤
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'dist', 'xxt-auto.user.js');
const OUT = path.join(ROOT, 'dist', 'install.html');

const code = fs.readFileSync(SRC, 'utf8');
const bytes = Buffer.byteLength(code, 'utf8');
const kib = (bytes / 1024).toFixed(0);
const verMatch = /\/\/ @version\s+(\S+)/.exec(code);
const version = verMatch ? verMatch[1] : '?';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>学习通全自动 v${version} · 安装向导</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #16181d; color: #e6e6e6;
         font: 14px/1.8 "Microsoft YaHei", system-ui, sans-serif; }
  .wrap { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 23px; margin: 0 0 6px; color: #7fd1ff; }
  .sub { color: #8b9099; margin-bottom: 22px; font-size: 13.5px; }
  .card { background: #1d2026; border: 1px solid #2f333b; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 12px; color: #ffd479; }
  ol { margin: 0; padding-left: 22px; }
  li { margin: 8px 0; }
  code { background: #262a31; padding: 1px 6px; border-radius: 4px; color: #a8e6cf; font-family: Consolas, monospace; }
  b { color: #fff; }
  .btn { display: inline-block; background: #2d6cdf; color: #fff; border: 0; border-radius: 6px;
         padding: 10px 22px; font-size: 14.5px; cursor: pointer; font-family: inherit; }
  .btn:hover { background: #3d7cef; }
  .btn.ok { background: #2ea043; }
  .btn.bad { background: #a8412a; }
  textarea { width: 100%; height: 200px; margin-top: 14px; background: #101216; color: #9aa0a6;
             border: 1px solid #2f333b; border-radius: 8px; padding: 10px;
             font: 11.5px/1.5 Consolas, monospace; resize: vertical; }
  .tip { color: #8b9099; font-size: 12.5px; margin-top: 10px; }
  .grid { display: grid; grid-template-columns: 78px 1fr; gap: 6px 12px; font-size: 13px; }
  .grid dt { color: #7fd1ff; font-weight: 700; }
  .grid dd { margin: 0; color: #c9ced6; }
  .warn { background: #2a2118; border-color: #5a4520; }
  .warn h2 { color: #ffb454; }
  .danger { background: #2a1a18; border-color: #5a2620; }
  .danger h2 { color: #ff7b72; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #2f333b; }
  th { color: #8b9099; font-weight: 400; }
  td.k { color: #7fd1ff; white-space: nowrap; }
</style>
</head>
<body>
<div class="wrap">
  <h1>学习通全自动 v${version}</h1>
  <div class="sub">一个脚本管一页上的所有任务点：视频 · 长图 · 章节测验。全清完，才跳到下一个有任务点的小节。</div>

  <div class="card">
    <h2>① 复制脚本全文</h2>
    <button class="btn" id="copy">复制脚本全文（${kib} KB）</button>
    <div class="tip">点一下就好，不用手动选中。复制成功后按钮会变绿。</div>
    <textarea id="src" readonly>${esc(code)}</textarea>
  </div>

  <div class="card">
    <h2>② 装进 Tampermonkey</h2>
    <ol>
      <li>点浏览器右上角的 <b>Tampermonkey 图标</b> → 选「<b>管理面板</b>」</li>
      <li>点左上角 <b>+</b> 号（新建脚本）</li>
      <li>编辑器里有一段默认模板，<b>Ctrl+A 全选 → Delete 删掉</b></li>
      <li>回到这里点「复制脚本全文」，然后在编辑器里 <b>Ctrl+V 粘贴</b></li>
      <li><b>Ctrl+S 保存</b> → 关掉标签页 → <b>回到学习通刷新一次页面</b></li>
    </ol>
    <div class="tip">
      <b>装这一个就够了</b>：之前那个「刷视频」和「题干还原」两个脚本可以停用或删掉，功能都已经并进来了。
      管理面板里应该看到一条「<b>学习通全自动（刷课 + 做题）</b>」、版本 <code>${version}</code>、已启用。
    </div>
  </div>

  <div class="card">
    <h2>③ 它会怎么干活</h2>
    <ol>
      <li>进入一个有任务的小节，右上角出现面板</li>
      <li>把这一页的<b>视频、长图、测验三类任务同时推进</b>，谁有活谁干，不互相排队</li>
      <li>视频：1.5x、静音、播完自动接下一个（同页多个视频连着放）</li>
      <li>长图：从上往下一格一格翻到底</li>
      <li>测验：还原题干 → 问 AI → 自动勾选 → 自动点「暂存」</li>
      <li>三类都没动静了，<b>还要往下推 12 轮确认</b>，把懒加载的东西逼出来，才认定这页做完了</li>
      <li>然后跳到<b>下一个有任务点的小节</b>（没标记的越过，最多连跳 2 个）</li>
    </ol>
    <div class="tip">一页里同时挂着「视频 + 长图 + 测验」也能处理，不用你选顺序。</div>
  </div>

  <div class="card">
    <h2>④ 面板上的五个开关（状态自动记住）</h2>
    <table>
      <tr><th>开关</th><th>默认</th><th>作用</th></tr>
      <tr><td class="k">自动问 AI</td><td>开</td><td>读到题目就自己问一次，不用点按钮</td></tr>
      <tr><td class="k">自动勾选</td><td>开</td><td>AI 出答案后自动点选项 / 填输入框</td></tr>
      <tr><td class="k">自动暂存</td><td>开</td><td>全部填好后自动点页面上的「暂存 / 保存」</td></tr>
      <tr><td class="k">清完自动去下一节</td><td>开</td><td>这页任务全清完就跳下一节</td></tr>
      <tr><td class="k">等交卷再走</td><td><b>关</b></td><td>关＝保存完就跳；开＝停在原地等你点提交</td></tr>
    </table>
  </div>

  <div class="card">
    <h2>⑤ 填 AI 接口（填一次，关机重启都不丢）</h2>
    <div class="grid">
      <dt>接口地址</dt><dd><code>https://api.deepseek.com/chat/completions</code></dd>
      <dt>密钥</dt><dd><code>sk-</code> 开头的那串</dd>
      <dt>模型名</dt><dd><code>deepseek-chat</code></dd>
    </div>
    <ol style="margin-top:12px">
      <li>填完点「<b>保存设置</b>」，右边会显示「已存到油猴存储」</li>
      <li>再点「<b>测试连接</b>」当场验一下，通了会显示 <code>✓ 通了（模型名）</code></li>
    </ol>
    <div class="tip">
      任何 OpenAI 兼容接口都行（Kimi、通义、本地 ollama 都算），只要认 <code>chat/completions</code> 这套格式。
      <b>配置存在油猴扩展自己的存储里</b>，不放在页面里 —— 所以换子域、关浏览器、关机重启都还在。
    </div>
  </div>

  <div class="card warn">
    <h2>⑤b 为什么以前设置老丢</h2>
    <p style="margin:0 0 10px;color:#c9ced6;font-size:13px">
      旧版把配置写在网页自己的 localStorage 里，它有三个躲不开的毛病：
    </p>
    <ol>
      <li><b>按域名隔离</b>：<code>mooc1.chaoxing.com</code> 和 <code>mooc2-ans.chaoxing.com</code> 是两个不同的域，这边填的到那边读不到</li>
      <li><b>会被清</b>：Firefox 的隐私设置、清站点数据、网站自己发的 Clear-Site-Data 都能把它带走</li>
      <li><b>关机就没了</b>：浏览器清会话数据时它跟着走 —— 这就是"关一次机、配置就空"的原因</li>
    </ol>
    <div class="tip">
      现在两边都写一份，读的时候优先油猴那份。旧版本残留在页面里的配置会在第一次运行时<b>自动搬过去</b>，
      不用重新填。控制台敲 <code>xxt.storage()</code> 能看到当前用的是哪种存储。
    </div>
  </div>

  <div class="card danger">
    <h2>⑥ 关于「提交」：脚本永远不点，这一点没变</h2>
    <ol>
      <li>它只代点「<b>暂存 / 保存</b>」，提交那一步永远留给你</li>
      <li>按钮文字里只要带「提交」或「交卷」，脚本一律不碰</li>
      <li><b>默认走法</b>：填完 → 暂存 → 停 1.5 秒 → 去下一节。这一页就留在"已暂存未交卷"的状态</li>
      <li><b>想稳一点</b>：勾上「等交卷再走」，它就停在测验页等你点提交，见到交卷信号才走</li>
      <li>不管哪种走法，<b>答案都还在页面上</b>。回头从目录点回去，检查一下再点提交就行</li>
    </ol>
    <div class="tip" style="color:#ffb454">
      提醒：默认走法下，脚本跳到下一节时这一页还没交卷。如果你要的是"绝不漏交"，就勾上「等交卷再走」。
    </div>
  </div>

  <div class="card warn">
    <h2>⑦ 怀疑漏了？三条命令查清楚</h2>
    <ol>
      <li><code>xxt.tasks()</code> —— 这一页还剩什么：几个视频、各播到哪、几个长图滚动盒、几道题</li>
      <li><code>xxt.skipped()</code> —— 脚本记下的「跳过账」：哪一节、什么时间、为什么跳过</li>
      <li><code>xxt.state()</code> —— 当前状态：在确认第几轮、测验到哪一步、错误信息</li>
      <li><code>xxt.storage()</code> —— 配置存在哪、会不会丢</li>
      <li><code>xxt.cfg()</code> —— 现在存着的 AI 配置（密钥也会显示出来）</li>
    </ol>
    <div class="tip">
      脚本已经对「漏」做了针对性加固：视频台账按「小节+视频」记账（同一段视频挂多节不再互相顶）；
      长图认得出还在懒加载的图；测验页给双倍加载耐心；题卡上的"已作答"不会再被误判成整卷已交。
      真要有漏的，<code>xxt.skipped()</code> 里会留下记录，点回去手动补一下就行。
    </div>
  </div>

  <div class="card warn">
    <h2>⑧ 其他排查</h2>
    <ol>
      <li>面板没出现 → 确认地址是 <code>chaoxing.com</code> / <code>chaoxing.cn</code> / <code>edu.cn</code>，然后刷新</li>
      <li>题目是乱码 → 面板里应该已经是正常字了；还是乱码就把文字截图发我</li>
      <li>一直卡在某一页不走 → 看面板上的状态文字，它会写卡在哪一步</li>
      <li>题目读出来了却一直没答案（没配 AI）→ 等 3 分钟会自己跳过，不会整晚卡着</li>
      <li>想换倍速 → 控制台 <code>xxt.rate(2)</code>（1 到 4 之间，会记住）</li>
      <li>想停下 → 面板左上角「停止」，或者控制台敲 <code>xxt.stop()</code></li>
      <li>想手动跳一节 → 控制台敲 <code>xxt.next()</code></li>
    </ol>
  </div>
</div>

<script>
document.getElementById('copy').addEventListener('click', function () {
  var btn = this;
  var ta = document.getElementById('src');
  ta.removeAttribute('readonly');
  ta.select();
  ta.setSelectionRange(0, 999999);
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.setAttribute('readonly', 'readonly');
  if (!ok && navigator.clipboard) {
    navigator.clipboard.writeText(ta.value).then(done, fail);
    return;
  }
  ok ? done() : fail();
  function done() {
    btn.textContent = '✅ 已复制，去 Tampermonkey 粘贴';
    btn.className = 'btn ok';
    setTimeout(function () { btn.textContent = '复制脚本全文（${kib} KB）'; btn.className = 'btn'; }, 4000);
  }
  function fail() {
    btn.textContent = '复制失败 —— 请手动全选下面的框再按 Ctrl+C';
    btn.className = 'btn bad';
    setTimeout(function () { btn.textContent = '复制脚本全文（${kib} KB）'; btn.className = 'btn'; }, 4000);
  }
});
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('[build-all-guide] ' + path.relative(ROOT, OUT) + ' (' + Buffer.byteLength(html, 'utf8') + ' 字节)');
