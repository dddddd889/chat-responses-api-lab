/* 用真实 SSE 驱动源码映射演示：逐条累积，不从最终日志反填未来内容。 */
(function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));

  // pi-ai 输入统计扣除缓存；Harness 保留该口径，非零缓存另列。
  function mapUsage(raw, chat) {
    const details = chat ? raw.prompt_tokens_details : raw.input_tokens_details;
    const cacheRead = details?.cached_tokens ?? (chat ? raw.prompt_cache_hit_tokens : 0) ?? 0;
    const cacheWrite = details?.cache_write_tokens || 0;
    const input = Math.max(0,(chat ? raw.prompt_tokens : raw.input_tokens)-cacheRead-cacheWrite);
    const output = (chat ? raw.completion_tokens : raw.output_tokens) || 0;
    const totalTokens = chat ? input+output+cacheRead+cacheWrite : raw.total_tokens;
    return {pi:{input,output,cacheRead,cacheWrite,totalTokens},harness:{inputTokens:input,outputTokens:output,totalTokens,...cacheRead ? {cacheReadTokens:cacheRead} : {},...cacheWrite ? {cacheWriteTokens:cacheWrite} : {}}};
  }

  // 时间轴每步保存当时的内容快照；块 start/delta/end、终止与提交分别可观察。
  function build(scene, choice=0) {
    const frames = [], pi = [], harness = [], slots = new Map(), closed = new Set();
    let sse = 0, raw = null, usage = null, harnessUsage = null, finish = null, ended = false, error = '', currentChat = null;
    // 保存同一 SSE 引发的映射与累积状态，来源序号可回到上游检查器。
    function save(label, piEvent=null, chunks=[], event=null) {
      frames.push(clone({label,sse,raw,piEvent,chunks,piBlocks:pi,harnessBlocks:harness,piUsage:usage?.pi || null,usage:harnessUsage,finish,event,error}));
    }
    // pi-ai 的类型、块编号和增量在 Harness 中一一映射。
    function emit(event) {
      const index = event.contentIndex, block = pi[index];
      let chunks = [];
      if (event.type.endsWith('_start')) {
        harness[index] = block.type === 'toolCall' ? {type:'tool-call',id:block.id,name:block.name,arguments:''} : {type:block.type === 'thinking' ? 'reasoning' : 'text',text:''};
        chunks = [{type:'block-start',index,blockType:harness[index].type}];
      } else if (event.type.endsWith('_delta') && !closed.has(index)) {
        const tool = block.type === 'toolCall';
        if (tool) {harness[index].arguments += event.delta;chunks=[{type:'tool-call-delta',index,id:block.id,...block.name ? {name:block.name} : {},argumentsDelta:event.delta}];}
        else {harness[index].text += event.delta;chunks=[{type:block.type === 'thinking' ? 'reasoning-delta' : 'text-delta',index,text:event.delta}];}
      } else if (event.type.endsWith('_end') && !closed.has(index)) {
        harness[index] = block.type === 'toolCall' ? {type:'tool-call',id:block.id,name:block.name,arguments:JSON.stringify(block.arguments)} : {type:block.type === 'thinking' ? 'reasoning' : 'text',text:event.content};
        closed.add(index);chunks=[{type:'block-end',index,block:harness[index]}];
      }
      save(event.type,event,chunks);
    }
    // 工具的原始参数字符串只在结束且可解析时转成对象；不猜测不完整 JSON。
    function start(key,type,meta={}) {
      if (slots.has(key)) return slots.get(key);
      const index=pi.length;
      pi.push(type === 'toolCall' ? {type,id:meta.id || '',name:meta.name || '',arguments:{}} : type === 'thinking' ? {type,thinking:''} : {type,text:''});
      slots.set(key,{index,type,arguments:''});
      emit({type:type === 'toolCall' ? 'toolcall_start' : type === 'thinking' ? 'thinking_start' : 'text_start',contentIndex:index});
      return slots.get(key);
    }
    // 只追加已收到的 delta，绝不借用样本的最终内容。
    function delta(slot,text) {
      if (!text || closed.has(slot.index)) return;
      const block=pi[slot.index];
      if (slot.type === 'toolCall') slot.arguments += text;
      else block[slot.type === 'thinking' ? 'thinking' : 'text'] += text;
      emit({type:slot.type === 'toolCall' ? 'toolcall_delta' : slot.type === 'thinking' ? 'thinking_delta' : 'text_delta',contentIndex:slot.index,delta:text});
    }
    // 全文结束校准后关闭内容块；同一块不会重复结束或重复追加。
    function end(slot,text) {
      if (!slot || closed.has(slot.index)) return;
      const block=pi[slot.index];
      if (slot.type === 'toolCall') {
        try {block.arguments=JSON.parse(text ?? slot.arguments);}
        catch (_) {error='工具参数未形成完整 JSON，不能正式提交';save('工具参数无法结束');return;}
        emit({type:'toolcall_end',contentIndex:slot.index,toolCall:block});
      } else {
        const field=slot.type === 'thinking' ? 'thinking' : 'text';
        if (text != null) block[field]=text;
        emit({type:slot.type === 'thinking' ? 'thinking_end' : 'text_end',contentIndex:slot.index,content:block[field]});
      }
    }
    save('尚未收到 SSE');
    for (const record of scene.sse) {
      sse=record.event_index;raw=record.object ?? record.data;
      const before=frames.length, event=record.object;
      const wire=scene.protocol === 'chat' ? event?.usage : event?.response?.usage;
      if (wire) usage=mapUsage(wire,scene.protocol === 'chat');
      if (scene.protocol === 'chat') {
        for (const entry of event?.choices || []) {
          if (entry.index !== choice) continue;
          const part=entry.delta || {};
          for (const [type,text] of [['text',part.content],['thinking',part.reasoning_content || part.reasoning || part.reasoning_text]]) {
            if (!text) continue;
            if (currentChat?.type !== type) {end(currentChat);currentChat=start(`chat:${pi.length}`,type);}
            delta(currentChat,text);
          }
          for (const tool of part.tool_calls || []) {
            end(currentChat);currentChat=null;
            const slot=start(`tool:${tool.index}`,'toolCall',{id:tool.id,name:tool.function?.name});
            if (tool.id) {pi[slot.index].id=tool.id;harness[slot.index].id=tool.id;}
            if (tool.function?.name) {pi[slot.index].name=tool.function.name;harness[slot.index].name=tool.function.name;}
            delta(slot,tool.function?.arguments);
          }
          if (entry.finish_reason) finish=entry.finish_reason === 'length' ? 'max-tokens' : entry.finish_reason === 'tool_calls' ? 'tool-calls' : entry.finish_reason === 'stop' ? 'stop' : 'error';
        }
        if (record.data === '[DONE]') {
          for (const slot of slots.values()) end(slot);
          ended=true;
        }
      } else if (event) {
        const key=`output:${event.output_index}`;
        if (event.type === 'response.output_item.added') {
          const item=event.item;
          if (item.type === 'reasoning') start(key,'thinking');
          if (item.type === 'message') start(key,'text');
          if (item.type === 'function_call') start(key,'toolCall',{id:`${item.call_id}|${item.id}`,name:item.name});
        }
        const slot=slots.get(key);
        if (['response.output_text.delta','response.refusal.delta','response.reasoning_text.delta','response.reasoning_summary_text.delta','response.function_call_arguments.delta'].includes(event.type) && slot) delta(slot,event.delta);
        if (event.type === 'response.output_item.done' && slot) {
          const item=event.item;
          const text=item.type === 'reasoning' ? item.summary?.map(part=>part.text || '').join('\n\n') || item.content?.map(part=>part.text || '').join('\n\n') || undefined : item.type === 'message' ? (item.content || []).map(part=>part.type === 'refusal' ? part.refusal || '' : part.text || '').join('') : item.arguments;
          end(slot,text);
        }
        if (['response.completed','response.incomplete','response.failed'].includes(event.type)) {
          ended=true;
          finish=event.type === 'response.completed' ? (pi.some(block=>block.type==='toolCall') ? 'tool-calls' : 'stop') : event.response?.incomplete_details?.reason === 'max_output_tokens' ? 'max-tokens' : 'error';
          for (const slot of slots.values()) end(slot);
        }
      }
      if (frames.length === before) save(wire ? '收到上游 usage；等待 pi-ai 终止事件' : '上游 SSE');
    }
    // Harness 只在 pi-ai done/error 后给出 usage 和 finish；随后才演示会话追加。
    if (ended) {
      if (!finish) {finish='error';error='未收到有效终止原因，不能正式提交';}
      if (!pi.length && finish==='stop') {finish='error';error='没有 assistant 内容，不能正式提交';}
      harnessUsage=usage?.harness || null;
      save('pi-ai 终止 → Harness usage / finish',{type:finish==='error' ? 'error' : 'done',reason:finish==='max-tokens' ? 'length' : finish==='tool-calls' ? 'toolUse' : finish,[finish==='error' ? 'error' : 'message']:{role:'assistant',content:pi,stopReason:finish==='max-tokens' ? 'length' : finish==='tool-calls' ? 'toolUse' : finish,...usage ? {usage:usage.pi} : {}}},[...harnessUsage ? [{type:'usage',usage:harnessUsage}] : [],{type:'finish',reason:{kind:finish || 'error'}}]);
      if (finish && finish !== 'error' && !error && pi.length) {
        const message={role:'assistant',content:harness};
        save('session.append → assistant/message',null,[],{type:'assistant/message',data:{message,...harnessUsage ? {usage:harnessUsage} : {}},surfaceOp:'append'});
      }
    }
    return frames;
  }
  window.StreamJourneyReplay={build};
})();
