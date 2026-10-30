/* 按 Go 累积器的日志结构重放 SSE；结果对照与回放信息不混入对象。 */
(function () {
  'use strict';
  const C = window.StreamCore;
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const toggleLabel = mode => mode === 'json' ? '内容摘要' : 'JSON';

  // 对齐 Go 的 usage 字段；缺省明细保留 null，不加入页面计算的缓存指标。
  function usageOf(usage, chat) {
    if (!usage) return null;
    const input = chat ? 'prompt_tokens' : 'input_tokens';
    const output = chat ? 'completion_tokens' : 'output_tokens';
    return {[input]:usage[input] ?? 0,[output]:usage[output] ?? 0,total_tokens:usage.total_tokens ?? 0,
      [chat ? 'prompt_tokens_details' : 'input_tokens_details']:clone(usage[chat ? 'prompt_tokens_details' : 'input_tokens_details'] ?? null),
      [chat ? 'completion_tokens_details' : 'output_tokens_details']:clone(usage[chat ? 'completion_tokens_details' : 'output_tokens_details'] ?? null)};
  }

  // Chat 的 choices/tool_calls 按编号保存为对象，与 ChatResult 日志一致。
  function chatObject(records) {
    const result = {id:'',model:'',created:0,choices:{},usage:null};
    for (const record of records) {
      const event = record.object;
      if (!event || record.data === '[DONE]') continue;
      if (!result.id) {result.id = event.id;result.model = event.model;result.created = event.created;}
      if (event.usage) result.usage = usageOf(event.usage,true);
      for (const choice of event.choices || []) {
        const answer = result.choices[choice.index] ||= {index:choice.index,role:'',content:'',refusal:'',finish_reason:null,tool_calls:{},function_call:null};
        const delta = choice.delta || {};
        if (delta.role != null) answer.role = delta.role;
        answer.content += delta.content || '';answer.refusal += delta.refusal || '';
        if (choice.finish_reason != null) answer.finish_reason = choice.finish_reason;
        if (delta.function_call) {
          answer.function_call ||= {name:'',arguments:''};
          answer.function_call.name += delta.function_call.name || '';
          answer.function_call.arguments += delta.function_call.arguments || '';
        }
        for (const part of delta.tool_calls || []) {
          const tool = answer.tool_calls[part.index] ||= {index:part.index,id:'',type:'',function:{name:'',arguments:''}};
          if (part.id != null) tool.id = part.id;
          if (part.type != null) tool.type = part.type;
          tool.function.name += part.function?.name || '';
          tool.function.arguments += part.function?.arguments || '';
        }
      }
    }
    return result;
  }

  // 对齐 ResponsePart 的已建模字段；完整上游扩展仍可在事件检查器查看。
  function responsePart(part) {
    const result = {type:part.type};
    if (part.text) result.text = part.text;
    if (part.refusal) result.refusal = part.refusal;
    return result;
  }

  // 对齐 ResponseItem 的字段和省略规则，避免把注解等扩展误标成日志字段。
  function responseItem(item) {
    const result = {id:item.id,type:item.type};
    for (const key of ['status','role','call_id','name','arguments']) if (item[key]) result[key] = item[key];
    if (item.content?.length) result.content = item.content.filter(Boolean).map(responsePart);
    return result;
  }

  // 生命周期只接收事件携带的 response，绝不读取场景最终日志反填。
  function responseObject(records) {
    let result = {id:'',status:'',model:'',output:[],usage:null,error:null,incomplete_details:null};
    const items = new Map();
    for (const record of records) {
      const event = record.object;
      if (!event) continue;
      if (event.response) {
        const response = event.response;
        result = {id:response.id,status:response.status,model:response.model,output:(response.output || []).map(responseItem),
          usage:usageOf(response.usage,false),error:clone(response.error ?? null),incomplete_details:clone(response.incomplete_details ?? null)};
        if (['response.completed','response.incomplete','response.failed'].includes(event.type)) return result;
      }
      const index = event.output_index;
      if (['response.output_item.added','response.output_item.done'].includes(event.type)) items.set(index,responseItem(event.item));
      const item = items.get(index);
      if (!item) continue;
      if (event.type === 'response.function_call_arguments.delta') item.arguments = (item.arguments || '') + (event.delta || '');
      if (event.type === 'response.function_call_arguments.done') item.arguments = event.arguments;
      if (['response.output_text.delta','response.output_text.done','response.refusal.delta','response.refusal.done'].includes(event.type)) {
        item.content ||= [];
        const refusal = event.type.includes('refusal');
        const field = refusal ? 'refusal' : 'text';
        const part = item.content[event.content_index] ||= {type:refusal ? 'refusal' : 'output_text'};
        part[field] = event.type.endsWith('.delta') ? (part[field] || '') + (event.delta || '') : event[field];
      }
    }
    if (items.size) result.output = [...items.entries()].sort(([a],[b]) => a-b).map(([,item]) => responseItem(item));
    return result;
  }

  // 只消费当前位置之前的 SSE；播放到终点也使用同一条重放路径。
  function object(scene, snapshot) {
    if (scene.httpError) return clone(scene.httpError.object);
    const records = scene.sse.slice(0,snapshot.step);
    return scene.protocol === 'chat' ? chatObject(records) : responseObject(records);
  }

  // 递归比较同一路径的值；属性顺序不影响比较，数组保留索引语义。
  function differences(current, final, path='$') {
    if (Object.is(current,final)) return [];
    if (current && final && typeof current === 'object' && typeof final === 'object' && Array.isArray(current) === Array.isArray(final)) {
      const keys = [...new Set([...Object.keys(current),...Object.keys(final)])];
      return keys.flatMap(key => differences(current[key],final[key],Array.isArray(current) ? `${path}[${key}]` : `${path}.${key}`));
    }
    return [{path,current,final}];
  }

  // JSON 始终展示累积器对象；序号和状态留在对象外，方便直接复制对照。
  function render(scene, snapshot) {
    return `<div class="snapshot-json-label">截至 SSE #${snapshot.step} · 与完整结果使用相同字段结构</div><div class="snapshot-json"><pre class="code" tabindex="0" aria-label="合并对象 JSON">${C.highlight(C.pretty(object(scene,snapshot)))}</pre></div>`;
  }

  // 同时给出当前事件的更新路径和当前值/终点值，建立事件到最终字段的关联。
  function comparison(scene, snapshot) {
    const current = object(scene,snapshot);
    const previous = object(scene,{step:Math.max(0,snapshot.step-1)});
    const changes = snapshot.step ? differences(previous,current) : [];
    const diffs = differences(current,scene.result.object);
    const value = item => item === undefined ? '尚无此字段' : C.pretty(item);
    const updated = changes.length ? changes.map(change => `<code>${C.escapeHTML(change.path)}</code>`).join('、') : '本条没有更新已建模字段（可能是结束标记或扩展事件）';
    const rows = diffs.map(diff => `<tr><td><code>${C.escapeHTML(diff.path)}</code></td><td><pre>${C.escapeHTML(value(diff.current))}</pre></td><td><pre>${C.escapeHTML(value(diff.final))}</pre></td></tr>`).join('');
    return `<p class="comparison-update">${snapshot.step ? `SSE #${snapshot.step} 更新` : '尚未接收事件'}：${snapshot.step ? updated : '选择事件，观察字段逐步补全。'}</p><p class="comparison-status" role="status">${diffs.length ? `当前有 ${diffs.length} 处字段差异${snapshot.step === snapshot.max ? '，请检查终点结果' : '，继续接收事件后对照'}` : '逐字段一致：当前累积对象与日志完整结果相同'}</p>${diffs.length ? `<div class="comparison-table-wrap"><table class="comparison-table"><thead><tr><th>字段路径</th><th>当前累积值</th><th>日志最终值</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
  }

  window.StreamSnapshotView = {object,render,comparison,differences,toggleLabel,copyLabel:'复制当前累积对象 JSON'};
})();
