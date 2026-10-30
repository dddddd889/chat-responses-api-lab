/* 使用 Node 标准库验证真实数据、回放状态和静态页面，不调用模型或网络。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const C = require('./web/core.js');
const sandbox = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'dist/data.js'),'utf8'),sandbox);
const data = JSON.parse(JSON.stringify(sandbox.window.SSE_DATA));
const scenes = data.scenarios.map(C.prepare);

// 每个独立页面的终点必须等于真实日志给出的完整结果，而不是重新编造结果。
for (const scene of scenes) {
  test(`${scene.id}：独立页面、原日志哈希和回放终点`,() => {
    const source = path.join(__dirname,'..',data.source,'live',scene.id,'events.jsonl');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),scene.sourceSHA256);
    assert.equal(fs.readFileSync(source,'utf8'),scene.sourceText);
    const html = fs.readFileSync(path.join(__dirname,'dist/scenarios',scene.id,'index.html'),'utf8');
    assert.ok(html.includes(`data-scenario="${scene.id}"`));
    assert.ok(html.includes('src="../../data.js"'));
    assert.ok(!html.includes('{{'));
    const final = C.finalView(scene), state = C.snapshot(scene,scene.sse.length);
    if (scene.httpError) {
      assert.equal(state.status,'http_error');assert.equal(scene.sse.length,0);assert.equal(scene.business.length,0);assert.equal(state.usage,null);
    } else {
      assert.equal(state.authoritative,true);
      assert.deepEqual(state.tools,final.tools);assert.equal(state.text,final.text);assert.deepEqual(state.usage,final.usage);
      assert.equal(state.usage.total_tokens,scene.tokens);
      assert.equal(state.status,scene.kind === 'length' ? (scene.protocol === 'chat' ? 'truncated':'partial'):'complete');
      for (const record of scene.business) {
        assert.ok(record.event_index >= 1 && record.event_index <= scene.sse.length);
        assert.ok(record.first_event_index <= record.last_event_index);
        assert.equal(scene.sse[record.event_index-1].event_index,record.event_index);
      }
    }
  });
}

test('双工具的参数增量独立累积；JSON 正文、done 全文不会重复追加',() => {
  for (const protocol of ['chat','responses']) {
    const scene = scenes.find(item => item.id === protocol+'-multi_tool');
    for (let step=0;step<=scene.sse.length;step++) {
      const state = C.snapshot(scene,step);
      assert.ok(state.tools.length<=2);
      for (const tool of state.tools) {
        assert.ok(tool.arguments.length <= '{"city": "上海"}'.length);
        assert.ok(!tool.arguments.includes('}{'));
        if (tool.index === 0) assert.ok(!tool.arguments.includes('北京'));
        if (tool.index === 1) assert.ok(!tool.arguments.includes('上海'));
      }
    }
    assert.deepEqual(C.finalView(scene).tools.map(tool => JSON.parse(tool.arguments).city),['上海','北京']);
  }
});

test('usage 到达之前保持未知；到达后保留整次快照',() => {
  for (const scene of scenes.filter(item => !item.httpError)) {
    const firstUsage = scene.sse.find(record => record.object?.usage || record.object?.response?.usage).event_index;
    assert.equal(C.snapshot(scene,firstUsage-1).usage,null);
    assert.equal(C.snapshot(scene,firstUsage).usage.total_tokens,scene.tokens);
  }
});

test('同类型场景都有对应接口页面，但两次请求的序号不会强行对齐',() => {
  assert.equal(scenes.length,14);assert.equal(data.totalTokens,1815);
  for (const scene of scenes) assert.equal(scenes.filter(item => item.kind === scene.kind).length,2);
  assert.equal(scenes.find(item => item.id === 'chat-multi_tool').sse.length,19);
  assert.equal(scenes.find(item => item.id === 'responses-multi_tool').sse.length,23);
});

test('JSON 高亮不能把模型输出变成 HTML',() => {
  const unsafe = '<img src=x onerror=alert(1)></script><script>bad()</script>';
  const output = C.highlight(JSON.stringify({content:unsafe}));
  assert.ok(!output.includes('<img'));assert.ok(!output.includes('<script>'));
  assert.ok(output.includes('&lt;img'));
  assert.equal(C.escapeHTML('"&<>\''),'&quot;&amp;&lt;&gt;&#39;');
});

test('进度边界有效，归零不会泄漏最终参数或 usage',() => {
  for (const scene of scenes.filter(item => !item.httpError)) {
    assert.equal(C.snapshot(scene,-9).step,0);
    assert.equal(C.snapshot(scene,10000).step,scene.sse.length);
    assert.deepEqual(C.snapshot(scene,0).tools,[]);
    assert.equal(C.snapshot(scene,0).text,'');assert.equal(C.snapshot(scene,0).usage,null);
  }
});

// 缓存属于输入，两个命中字段不能相加，命中率不以总 token 为分母。
test('真实缓存统计保留，双工具为 128/300，单工具为 128/290',() => {
  for (const scene of scenes.filter(item => !item.httpError)) {
    const expected = ['tool','multi_tool'].includes(scene.kind) ? 128 : 0;
    const usage = C.finalView(scene).usage;
    assert.equal(usage.cached_tokens,expected);
    assert.equal(usage.uncached_tokens,usage.input_tokens-expected);
    assert.equal(usage.cache_hit_rate,expected/usage.input_tokens);
    const wire = scene.sse.find(record => record.object?.usage || record.object?.response?.usage);
    const raw = scene.protocol === 'chat' ? wire.object.usage : wire.object.response.usage;
    const details = scene.protocol === 'chat' ? raw.prompt_tokens_details : raw.input_tokens_details;
    assert.deepEqual(usage.input_tokens_details,details);
    assert.equal(C.snapshot(scene,wire.event_index).usage.cached_tokens,expected);
  }
  assert.equal(C.finalView(scenes.find(scene => scene.id==='chat-multi_tool')).usage.cache_hit_rate,128/300);
});

test('缓存缺省、明确 0、别名、零输入和非法统计分别处理',() => {
  const raw = {prompt_tokens:300,completion_tokens:58,total_tokens:358,prompt_tokens_details:{cached_tokens:128},prompt_cache_hit_tokens:128,prompt_cache_miss_tokens:172};
  const copy = JSON.parse(JSON.stringify(raw));
  const usage = C.normalizeUsage(raw,'chat');
  assert.equal(usage.cached_tokens,128);assert.equal(usage.uncached_tokens,172);assert.equal(usage.cache_hit_rate,128/300);
  assert.deepEqual(raw,copy);
  assert.equal(C.normalizeUsage({...raw,prompt_tokens_details:null},'chat').cached_tokens,128);
  assert.equal(C.normalizeUsage({input_tokens:55,input_tokens_details:{cached_tokens:0}},'responses').cache_hit_rate,0);
  const missing = C.normalizeUsage({input_tokens:55},'responses');
  assert.equal(missing.cached_tokens,null);assert.equal(missing.uncached_tokens,null);assert.equal(missing.cache_hit_rate,null);
  const zero = C.normalizeUsage({input_tokens:0,input_tokens_details:{cached_tokens:0}},'responses');
  assert.equal(zero.cached_tokens,0);assert.equal(zero.cache_hit_rate,null);
  for (const value of [-1,301,'128',1.5,Infinity]) assert.equal(C.normalizeUsage({input_tokens:300,input_tokens_details:{cached_tokens:value}},'responses').cached_tokens,null);
});

test('原始最终对象不增加展示字段，缓存扩展也不会在终点被丢失',() => {
  for (const scene of scenes.filter(item => !item.httpError)) {
    const before = JSON.stringify(scene.result.object);
    const final = C.finalView(scene), snapshot = C.snapshot(scene,scene.sse.length);
    assert.equal(JSON.stringify(scene.result.object),before);
    assert.deepEqual(snapshot.usage.input_tokens_details,final.usage.input_tokens_details);
    assert.equal(snapshot.usage.cached_tokens,final.usage.cached_tokens);
    assert.equal(scene.result.object.cached_tokens,undefined);
  }
});
