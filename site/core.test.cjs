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

// 对照必须独立重放；篡改最终日志不能让累积区跟着变化而伪造一致。
const snapshotContext = {window:{StreamCore:C}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'web/snapshot.js'),'utf8'),snapshotContext);
const V = snapshotContext.window.StreamSnapshotView;
const plain = value => JSON.parse(JSON.stringify(value));
test('所有流场景独立重放到终点均与 Go 日志一致，不读取最终对象反填',() => {
  for (const scene of scenes.filter(item => !item.httpError)) {
    const before = JSON.stringify(scene);
    const final = plain(V.object(scene,{step:scene.sse.length}));
    const expected = JSON.parse(JSON.stringify(scene.result.object));
    if (scene.id === 'chat-thinking') expected.choices[0].reasoning_content = scene.sse.flatMap(record => record.object?.choices || []).map(choice => choice.delta?.reasoning_content || '').join('');
    assert.deepEqual(final,expected,scene.id);
    assert.deepEqual(plain(V.finalObject(scene)),expected,scene.id);
    const altered = {...scene,result:{...scene.result,object:{wrong:true}}};
    assert.deepEqual(plain(V.object(altered,{step:scene.sse.length})),final);
    assert.ok(V.differences(final,altered.result.object).length > 0);
    assert.equal(JSON.stringify(scene),before);
    const empty = V.object(scene,{step:0});
    assert.equal(empty.id,'');assert.equal(empty.usage,null);
    assert.equal(empty.preview,undefined);assert.equal(empty.text,undefined);
    for (let step=0;step<=scene.sse.length;step++) {
      assert.deepEqual(Object.keys(V.object(scene,{step})),Object.keys(final));
    }
  }
});

test('工具参数中途保持原始字符串，当前字段路径与终点一一对应',() => {
  for (const protocol of ['chat','responses']) {
    const scene = scenes.find(item => item.id === protocol+'-multi_tool');
    const first = scene.sse.find(record => protocol === 'chat'
      ? record.object?.choices?.some(choice => choice.delta?.tool_calls?.some(tool => tool.function?.arguments))
      : record.object?.type === 'response.function_call_arguments.delta');
    const object = V.object(scene,{step:first.event_index});
    const args = protocol === 'chat' ? object.choices[0].tool_calls[0].function.arguments : object.output[0].arguments;
    assert.equal(args,'{"');
    assert.equal(object.usage,null);
    const diffs = V.differences(object,scene.result.object);
    assert.ok(diffs.some(diff => diff.path === (protocol === 'chat' ? '$.choices.0.tool_calls.0.function.arguments' : '$.output[0].arguments')));
    assert.ok(!JSON.stringify(object).includes('北京'));
  }
});

test('差异比较忽略对象属性顺序，并转义模型文本与字段路径',() => {
  assert.equal(V.differences({a:1,b:2},{b:2,a:1}).length,0);
  const scene = {protocol:'chat',sse:[{object:{id:'x',model:'m',created:1,choices:[{index:0,delta:{content:'<img src=x onerror=alert(1)>'}}]}}],result:{object:{}}};
  const html = V.renderDiff(scene,{step:1,max:1});
  assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));
});

// 结构演示使用真实调用 ID；绝不生成声称已写入的序号、执行结果或下一轮请求。
const journeyContext = {window:{StreamCore:C}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'web/journey.js'),'utf8'),journeyContext);
const J = journeyContext.window.StreamJourney;
test('完整过程投影保留关联 ID 与工具参数，消息原样包入 EventLog 片段',() => {
  for (const protocol of ['chat','responses']) {
    const scene = scenes.find(item => item.id === protocol+'-multi_tool');
    const before = JSON.stringify(scene);
    const data = J.prepare(scene,'0:1');
    const selected = data.piBlocks[data.selectedIndex];
    assert.equal(selected.id,protocol === 'responses' ? `${data.selected.callID}|${data.selected.itemID}` : data.selected.callID);
    assert.deepEqual(plain(selected.arguments),{city:'北京'});
    assert.equal(data.message.content.length,2);
    assert.deepEqual(plain(JSON.parse(data.message.content[1].arguments)),{city:'北京'});
    assert.equal(data.event.data.message,data.message);
    for (const field of ['seq','time']) assert.equal(data.event[field],undefined);
    assert.equal(data.message.id,undefined);
    assert.equal(data.message.source,undefined);
    assert.equal(JSON.stringify(scene),before);
    assert.ok(J.render(scene,'eventlog','0:1').includes('没有产生真实 EventLog'));
    assert.ok(J.render(scene,'request','0:1').includes('未发送第二次模型请求'));
  }
});

test('缺少工具、截断或非法参数时不制造可执行的 Harness 消息',() => {
  const text = scenes.find(item => item.id==='chat-text');
  assert.ok(J.prepare(text).blocked);
  const scene = JSON.parse(JSON.stringify(scenes.find(item => item.id==='chat-tool')));
  scene.result.object.choices[0].tool_calls[0].function.arguments = '{';
  const invalid = J.prepare(scene);
  assert.ok(invalid.blocked);assert.deepEqual(plain(invalid.piBlocks),[]);
  scene.result.status = 'partial';
  assert.ok(J.prepare(scene).blocked.includes('没有完整结束'));
});

// 逐条使用真实 SSE 的 delta/done 作独立预期，确认推理在结束前就已增长。
test('Chat 与 Responses 的真实思考样本逐条累积，done 不重复，正文与推理分开',() => {
  for (const protocol of ['chat','responses']) {
    const scene = scenes.find(item => item.id === protocol+'-thinking');
    const original = JSON.stringify(scene.result.object);
    let expected = '', deltaCount = 0;
    for (const record of scene.sse) {
      const event = record.object;
      if (protocol === 'chat') for (const choice of event?.choices || []) {
        if (typeof choice.delta?.reasoning_content === 'string') {expected += choice.delta.reasoning_content;deltaCount++;}
      }
      if (event?.type === 'response.reasoning_text.delta') {expected += event.delta;deltaCount++;}
      if (event?.type === 'response.reasoning_text.done') expected = event.text;
      const current = V.object(scene,{step:record.event_index});
      const reasoning = protocol === 'chat' ? current.choices[0]?.reasoning_content || '' : (current.output.find(item => item.type==='reasoning')?.content || []).map(part => part.text || '').join('');
      assert.equal(reasoning,expected,`${scene.id} SSE #${record.event_index}`);
      const summary = C.snapshot(scene,record.event_index);
      assert.equal(summary.reasoning,expected,`${scene.id} 内容摘要 SSE #${record.event_index}`);
      assert.ok(!summary.text.includes('We need'));
    }
    assert.ok(deltaCount>10);assert.ok(expected.length>20);
    assert.equal(JSON.stringify(scene.result.object),original);
    if (protocol==='chat') assert.equal(scene.result.object.choices[0].reasoning_content,undefined);
    assert.deepEqual(plain(V.object(scene,{step:scene.sse.length})),plain(V.finalObject(scene)));
    assert.equal(C.snapshot(scene,scene.sse.length).text,'391');
  }
});

// 同一 reasoning 项可同时含 content 和 summary；分别定位并用完整块校准。
test('交错推理项、正文与摘要按索引隔离，done 全文校准，不串入工具或回答',() => {
  const events = [
    {type:'response.created',response:{id:'r',model:'m',status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{id:'rs0',type:'reasoning',status:'in_progress'}},
    {type:'response.output_item.added',output_index:1,item:{id:'rs1',type:'reasoning',status:'in_progress'}},
    {type:'response.reasoning_text.delta',output_index:0,item_id:'rs0',content_index:1,delta:'A'},
    {type:'response.reasoning_text.delta',output_index:1,item_id:'rs1',content_index:0,delta:'B'},
    {type:'response.reasoning_summary_text.delta',output_index:0,item_id:'rs0',summary_index:0,delta:'s'},
    {type:'response.reasoning_text.done',output_index:0,item_id:'rs0',content_index:1,text:'A corrected'},
    {type:'response.reasoning_summary_text.done',output_index:0,item_id:'rs0',summary_index:0,text:'summary corrected'},
  ];
  const scene = {protocol:'responses',sse:events.map((object,index)=>({object,event_index:index+1}))};
  const current = V.object(scene,{step:events.length});
  assert.equal(current.output[0].content[0].text,'A corrected');
  assert.equal(current.output[0].summary[0].text,'summary corrected');
  assert.equal(current.output[1].content[0].text,'B');
  assert.equal(C.snapshot(scene,events.length).text,'');
  assert.equal(C.snapshot(scene,events.length).reasoningSummary,'summary corrected');
  const item = {id:'rs0',type:'reasoning',status:'completed',content:[{type:'reasoning_text',text:'final correction'}],summary:[{type:'summary_text',text:'final summary'}]};
  scene.sse.push({event_index:9,object:{type:'response.output_item.done',output_index:0,item}});
  assert.equal(V.object(scene,{step:9}).output[0].content[0].text,'final correction');
  assert.equal(C.snapshot(scene,9).reasoning,'final correctionB');
  const response = {id:'r',model:'m',status:'completed',output:[item,{...current.output[1],status:'completed'}],usage:null,error:null,incomplete_details:null};
  scene.sse.push({event_index:10,object:{type:'response.completed',response}});
  const raw = JSON.parse(JSON.stringify(response));delete raw.output[0].summary;
  scene.result = {object:raw};
  assert.deepEqual(plain(V.finalObject(scene)),plain(response));
  assert.deepEqual(plain(V.object(scene,{step:10})),plain(response));
  assert.equal(scene.result.object.output[0].summary,undefined);
});

// 每条事件都检查用量来源；最终日志即使存在用量也不能提前泄漏到回放。
test('所有场景 usage 仅在上游用量事件到达后出现', () => {
  for (const scene of scenes.filter(scene => !scene.httpError)) {
    let received = null;
    for (let step = 0; step <= scene.sse.length; step++) {
      const event = scene.sse[step-1]?.object;
      const wire = scene.protocol === 'chat' ? event?.usage : event?.response?.usage;
      if (wire) received = wire;
      const current = V.object(scene,{step});
      const summary = C.snapshot(scene,step);
      assert.equal(current.usage !== null,received !== null,`${scene.id} #${step} 完整对象`);
      assert.equal(summary.usage !== null,received !== null,`${scene.id} #${step} 内容摘要`);
      if (received) assert.equal(current.usage.total_tokens,received.total_tokens);
      else assert.equal(current.usage,null);
    }
  }
});
