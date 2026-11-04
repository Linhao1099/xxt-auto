// 合并版（v3.1）测试：视频 / 测验 / 混排 / 跳过空小节 / 保存完自动跳 / 绝不点提交
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = await readFile(path.join(root, 'src', 'xxt-all.js'), 'utf8');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (n, c, x = '') => {
    console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${!c && x ? ' -> ' + x : ''}`);
    if (!c) failed++;
};

function stubMedia(video) {
    const s = { paused: true, currentTime: 0, duration: 100, ended: false, rate: 1, muted: false, plays: 0 };
    Object.defineProperties(video, {
        paused: { get: () => s.paused, configurable: true },
        currentTime: { get: () => s.currentTime, set: (v) => { s.currentTime = v; }, configurable: true },
        duration: { get: () => s.duration, configurable: true },
        ended: { get: () => s.ended, configurable: true },
        playbackRate: { get: () => s.rate, set: (v) => { s.rate = v; }, configurable: true },
        muted: { get: () => s.muted, set: (v) => { s.muted = v; }, configurable: true },
        readyState: { get: () => 4, configurable: true },
    });
    video.play = () => { s.paused = false; s.plays++; return Promise.resolve(); };
    video.pause = () => { s.paused = true; return Promise.resolve(); };
    return s;
}

// jsdom 里所有元素尺寸都是 0，isVisible() 会一律判成不可见。这里给需要点到的元素造个假尺寸。
function makeVisible(el) {
    el.getBoundingClientRect = () => ({ width: 90, height: 26, top: 10, left: 10, right: 100, bottom: 36, x: 10, y: 10 });
}

// 测试里把「确认阶段」调快：真实是 12 轮 / 20 秒，测试里 1 轮 / 0.4 秒
const TEST_OPTS = { scanRounds: 1, emptyWait: 400, probeGap: 100 };

function boot(html, opts, gm, url) {
    const dom = new JSDOM(html, {
        url: url || 'https://mooc1.chaoxing.com/course/1',
        pretendToBeVisual: true,
        runScripts: 'dangerously',
    });
    const win = dom.window;
    win.__XXT_TEST__ = Object.assign({}, TEST_OPTS, opts || {});
    if (gm) gm.attach(win);
    return { dom, win };
}

/**
 * 模拟油猴的存储。
 * 它的特点是：挂在扩展上，不跟着页面 origin 走，也不跟着浏览器会话走 ——
 * 所以不同的 JSDOM（= 不同"浏览器会话"）共用同一份 data，就能模拟"关机重启"和"换域名"。
 */
function makeGMStore() {
    const data = {};
    return {
        data,
        attach(win) {
            win.GM_setValue = (k, v) => { data[k] = String(v); };
            win.GM_getValue = (k, d) => (k in data ? data[k] : d);
            win.GM_deleteValue = (k) => { delete data[k]; };
        }
    };
}

const PLAIN_PAGE = `<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 文档">1.1</span></div>
</li></ul></div>
</body></html>`;

function watchCatalog(win, clicks) {
    win.document.querySelectorAll('.posCatalog_name').forEach((el) => {
        el.addEventListener('click', () => clicks.push(el.getAttribute('title')));
    });
}

/* ================= 场景 A：纯视频，照旧要能播完切下一节 ================= */
console.log('== A. 纯视频：播完自动下一节 ==');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 视频A">1.1</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.2 视频B">1.2</span></div>
</li></ul></div>
<video id="v"></video>
<button id="prevNextFocusNext">下一节</button>
</body></html>`, { scanRounds: 1 });

    const media = stubMedia(win.document.getElementById('v'));
    const clicks = [];
    watchCatalog(win, clicks);
    let btnClicks = 0;
    win.document.getElementById('prevNextFocusNext').addEventListener('click', () => { btnClicks++; });

    win.eval(SRC);
    await wait(900);

    ok('挂到 window.xxt', typeof win.xxt === 'object' && win.xxt.version === '3.3', String(win.xxt && win.xxt.version));
    ok('视频已播放', media.paused === false && media.plays > 0, `plays=${media.plays}`);
    ok('倍速 1.5', media.rate === 1.5, String(media.rate));
    ok('已静音', media.muted === true);
    ok('面板已挂出', !!win.document.getElementById('xxt-all-panel'));

    media.currentTime = 100;
    media.ended = true;
    await wait(2900);

    ok('播完后切到下一个有任务点的小节', clicks[0] === '1.2 视频B', JSON.stringify(clicks));
    ok('没去点页面「下一节」按钮', btnClicks === 0, `btn=${btnClicks}`);

    win.xxt.stop();
    await wait(50);
    const before = media.plays;
    media.paused = true;
    await wait(1200);
    ok('停止后不再拉起播放', media.plays === before && media.paused === true);
    win.close();
}

/* ================= 场景 B：纯测验页，保存完就跳下一节 ================= */
console.log('\n== B. 纯测验页：读题 → 自动勾选 → 暂存 → 跳下一节 ==');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 小测">1.1</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.2 下一节">1.2</span></div>
</li></ul></div>
<div class="singleQuesId" data="101">
  <div class="Zy_TItle">【单选题】熵增原理说的是什么？</div>
  <ul><li>A. 孤立系统的熵永不减少</li><li>B. 熵总是减少</li></ul>
</div>
<div class="singleQuesId" data="102">
  <div class="Zy_TItle">【判断题】化学反应都一定能自发进行。</div>
  <ul><li>A. 对</li><li>B. 错</li></ul>
</div>
<div class="singleQuesId" data="103">
  <div class="Zy_TItle">【填空题】反应物分子一步直接碰撞生成产物分子的反应叫＿＿反应。</div>
  <input type="text" name="answer103">
</div>
<button id="save">暂存</button>
<button id="submit">提交</button>
</body></html>`, { scanRounds: 1 });

    const doc = win.document;
    const clicks = [];
    watchCatalog(win, clicks);
    let saveClicks = 0;
    let submitClicks = 0;
    makeVisible(doc.getElementById('save'));
    makeVisible(doc.getElementById('submit'));
    doc.getElementById('save').addEventListener('click', () => { saveClicks++; });
    doc.getElementById('submit').addEventListener('click', () => { submitClicks++; });

    win.eval(SRC);
    await wait(2200);

    const st = win.xxt.state();
    ok('认出了这是测验页', st.quizPhase === 'ready', st.quizPhase);
    ok('读到 3 道题', /题目 3 道/.test(st.quizStats), st.quizStats);
    ok('没配 AI 时给出提示', /AI 接口/.test(st.err), st.err);

    const panel = doc.getElementById('xxt-all-panel');
    ok('面板已挂出并摊开', !!panel);
    const ta = panel.querySelector('textarea');
    ok('题目明文进面板', !!ta && ta.value.includes('熵增原理'), ta ? ta.value.slice(0, 40) : 'none');

    const quiz = win.xxt.quiz().data.quiz;
    ok('题型识别正确', quiz[0].kind === 'single' && quiz[1].kind === 'judge' && quiz[2].kind === 'blank',
        quiz.map((q) => q.kind).join(','));

    // 走状态机：把答案塞进去，剩下的该脚本自己干
    win.xxt.quiz().letters = ['A', 'B', '单分子'];
    await wait(1200);

    const q = win.xxt.quiz();
    ok('自动勾选了三道', q.fillRes && q.fillRes.filled === 3, JSON.stringify(q.fillRes));
    ok('填空题写进了输入框', doc.querySelector('input[name="answer103"]').value === '单分子',
        doc.querySelector('input[name="answer103"]').value);
    ok('点了页面上的「暂存」', saveClicks === 1, `clicks=${saveClicks}`);
    ok('绝不点「提交」', submitClicks === 0, `submit=${submitClicks}`);

    // 保存完停 1.5 秒就该自己走，不用等交卷
    await wait(2400);
    ok('保存完自动去下一节（没等交卷）', clicks[0] === '1.2 下一节', JSON.stringify(clicks));
    ok('全程没碰提交按钮', submitClicks === 0, `submit=${submitClicks}`);
    ok('状态记为已完成', win.xxt.state().quizPhase === 'done', win.xxt.state().quizPhase);

    win.xxt.stop();
    win.close();
}

/* ================= 场景 C：混排（视频 + 测验），先播完再做测验 ================= */
console.log('\n== C. 混排：视频先播完，再处理测验 ==');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 视频加测试">1.1</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.2 下一个">1.2</span></div>
</li></ul></div>
<video id="v"></video>
<div class="singleQuesId" data="201">
  <div class="Zy_TItle">【单选题】第 1 题</div>
  <ul><li>A. 甲</li><li>B. 乙</li></ul>
</div>
<button id="save">暂存</button>
<button id="submit">交卷</button>
</body></html>`, { scanRounds: 1 });

    const doc = win.document;
    const media = stubMedia(doc.getElementById('v'));
    const clicks = [];
    watchCatalog(win, clicks);
    let submitClicks = 0;
    makeVisible(doc.getElementById('save'));
    makeVisible(doc.getElementById('submit'));
    doc.getElementById('submit').addEventListener('click', () => { submitClicks++; });

    win.eval(SRC);
    await wait(1200);

    ok('先播视频', media.paused === false && media.plays > 0, `plays=${media.plays}`);
    ok('视频没播完之前不跳节', clicks.length === 0, JSON.stringify(clicks));

    media.currentTime = 100;
    media.ended = true;
    await wait(2200);

    ok('视频播完后接着读测验', win.xxt.state().quizPhase === 'ready', win.xxt.state().quizPhase);
    ok('这时还没跳节（测验没做完）', clicks.length === 0, JSON.stringify(clicks));

    win.xxt.quiz().letters = ['B'];
    await wait(1200);
    const qz = win.xxt.quiz();
    ok('勾了选项并暂存', qz.fillRes && qz.fillRes.filled === 1, JSON.stringify(qz.fillRes));
    ok('没点交卷', submitClicks === 0, `submit=${submitClicks}`);

    await wait(4500);   // 1.5 秒冷却 + 视频那 1 轮翻屏
    ok('保存后跳到下一节（不用等交卷）', clicks[0] === '1.2 下一个', JSON.stringify(clicks));

    win.xxt.stop();
    win.close();
}

/* ================= 场景 D：越过没标任务点的小节 ================= */
console.log('\n== D. 越过没标任务点的小节 ==');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 视频A">1.1</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.2 空小节">1.2</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.3 有任务">1.3</span>
    <input class="jobUnfinishCount" value="2">
  </div>
</li></ul></div>
<video id="v"></video>
</body></html>`, { scanRounds: 1 });

    const media = stubMedia(win.document.getElementById('v'));
    const clicks = [];
    watchCatalog(win, clicks);

    win.eval(SRC);
    await wait(900);
    media.currentTime = 100;
    media.ended = true;
    await wait(3200);

    ok('跳过了 1.2，直接点 1.3', clicks[0] === '1.3 有任务', JSON.stringify(clicks));
    win.xxt.stop();
    win.close();
}

/* ================= 场景 E：找不到暂存按钮，也要先跳下一节 ================= */
console.log('\n== E. 页面上只有「提交」、没有「暂存」：跳过但绝不代点 ==');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 只有提交">1.1</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.2 下一节">1.2</span></div>
</li></ul></div>
<div class="singleQuesId" data="301">
  <div class="Zy_TItle">【判断题】只有提交，没有暂存。</div>
  <ul><li>A. 对</li><li>B. 错</li></ul>
</div>
<button id="submit">提交</button>
</body></html>`, { scanRounds: 1 });

    const doc = win.document;
    const clicks = [];
    watchCatalog(win, clicks);
    let submitClicks = 0;
    makeVisible(doc.getElementById('submit'));
    doc.getElementById('submit').addEventListener('click', () => { submitClicks++; });

    win.eval(SRC);
    await wait(2200);

    ok('面板里自己那个「暂存」不被当成页面按钮', win.xxt.save(null) === null, String(win.xxt.save(null)));
    await wait(100);
    ok('提交按钮一次都没被点', submitClicks === 0, `submit=${submitClicks}`);

    win.xxt.quiz().letters = ['B'];
    await wait(1200);
    ok('存的按钮找不到也记为「已处理」', win.xxt.state().quizPhase === 'saved', win.xxt.state().quizPhase);
    ok('面板上留了提示', /没找到/.test(win.xxt.state().err), win.xxt.state().err);

    await wait(2600);
    ok('存不上也先跳下一节', clicks[0] === '1.2 下一节', JSON.stringify(clicks));
    ok('全程没碰提交按钮', submitClicks === 0, `submit=${submitClicks}`);

    win.xxt.stop();
    win.close();
}

/* ================= 场景 F：勾上「等交卷再走」时，保存完不跳 ================= */
console.log('\n== F. 打开「等交卷再走」：保存完停在原地 ==');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 小测">1.1</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.2 下一节">1.2</span></div>
</li></ul></div>
<div class="singleQuesId" data="401">
  <div class="Zy_TItle">【单选题】题</div>
  <ul><li>A. 甲</li><li>B. 乙</li></ul>
</div>
<button id="save">暂存</button>
<button id="submit">提交</button>
</body></html>`, { scanRounds: 1 });

    const doc = win.document;
    win.localStorage.setItem('xxt-quiz:opts', JSON.stringify({ waitSubmit: true }));

    const clicks = [];
    watchCatalog(win, clicks);
    let submitClicks = 0;
    makeVisible(doc.getElementById('save'));
    makeVisible(doc.getElementById('submit'));
    doc.getElementById('submit').addEventListener('click', () => { submitClicks++; });

    win.eval(SRC);
    await wait(2200);
    win.xxt.quiz().letters = ['A'];
    await wait(4000);

    ok('保存完停在本页等交卷', clicks.length === 0, JSON.stringify(clicks));
    ok('状态是「已处理」', win.xxt.state().quizPhase === 'saved', win.xxt.state().quizPhase);
    ok('提示在等提交', /等你点提交/.test(win.xxt.state().err), win.xxt.state().err);
    ok('仍然没点提交', submitClicks === 0, `submit=${submitClicks}`);

    win.xxt.stop();
    win.close();
}

/* ================= 场景 G：长图懒加载，naturalHeight 还是 0 也要认出来 ================= */
console.log('\n== G. 长图：图片还没加载完也能认出并翻到底 ==');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 长图">1.1</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.2 下一节">1.2</span></div>
</li></ul></div>
<div id="picbox" style="overflow-y:auto">
  <img id="longpic" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" >
</div>
</body></html>`, { scanRounds: 2, emptyWait: 600, probeGap: 100 });

    const doc = win.document;
    const clicks = [];
    watchCatalog(win, clicks);

    const box = doc.getElementById('picbox');
    const img = doc.getElementById('longpic');

    // 懒加载的图：naturalHeight / naturalWidth 都是 0，只有渲染尺寸有值
    Object.defineProperty(img, 'naturalHeight', { get: () => 0, configurable: true });
    Object.defineProperty(img, 'naturalWidth', { get: () => 0, configurable: true });
    img.getBoundingClientRect = () => ({ width: 600, height: 1200, top: 0, left: 0, right: 600, bottom: 1200, x: 0, y: 0 });

    // jsdom 不做布局，滚动相关的尺寸得自己给
    Object.defineProperty(box, 'scrollHeight', { get: () => 1400, configurable: true });
    Object.defineProperty(box, 'clientHeight', { get: () => 600, configurable: true });
    let st = 0;
    Object.defineProperty(box, 'scrollTop', { get: () => st, set: (v) => { st = v; }, configurable: true });
    box.getBoundingClientRect = () => ({ width: 600, height: 600, top: 0, left: 0, right: 600, bottom: 600, x: 0, y: 0 });

    win.eval(SRC);
    await wait(1200);
    ok('认出了这个长图滚动盒', win.xxt.tasks().imgBoxes === 1, String(win.xxt.tasks().imgBoxes));
    ok('开始往下翻', st > 0, 'scrollTop=' + st);

    await wait(4200);
    ok('翻到了底', st >= 780, 'scrollTop=' + st);
    ok('翻完后才去下一节', clicks[0] === '1.2 下一节', JSON.stringify(clicks));

    win.xxt.stop();
    win.close();
}

/* ================= 场景 H：测验页题目姗姗来迟，不能提前跳走 ================= */
console.log('\n== H. 题目晚几秒才渲染出来：不许当成空页面跳走 ==');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 测验">1.1</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.2 下一节">1.2</span></div>
</li></ul></div>
<div id="holder"></div>
</body></html>`, { scanRounds: 2, emptyWait: 3000, probeGap: 150 });

    const doc = win.document;
    const clicks = [];
    watchCatalog(win, clicks);

    win.eval(SRC);

    // 2.5 秒后才把题目塞进来（模拟 iframe + 字体加载慢）
    setTimeout(() => {
        doc.getElementById('holder').innerHTML =
            '<div class="singleQuesId" data="901">' +
            '<div class="Zy_TItle">【单选题】晚来的题</div>' +
            '<ul><li>A. 甲</li><li>B. 乙</li></ul></div>';
    }, 2500);

    await wait(1800);
    ok('题目还没来时先按兵不动', clicks.length === 0, JSON.stringify(clicks));

    await wait(3000);
    ok('题目出来后读到了', win.xxt.state().quizPhase !== 'none', win.xxt.state().quizPhase);
    ok('没有把这页当空页面跳走', clicks.length === 0, JSON.stringify(clicks));

    win.xxt.stop();
    win.close();
}

/* ================= 场景 I：页面上的「已作答」不算交卷 ================= */
console.log('\n== I. 题卡上写着「已作答」时，不能误判成整卷已交 =================');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active"><span class="posCatalog_name" title="1.1 作业">1.1</span></div>
  <div class="posCatalog_select"><span class="posCatalog_name" title="1.2 下一节">1.2</span></div>
</li></ul></div>
<div class="singleQuesId" data="951">
  <div class="Zy_TItle">【单选题】第一题</div>
  <ul><li>A. 甲</li><li>B. 乙</li></ul>
  <span class="done-tag">已作答</span>
</div>
<div class="singleQuesId" data="952">
  <div class="Zy_TItle">【判断题】第二题</div>
  <ul><li>A. 对</li><li>B. 错</li></ul>
</div>
<button id="save">暂存</button>
</body></html>`, { scanRounds: 1, emptyWait: 600, probeGap: 100 });

    const doc = win.document;
    const clicks = [];
    watchCatalog(win, clicks);
    makeVisible(doc.getElementById('save'));

    win.eval(SRC);
    await wait(2000);

    const st = win.xxt.state();
    ok('没被「已作答」骗过去', st.quizPhase === 'ready', st.quizPhase);
    ok('两道题都读到了', /题目 2 道/.test(st.quizStats), st.quizStats);
    ok('没有跳走', clicks.length === 0, JSON.stringify(clicks));

    win.xxt.stop();
    win.close();
}

/* ================= 场景 J：同一段视频挂在两节，不能互相顶账 ================= */
console.log('\n== J. 两节挂同一个视频地址：记的是「小节+视频」，不是只记视频 ==');
{
    const { win } = boot(`<!doctype html><html><body>
<div id="coursetree"><ul><li>
  <div class="posCatalog_select firstLayer"><span class="posCatalog_title">第一章</span></div>
  <div class="posCatalog_select posCatalog_active" id="u1"><span class="posCatalog_name" title="1.1 视频">1.1</span></div>
  <div class="posCatalog_select" id="u2"><span class="posCatalog_name" title="1.2 同一个视频">1.2</span></div>
</li></ul></div>
<video id="v" src="https://cdn.example.com/v/a.mp4"></video>
</body></html>`, { scanRounds: 1, emptyWait: 600, probeGap: 100 });

    const doc = win.document;
    const v = doc.getElementById('v');
    stubMedia(v);
    Object.defineProperty(v, 'duration', { get: () => 120, configurable: true });
    Object.defineProperty(v, 'src', { get: () => 'https://cdn.example.com/v/a.mp4', configurable: true });

    win.eval(SRC);
    await wait(900);

    const k1 = win.xxt.tasks().videos[0].key;
    ok('台账键里带着小节名', /1\.1/.test(String(k1)), String(k1));

    // 手动模拟"切到 1.2"：把 active 挪过去
    doc.getElementById('u1').classList.remove('posCatalog_active');
    doc.getElementById('u2').classList.add('posCatalog_active');
    await wait(1200);

    const k2 = win.xxt.tasks().videos[0].key;
    ok('换节后键跟着变', k2 !== k1, `k1=${k1} k2=${k2}`);
    ok('新键里是新小节名', /1\.2/.test(String(k2)), String(k2));

    win.xxt.stop();
    win.close();
}

/* ================= 场景 K：配置存进油猴存储，关机重启后还在 ================= */
console.log('\n== K. 配置持久化：旧数据迁移 + 重启后还在 ==');
{
    const gm = makeGMStore();

    // 第一次：老版本只把配置写进了页面 localStorage
    const w1 = boot(PLAIN_PAGE, {}, gm).win;
    w1.localStorage.setItem('xxt-quiz:api', JSON.stringify({
        url: 'https://api.deepseek.com/chat/completions',
        key: 'sk-old-123',
        model: 'deepseek-chat'
    }));

    w1.eval(SRC);
    await wait(1000);

    ok('先认得出油猴存储可用', w1.xxt.storage().hasGM === true);
    ok('把旧的页面配置搬进了油猴存储', /sk-old-123/.test(gm.data['xxt-quiz:api'] || ''), gm.data['xxt-quiz:api']);
    w1.xxt.stop();
    w1.close();

    // 第二次：全新会话（等同于关机重启 + 页面存储被清）。localStorage 是空的，只剩油猴那份
    const w2 = boot(PLAIN_PAGE, {}, gm).win;
    ok('页面存储确实是空的', w2.localStorage.getItem('xxt-quiz:api') === null);
    w2.eval(SRC);
    await wait(1000);

    const cfg = w2.xxt.cfg();
    ok('重开之后地址还在', cfg.url === 'https://api.deepseek.com/chat/completions', cfg.url);
    ok('密钥还在', cfg.key === 'sk-old-123', cfg.key);
    ok('模型名还在', cfg.model === 'deepseek-chat', cfg.model);

    const panel = w2.document.getElementById('xxt-all-panel');
    const inputs = panel.querySelectorAll('input');
    let urlShown = '';
    for (const el of inputs) {
        if ((el.placeholder || '').includes('接口地址')) urlShown = el.value;
    }
    ok('面板输入框里也显示出来了', urlShown === 'https://api.deepseek.com/chat/completions', urlShown);

    w2.xxt.stop();
    w2.close();
}

/* ================= 场景 L：换一个子域也能读到同一份配置 ================= */
console.log('\n== L. 跨子域：在 mooc1 填的，到 mooc2-ans 也认 ==');
{
    const gm = makeGMStore();

    const wA = boot(PLAIN_PAGE, {}, gm, 'https://mooc1.chaoxing.com/course/1').win;
    wA.eval(SRC);
    await wait(1000);
    wA.xxt.cfg({ url: 'https://api.deepseek.com/chat/completions', key: 'sk-cross', model: 'deepseek-chat' });
    const saved = gm.data['xxt-quiz:api'];
    wA.xxt.stop();
    wA.close();

    ok('写进了油猴存储', /sk-cross/.test(saved || ''), saved);

    // 另一个子域：localStorage 完全隔离，读不到 A 写的东西
    const wB = boot(PLAIN_PAGE, {}, gm, 'https://mooc2-ans.chaoxing.com/course/1').win;
    ok('B 的页面存储是独立的', wB.localStorage.getItem('xxt-quiz:api') === null);
    wB.eval(SRC);
    await wait(1000);

    const cfgB = wB.xxt.cfg();
    ok('B 也读到了 A 存的密钥', cfgB.key === 'sk-cross', cfgB.key);
    ok('B 的地址也对', cfgB.url === 'https://api.deepseek.com/chat/completions', cfgB.url);

    wB.xxt.stop();
    wB.close();
}

console.log(failed ? `\n[all] ${failed} 项未通过` : '\n[all] 全部通过');
process.exitCode = failed ? 1 : 0;
