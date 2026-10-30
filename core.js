/* 纯数据层：按本地 SSE 序号重建浏览状态，不发送请求，不执行工具。 */
(function (root) {
  'use strict';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const pretty = value => JSON.stringify(value, null, 2);

  // 将统一记录分成三层，保留原文件文本供下载。
  function prepare(meta) {
    const records = meta.sourceText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return {...meta, records, sse: records.filter(r => r.kind === 'sse'), business: records.filter(r => r.kind === 'event'), result: records.find(r => r.kind === 'result'), httpError: records.find(r => r.kind === 'http_error')};
  }

  // 保留缓存明细；命中率以输入 token 为分母，缺省与明确为 0 分开处理。
  function normalizeUsage(usage, protocol) {
    if (!usage) return null;
    const chat = protocol === 'chat';
    const input = chat ? usage.prompt_tokens : usage.input_tokens;
    const details = chat ? usage.prompt_tokens_details : usage.input_tokens_details;
    const outputDetails = chat ? usage.completion_tokens_details : usage.output_tokens_details;
    const candidate = details?.cached_tokens ?? (chat ? usage.prompt_cache_hit_tokens : undefined);
    const validCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const inputKnown = validCount(input);
    const cached = validCount(candidate) && (!inputKnown || candidate <= input) ? candidate : null;
    return {
      input_tokens:input,
      output_tokens:chat ? usage.completion_tokens : usage.output_tokens,
      total_tokens:usage.total_tokens,
      input_tokens_details:clone(details ?? null),
      output_tokens_details:clone(outputDetails ?? null),
      cached_tokens:cached,
      uncached_tokens:cached != null && inputKnown ? input-cached : null,
      cache_hit_rate:cached != null && inputKnown && input > 0 ? cached/input : null
    };
  }

  // 两种协议的完整对象转成可比较的展示数据，原始对象仍单独保留。
  function finalView(scenario) {
    const native = scenario.result?.object;
    if (!native) return {text:'', refusal:'', tools:[], usage:null, status:'http_error', native:null};
    let text = '', refusal = '', tools = [], usage = null, finish = '';
    if (scenario.protocol === 'chat') {
      for (const [choice, answer] of Object.entries(native.choices || {})) {
        text += answer.content || ''; refusal += answer.refusal || '';
        if (answer.finish_reason === 'length') finish = 'length';
        for (const [tool, call] of Object.entries(answer.tool_calls || {})) tools.push({choice:Number(choice), index:Number(tool), callID:call.id, itemID:'', name:call.function.name, arguments:call.function.arguments, complete:true});
      }
      usage = normalizeUsage(native.usage,'chat');
    } else {
      (native.output || []).forEach((item, index) => {
        if (item.type === 'function_call') tools.push({choice:0,index,callID:item.call_id,itemID:item.id,name:item.name,arguments:item.arguments || '',complete:item.status === 'completed' || native.status === 'completed'});
        for (const part of item.content || []) { if (part.type === 'output_text') text += part.text || ''; if (part.type === 'refusal') refusal += part.refusal || ''; }
      });
      usage = normalizeUsage(native.usage,'responses');
    }
    return {text,refusal,tools,usage,native,finish,status:scenario.result.status === 'partial' ? 'partial' : finish === 'length' ? 'truncated' : 'complete'};
  }

  // 重放到指定序号；delta 追加，done 全文替换，避免参数重复拼接。
  function snapshot(scenario, cursor) {
    const max = scenario.sse.length;
    const step = Math.max(0, Math.min(max, Number(cursor) || 0));
    const state = {step,max,text:'',refusal:'',reasoning:'',tools:[],usage:null,status:'waiting',finish:'',authoritative:false};
    if (scenario.httpError) return {...state,status:'http_error',error:scenario.httpError.object};
    if (!step) return state;
    state.status = 'streaming';
    const tools = new Map(), parts = new Map();
    let transportDone = false;
    for (const record of scenario.sse.slice(0, step)) {
      const event = record.object;
      if (scenario.protocol === 'chat') {
        if (record.data === '[DONE]') { transportDone = true; continue; }
        for (const choice of event?.choices || []) {
          const delta = choice.delta || {};
          state.text += delta.content || ''; state.refusal += delta.refusal || ''; state.reasoning += delta.reasoning_content || '';
          for (const call of delta.tool_calls || []) {
            const key = `${choice.index}:${call.index}`;
            const tool = tools.get(key) || {choice:choice.index,index:call.index,callID:'',itemID:'',name:'',arguments:'',complete:false};
            if (call.id != null) tool.callID = call.id;
            tool.name += call.function?.name || ''; tool.arguments += call.function?.arguments || '';
            tools.set(key,tool);
          }
          if (choice.finish_reason) {
            state.finish = choice.finish_reason;
            if (choice.finish_reason === 'tool_calls') for (const tool of tools.values()) if (tool.choice === choice.index) tool.complete = true;
          }
        }
        if (event?.usage) state.usage = normalizeUsage(event.usage,'chat');
      } else if (event) {
        const index = event.output_index;
        if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
          const item = event.item;
          if (item?.type === 'function_call') tools.set(index,{choice:0,index,callID:item.call_id || '',itemID:item.id,name:item.name || '',arguments:item.arguments || '',complete:event.type.endsWith('.done') && item.status !== 'incomplete'});
        }
        if (event.type === 'response.function_call_arguments.delta' || event.type === 'response.function_call_arguments.done') {
          const tool = tools.get(index);
          if (tool) tool.arguments = event.type.endsWith('.done') ? event.arguments : tool.arguments + (event.delta || '');
        }
        if (['response.output_text.delta','response.output_text.done','response.refusal.delta','response.refusal.done'].includes(event.type)) {
          const key = `${index}:${event.content_index}:${event.type.includes('refusal') ? 'refusal' : 'text'}`;
          parts.set(key, event.type.endsWith('.delta') ? (parts.get(key) || '') + (event.delta || '') : (event.text ?? event.refusal ?? ''));
        }
        if (event.response?.usage) state.usage = normalizeUsage(event.response.usage,'responses');
        if (['response.completed','response.incomplete','response.failed'].includes(event.type)) {
          transportDone = true; state.status = event.type === 'response.completed' ? 'complete' : 'partial';
        }
      }
    }
    if (scenario.protocol === 'responses') {
      for (const [key,value] of parts) { if (key.endsWith('refusal')) state.refusal += value; else state.text += value; }
    }
    state.tools = [...tools.values()].sort((a,b) => a.choice-b.choice || a.index-b.index);
    if (step === max && scenario.result) {
      const final = finalView(scenario);
      Object.assign(state,{text:final.text,refusal:final.refusal,tools:final.tools,usage:final.usage,finish:final.finish || state.finish,status:final.status,authoritative:true});
    } else if (transportDone && state.status === 'streaming') state.status = state.finish === 'length' ? 'truncated' : 'complete';
    return state;
  }

  // 将第一层事件简要命名，完整 JSON 始终保留在检查器中。
  function describe(record, protocol) {
    const event = record.object;
    if (record.data === '[DONE]') return {type:'结束标记',detail:'[DONE]',category:'done'};
    if (!event) return {type:'非 JSON 数据',detail:record.data || '',category:'error'};
    if (protocol === 'chat') {
      const choice = event.choices?.[0], delta = choice?.delta || {}, call = delta.tool_calls?.[0];
      if (call) return {type:`工具 ${call.index} · ${call.function?.name ? '开始' : '参数增量'}`,detail:call.function?.name || call.function?.arguments || '空片段',category:'tool'};
      if (choice?.finish_reason) return {type:'候选结束',detail:choice.finish_reason,category:'done'};
      if (event.usage) return {type:'请求用量',detail:`${event.usage.total_tokens} tokens`,category:'usage'};
      if (delta.reasoning_content != null) return {type:'思考增量',detail:delta.reasoning_content || '开始思考',category:'reasoning'};
      return {type:delta.role ? '回答开始' : '文本增量',detail:delta.content || delta.refusal || delta.role || '元数据',category:'text'};
    }
    const type = event.type || record.event;
    if (type.includes('function_call_arguments')) return {type:type.endsWith('.delta') ? `工具 ${event.output_index} · 参数增量` : `工具 ${event.output_index} · 参数全文`,detail:event.delta ?? event.arguments ?? '',category:'tool'};
    if (type.includes('output_item')) return {type:event.item?.type === 'function_call' ? `工具 ${event.output_index} · ${type.endsWith('.added') ? '开始' : '完成'}` : '输出项目',detail:event.item?.name || event.item?.type || '',category:event.item?.type === 'function_call' ? 'tool' : 'text'};
    if (type.includes('output_text')) return {type:type.endsWith('.delta') ? '文本增量' : '文本全文',detail:event.delta ?? event.text ?? '',category:'text'};
    if (type === 'response.incomplete') return {type:'响应未完成',detail:'达到生成长度上限',category:'error'};
    if (type === 'response.completed') return {type:'响应完成',detail:`${event.response?.usage?.total_tokens ?? '—'} tokens`,category:'done'};
    return {type:type.replace(/^response\./,''),detail:event.delta || event.response?.status || '',category:type.includes('reasoning') ? 'reasoning' : 'meta'};
  }

  // 安全高亮 JSON：所有原文先转义，再添加固定的 token 标签。
  function highlight(value) {
    const text = typeof value === 'string' ? value : pretty(value);
    if (text == null) return '';
    const pattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
    let result = '', previous = 0;
    for (const match of text.matchAll(pattern)) {
      result += escapeHTML(text.slice(previous,match.index));
      const token = match[0], category = token.startsWith('"') ? (/^\s*:/.test(text.slice(match.index+token.length)) ? 'key' : 'string') : /true|false|null/.test(token) ? 'literal' : 'number';
      result += `<span class="json-${category}">${escapeHTML(token)}</span>`;
      previous = match.index + token.length;
    }
    return result + escapeHTML(text.slice(previous));
  }

  const api = {prepare,finalView,snapshot,normalizeUsage,describe,pretty,escapeHTML,highlight};
  root.StreamCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
