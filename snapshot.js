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

  // JSON 视图保留纯对象，复制按钮也始终复制该对象，不夹带 diff 标记。
  function render(scene, snapshot) {
    return `<div class="snapshot-json-label">截至 SSE #${snapshot.step} · 与完整结果使用相同字段结构</div><div class="snapshot-json"><pre class="code" tabindex="0" aria-label="合并对象 JSON">${C.highlight(C.pretty(object(scene,snapshot)))}</pre></div>`;
  }

  // 用最长公共子序列对齐两份 JSON 的行，保留未变行并区分删除行和新增行。
  function diffLines(before, after) {
    const oldLines = C.pretty(before).split('\n'), newLines = C.pretty(after).split('\n');
    const lengths = Array.from({length:oldLines.length+1},() => new Uint32Array(newLines.length+1));
    for (let i=oldLines.length-1;i>=0;i--) for (let j=newLines.length-1;j>=0;j--) {
      lengths[i][j] = oldLines[i] === newLines[j] ? lengths[i+1][j+1]+1 : Math.max(lengths[i+1][j],lengths[i][j+1]);
    }
    const rows = [];
    let i=0,j=0;
    while (i<oldLines.length || j<newLines.length) {
      if (i<oldLines.length && j<newLines.length && oldLines[i] === newLines[j]) {
        rows.push({kind:'context',text:oldLines[i++]});j++;
      } else if (i<oldLines.length && (j===newLines.length || lengths[i+1][j]>=lengths[i][j+1])) {
        rows.push({kind:'delete',text:oldLines[i++]});
      } else rows.push({kind:'add',text:newLines[j++]});
    }
    return {rows,oldCount:oldLines.length,newCount:newLines.length};
  }

  // 两种差异视图共用同一套行对齐，标题明确指出比较方向。
  function renderLineDiff(before, after, beforeName, afterName, label) {
    const diff = diffLines(before,after);
    const added = diff.rows.filter(row => row.kind === 'add').length;
    const deleted = diff.rows.filter(row => row.kind === 'delete').length;
    const header = `--- ${beforeName}\n+++ ${afterName}\n@@ -1,${diff.oldCount} +1,${diff.newCount} @@`;
    const rows = diff.rows.map(row => `<span class="diff-line diff-${row.kind}"><span class="diff-marker">${row.kind === 'add' ? '+' : row.kind === 'delete' ? '-' : ' '}</span>${C.highlight(row.text)}</span>`).join('\n');
    return `<div class="snapshot-json-label">${C.escapeHTML(beforeName)} → ${C.escapeHTML(afterName)} · <span class="diff-added-count">+${added} 行</span> / <span class="diff-deleted-count">−${deleted} 行</span></div><div class="snapshot-json snapshot-diff"><pre class="code" tabindex="0" aria-label="${C.escapeHTML(label)}"><span class="diff-header">${C.escapeHTML(header)}</span>\n${rows}</pre></div>`;
  }

  // 中间列比较相邻事件，显示本条 SSE 带来的变化。
  function renderDiff(scene, snapshot) {
    const previousStep = Math.max(0,snapshot.step-1);
    return renderLineDiff(object(scene,{step:previousStep}),object(scene,snapshot),`SSE #${previousStep}`,`SSE #${snapshot.step}`,'拼接状态 Git diff');
  }

  // 右列比较当前累积对象和固定日志终点；仅差异随进度变化，原始日志不被修改。
  function renderResult(scene, snapshot, mode='diff') {
    const current = object(scene,snapshot), final = scene.result.object;
    const diffs = differences(current,final);
    const status = `<div class="result-match" role="status">${diffs.length ? `距日志终点还有 ${diffs.length} 处字段差异` : '逐字段一致：当前状态已达到日志终点'}</div>`;
    if (mode === 'json') return status+`<div class="snapshot-json-label">日志完整结果 · 固定原文</div><div class="final-result-code"><pre class="code" tabindex="0" aria-label="日志完整结果 JSON">${C.highlight(C.pretty(final))}</pre></div>`;
    return status+renderLineDiff(current,final,`当前 SSE #${snapshot.step}`,'日志完整结果','完整结果 Git diff');
  }

  window.StreamSnapshotView = {object,render,renderDiff,diffLines,renderLineDiff,renderResult,differences,toggleLabel,copyLabel:'复制当前累积对象 JSON'};
})();
