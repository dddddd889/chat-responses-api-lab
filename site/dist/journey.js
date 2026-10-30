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

  // 从完整样本投影内容块；推理从 SSE 读取，避免旧 Go 日志遗漏字段。
  function prepare(scene, requestedKey) {
    const view = C.finalView(scene), tools = view.tools;
    const selected = tools.find(tool => toolKey(tool) === requestedKey) || tools[0] || null;
    const choice = selected?.choice ?? 0;
    const related = tools.filter(tool => tool.choice === choice);
    const native = scene.result?.object;
    const terminal = scene.sse.map(record => record.object).find(event => ['response.completed','response.incomplete','response.failed'].includes(event?.type));
    const lengthLimited = view.finish === 'length' || terminal?.response?.incomplete_details?.reason === 'max_output_tokens' || native?.incomplete_details?.reason === 'max_output_tokens';
    const invalid = related.map(tool => parseArguments(tool.arguments)).find(item => item.error);
    const blocked = scene.httpError ? 'HTTP 请求被拒绝，没有 assistant 内容可转换。' : (view.status === 'partial' && !lengthLimited ? '本次响应没有完整结束，不能演示正式会话提交。' : invalid?.error || null);
    const piBlocks = [];
    // pi-ai 内容块索引按块出现顺序计数，不能直接拿 output_index 当 contentIndex。
    function addTool(tool) {
      if (!tool) return;
      const parsed = parseArguments(tool.arguments);
      if (!parsed.error) piBlocks.push({type:'toolCall',id:scene.protocol === 'responses' ? `${tool.callID}|${tool.itemID}` : tool.callID,name:tool.name,arguments:parsed.value});
    }
    if (!blocked && scene.protocol === 'responses') {
      for (const item of terminal?.response?.output || native?.output || []) {
        if (item.type === 'reasoning') {
          // pi-ai 的结束校准优先取 summary，再取 content，二者不重复叠加。
          const thinking = item.summary?.map(part => part.text || '').join('\n\n') || item.content?.map(part => part.text || '').join('\n\n') || '';
          if (thinking) piBlocks.push({type:'thinking',thinking});
        } else if (item.type === 'message') {
          const text = (item.content || []).map(part => part.type === 'refusal' ? part.refusal || '' : part.text || '').join('');
          if (text) piBlocks.push({type:'text',text});
        } else if (item.type === 'function_call') addTool(related.find(tool => tool.itemID === item.id));
      }
    } else if (!blocked) {
      // Chat 的正文和推理按实际增量切换顺序分块；工具块在首次出现时占位。
      const toolSlots = new Set();
      for (const record of scene.sse) for (const entry of record.object?.choices || []) {
        if (entry.index !== choice) continue;
        const delta = entry.delta || {};
        for (const [type,text] of [['text',delta.content],['thinking',delta.reasoning_content || delta.reasoning || delta.reasoning_text]]) {
          if (!text) continue;
          const field = type === 'thinking' ? 'thinking' : 'text';
          const last = piBlocks[piBlocks.length-1];
          if (last?.type === type) last[field] += text;
          else piBlocks.push({type,[field]:text});
        }
        for (const part of delta.tool_calls || []) if (!toolSlots.has(part.index)) {
          toolSlots.add(part.index);addTool(related.find(tool => tool.index === part.index));
        }
      }
    }
    const harnessBlocks = piBlocks.map(block => block.type === 'thinking' ? {type:'reasoning',text:block.thinking} : block.type === 'text' ? {type:'text',text:block.text} : {type:'tool-call',id:block.id,name:block.name,arguments:JSON.stringify(block.arguments)});
    const selectedIndex = selected ? piBlocks.findIndex(block => block.type === 'toolCall' && block.id === (scene.protocol === 'responses' ? `${selected.callID}|${selected.itemID}` : selected.callID)) : 0;
    const message = {role:'assistant',content:harnessBlocks};
    // usage 属于 EventLog data，而非 message.content；不伪造运行时 ID、seq、time。
    const rawUsage = scene.sse.map(record => scene.protocol === 'chat' ? record.object?.usage : record.object?.response?.usage).filter(Boolean).at(-1);
    let piUsage, usage;
    if (rawUsage) {
      const input = scene.protocol === 'chat' ? rawUsage.prompt_tokens : rawUsage.input_tokens;
      const output = scene.protocol === 'chat' ? rawUsage.completion_tokens : rawUsage.output_tokens;
      const details = scene.protocol === 'chat' ? rawUsage.prompt_tokens_details : rawUsage.input_tokens_details;
      const cacheRead = details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0, cacheWrite = details?.cache_write_tokens || 0;
      piUsage = {input:Math.max(0,input-cacheRead-cacheWrite),output,cacheRead,cacheWrite,totalTokens:scene.protocol === 'chat' ? Math.max(0,input-cacheRead-cacheWrite)+output+cacheRead+cacheWrite : rawUsage.total_tokens};
      usage = {inputTokens:piUsage.input,outputTokens:output,totalTokens:piUsage.totalTokens,...cacheRead > 0 ? {cacheReadTokens:cacheRead} : {},...cacheWrite > 0 ? {cacheWriteTokens:cacheWrite} : {}};
    }
    const event = {type:'assistant/message',data:{message,...usage ? {usage} : {}},surfaceOp:'append'};
    const sourceEvent = selected && scene.sse.find(record => scene.protocol === 'responses' ? record.object?.item?.call_id === selected.callID : record.object?.choices?.some(entry => entry.index === selected.choice && entry.delta?.tool_calls?.some(tool => tool.id === selected.callID)));
    const upstream = selected ? scene.protocol === 'responses' ? native.output[selected.index] : native.choices[selected.choice].tool_calls[selected.index] : native;
    return {tools,view,selected,related,selectedIndex,blocked,piBlocks,harnessBlocks,message,event,upstream,sourceEvent,piUsage,usage,lengthLimited};
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

  // 不满足提交条件的响应仍保留上游原文，不编造成功提交。
  function unavailable(data) {
    return `<div class="journey-empty"><strong>无法生成正式消息演示</strong><p>${e(data.blocked)}</p></div>`;
  }

  // 各类内容逐块对应；结束事件使用全文，增量规则另列说明。
  function adapterStage(scene, data) {
    if (data.blocked) return unavailable(data);
    const pairs = data.piBlocks.map((pi,index) => {
      const type = pi.type === 'thinking' ? 'thinking_end' : pi.type === 'text' ? 'text_end' : 'toolcall_end';
      const event = pi.type === 'toolCall' ? {type,contentIndex:index,toolCall:pi} : {type,contentIndex:index,content:pi.type === 'thinking' ? pi.thinking : pi.text};
      return `<div class="journey-pair">${code(`pi-ai · ${type} · 块 #${index}`,event,pi.type === 'toolCall' && index === data.selectedIndex ? 'pi-ai 工具结束事件片段' : `pi-ai 内容结束事件 #${index}`)}${code(`Harness · block-end · 块 #${index}`,{type:'block-end',index,block:data.harnessBlocks[index]},pi.type === 'toolCall' && index === data.selectedIndex ? 'Harness 工具块结束事件' : `Harness 内容块结束事件 #${index}`)}</div>`;
    }).join('');
    return `<p class="journey-description">源码结构演示：从本次 API 样本投影 pi-ai 内容块与结束事件，再按适配器映射到 Harness。块索引按内容出现顺序排列；这里不是已捕获的 pi-ai 运行记录。</p>${data.lengthLimited ? '<div class="notice">长度上限截断：保留已生成正文和推理，finish 映射为 max-tokens；不冒充完整回答。</div>' : ''}${code('pi-ai 累积内容片段',{role:'assistant',content:data.piBlocks},'pi-ai 累积内容片段')}${pairs || '<p>上游没有可展示的正文、推理或工具内容块。</p>'}<table class="journey-mapping"><thead><tr><th>pi-ai</th><th>Harness</th><th>规则</th></tr></thead><tbody><tr><td>text_delta / text_end</td><td>text-delta / block-end text</td><td>delta 追加，结束全文校准</td></tr><tr><td>thinking_delta / thinking_end</td><td>reasoning-delta / block-end reasoning</td><td>thinking → reasoning，正文独立</td></tr><tr><td>toolCall.arguments</td><td>tool-call.arguments</td><td>JSON.stringify：对象 → 字符串</td></tr></tbody></table>${data.usage ? `<div class="journey-pair">${code('pi-ai 用量片段',data.piUsage)}${code('Harness usage chunk',{type:'usage',usage:data.usage})}</div><p>pi-ai input 已扣除缓存命中与写入；Harness 保持此值，非零缓存另列，不重复加到 total。</p>` : '<p>上游未返回 usage，不补造统计。</p>'}<p class="journey-note">省略 partial、签名、成本及模型元数据。本页只演示内容和用量映射；重放所需签名在真实 Harness 的 source.replayState 中另存。</p><div class="journey-sources">${source('packages/llm/llm-pi-ai/src/stream.ts',151,'正文、推理和工具转换源码')}${source('packages/llm/llm/src/assembler.ts',63,'内容累积源码')}</div>`;
  }

  // 重点说明“消息内容”和“日志外壳”：省略的字段不生成假序号、时间或消息 ID。
  function eventlogStage(scene, data) {
    if (data.blocked) return unavailable(data);
    return `<p class="journey-description">源码结构演示：流结束并完成检查后，收集器生成 assistant 消息；session.append 再给消息加上日志事件外壳。下面保留同一候选的正文、推理和工具块；usage 位于 data.usage。</p><div class="journey-pair">${code('输入：Harness assistant 消息片段',data.message,'Harness assistant 消息片段')}${code('输出：EventLog 事件片段',data.event,'EventLog assistant/message 结构片段')}</div><table class="journey-mapping"><thead><tr><th>输入位置</th><th>输出位置</th><th>发生了什么</th></tr></thead><tbody><tr><td><code>role / content</code></td><td><code>data.message.role / content</code></td><td>消息内容原样包入事件</td></tr><tr><td>由提交动作决定</td><td><code>type: assistant/message</code></td><td>新增事件类型</td></tr><tr><td>会话提交意图</td><td><code>surfaceOp: append</code></td><td>追加到有效会话历史</td></tr></tbody></table><p class="journey-note">未采集并省略：消息 id、source/replayState、事件 seq/time、turn/step 和 stream。这里没有执行 session.append，也没有产生真实 EventLog。正式记录还需要这些运行时字段。</p><div class="journey-sources">${source('packages/core/agent-loop/src/agent.ts',528,'消息生成与提交源码')}${source('packages/core/session/src/index.ts',818,'事件外壳源码')}</div>`;
  }

  // 工具阶段只显示已知的输入和缺失的证据，不编造天气查询结果。
  function toolStage(scene, data) {
    if (!data.selected) return '<div class="journey-empty"><strong>不适用：本场景没有工具调用</strong><p>正文和推理已在前两阶段展示，无需执行工具。</p></div>';
    return `<p class="journey-description">请求 1 生成工具调用，不等于工具已经执行。当前 API 样本没有执行工具，也没有采集 Harness 工具日志。</p>${data.selected ? code('已知输入：API 工具调用',data.upstream) : ''}<div class="journey-empty"><strong>未采集：tool/call、tool/result</strong><p>后续接入工具开始事件、实际执行参数、结果内容及成功或失败状态后，才能展示执行过程。</p></div><table class="journey-mapping"><thead><tr><th>需要关联的字段</th><th>作用</th></tr></thead><tbody><tr><td><code>tool/call.data.callId</code></td><td>关联 assistant 中的工具调用</td></tr><tr><td><code>tool/result.data.message.toolCallId</code></td><td>关联执行结果</td></tr><tr><td><code>sourceEventSeqs</code></td><td>指向这次工具开始事件的序号</td></tr></tbody></table><div class="journey-sources">${source('packages/core/agent-loop/src/tool-calls.ts',263,'工具日志源码')}</div>`;
  }

  // 下一轮需要真实工具结果和请求体；只解释字段关联，不生成冒充已发送的请求。
  function requestStage(scene, data) {
    return `<p class="journey-description">请求 2：未采集。Harness 先从有效会话历史派生消息，再由适配器组装下一次请求；不是把整份 EventLog 原样发给模型。</p><div class="journey-empty"><strong>${data.selected ? '缺少实际工具结果和下一次 HTTP 请求体' : '缺少下一次用户输入、派生历史和 HTTP 请求体'}</strong><p>需要同时采集派生历史、最终请求体与来源事件序号，才能比较“保存了什么”和“模型实际看到了什么”。</p></div><table class="journey-mapping"><thead><tr><th>接口</th><th>下次请求中的关联规则（不是实测请求）</th></tr></thead><tbody><tr><td>${scene.protocol === 'responses' ? 'Responses' : 'Chat Completions'}</td><td>${scene.protocol === 'responses' ? '<code>input[i].call_id</code>（function_call）与 <code>input[j].call_id</code>（function_call_output）对应' : '<code>messages[].tool_calls[].id</code> 与 tool 消息的 <code>tool_call_id</code> 对应'}</td></tr>${data.selected ? `<tr><td>本次上游调用 ID</td><td><code>${e(data.selected.callID)}</code></td></tr>` : ''}</tbody></table><p class="journey-note">还需核对实际配置使用的 provider、pi-ai 版本、system/user 历史及工具定义。当前演示未发送第二次模型请求。</p><div class="journey-sources">${source('packages/core/agent-loop/src/agent.ts',688,'历史派生与请求组装')}${source('packages/llm/llm-pi-ai/src/context.ts',32,'工具结果转换源码')}</div>`;
  }

  // 阶段与调用独立选择，切换后保留同一个调用标识，数据来源始终可见。
  function render(scene, requestedStage='eventlog', requestedKey) {
    const data = prepare(scene,requestedKey);
    const stage = stages.find(item => item.id === requestedStage) || stages[0];
    const renderers = {response:responseStage,adapter:adapterStage,eventlog:eventlogStage,tool:toolStage,request:requestStage};
    const stageStatus = item => !data.selected && item.id === 'tool' ? '不适用：无工具调用' : data.blocked && ['adapter','eventlog'].includes(item.id) ? '演示条件未满足' : item.status;
    const buttons = stages.map((item,index) => `<button data-action="journey-stage" data-stage="${item.id}" ${item.id === stage.id ? 'aria-current="step"' : ''}><span>${index+1}</span><strong>${item.name}</strong><small>${stageStatus(item)}</small></button>`).join('');
    const calls = data.tools.map(tool => `<button data-action="journey-tool" data-tool="${e(toolKey(tool))}" aria-pressed="${toolKey(tool) === (data.selected && toolKey(data.selected))}">${e(tool.name)} · choice ${tool.choice} / tool ${tool.index}<code>${e(tool.callID)}</code></button>`).join('');
    return `<div class="journey-intro"><h2>${data.selected ? '一次工具调用的完整过程' : '本次回复的完整处理过程'}</h2><p>请求 1：真实 API 样本。转换与会话提交：源码结构演示。工具执行与请求 2：未采集。</p><p>流程按处理层次组织；适配器转换会与接收流同时推进，不代表每一步都要等待上一步全部完成。</p></div><nav class="journey-rail" aria-label="调用处理阶段">${buttons}</nav>${calls ? `<div class="journey-calls" aria-label="选择关联工具调用">${calls}</div>` : ''}<section class="panel journey-stage-panel"><div class="panel-head"><span class="panel-title">${e(stage.name)}</span><span class="badge ${stage.id === 'response' ? 'good' : 'warn'}">${e(stageStatus(stage))}</span></div>${identity(scene,data)}<div class="journey-stage-content">${renderers[stage.id](scene,data)}</div></section><p class="journey-provenance">转换依据：Harness 源码 ${revision.slice(0,7)}。浏览本视图不执行工具、不写会话、不请求模型。</p>`;
  }

  window.StreamJourney = {stages,prepare,render,toolKey};
})();
