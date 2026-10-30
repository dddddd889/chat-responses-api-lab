/* 可选的 DOM 交互测试：只加载本站点的本地文件，不启动或控制真实浏览器。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const modulePath = process.env.SSE_DOM_MODULE;
const root = path.join(__dirname,'dist');
const sandbox = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'data.js'),'utf8'),sandbox);
const meta = JSON.parse(JSON.stringify(sandbox.window.SSE_DATA));
const C = require('./web/core.js');

// 本地资源加载器拒绝网络访问，确保交互不会偷偷请求 API。
async function open(id,t,view='json',query='') {
  const {JSDOM,VirtualConsole,ResourceLoader} = require(modulePath);
  const errors = [];
  const console = new VirtualConsole();console.on('jsdomError',error => errors.push(error));
  class LocalOnly extends ResourceLoader {
    fetch(url,options) {
      const resource = new URL(url);
      assert.equal(resource.origin,'https://sse.test','unexpected network: '+url);
      const local = path.resolve(root,'.'+decodeURIComponent(resource.pathname));
      assert.ok(local.startsWith(root+path.sep),'unexpected file: '+url);
      return Promise.resolve(fs.readFileSync(local));
    }
  }
  const dom = await JSDOM.fromFile(path.join(root,'scenarios',id,'index.html'),{url:`https://sse.test/scenarios/${id}/index.html${query}`,runScripts:'dangerously',resources:new LocalOnly(),virtualConsole:console,pretendToBeVisual:true});
  t.after(() => dom.window.close());
  await new Promise((resolve,reject) => {
    if (dom.window.document.readyState === 'complete') return resolve();
    const timeout = setTimeout(() => reject(new Error('local page load timeout')),5000);
    dom.window.addEventListener('load',() => {clearTimeout(timeout);resolve();},{once:true});
  });
  assert.deepEqual(errors.map(error => error.message),[]);
  // 常规测试显式查看 JSON；差异视图由专门用例覆盖默认状态与切换。
  const diffToggle = dom.window.document.querySelector('[data-action="snapshot-diff"]');
  if (view === 'json' && diffToggle?.getAttribute('aria-pressed') === 'true') diffToggle.click();
  const resultToggle = dom.window.document.querySelector('[data-action="result-mode"]');
  if (view === 'json' && resultToggle?.getAttribute('aria-pressed') === 'false') resultToggle.click();
  if (view === 'diff' && resultToggle?.getAttribute('aria-pressed') === 'true') resultToggle.click();
  return dom;
}

for (const scene of meta.scenarios) {
  test(`${scene.id}：页面实际渲染与三块对照`,{skip:!modulePath},async t => {
    const dom = await open(scene.id,t), document = dom.window.document;
    const prepared = C.prepare(scene);
    assert.ok(document.querySelector('h1').textContent.includes(scene.title));
    assert.equal(document.querySelectorAll('.scenario-link').length,7);
    assert.equal(document.querySelectorAll('.sse-row').length,prepared.sse.length);
    assert.equal(document.querySelectorAll('.business-row').length,0);
    if (scene.httpStatus !== 400) {
      const titles = [...document.querySelectorAll('.workbench > .panel .panel-title')].map(node => node.textContent);
      assert.equal(titles.length,3);
      assert.ok(titles[0].startsWith('上游 SSE'));assert.ok(titles[1].startsWith('拼接状态'));assert.ok(titles[2].startsWith('完整结果'));
      assert.ok(document.querySelector('.final-result-panel [aria-label="完整结果视图 JSON"]'));
    }
    if (scene.httpStatus !== 400) document.querySelector('[data-action="snapshot-mode"]').click();
    assert.equal(document.querySelectorAll('.protocol-switch a').length,2);
    if (scene.httpStatus === 400) {
      assert.ok(document.querySelector('.http-card').textContent.includes('未建立 SSE'));
      assert.equal(document.querySelector('.stats'),null);
    } else {
      assert.equal(document.querySelector('.playback-step b').textContent,String(prepared.sse.length).padStart(2,'0'));
      assert.equal(document.querySelector('.usage-grid .total strong').textContent,String(scene.tokens));
    }
  });
}

test('进度、参数拼接、完整结果、协议对照、筛选和搜索可以联动',{skip:!modulePath},async t => {
  const dom = await open('chat-multi_tool',t), window = dom.window, document = window.document;
  const prepared = C.prepare(meta.scenarios.find(scene => scene.id === 'chat-multi_tool'));
  document.querySelector('[data-action="snapshot-mode"]').click();
  document.querySelector('[data-action="reset"]').click();
  assert.equal(document.querySelectorAll('#snapshot-body .tool-card').length,0); // 归零后当前拼接区不能提前出现未来工具。
  assert.equal(document.querySelector('#snapshot-body .usage-grid .total strong').textContent,'—');
  const first = prepared.business.find(record => record.object.type === 'tool_arguments_delta');
  document.querySelector(`.sse-row[data-index="${first.event_index}"]`).click();
  assert.equal(document.querySelector('#snapshot-body .arguments').textContent,'{"');
  document.querySelector('[data-action="source-mode"]').click();
  assert.ok(document.querySelector('#source-code').textContent.startsWith('data: '));
  const done = prepared.sse.find(record => record.object?.choices?.some(choice => choice.finish_reason === 'tool_calls'));
  document.querySelector(`.sse-row[data-index="${done.event_index}"]`).click();
  assert.equal(document.querySelectorAll('#snapshot-body .tool-card').length,2);
  const slider = document.querySelector('#event-progress');slider.value='5';slider.dispatchEvent(new window.Event('input',{bubbles:true}));
  assert.equal(document.querySelector('.playback-step b').textContent,'05');
  document.querySelector('[data-tab="compare"]').click();
  assert.equal(document.querySelector('#pane-compare').hidden,false);
  assert.equal(document.querySelector('#pane-replay').hidden,true);
  assert.equal(document.querySelectorAll('.compare-card').length,2);
  assert.equal(document.querySelectorAll('.scenario-link').length,7);assert.equal(document.querySelector('[data-filter]'),null);
  const search = document.querySelector('#scenario-search');search.value='双工具';search.dispatchEvent(new window.Event('input',{bubbles:true}));
  assert.equal(document.querySelectorAll('.scenario-link').length,1);
  assert.ok(document.querySelector('.scenario-link').href.includes('chat-multi_tool'));
});

test('播放会推进序号，暂停后停止，切换标签保留正确可访问状态',{skip:!modulePath},async t => {
  const dom = await open('responses-multi_tool',t), window = dom.window, document = window.document;
  document.querySelector('[data-action="reset"]').click();
  const speed = document.querySelector('#playback-speed');speed.value='250';speed.dispatchEvent(new window.Event('change',{bubbles:true}));
  document.querySelector('[data-action="play"]').click();
  await new Promise(resolve => setTimeout(resolve,320));
  document.querySelector('[data-action="play"]').click();
  const paused = document.querySelector('.playback-step b').textContent;assert.ok(Number(paused)>=1);
  await new Promise(resolve => setTimeout(resolve,320));
  assert.equal(document.querySelector('.playback-step b').textContent,paused);
  const tab = document.querySelector('#tab-replay');
  tab.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  assert.equal(document.querySelector('#tab-journey').getAttribute('aria-selected'),'true');
  assert.equal(document.querySelector('#pane-journey').hidden,false);
});

// 同一个命中量在概览、回放和协议对照中采用相同口径。
test('双工具缓存命中 128、命中率 42.7%，回放归零时统计未知',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom = await open(protocol+'-multi_tool',t), document = dom.window.document;
    document.querySelector('[data-action="snapshot-mode"]').click();
    assert.ok(document.querySelector('.token-equation').textContent.includes('128'));
    assert.ok(document.querySelector('.token-equation').textContent.includes('42.7%'));
    assert.equal(document.querySelector('#snapshot-body [data-cache="uncached"]').textContent,'172');
    assert.equal(document.querySelector('#snapshot-body .cache-progress').value,128/300);
    assert.equal(document.querySelectorAll('[data-cache-context="compare"]').length,2);
    for (const panel of document.querySelectorAll('[data-cache-context="compare"]')) {
      assert.equal(panel.querySelector('[data-cache="cached"]').textContent,'128');assert.equal(panel.querySelector('[data-cache="rate"]').textContent,'42.7%');
    }
    document.querySelector('[data-action="reset"]').click();
    assert.equal(document.querySelector('#snapshot-body [data-cache="cached"]').textContent,'—');
    assert.equal(document.querySelector('#snapshot-body [data-cache="rate"]').textContent,'—');
    assert.ok(document.querySelector('.token-equation').textContent.includes('128'));
  }
});

test('Token 中文字段说明保留原始命中别名，解释输入输出和缓存关系',{skip:!modulePath},async t => {
  const dom = await open('chat-multi_tool',t), document = dom.window.document;
  document.querySelector('.token-guide summary').click();assert.equal(document.querySelector('.token-guide').open,true);
  const rows = [...document.querySelectorAll('.token-table tbody tr')];
  const fields = rows.map(row => row.querySelector('code').textContent);
  assert.deepEqual(fields,['prompt_tokens','completion_tokens','total_tokens','prompt_tokens_details.cached_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens']);
  assert.deepEqual(rows.map(row => row.cells[1].textContent),['300','58','358','128','128','172']);
  assert.ok(document.querySelector('.token-guide').textContent.includes('同一份命中量'));
  assert.ok(document.querySelector('.token-guide').textContent.includes('输入 300 = 命中 128 + 未命中 172'));
});

test('JSON 视图使用日志同结构，当前累积值可直接对照最终结果',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom = await open(protocol+'-multi_tool',t), window = dom.window, document = window.document;
    const prepared = C.prepare(meta.scenarios.find(scene => scene.id === protocol+'-multi_tool'));
    let copied;
    Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async value => {copied=value;}},configurable:true});
    const parsed = JSON.parse(document.querySelector('.snapshot-json .code').textContent);
    assert.deepEqual(parsed,prepared.result.object);
    assert.equal(parsed.preview,undefined);
    assert.ok(document.querySelector('.result-match').textContent.includes('逐字段一致'));
    assert.deepEqual(JSON.parse(document.querySelector('[aria-label="完整结果视图 JSON"]').textContent),prepared.result.object);
    assert.equal(document.querySelector('[data-action="snapshot-mode"]').getAttribute('aria-pressed'),'true');
    document.querySelector('[data-content="snapshot"]').click();await Promise.resolve();
    assert.deepEqual(JSON.parse(copied),parsed);
    document.querySelector('[data-action="reset"]').click();
    const preview = JSON.parse(document.querySelector('.snapshot-json .code').textContent);
    assert.equal(preview.usage,null);
    assert.equal(preview.id,'');
    assert.equal(document.querySelector('.result-match').textContent.includes('逐字段一致'),false);
    assert.deepEqual(Object.keys(preview),Object.keys(parsed));
    assert.ok(document.querySelector('.snapshot-json-label').textContent.includes('相同字段结构'));
    document.querySelector('[data-action="snapshot-mode"]').click();
    assert.equal(document.querySelector('.snapshot-json'),null);
    assert.equal(document.querySelector('#snapshot-body [data-cache="cached"]').textContent,'—');
  }
});

test('移除统计卡片仍保留零命中说明和 HTTP 状态',{skip:!modulePath},async t => {
  const zero = await open('chat-text',t);
  assert.match(zero.window.document.querySelector('.token-equation').textContent,/0%/);
  assert.equal(zero.window.document.querySelector('.stats'),null);
  const unknown = await open('chat-http_error',t);
  assert.match(unknown.window.document.querySelector('.http-summary').textContent,/HTTP 400/);
  assert.match(unknown.window.document.querySelector('.token-guide').textContent,/未返回 usage/);
});

// 完整事件类型直接可见；同一条参数增量同时关联左侧事件与中间累积值。
test('上游列表和检查器显示完整 event type，Chat event 与 JSON object 分开标注',{skip:!modulePath},async t => {
  const responses = await open('responses-tool',t), document = responses.window.document;
  const scene = C.prepare(meta.scenarios.find(scene => scene.id === 'responses-tool'));
  const delta = scene.sse.find(record => record.object?.type === 'response.function_call_arguments.delta');
  const row = document.querySelector(`.sse-row[data-index="${delta.event_index}"]`);
  assert.equal(row.querySelector('.event-row-title').textContent,'response.function_call_arguments.delta');
  row.click();
  assert.ok(document.getElementById('source-title').textContent.includes('response.function_call_arguments.delta'));
  assert.equal(JSON.parse(document.querySelector('#snapshot-body .code').textContent).output[0].arguments,delta.object.delta);
  const final = JSON.parse(document.querySelector('.final-result-panel .code').textContent);
  assert.equal(final.output[0].arguments,delta.object.delta);
  assert.deepEqual(JSON.parse(document.querySelector('#pane-result .result-code .code').textContent),scene.result.object);
  const chat = await open('chat-tool',t), chatDocument = chat.window.document;
  assert.equal(chatDocument.querySelector('.event-row-title').textContent,'message');
  assert.ok(chatDocument.querySelector('.event-row-detail').textContent.includes('JSON object: chat.completion.chunk'));
});

// 右列的红色当前值随回放变化，绿色终点值逐步归并为相同行。
test('完整结果的 JSON 和 Diff 都随 SSE 更新，到终点才核对日志',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom = await open(protocol+'-tool',t,'diff'), document = dom.window.document;
    const scene = C.prepare(meta.scenarios.find(scene => scene.id === protocol+'-tool'));
    const deltas = scene.sse.filter(record => protocol === 'responses'
      ? record.object?.type === 'response.function_call_arguments.delta'
      : record.object?.choices?.some(choice => choice.delta?.tool_calls?.some(tool => tool.function?.arguments)));
    let accumulated = '';
    for (const record of deltas) {
      document.querySelector(`.sse-row[data-index="${record.event_index}"]`).click();
      const rows = [...document.querySelectorAll('#final-result-body .diff-line')];
      const current = JSON.parse(rows.filter(node => !node.classList.contains('diff-delete')).map(node => node.textContent.slice(1)).join('\n'));
      accumulated += protocol === 'responses' ? record.object.delta : record.object.choices[0].delta.tool_calls[0].function.arguments;
      assert.equal(protocol === 'responses' ? current.output[0].arguments : current.choices[0].tool_calls[0].function.arguments,accumulated);
      assert.ok(document.querySelector('.result-match').textContent.includes('正在构建'));
    }
    document.querySelector(`.sse-row[data-index="${scene.sse.length}"]`).click();
    assert.ok(document.querySelector('.result-match').textContent.includes('逐字段一致'));
    assert.equal(document.querySelector('.result-comparison'),null);
    document.querySelector('[data-action="result-mode"]').click();
    assert.deepEqual(JSON.parse(document.querySelector('#final-result-body .code').textContent),scene.result.object);
  }
});

// Git diff 的加减行必须能分别还原处理后的对象和处理前的对象。
test('默认 Git diff 标记本条增删行，JSON 视图和复制仍保留完整对象',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom = await open(protocol+'-tool',t,'diff'), window = dom.window, document = window.document;
    const scene = C.prepare(meta.scenarios.find(scene => scene.id === protocol+'-tool'));
    assert.equal(document.querySelector('[data-action="snapshot-diff"]').getAttribute('aria-pressed'),'true');
    const delta = scene.sse.find(record => protocol === 'responses'
      ? record.object?.type === 'response.function_call_arguments.delta'
      : record.object?.choices?.some(choice => choice.delta?.tool_calls?.some(tool => tool.function?.arguments)));
    document.querySelector(`.sse-row[data-index="${delta.event_index}"]`).click();
    const after = document.querySelectorAll('#snapshot-body .snapshot-diff .diff-add');
    assert.ok(after.length > 0);
    assert.ok([...after].some(node => node.textContent.includes('arguments')));
    const rows = [...document.querySelectorAll('#snapshot-body .snapshot-diff .diff-line')];
    const newJSON = JSON.parse(rows.filter(node => !node.classList.contains('diff-delete')).map(node => node.textContent.slice(1)).join('\n'));
    const oldJSON = JSON.parse(rows.filter(node => !node.classList.contains('diff-add')).map(node => node.textContent.slice(1)).join('\n'));
    assert.notDeepEqual(oldJSON,newJSON);
    assert.ok(document.querySelector('[aria-label="完整结果 Git diff"]'));
    let copied;
    Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async value => {copied=value;}},configurable:true});
    document.querySelector('[data-content="snapshot"]').click();await Promise.resolve();
    assert.deepEqual(JSON.parse(copied),newJSON);
    document.querySelector('[data-action="snapshot-mode"]').click();
    assert.deepEqual(JSON.parse(document.querySelector('#snapshot-body .code').textContent),newJSON);
    document.querySelector('[data-action="snapshot-diff"]').click();
    document.querySelector('[data-action="reset"]').click();
    assert.equal(document.querySelectorAll('#snapshot-body .snapshot-diff .diff-add,#snapshot-body .snapshot-diff .diff-delete').length,0);
    document.querySelector(`.sse-row[data-index="${scene.sse.length}"]`).click();
    if (protocol === 'chat') assert.equal(document.querySelectorAll('#snapshot-body .snapshot-diff .diff-add,#snapshot-body .snapshot-diff .diff-delete').length,0);
    else assert.ok([...document.querySelectorAll('#snapshot-body .snapshot-diff .diff-add')].some(node => node.textContent.includes('completed')));
  }
});

// 从选中调用一路追踪到消息与事件外壳，并明确区分结构演示和实际记录。
test('完整过程按阶段关联同一工具调用，结构演示和未采集状态清楚可见',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom = await open(protocol+'-multi_tool',t), window = dom.window, document = window.document;
    const scene = C.prepare(meta.scenarios.find(scene => scene.id===protocol+'-multi_tool'));
    document.querySelector('[data-tab="journey"]').click();
    assert.equal(document.getElementById('pane-journey').hidden,false);
    assert.equal(document.querySelectorAll('.journey-rail button').length,5);
    assert.equal(document.querySelectorAll('.journey-calls button').length,2);
    document.querySelector('[data-action="journey-tool"][data-tool="0:1"]').click();
    assert.ok(document.querySelector('.journey-identity').textContent.includes(C.finalView(scene).tools[1].callID));
    const message = JSON.parse(document.querySelector('[aria-label="过程收集器内容"]').textContent);
    const event = JSON.parse(document.querySelector('[aria-label="过程 EventLog"]').textContent);
    assert.deepEqual(event.data.message,message);assert.equal(event.seq,undefined);
    assert.ok(document.querySelector('.journey-note').textContent.includes('没有实际执行 session.append'));
    document.querySelector('[data-action="journey-stage"][data-stage="adapter"]').click();
    const pi = JSON.parse(document.querySelector('[aria-label="过程 pi-ai 累积内容"]').textContent).content[1];
    const harness = JSON.parse(document.querySelector('[aria-label="过程 Harness 累积内容"]').textContent).content[1];
    assert.deepEqual(JSON.parse(harness.arguments),pi.arguments);
    assert.equal(harness.id,pi.id);
    document.querySelector('[data-action="journey-stage"][data-stage="tool"]').click();
    assert.ok(document.querySelector('.journey-empty').textContent.includes('未采集'));
    assert.equal(document.querySelector('[aria-label="工具执行结果 JSON"]'),null);
    document.querySelector('[data-action="journey-stage"][data-stage="request"]').click();
    assert.ok(document.getElementById('pane-journey').textContent.includes('未发送第二次模型请求'));
    document.querySelector('[data-action="journey-stage"][data-stage="response"]').click();
    document.querySelector('[data-action="journey-replay"]').click();
    assert.equal(document.getElementById('pane-replay').hidden,false);
    assert.ok(document.getElementById('source-code').textContent.length>0);
    document.querySelector('[data-tab="journey"]').click();
    assert.equal(document.querySelector('[data-action="journey-tool"][data-tool="0:1"]').getAttribute('aria-pressed'),'true');
    let copied;
    Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async value => {copied=value;}},configurable:true});
    document.querySelector('[data-action="copy-link"]').click();await Promise.resolve();
    assert.equal(new URL(copied).searchParams.get('tab'),'journey');
    assert.equal(new URL(copied).searchParams.get('call'),'0:1');
  }
});

// 新增完整过程后，四个主标签仍可用方向键往返并正确循环。
test('四个主标签的键盘导航可循环，完整过程不会破坏原标签切换',{skip:!modulePath},async t => {
  const dom = await open('responses-tool',t), window = dom.window, document = window.document;
  const names = ['replay','journey','compare','result'];
  for (let index=0;index<names.length;index++) {
    const current = document.getElementById('tab-'+names[index]);
    current.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    const next = document.getElementById('tab-'+names[(index+1)%names.length]);
    assert.equal(next.getAttribute('aria-selected'),'true');assert.equal(document.activeElement,next);
  }
  document.getElementById('tab-replay').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  assert.equal(document.getElementById('tab-result').getAttribute('aria-selected'),'true');
});

// 在真实页面逐条点击每个推理 delta，核对两块对象和摘要，不只验收终点。
test('思考内容逐条显示在拼接状态和完整结果，终点不重复且原始日志不被修改',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom = await open(protocol+'-thinking',t), window = dom.window, document = window.document;
    const scene = C.prepare(meta.scenarios.find(scene => scene.id===protocol+'-thinking'));
    const original = document.querySelector('#pane-result .result-code .code').textContent;
    const deltas = scene.sse.filter(record => protocol==='chat'
      ? typeof record.object?.choices?.[0]?.delta?.reasoning_content === 'string'
      : record.object?.type==='response.reasoning_text.delta');
    let expected = '';
    for (const record of deltas) {
      expected += protocol==='chat' ? record.object.choices[0].delta.reasoning_content : record.object.delta;
      document.querySelector(`.sse-row[data-index="${record.event_index}"]`).click();
      const current = JSON.parse(document.querySelector('#snapshot-body .code').textContent);
      const complete = JSON.parse(document.querySelector('#final-result-body .code').textContent);
      const getReasoning = value => protocol==='chat' ? value.choices[0]?.reasoning_content || '' : (value.output.find(item=>item.type==='reasoning')?.content || []).map(part=>part.text || '').join('');
      assert.equal(getReasoning(current),expected);
      assert.equal(getReasoning(complete),expected);
      assert.ok(!document.querySelector('.result-match').textContent.includes('逐字段一致'));
    }
    document.querySelector(`.sse-row[data-index="${scene.sse.length}"]`).click();
    const current = JSON.parse(document.querySelector('#snapshot-body .code').textContent);
    assert.deepEqual(JSON.parse(document.querySelector('#final-result-body .code').textContent),current);
    assert.ok(document.querySelector('.result-match').textContent.includes('逐字段一致'));
    assert.equal(document.querySelector('#pane-result .result-code .code').textContent,original);
    if (protocol==='chat') assert.ok(document.querySelector('.reasoning-provenance').textContent.includes('历史 Go 日志未保存'));
    let copied;
    Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async value => {copied=value;}},configurable:true});
    document.querySelector('[data-content="result-view"]').click();await Promise.resolve();
    assert.deepEqual(JSON.parse(copied),current);
    document.querySelector('[data-action="snapshot-mode"]').click();
    assert.equal(document.querySelector('#snapshot-body .reasoning-output').textContent,expected);
    assert.equal(document.querySelector('#snapshot-body .text-output:not(.reasoning-output)').textContent,'391');
  }
});

// 在用量到达前后直接读两栏 JSON，防止日志终点数据混入当前进度。
test('usage 来源明确，两栏在用量事件前为 null，事件到达后同步出现',{skip:!modulePath},async t => {
  for (const id of ['chat-thinking','responses-thinking']) {
    const dom = await open(id,t), document = dom.window.document;
    const scene = C.prepare(meta.scenarios.find(scene => scene.id === id));
    const received = scene.sse.find(record => scene.protocol === 'chat' ? record.object?.usage : record.object?.response?.usage);
    const progress = document.querySelector('#event-progress');
    for (const step of [received.event_index-1,received.event_index,0]) {
      progress.value = step;progress.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
      const left = JSON.parse(document.querySelector('[aria-label="合并对象 JSON"]').textContent);
      const right = JSON.parse(document.querySelector('[aria-label="完整结果视图 JSON"]').textContent);
      assert.deepEqual(left.usage,right.usage);
      const source = document.querySelector('[data-usage-source]').textContent;
      if (step < received.event_index) {assert.equal(right.usage,null);assert.match(source,/尚未收到 usage/);}
      else {assert.ok(right.usage.total_tokens>0);assert.ok(source.includes(`SSE #${received.event_index}`));}
    }
    assert.match(document.querySelector('#pane-result').textContent,/不随回放进度变化/);
  }
});

// 普通回复、思考和长度截断都有内容转换与会话消息；仅工具执行不适用。
test('无工具的正文、推理、截断场景有适配与会话展示',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) for (const kind of ['text','thinking','length']) {
    const dom = await open(`${protocol}-${kind}`,t), document = dom.window.document;
    document.querySelector('[data-tab="journey"]').click();
    document.querySelector('[data-stage="adapter"]').click();
    const pi = JSON.parse(document.querySelector('[aria-label="过程 pi-ai 累积内容"]').textContent);
    assert.ok(pi.content.some(block => block.type === 'text'));
    if (kind === 'thinking') assert.ok(pi.content.some(block => block.type === 'thinking' && block.thinking.length>20));
    assert.ok(!document.querySelector('.journey-stage-panel .badge').textContent.includes('不适用'));
    if (kind === 'length') assert.match(document.querySelector('.journey-stage-content').textContent,/max-tokens/);
    document.querySelector('[data-stage="eventlog"]').click();
    const message = JSON.parse(document.querySelector('[aria-label="过程收集器内容"]').textContent);
    const event = JSON.parse(document.querySelector('[aria-label="过程 EventLog"]').textContent);
    assert.deepEqual(event.data.message,message);assert.ok(event.data.usage.totalTokens>0);
    if (kind === 'thinking') assert.ok(message.content.some(block => block.type === 'reasoning' && block.text.length>20));
    document.querySelector('[data-stage="tool"]').click();
    assert.match(document.querySelector('.journey-stage-content').textContent,/不适用：本场景没有工具调用/);
    document.querySelector('[data-stage="request"]').click();
    assert.equal(document.querySelector('.journey-stage-panel .badge').textContent,'未采集');
  }
});

// 覆盖地址实时同步、深链接恢复、前进后退以及连续回放不刷屏历史。
test('标签、阶段、工具和回放进度写入路由并可恢复',{skip:!modulePath},async t => {
  const dom = await open('responses-multi_tool',t), {document,history} = dom.window;
  const route = () => new URL(dom.window.location.href).searchParams;
  const progress = document.querySelector('#event-progress');
  const originalLength = history.length;
  for (const step of [2,3,4]) {
    progress.value=step;progress.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
    assert.equal(route().get('step'),String(step));
  }
  assert.equal(history.length,originalLength);
  document.querySelector('[data-tab="journey"]').click();
  assert.equal(route().get('tab'),'journey');
  document.querySelector('[data-stage="adapter"]').click();
  assert.equal(route().get('stage'),'adapter');
  document.querySelector('[data-tool="0:1"]').click();
  assert.equal(route().get('call'),'0:1');
  const shared = dom.window.location.search;
  // 新建页面模拟重新打开分享链接，恢复阶段、工具以及保留的回放进度。
  const restored = await open('responses-multi_tool',t,'json',shared);
  assert.equal(restored.window.document.querySelector('#tab-journey').getAttribute('aria-selected'),'true');
  assert.equal(restored.window.document.querySelector('[data-stage="adapter"]').getAttribute('aria-current'),'step');
  assert.equal(restored.window.document.querySelector('[data-tool="0:1"]').getAttribute('aria-pressed'),'true');
  assert.equal(restored.window.document.querySelector('#event-progress').value,'4');
  // 后退恢复工具选择之前的状态，前进再恢复选中的第二个工具。
  const navigate = direction => new Promise(resolve => {dom.window.addEventListener('popstate',resolve,{once:true});history[direction]();});
  await navigate('back');
  assert.equal(route().get('call'),null);
  assert.equal(document.querySelector('[data-tool="0:0"]').getAttribute('aria-pressed'),'true');
  await navigate('forward');
  assert.equal(document.querySelector('[data-tool="0:1"]').getAttribute('aria-pressed'),'true');
  document.querySelector('[data-tab="replay"]').click();
  assert.equal(route().get('tab'),'replay');
  await navigate('back');
  assert.equal(document.querySelector('#tab-journey').getAttribute('aria-selected'),'true');
  await navigate('forward');
  assert.equal(document.querySelector('#tab-replay').getAttribute('aria-selected'),'true');
  assert.equal(document.querySelector('#event-progress').value,'4');
});

// 协议只由顶部标签切换，路径与页面状态一起保留，菜单不再重复分组。
test('协议标签保留路由状态且菜单每个场景只出现一次',{skip:!modulePath},async t => {
  const dom = await open('responses-thinking',t,'json','?tab=journey&stage=adapter&step=5'), document=dom.window.document;
  assert.equal(document.querySelectorAll('.scenario-link').length,7);
  assert.equal(document.querySelectorAll('[data-filter]').length,0);
  assert.equal(document.querySelectorAll('.protocol-switch a').length,2);
  const target = new URL(document.querySelector('.protocol-switch a[data-scene="chat-thinking"]').href);
  assert.ok(target.pathname.endsWith('/chat-thinking/index.html'));
  assert.equal(target.searchParams.get('tab'),'journey');assert.equal(target.searchParams.get('stage'),'adapter');
  assert.equal(target.searchParams.get('step'),'5');
  const restored = await open('chat-thinking',t,'json',target.search);
  assert.equal(restored.window.document.querySelector('.protocol-switch .active').textContent,'Chat');
  assert.equal(restored.window.document.querySelector('#tab-journey').getAttribute('aria-selected'),'true');
  assert.equal(restored.window.document.querySelector('[data-stage="adapter"]').getAttribute('aria-current'),'step');
  assert.equal(restored.window.document.querySelector('#event-progress').value,'5');
  document.querySelector('[data-tab="replay"]').click();
  const progress=document.querySelector('#event-progress');progress.value=42;progress.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  const updated=new URL(document.querySelector('.protocol-switch a[data-scene="chat-thinking"]').href);
  assert.equal(updated.searchParams.get('tab'),'replay');
  assert.equal(updated.searchParams.get('step'),String(C.prepare(meta.scenarios.find(scene=>scene.id==='chat-thinking')).sse.length));
});

// 原链接 step=0 必须为空起点；正文与推理逐步增长，正式日志只在提交步骤出现。
test('完整过程逐步展示推理转换与提交，jstep 分享和前进后退可恢复',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom=await open(`${protocol}-thinking`,t,'json','?tab=journey&stage=adapter&step=0'), window=dom.window, document=window.document;
    const frames=window.StreamJourney.timeline(window.StreamCore.prepare(window.SSE_DATA.scenarios.find(scene=>scene.id===`${protocol}-thinking`)));
    const deltas=frames.map((frame,index)=>({frame,index})).filter(({frame})=>frame.piEvent?.type==='thinking_delta');
    assert.equal(document.querySelector('#journey-progress').value,'0');
    assert.deepEqual(JSON.parse(document.querySelector('[aria-label="过程 pi-ai 累积内容"]').textContent).content,[]);
    const move=index=>{const progress=document.querySelector('#journey-progress');progress.value=index;progress.dispatchEvent(new window.Event('input',{bubbles:true}));};
    for (const {frame,index} of deltas.slice(0,2)) {
      move(index);
      const pi=JSON.parse(document.querySelector('[aria-label="过程 pi-ai 累积内容"]').textContent);
      const harness=JSON.parse(document.querySelector('[aria-label="过程 Harness 累积内容"]').textContent);
      assert.equal(pi.content[0].thinking,frame.piBlocks[0].thinking);
      assert.equal(harness.content[0].text,pi.content[0].thinking);
      assert.equal(new URL(window.location.href).searchParams.get('jstep'),String(index));
    }
    document.querySelector('[data-stage="eventlog"]').click();
    assert.equal(JSON.parse(document.querySelector('[aria-label="过程 EventLog"]').textContent),null);
    assert.match(document.querySelector('[data-journey-commit]').textContent,/尚未写入/);
    move(frames.length-2);assert.equal(JSON.parse(document.querySelector('[aria-label="过程 EventLog"]').textContent),null);
    document.querySelector('[data-action="journey-next"]').click();
    const event=JSON.parse(document.querySelector('[aria-label="过程 EventLog"]').textContent);
    assert.ok(event.data.message.content.some(block=>block.type==='reasoning'));
    if (protocol==='chat') {
      const history=JSON.parse(document.querySelector('[aria-label="过程 Chat 历史映射"]').textContent);
      assert.equal(history.messages[0].reasoning_content,event.data.message.content.find(block=>block.type==='reasoning').text);
      assert.equal(history.messages[0].content,'391');
    }
    // 刷新恢复独立过程步，不要求将旧 SSE step 改成同一个数。
    const restored=await open(`${protocol}-thinking`,t,'json',window.location.search);
    assert.equal(restored.window.document.querySelector('#journey-progress').value,String(frames.length-1));
    assert.ok(JSON.parse(restored.window.document.querySelector('[aria-label="过程 EventLog"]').textContent));
    document.querySelector('[data-stage="adapter"]').click();
    const back=new Promise(resolve=>window.addEventListener('popstate',resolve,{once:true}));window.history.back();await back;
    assert.equal(document.querySelector('[data-stage="eventlog"]').getAttribute('aria-current'),'step');
    assert.equal(document.querySelector('#journey-progress').value,String(frames.length-1));
    // 返回起点必须抹掉已展示的正式事件和推理历史映射。
    document.querySelector('[data-action="journey-reset"]').click();
    assert.equal(JSON.parse(document.querySelector('[aria-label="过程 EventLog"]').textContent),null);
    assert.equal(document.querySelector('[aria-label="过程 Chat 历史映射"]'),null);
  }
});

// 自动播放与手动切换共用进度，离开后停止计时而非后台偷偷修改地址。
test('完整过程自动播放可暂停并在切换主标签后停止',{skip:!modulePath},async t => {
  const dom=await open('chat-thinking',t,'json','?tab=journey&stage=adapter&jstep=0'), window=dom.window, document=window.document;
  document.querySelector('[data-action="journey-play"]').click();
  await new Promise(resolve=>setTimeout(resolve,700));
  assert.ok(Number(document.querySelector('#journey-progress').value)>0);
  document.querySelector('[data-action="journey-play"]').click();
  const paused=window.location.search;
  await new Promise(resolve=>setTimeout(resolve,700));assert.equal(window.location.search,paused);
  document.querySelector('[data-action="journey-play"]').click();
  document.querySelector('[data-tab="replay"]').click();
  const left=window.location.search;
  await new Promise(resolve=>setTimeout(resolve,700));assert.equal(window.location.search,left);
});
