// 字形解码链路验证：真实加密字体 + 真实题干 → 还原成正常汉字
//
// 字形表（dist/font-table.txt）已经随仓库发布，所以日常跑测试**不需要**字体文件。
// 只有想验证"从 TTF 现场算一遍映射"时才需要放一份 cxsecret.ttf 到：
//   tests/fixtures/cxsecret.ttf   （或仓库上一级目录）
// 字体怎么来的：脚本的 tools/font-export.user.js，在学习通做题页运行会把 base64 打出来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const TTF_CANDIDATES = [
  path.resolve(ROOT, '..', 'cxsecret.ttf'),
  path.resolve(ROOT, 'tests', 'fixtures', 'cxsecret.ttf'),
];

const ttfPath = TTF_CANDIDATES.find((p) => fs.existsSync(p));
if (!ttfPath) {
  console.log('[decode] 没找到 cxsecret.ttf，跳过（字形表已随仓库发布，这项不是必须的）');
  console.log('[decode] 想跑的话：把它放到 ' + path.relative(ROOT, TTF_CANDIDATES[1]));
  process.exit(0);
}

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b64 = fs.readFileSync(ttfPath).toString('base64');
const code = fs.readFileSync(path.join(ROOT, 'dist', 'xxt-auto.user.js'), 'utf8');

// 真实题干：字形被随机打乱，页面上看到的是「嵡嵢嵣…」这种，真字得靠字体形状推
const html = `<!doctype html><html><head><meta charset="utf-8">
<style id="cxSecretStyle">@font-face{font-family:'cx';src:url(data:application/font-ttf;base64,${b64}) format('truetype');}</style>
</head><body>
<div class="singleQuesId" data="400634589">
  <div class="Zy_TItle">1 【单选题】 在一定嵣度嵦,发嵥嵢化的嵡嵧嵤系,其总熵( )。</div>
  <ul>
    <li>A 嵨变</li>
    <li>B 嵮嵪增嵯嵭嵩嵫</li>
    <li>C 嵰嵱减嵫</li>
    <li>D 嵰嵱增嵯</li>
  </ul>
</div>
<div class="singleQuesId" data="400634584">
  <div class="Zy_TItle">2 【判断题】 在0℃时,任脊稳嵶嵳嵷单嵵的嵲准摩嵸熵都等于零。</div>
  <ul>
    <li>A 对</li>
    <li>B 错</li>
  </ul>
</div>
<div style="margin-top:20px">
  <a id="saveTmp">暂 存</a>
  <a id="submitBtn">提交</a>
</div>
</body></html>`;

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://mooc1.chaoxing.com/mooc-ans/api/work?api=1&workId=test',
});
const win = dom.window;
win.__XXT_TEST__ = { scanRounds: 1, emptyWait: 300, probeGap: 100, quizIdle: 60000 };
win.__clicks = [];
win.__saves = [];
win.__submits = [];

let submitClicks = 0;
const saveEl = win.document.getElementById('saveTmp');
const submitEl = win.document.getElementById('submitBtn');
for (const el of [saveEl, submitEl]) {
  el.getBoundingClientRect = () => ({ width: 60, height: 24, top: 0, left: 0, right: 60, bottom: 24 });
}
saveEl.addEventListener('click', () => { win.__saves.push('暂存'); });
submitEl.addEventListener('click', () => { submitClicks++; });
// 选项点击记一笔
win.document.querySelectorAll('ul li').forEach((li) => {
  li.addEventListener('click', () => win.__clicks.push(li.textContent.trim()));
});

console.log('== MD5 自检 ==');
win.eval(code);
ok(!!win.xxt && typeof win.xxt === 'object', '脚本挂上了 window.xxt');
ok(win.xxt.md5.call(win.xxt, new Uint8Array([97, 98, 99])) === '900150983cd24fb0d6963f7d28e17f72', 'MD5("abc") 正确');
ok(win.xxt.md5.call(win.xxt, new Uint8Array(0)) === 'd41d8cd98f00b204e9800998ecf8427e', 'MD5("") 正确');

await sleep(900);

console.log('== 字形表 ==');
ok(win.xxt.glyphTableSize() === 6725, '字形表载入了（实际 ' + win.xxt.glyphTableSize() + ' 条）');

console.log('== 解码结果 ==');
const r = win.xxt.decode();
ok(r.ok === true, '这一页解码成功');
const text = r.ok ? r.data.text : '';
const stats = r.ok ? r.data.stats : '';

ok(/字形 54\/54/.test(stats), '54 个字形全部解出（实际：' + stats + '）');
ok(text.includes('在一定温度下,发生变化的孤立体系,其总熵'), '题 1 题干还原正确');
ok(text.includes('A 不变'), '选项 A 还原正确');
ok(text.includes('B 可能增大或减小'), '选项 B 还原正确');
ok(text.includes('C 总是减小'), '选项 C 还原正确');
ok(text.includes('D 总是增大'), '选项 D 还原正确');
ok(text.includes('在0℃时,任何稳定状态单质的标准摩尔熵都等于零'), '题 2 题干还原正确');
// 只查这份字体真正用到的那些码位，别把「度」「平」这类正常字也算成残留
const encrypted = '嵡嵢嵣嵤嵥嵦嵧嵨嵩嵪嵫嵬嵭嵮嵯嵰嵱嵲嵳嵴嵵嵶嵷嵸脊';
ok(![...encrypted].some((c) => text.includes(c)), '输出里没有残留加密字符');
ok(!/A\.\s*A\s/.test(text), '选项没重复带序号');

const quiz = r.ok ? r.data.quiz : [];
ok(quiz.length === 2, '读到 2 道题（实际 ' + quiz.length + '）');
ok(quiz[0] && quiz[0].id === '400634589', '题目 id 带出来了');
ok(quiz[0] && quiz[0].kind === 'single', '第 1 题认成单选');
ok(quiz[1] && quiz[1].kind === 'judge', '第 2 题认成判断');

console.log('== 填入答案（不提交）==');
const res = win.xxt.fill(quiz, ['D', 'B']);
ok(res.filled === 2, '两道题都填上了（实际 ' + res.filled + '）');
const clicks = win.__clicks;
ok(clicks.length === 2, '点了两个选项（实际 ' + clicks.length + '）');
ok(clicks[0] === 'D 嵰嵱增嵯', '第 1 题点的是 D（实际：' + clicks[0] + '）');
ok(clicks[1] === 'B 错', '第 2 题点的是 B（实际：' + clicks[1] + '）');

const savedName = win.xxt.save(null);
ok(savedName === '暂存', '点了页面上的「暂存」（实际：' + savedName + '）');
await sleep(100);
ok(win.__saves.length === 1, '暂存被点了 1 次');
ok(submitClicks === 0, '完全没碰「提交」');

console.log('== 答案解析 ==');
const parse = win.xxt.parse;
ok(JSON.stringify(parse('D,B,B,A,B', 5)) === '["D","B","B","A","B"]', '逗号分隔');
ok(JSON.stringify(parse('DBBAB', 5)) === '["D","B","B","A","B"]', '连写 5 个字母');
ok(JSON.stringify(parse('1D 2B 3AB', 3)) === '["D","B","AB"]', '带题号 + 多选');
ok(JSON.stringify(parse('D，B；B A', 4)) === '["D","B","B","A"]', '中文标点');
ok(parse('', 3).length === 0, '空输入得到空数组');

console.log('== 填空题的答案不被当选择题过滤 ==');
const withBlank = [
  { kind: 'single' }, { kind: 'judge' },
  { kind: 'blank' }
];
const mixed = parse('D\nA\n反应物分子一步直接碰撞生成产物分子的反应', withBlank);
ok(mixed.length === 3, '读到 3 段（实际 ' + mixed.length + '）');
ok(mixed[0] === 'D' && mixed[1] === 'A', '前两段是字母');
ok(mixed[2] === '反应物分子一步直接碰撞生成产物分子的反应', '第三段中文完整保留（实际：' + mixed[2] + '）');

console.log('== 暂存按钮识别 ==');
const found = win.xxt.findSave();
ok(!!found, '找得到「暂存」按钮');
ok(!!found && found.name === '暂存', '识别出的名字是「暂存」而不是「提交」');
ok(!!found && found.el.id === 'saveTmp', '挑的是暂存那个，没挑提交');

win.xxt.stop();
win.close();

console.log(fail ? `\n[decode] ${fail} 项未通过` : `\n[decode] 全部通过：${pass} passed, 0 failed`);
process.exitCode = fail ? 1 : 0;
