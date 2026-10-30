/* 完整过程视图：真实 API 数据与源码结构演示严格分开，不执行工具或写入会话。 */
(function () {
  'use strict';
  const C = window.StreamCore;
  const e = C.escapeHTML;
  const revision = '687f282e8625c6b8d11ff58211a90524be2e4317';
  const repository = `https://github.com/deepseek-ai/deepseek-harness/blob/${revision}/`;
  const stages = [
    {id:'response',name:'模型响应',status:'API 实测'},
    {id:'adapter',name:'适配器转换',status:'结构演示'},
    {id:'eventlog',name:'写入会话',status:'结构演示'},
    {id:'tool',name:'执行工具',status:'未采集'},
    {id:'request',name:'下一次请求',status:'未采集'},
  ];

  // 用 choice 和工具索引区分调用，避免双工具场景只按工具名匹配。
  function toolKey(tool) { return `${tool.choice}:${tool.index}`; }

  // 只接受完整参数对象；不把截断内容或非法 JSON 修补成可执行的调用。
  function parseArguments(raw) {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value) ? {value} : {error:'参数不是 JSON 对象'};
    } catch (_) { return {error:'参数尚未形成完整 JSON'}; }
  }

  // 从真实最终对象抽取调用；演示仅投影工具块，省略未采集的消息元数据和其他内容块。
  function prepare(scene, requestedKey) {
    const view = C.finalView(scene);
    const tools = view.tools;
    const selected = tools.find(tool => toolKey(tool) === requestedKey) || tools[0];
    if (!selected) return {tools,view,selected:null,blocked:scene.httpError ? 'HTTP 请求被拒绝，没有生成工具调用。' : '当前场景没有函数工具调用，可切换左侧的单工具或双工具场景。'};
    const related = tools.filter(tool => tool.choice === selected.choice);
    const argumentsList = related.map(tool => parseArguments(tool.arguments));
    const blocked = view.status !== 'complete' ? '本次响应没有完整结束，暂不演示工具提交或执行。' : argumentsList.find(item => item.error)?.error;
    const piBlocks = blocked ? [] : related.map((tool,index) => ({type:'toolCall',id:scene.protocol === 'responses' ? `${tool.callID}|${tool.itemID}` : tool.callID,name:tool.name,arguments:argumentsList[index].value}));
    const harnessBlocks = piBlocks.map(block => ({type:'tool-call',id:block.id,name:block.name,arguments:JSON.stringify(block.arguments)}));
    const selectedIndex = related.findIndex(tool => toolKey(tool) === toolKey(selected));
    const message = {role:'assistant',content:harnessBlocks};
    const event = {type:'assistant/message',data:{message},surfaceOp:'append'};
    const sourceEvent = scene.sse.find(record => scene.protocol === 'responses'
      ? record.object?.item?.call_id === selected.callID
      : record.object?.choices?.some(choice => choice.index === selected.choice && choice.delta?.tool_calls?.some(tool => tool.id === selected.callID)));
    const upstream = scene.protocol === 'responses' ? scene.result.object.output[selected.index] : scene.result.object.choices[selected.choice].tool_calls[selected.index];
    return {tools,view,selected,related,selectedIndex,blocked,piBlocks,harnessBlocks,message,event,upstream,sourceEvent};
  }

  // JSON 内容先转义再高亮；卡片标题说明数据是实际记录还是演示片段。
  function code(title, value, label=title) {
    return `<section class="journey-code-card"><h3>${e(title)}</h3><pre class="code" tabindex="0" aria-label="${e(label)}">${C.highlight(C.pretty(value))}</pre></section>`;
  }

  // 来源使用固定提交链接，避免仓库后续修改使解释失去对应依据。
  function source(path, line, label) {
    return `<a href="${repository}${path}#L${line}" target="_blank" rel="noopener noreferrer">${e(label)} ↗</a>`;
  }

  // 显示同一调用在各层的关联字段，而不是把不同请求或同名工具混在一起。
  function identity(scene, data) {
    if (!data.selected) return '';
    const tool = data.selected;
    const projectedID = scene.protocol === 'responses' ? `${tool.callID}|${tool.itemID}` : tool.callID;
    return `<div class="journey-identity"><strong>${e(tool.name)} · 同一调用的关联</strong><dl><dt>上游调用 ID</dt><dd>${e(tool.callID)}</dd>${tool.itemID ? `<dt>上游 Item ID</dt><dd>${e(tool.itemID)}</dd>` : ''}<dt>pi-ai / Harness ID（演示）</dt><dd>${e(projectedID)}</dd></dl><p>${scene.protocol === 'responses' ? '演示规则：call_id 与 Item ID 用 | 连接；下一次 Responses 请求再拆回 call_id。' : 'Chat 调用 ID 在这些映射中保持不变。'} 点击流程步骤查看同一调用的表示。</p></div>`;
  }

  // 模型响应来自已保存日志；后续转换不假装是这次请求实际运行过的 Harness。
  function responseStage(scene, data) {
    if (scene.httpError) return code('真实 HTTP 错误响应',scene.httpError.object);
    const jump = data.sourceEvent?.event_index || scene.sse.length;
    return `<p class="journey-description">请求 1：本场景已保存的 API 响应。此处读取完整样本，独立于逐步回放游标。</p>${code(data.selected ? '选中调用 · 真实 API 数据' : '完整结果 · 真实 API 数据',data.selected ? data.upstream : scene.result.object)}<button class="outline-btn" data-action="journey-replay" data-index="${jump}">定位上游 SSE #${jump}</button><p class="journey-note">${e(scene.protocol === 'chat' ? '日志中的 ChatResult 是项目累积器结构，choices/tool_calls 以编号为键。' : '此对象是项目 Go ResponseObject 已建模字段；完整上游 JSON 可在 SSE 检查器查看。')}</p>`;
  }

  // 无工具调用时明确说明适用范围，不把不存在的阶段展示成空对象。
  function unavailable(data) {
    return `<div class="journey-empty"><strong>${data.selected ? '本次响应不满足转换演示条件' : '不适用：本场景没有工具调用'}</strong><p>${e(data.blocked)}</p><p>此页目前只实现工具调用链路的结构演示。正文与推理的适配、会话写入尚未实现展示，不代表它们在真实 Harness 中为空。可切换“单工具调用”或“双工具调用”场景查看已有演示。</p></div>`;
  }

  // 展示工具块的类型与参数表示转换，不伪造完整 pi-ai 消息或流式运行记录。
  function adapterStage(scene, data) {
    if (data.blocked) return unavailable(data);
    const index = data.selectedIndex;
    const pi = data.piBlocks[index], block = data.harnessBlocks[index];
    return `<p class="journey-description">源码结构演示：适配器边接收 pi-ai 事件边转换，不需要等待整份消息完成。本例只展示工具块片段，index 是片段内的演示索引。</p><div class="journey-pair">${code('pi-ai · toolcall_end 片段',{type:'toolcall_end',contentIndex:index,toolCall:pi},'pi-ai 工具结束事件片段')}${code('Harness · block-end',{type:'block-end',index,block},'Harness 工具块结束事件')}</div><table class="journey-mapping"><thead><tr><th>变化</th><th>pi-ai</th><th>Harness</th></tr></thead><tbody><tr><td>工具类型</td><td><code>toolCall</code></td><td><code>tool-call</code></td></tr><tr><td>参数类型</td><td>对象</td><td>JSON 字符串</td></tr><tr><td>调用 ID</td><td colspan="2"><code>${e(pi.id)}</code> 保持关联</td></tr></tbody></table><p class="journey-note">JSON.stringify 会重新编码参数，空格和转义写法可能与上游不同。此处不是 OpenAI 官方响应结构，也不是已捕获的 pi-ai 运行结果。</p><div class="journey-sources">${source('packages/llm/llm-pi-ai/src/stream.ts',174,'转换源码')}</div>`;
  }

  // 重点说明“消息内容”和“日志外壳”：省略的字段不生成假序号、时间或消息 ID。
  function eventlogStage(scene, data) {
    if (data.blocked) return unavailable(data);
    return `<p class="journey-description">源码结构演示：流结束并完成检查后，收集器生成 assistant 消息；session.append 再给消息加上日志事件外壳。下面保留同一候选的全部工具块。</p><div class="journey-pair">${code('输入：Harness assistant 消息片段',data.message,'Harness assistant 消息片段')}${code('输出：EventLog 事件片段',data.event,'EventLog assistant/message 结构片段')}</div><table class="journey-mapping"><thead><tr><th>输入位置</th><th>输出位置</th><th>发生了什么</th></tr></thead><tbody><tr><td><code>role / content</code></td><td><code>data.message.role / content</code></td><td>消息内容原样包入事件</td></tr><tr><td>由提交动作决定</td><td><code>type: assistant/message</code></td><td>新增事件类型</td></tr><tr><td>会话提交意图</td><td><code>surfaceOp: append</code></td><td>追加到有效会话历史</td></tr></tbody></table><p class="journey-note">未采集并省略：消息 id、source/replayState、事件 seq/time、turn/step、usage 和 stream。这里没有执行 session.append，也没有产生真实 EventLog。正式记录还需要这些运行时字段。</p><div class="journey-sources">${source('packages/core/agent-loop/src/agent.ts',528,'消息生成与提交源码')}${source('packages/core/session/src/index.ts',818,'事件外壳源码')}</div>`;
  }

  // 工具阶段只显示已知的输入和缺失的证据，不编造天气查询结果。
  function toolStage(scene, data) {
    return `<p class="journey-description">请求 1 生成工具调用，不等于工具已经执行。当前 API 样本没有执行工具，也没有采集 Harness 工具日志。</p>${data.selected ? code('已知输入：API 工具调用',data.upstream) : ''}<div class="journey-empty"><strong>未采集：tool/call、tool/result</strong><p>后续接入工具开始事件、实际执行参数、结果内容及成功或失败状态后，才能展示执行过程。</p></div><table class="journey-mapping"><thead><tr><th>需要关联的字段</th><th>作用</th></tr></thead><tbody><tr><td><code>tool/call.data.callId</code></td><td>关联 assistant 中的工具调用</td></tr><tr><td><code>tool/result.data.message.toolCallId</code></td><td>关联执行结果</td></tr><tr><td><code>sourceEventSeqs</code></td><td>指向这次工具开始事件的序号</td></tr></tbody></table><div class="journey-sources">${source('packages/core/agent-loop/src/tool-calls.ts',263,'工具日志源码')}</div>`;
  }

  // 下一轮需要真实工具结果和请求体；只解释字段关联，不生成冒充已发送的请求。
  function requestStage(scene, data) {
    return `<p class="journey-description">请求 2：未采集。Harness 先从有效会话历史派生消息，再由适配器组装下一次请求；不是把整份 EventLog 原样发给模型。</p><div class="journey-empty"><strong>缺少实际工具结果和下一次 HTTP 请求体</strong><p>需要同时采集派生历史、最终请求体与来源事件序号，才能比较“保存了什么”和“模型实际看到了什么”。</p></div><table class="journey-mapping"><thead><tr><th>接口</th><th>下次请求中的关联规则（不是实测请求）</th></tr></thead><tbody><tr><td>${scene.protocol === 'responses' ? 'Responses' : 'Chat Completions'}</td><td>${scene.protocol === 'responses' ? '<code>input[i].call_id</code>（function_call）与 <code>input[j].call_id</code>（function_call_output）对应' : '<code>messages[].tool_calls[].id</code> 与 tool 消息的 <code>tool_call_id</code> 对应'}</td></tr>${data.selected ? `<tr><td>本次上游调用 ID</td><td><code>${e(data.selected.callID)}</code></td></tr>` : ''}</tbody></table><p class="journey-note">还需核对实际配置使用的 provider、pi-ai 版本、system/user 历史及工具定义。当前演示未发送第二次模型请求。</p><div class="journey-sources">${source('packages/core/agent-loop/src/agent.ts',688,'历史派生与请求组装')}${source('packages/llm/llm-pi-ai/src/context.ts',32,'工具结果转换源码')}</div>`;
  }

  // 阶段与调用独立选择，切换后保留同一个调用标识，数据来源始终可见。
  function render(scene, requestedStage='eventlog', requestedKey) {
    const data = prepare(scene,requestedKey);
    const stage = stages.find(item => item.id === requestedStage) || stages[0];
    const renderers = {response:responseStage,adapter:adapterStage,eventlog:eventlogStage,tool:toolStage,request:requestStage};
    const stageStatus = item => !data.selected && item.id !== 'response' ? '不适用：无工具调用' : data.blocked && ['adapter','eventlog'].includes(item.id) ? '演示条件未满足' : item.status;
    const buttons = stages.map((item,index) => `<button data-action="journey-stage" data-stage="${item.id}" ${item.id === stage.id ? 'aria-current="step"' : ''}><span>${index+1}</span><strong>${item.name}</strong><small>${stageStatus(item)}</small></button>`).join('');
    const calls = data.tools.map(tool => `<button data-action="journey-tool" data-tool="${e(toolKey(tool))}" aria-pressed="${toolKey(tool) === (data.selected && toolKey(data.selected))}">${e(tool.name)} · choice ${tool.choice} / tool ${tool.index}<code>${e(tool.callID)}</code></button>`).join('');
    return `<div class="journey-intro"><h2>${data.selected ? '一次工具调用的完整过程' : '本场景响应与工具链路适用范围'}</h2><p>请求 1：真实 API 样本。转换与会话提交：源码结构演示。工具执行与请求 2：未采集。</p><p>流程按处理层次组织；适配器转换会与接收流同时推进，不代表每一步都要等待上一步全部完成。</p></div><nav class="journey-rail" aria-label="调用处理阶段">${buttons}</nav>${calls ? `<div class="journey-calls" aria-label="选择关联工具调用">${calls}</div>` : ''}<section class="panel journey-stage-panel"><div class="panel-head"><span class="panel-title">${e(stage.name)}</span><span class="badge ${stage.id === 'response' ? 'good' : 'warn'}">${e(stageStatus(stage))}</span></div>${!data.selected && stage.id === 'response' ? unavailable(data) : identity(scene,data)}<div class="journey-stage-content">${!data.selected && stage.id !== 'response' ? unavailable(data) : renderers[stage.id](scene,data)}</div></section><p class="journey-provenance">转换依据：Harness 源码 ${revision.slice(0,7)}。浏览本视图不执行工具、不写会话、不请求模型。</p>`;
  }

  window.StreamJourney = {stages,prepare,render,toolKey};
})();
