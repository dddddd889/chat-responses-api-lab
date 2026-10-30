/* 可选的 DOM 交互测试：只加载本站点的本地文件，不启动或控制真实浏览器。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {fileURLToPath} = require('node:url');
const vm = require('node:vm');
const modulePath = process.env.SSE_DOM_MODULE;
const root = path.join(__dirname,'dist');
const sandbox = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'data.js'),'utf8'),sandbox);
const meta = JSON.parse(JSON.stringify(sandbox.window.SSE_DATA));
const C = require('./web/core.js');

// 本地资源加载器拒绝网络访问，确保交互不会偷偷请求 API。
async function open(id,t) {
  const {JSDOM,VirtualConsole,ResourceLoader} = require(modulePath);
  const errors = [];
  const console = new VirtualConsole();console.on('jsdomError',error => errors.push(error));
  class LocalOnly extends ResourceLoader {
    fetch(url,options) {
      assert.ok(url.startsWith('file:'),'unexpected network: '+url);
      assert.ok(fileURLToPath(url).startsWith(root+path.sep),'unexpected file: '+url);
      return super.fetch(url,options);
    }
  }
  const dom = await JSDOM.fromFile(path.join(root,'scenarios',id,'index.html'),{runScripts:'dangerously',resources:new LocalOnly(),virtualConsole:console,pretendToBeVisual:true});
  t.after(() => dom.window.close());
  await new Promise((resolve,reject) => {
    if (dom.window.document.readyState === 'complete') return resolve();
    const timeout = setTimeout(() => reject(new Error('local page load timeout')),5000);
    dom.window.addEventListener('load',() => {clearTimeout(timeout);resolve();},{once:true});
  });
  assert.deepEqual(errors.map(error => error.message),[]);
  return dom;
}

for (const scene of meta.scenarios) {
  test(`${scene.id}：页面实际渲染与三列对照`,{skip:!modulePath},async t => {
    const dom = await open(scene.id,t), document = dom.window.document;
    const prepared = C.prepare(scene);
    assert.ok(document.querySelector('h1').textContent.includes(scene.title));
    assert.equal(document.querySelectorAll('.scenario-link').length,14);
    assert.equal(document.querySelectorAll('.sse-row').length,prepared.sse.length);
    assert.equal(document.querySelectorAll('.business-row').length,0);
    if (scene.httpStatus !== 400) {
      const titles = [...document.querySelectorAll('.workbench > .panel .panel-title')].map(node => node.textContent);
      assert.equal(titles.length,3);
      assert.ok(titles[0].startsWith('上游 SSE'));assert.ok(titles[1].startsWith('拼接状态'));assert.ok(titles[2].startsWith('完整结果'));
      assert.ok(document.querySelector('.final-result-panel [aria-label="日志完整结果 JSON"]'));
    }
    if (scene.httpStatus !== 400) document.querySelector('[data-action="snapshot-mode"]').click();
    assert.equal(document.querySelectorAll('.protocol-switch a').length,2);
    if (scene.httpStatus === 400) {
      assert.ok(document.querySelector('.http-card').textContent.includes('未建立 SSE'));
      assert.equal(document.querySelectorAll('.stats .stat-value')[3].textContent,'—');
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
  document.querySelector('[data-filter="responses"]').click();assert.equal(document.querySelectorAll('.scenario-link').length,7);
  const search = document.querySelector('#scenario-search');search.value='双工具';search.dispatchEvent(new window.Event('input',{bubbles:true}));
  assert.equal(document.querySelectorAll('.scenario-link').length,1);
  assert.ok(document.querySelector('.scenario-link').href.includes('responses-multi_tool'));
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
  assert.equal(document.querySelector('#tab-compare').getAttribute('aria-selected'),'true');
  assert.equal(document.querySelector('#pane-compare').hidden,false);
});

// 同一个命中量在概览、回放和协议对照中采用相同口径。
test('双工具缓存命中 128、命中率 42.7%，回放归零时统计未知',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom = await open(protocol+'-multi_tool',t), document = dom.window.document;
    document.querySelector('[data-action="snapshot-mode"]').click();
    assert.equal(document.querySelector('[data-metric="cache"] [data-cache="cached"]').textContent,'128');
    assert.equal(document.querySelector('[data-metric="cache"] [data-cache="rate"]').textContent,'42.7%');
    assert.equal(document.querySelector('#snapshot-body [data-cache="uncached"]').textContent,'172');
    assert.equal(document.querySelector('#snapshot-body .cache-progress').value,128/300);
    assert.equal(document.querySelectorAll('[data-cache-context="compare"]').length,2);
    for (const panel of document.querySelectorAll('[data-cache-context="compare"]')) {
      assert.equal(panel.querySelector('[data-cache="cached"]').textContent,'128');assert.equal(panel.querySelector('[data-cache="rate"]').textContent,'42.7%');
    }
    document.querySelector('[data-action="reset"]').click();
    assert.equal(document.querySelector('#snapshot-body [data-cache="cached"]').textContent,'—');
    assert.equal(document.querySelector('#snapshot-body [data-cache="rate"]').textContent,'—');
    assert.equal(document.querySelector('[data-metric="cache"] [data-cache="cached"]').textContent,'128');
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

test('第二层默认展示日志同结构的 JSON，当前累积值可直接对照最终结果',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom = await open(protocol+'-multi_tool',t), window = dom.window, document = window.document;
    const prepared = C.prepare(meta.scenarios.find(scene => scene.id === protocol+'-multi_tool'));
    let copied;
    Object.defineProperty(window.navigator,'clipboard',{value:{writeText:async value => {copied=value;}},configurable:true});
    const parsed = JSON.parse(document.querySelector('.snapshot-json .code').textContent);
    assert.deepEqual(parsed,prepared.result.object);
    assert.equal(parsed.preview,undefined);
    assert.ok(document.querySelector('#snapshot-comparison').textContent.includes('逐字段一致'));
    assert.deepEqual(JSON.parse(document.querySelector('[aria-label="日志完整结果 JSON"]').textContent),prepared.result.object);
    assert.equal(document.querySelector('[data-action="snapshot-mode"]').getAttribute('aria-pressed'),'true');
    document.querySelector('[data-content="snapshot"]').click();await Promise.resolve();
    assert.deepEqual(JSON.parse(copied),parsed);
    document.querySelector('[data-action="reset"]').click();
    const preview = JSON.parse(document.querySelector('.snapshot-json .code').textContent);
    assert.equal(preview.usage,null);
    assert.equal(preview.id,'');
    assert.equal(document.querySelector('#snapshot-comparison').textContent.includes('逐字段一致'),false);
    assert.deepEqual(Object.keys(preview),Object.keys(parsed));
    assert.ok(document.querySelector('.snapshot-json-label').textContent.includes('相同字段结构'));
    document.querySelector('[data-action="snapshot-mode"]').click();
    assert.equal(document.querySelector('.snapshot-json'),null);
    assert.equal(document.querySelector('#snapshot-body [data-cache="cached"]').textContent,'—');
  }
});

test('明确 0 命中显示 0%，HTTP 没有 usage 时显示未知',{skip:!modulePath},async t => {
  const zero = await open('chat-text',t);
  assert.equal(zero.window.document.querySelector('[data-metric="cache"] [data-cache="cached"]').textContent,'0');
  assert.equal(zero.window.document.querySelector('[data-metric="cache"] [data-cache="rate"]').textContent,'0%');
  const unknown = await open('chat-http_error',t);
  assert.equal(unknown.window.document.querySelector('[data-metric="cache"] [data-cache="cached"]').textContent,'—');
  assert.equal(unknown.window.document.querySelector('[data-metric="cache"] [data-cache="rate"]').textContent,'—');
});

// 选择参数增量时，当前值、最终值与上游事件应能通过同一路径关联。
test('逐步选择 SSE 会更新字段对照，完整结果保持不变，终点消除差异',{skip:!modulePath},async t => {
  for (const protocol of ['chat','responses']) {
    const dom = await open(protocol+'-tool',t), document = dom.window.document;
    const scene = C.prepare(meta.scenarios.find(scene => scene.id === protocol+'-tool'));
    const finalJSON = document.querySelector('[aria-label="日志完整结果 JSON"]').textContent;
    const first = scene.business.find(record => record.object.type === 'tool_arguments_delta');
    document.querySelector(`.sse-row[data-index="${first.event_index}"]`).click();
    const panel = document.querySelector('#snapshot-comparison');
    const expected = protocol === 'chat' ? '$.choices.0.tool_calls.0.function.arguments' : '$.output[0].arguments';
    assert.ok(panel.querySelector('.comparison-update').textContent.includes(expected));
    assert.ok(panel.querySelector('.comparison-table').textContent.includes(expected));
    assert.equal(document.querySelector('[aria-label="日志完整结果 JSON"]').textContent,finalJSON);
    document.querySelector(`.sse-row[data-index="${scene.sse.length}"]`).click();
    assert.ok(panel.textContent.includes('逐字段一致'));
    assert.equal(panel.querySelector('.comparison-table'),null);
  }
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
  assert.deepEqual(final,scene.result.object);
  assert.notEqual(final.output[0].arguments,delta.object.delta);
  const chat = await open('chat-tool',t), chatDocument = chat.window.document;
  assert.equal(chatDocument.querySelector('.event-row-title').textContent,'message');
  assert.ok(chatDocument.querySelector('.event-row-detail').textContent.includes('JSON object: chat.completion.chunk'));
});
