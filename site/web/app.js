/* 页面层：所有交互都在浏览器内完成，数据仅来自打包的真实日志。 */
(function () {
  'use strict';
  const C = window.StreamCore;
  const U = window.StreamUsageView;
  const V = window.StreamSnapshotView;
  const J = window.StreamJourney;
  const base = document.body.dataset.base;
  const dataset = window.SSE_DATA;
  const scenes = dataset.scenarios.map(C.prepare);
  const byID = new Map(scenes.map(scene => [scene.id, scene]));
  const initial = document.body.dataset.scenario;
  const scene = byID.get(initial) || byID.get('chat-multi_tool');
  const final = C.finalView(scene);
  const counterpart = scenes.find(item => item.kind === scene.kind && item.protocol !== scene.protocol);
  const params = new URLSearchParams(location.search);
  const app = document.getElementById('app');
  const state = {cursor:params.has('step') ? Math.max(0,Math.min(scene.sse.length,Math.trunc(Number(params.get('step'))) || 0)) : scene.sse.length, tab:['replay','journey','compare','result'].includes(params.get('tab')) ? params.get('tab') : 'replay', journeyStage:J.stages.some(stage => stage.id === params.get('stage')) ? params.get('stage') : 'eventlog', journeyTool:params.get('call'), search:'', sourceMode:params.get('source') === 'frame' ? 'frame' : 'json', resultMode:params.get('result_view') === 'diff' ? 'diff' : 'json', snapshotMode:['json','visual','diff'].includes(params.get('view')) ? params.get('view') : 'diff', playing:false, interval:650, timer:null};
  // 兼容旧 step 链接；新链接用 jstep 单独保存过程进度。
  state.jcursor = params.has('jstep') ? Math.max(0,Math.min(J.timeline(scene,state.journeyTool).length-1,Math.trunc(Number(params.get('jstep'))) || 0)) : params.has('step') ? J.position(scene,state.journeyTool,state.cursor) : J.timeline(scene,state.journeyTool).length-1;
  state.jplaying=false;state.jtimer=null;
  let toastTimer;
  const icon = (name,size=15) => {
    const paths = {play:'<path d="m8 5 11 7-11 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',back:'<path d="M6 5v14m12-14L8 12l10 7Z"/>',prev:'<path d="m15 5-7 7 7 7"/>',next:'<path d="m9 5 7 7-7 7"/>',code:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-5 2 2-16"/>',flow:'<rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="15" width="6" height="5" rx="1"/><path d="M6 9v8h9m-1-4 4 4-4 4"/>',braces:'<path d="M9 3H7v6l-3 3 3 3v6h2m6-18h2v6l3 3-3 3v6h-2"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',compare:'<path d="M12 3v18M4 7h4v10H4M16 7h4v10h-4"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',check:'<path d="m5 12 4 4L19 6"/>',link:'<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'};
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.code}</svg>`;
  };
  const e = C.escapeHTML;
  // 协议由场景路径表达；切换协议或场景时保留页面状态，并校正目标进度。
  const href = (id,preserve=false) => {
    const path = `${base}scenarios/${id}/index.html`;
    if (!preserve) return path;
    const target = byID.get(id), url = new URL(path,location.href);
    url.search = routeURL().search;
    url.searchParams.set('step',Math.min(state.cursor,target.sse.length));
    url.searchParams.set('jstep',Math.min(state.jcursor,J.timeline(target).length-1));
    if (!C.finalView(target).tools.some(tool => J.toolKey(tool) === state.journeyTool)) url.searchParams.delete('call');
    return url.href;
  };
  const protocolName = protocol => protocol === 'chat' ? 'Chat Completions' : 'Responses API';
  const statusLabel = status => ({waiting:'未开始',streaming:'拼接中',complete:'协议完整',partial:'部分结果',truncated:'生成截断',http_error:'HTTP 错误'}[status] || status);

  // 左侧每种场景只列一次，跟随右上角当前协议；搜索不改变场景或回放。
  function renderNav() {
    const query = state.search.toLowerCase();
    const matches = scenes.filter(item => item.protocol === scene.protocol && `${item.title} ${item.kind} ${item.description}`.toLowerCase().includes(query));
    const html = `<div class="nav-group-label">场景 <span>${matches.length}</span></div>` + matches.map(item => `<a class="scenario-link ${item.id === scene.id ? 'active' : ''} ${['length','http_error'].includes(item.kind) ? 'warn' : ''}" data-scene="${item.id}" href="${href(item.id,true)}" ${item.id === scene.id ? 'aria-current="page"' : ''}><span class="scenario-number">${item.number}</span><span>${e(item.title)}</span><span class="scene-status" aria-hidden="true"></span></a>`).join('');
    document.getElementById('scenario-nav').innerHTML = matches.length ? html : '<div class="empty-state">没有匹配的场景</div>';
  }

  // 页面框架与回放内容分开渲染，拖动进度条时保留焦点和控制按钮。
  function renderScene() {
    const isError = !!scene.httpError;
    document.title = `${scene.title} · ${protocolName(scene.protocol)} · SSE 流观察室`;
    document.getElementById('dataset-meta').textContent = `${dataset.date} · ${dataset.totalTokens.toLocaleString()} tokens`;
    document.getElementById('main').innerHTML = `
      <div class="topbar"><div class="breadcrumb">场景浏览器 <span class="sep">/</span> ${protocolName(scene.protocol)} <span class="sep">/</span><span>${e(scene.title)}</span></div><div class="topbar-note">14 个实测场景 · 浏览不产生 API 调用</div></div>
      <header class="hero"><div><div class="eyebrow"><span>SCENARIO ${scene.number}</span> / LIVE CAPTURE · ${dataset.date}</div><h1>${e(scene.title)}<span style="color:#c2cdd5;font-weight:400">.</span></h1><p>${e(scene.description)}</p></div><nav class="protocol-switch" aria-label="同场景切换接口">${['chat','responses'].map(protocol => `<a class="${scene.protocol === protocol ? 'active' : ''}" data-scene="${protocol}-${scene.kind}" href="${href(`${protocol}-${scene.kind}`,true)}" ${scene.protocol === protocol ? 'aria-current="page"' : ''}>${protocol === 'chat' ? 'Chat' : 'Responses'}</a>`).join('')}</nav></header>
      <div class="http-summary"><span class="badge ${isError ? 'warn' : 'good'}">HTTP ${scene.httpStatus}</span><span>${isError ? '未建立 SSE 流' : '已记录上游响应'}</span></div>
      ${U.definitions(scene)}
      <div class="tabs" role="tablist" aria-label="日志查看模式">
        <button class="tab" role="tab" id="tab-replay" aria-controls="pane-replay" data-tab="replay">${icon('flow')}逐步回放<span class="tiny-count">${scene.sse.length}</span></button>
        <button class="tab" role="tab" id="tab-journey" aria-controls="pane-journey" data-tab="journey">${icon('flow')}完整过程</button>
        <button class="tab" role="tab" id="tab-compare" aria-controls="pane-compare" data-tab="compare">${icon('compare')}协议对照</button>
        <button class="tab" role="tab" id="tab-result" aria-controls="pane-result" data-tab="result">${icon('braces')}完整结果</button>
      </div>
      <section id="pane-replay" role="tabpanel" aria-labelledby="tab-replay">
        ${isError ? renderHTTP() : `
        ${scene.kind === 'length' ? `<div class="notice"><strong>这次生成触发了长度上限。</strong> ${scene.protocol === 'chat' ? '收到了 finish_reason=length 与 [DONE]，传输完整，但正文被截断。' : '最后收到 response.incomplete，结果保留未完成状态和原因。'}</div>` : ''}
        ${scene.kind === 'thinking' ? `<div class="notice">推理文本随 SSE 逐条拼接，done 全文校准。${scene.protocol === 'chat' ? 'reasoning_content 是上游供应商扩展；旧 Go 日志未保存它，右侧回放视图会从 SSE 补齐，原始日志保持不变。' : 'reasoning 文本与 summary 摘要按各自索引保存，不混入回答正文。'}</div>` : ''}
        <div class="playback-bar"><button class="control-btn" data-action="reset" aria-label="回到开头" title="回到开头">${icon('back')}</button><button class="control-btn" data-action="prev" aria-label="上一条 SSE" title="上一条 SSE">${icon('prev')}</button><button class="play-button" id="play-toggle" data-action="play" aria-label="播放回放">${icon('play')}</button><button class="control-btn" data-action="next" aria-label="下一条 SSE" title="下一条 SSE">${icon('next')}</button><div class="playback-slider"><input id="event-progress" type="range" min="0" max="${scene.sse.length}" value="${state.cursor}" aria-label="回放到第几条 SSE"><span class="playback-step" id="playback-step"></span></div><div class="playback-meta"><span class="keyboard-hint">逐条探索</span><span class="keycap">← →</span><select id="playback-speed" aria-label="回放速度"><option value="1200">慢速</option><option value="650" selected>正常</option><option value="250">快速</option></select></div></div>
        <div class="workbench">
          <section class="panel sse-panel"><div class="panel-head"><span class="layer-number">01</span><span class="panel-title">上游 SSE<small>FULL EVENT TYPE / JSON</small></span><span class="panel-count">${scene.sse.length}</span></div><div class="panel-description">显示完整事件类型与原始 data JSON。点击左侧序号，右侧查看事件，下面联动累积状态。</div><div class="upstream-body"><div class="event-list" id="sse-list"></div><div class="inspector"><div class="inspector-head"><span id="source-title">事件检查器</span><div><button data-action="source-mode" id="source-mode-button">查看 SSE 帧</button> <button data-action="copy" data-content="source" aria-label="复制当前上游事件">${icon('copy',11)}</button></div></div><pre class="code" id="source-code" tabindex="0" aria-label="上游事件 JSON"></pre></div></div></section>
          <section class="panel accumulation-panel"><div class="panel-head"><span class="layer-number two">02</span><span class="panel-title">拼接状态<small>ACCUMULATED OBJECT</small></span><span class="panel-count" id="snapshot-count"></span><div class="panel-actions"><button data-action="snapshot-mode" aria-pressed="false">JSON</button><button data-action="snapshot-diff" aria-pressed="true" aria-label="查看 Git diff">Diff</button><button data-action="copy" data-content="snapshot" aria-label="${V.copyLabel}">${icon('copy',11)}</button></div></div><div class="panel-description">随上方 SSE 更新；完整展开当前状态，与旁边的完整结果逐字段对照。</div><div class="snapshot-body" id="snapshot-body"></div><div class="snapshot-foot">delta 按归属追加，done 全文替换。完整参数仍是 JSON 字符串，工具不会自动执行。</div></section>
          <section class="panel final-result-panel"><div class="panel-head"><span class="layer-number three">03</span><span class="panel-title">完整结果<small>FINAL RESULT</small></span><div class="panel-actions"><button data-action="result-mode" aria-pressed="false">JSON</button><button data-action="copy" data-content="result-view" aria-label="复制完整结果视图 JSON">${icon('copy',11)}</button></div></div><div class="panel-description">JSON 随当前 SSE 展示完整累积对象；Diff 查看本条变化，到终点才核对日志。</div><div class="final-result-body" id="final-result-body"></div></section>
        </div>
        <div class="workbench-caption"><span>${icon('link',12)} 序号是本地 event_index；上游 sequence_number 保留在 JSON 中。</span><span>回放速率为演示速度，不代表真实网络耗时。</span></div>
        <div class="flow-strip"><b>resp.Body</b><span class="arrow">→</span><span>SSE 解帧</span><span class="arrow">→</span><span>Chat / Responses 解码</span><span class="arrow">→</span><span>按 index 合并</span><span class="arrow">→</span><b>完整结果</b></div>`}
      </section>
      <section id="pane-journey" role="tabpanel" aria-labelledby="tab-journey" hidden>${J.render(scene,state.journeyStage,state.journeyTool,state.jcursor,state.jplaying)}</section>
      <section id="pane-compare" role="tabpanel" aria-labelledby="tab-compare" hidden>${renderCompare()}</section>
      <section id="pane-result" role="tabpanel" aria-labelledby="tab-result" hidden>${renderResult()}</section>
      <footer class="page-footer"><div>真实样本 · ${dataset.model} · 所有交互均在浏览器内进行</div><div class="footer-actions"><button data-action="copy-link">${icon('link',11)} 复制当前视图链接</button><button data-action="download" data-content="combined">${icon('download',11)} 下载完整日志</button></div></footer>`;
    selectTab(state.tab,'replace');
    if (!isError) renderPlayback();
  }


  // Responses 使用完整 type；Chat 显示 SSE event，不将 JSON object 冒充事件类型。
  function upstreamType(record) {
    return record.object?.type || record.event || 'message';
  }

  // 每次仅根据当前位置计算展示；usage 到达之前展示待接收状态。
  function renderPlayback() {
    const snapshot = C.snapshot(scene,state.cursor);
    document.getElementById('sse-list').innerHTML = scene.sse.map(record => {
      const label = C.describe(record,scene.protocol), index = record.event_index;
      return `<button class="sse-row ${index === state.cursor ? 'selected' : ''} ${index > state.cursor ? 'future' : ''}" data-action="jump" data-index="${index}" aria-label="查看 SSE 第 ${index} 条：${e(upstreamType(record))} · ${e(label.type)}" aria-pressed="${index === state.cursor}"><span class="event-ordinal">${String(index).padStart(2,'0')}</span><span class="event-dot ${label.category}"></span><span class="event-row-copy"><span class="event-row-title">${e(upstreamType(record))}</span><span class="event-row-detail">${scene.protocol === 'chat' && record.object?.object ? `JSON object: ${e(record.object.object)} · ` : ''}${e(label.type)} · ${e(label.detail)}</span></span>${record.object?.sequence_number != null ? `<span class="upstream-seq">s${record.object.sequence_number}</span>` : ''}</button>`;
    }).join('');
    const source = scene.sse[state.cursor-1];
    document.getElementById('source-title').textContent = source ? `SSE #${source.event_index} · ${upstreamType(source)} · ${state.sourceMode === 'json' ? '上游 JSON' : '重建事件帧'}` : '等待第一条事件';
    document.getElementById('source-mode-button').textContent = state.sourceMode === 'json' ? '查看 SSE 帧' : '查看 JSON';
    const value = source ? source.object ?? source.data : null;
    document.getElementById('source-code').innerHTML = source ? state.sourceMode === 'json' ? C.highlight(C.pretty(value)) : e(asFrame(source)) : '<span class="json-key">点击播放或选择一条事件开始。</span>';
    document.getElementById('final-result-body').innerHTML = V.renderResult(scene,snapshot,state.resultMode);
    const resultToggle = document.querySelector('[data-action="result-mode"]');
    resultToggle.textContent = state.resultMode === 'diff' ? 'JSON' : 'Diff';
    resultToggle.setAttribute('aria-pressed',String(state.resultMode === 'json'));
    document.getElementById('snapshot-count').textContent = `#${state.cursor}`;
    document.getElementById('snapshot-body').innerHTML = state.snapshotMode === 'diff' ? V.renderDiff(scene,snapshot) : state.snapshotMode === 'json' ? V.render(scene,snapshot) : renderSnapshot(snapshot);
    const snapshotToggle = document.querySelector('[data-action="snapshot-mode"]');
    snapshotToggle.textContent = V.toggleLabel(state.snapshotMode);
    snapshotToggle.classList.toggle('active',state.snapshotMode === 'json');
    snapshotToggle.setAttribute('aria-pressed',String(state.snapshotMode === 'json'));
    const diffToggle = document.querySelector('[data-action="snapshot-diff"]');
    diffToggle.classList.toggle('active',state.snapshotMode === 'diff');
    diffToggle.setAttribute('aria-pressed',String(state.snapshotMode === 'diff'));
    document.getElementById('playback-step').innerHTML = `<b>${String(state.cursor).padStart(2,'0')}</b> / ${String(scene.sse.length).padStart(2,'0')} SSE`;
    document.getElementById('event-progress').value = state.cursor;
    document.getElementById('event-progress').setAttribute('aria-valuetext',`已接收 ${state.cursor} 条，共 ${scene.sse.length} 条 SSE`);
    const play = document.getElementById('play-toggle');
    play.innerHTML = icon(state.playing ? 'pause' : 'play');play.setAttribute('aria-label',state.playing ? '暂停回放' : '播放回放');
    document.querySelector('[data-action="prev"]').disabled = state.cursor === 0;
    document.querySelector('[data-action="next"]').disabled = state.cursor === scene.sse.length;
  }

  function renderSnapshot(snapshot) {
    let content = `<div class="snapshot-state"><span>截至 SSE #${snapshot.step} 的状态 · 内容摘要</span><span class="badge ${snapshot.status === 'complete' ? 'good' : ['partial','truncated'].includes(snapshot.status) ? 'warn' : ''}">${statusLabel(snapshot.status)}</span></div>`;
    if (snapshot.text) content += `<div class="text-label">回答正文</div><div class="text-output">${e(snapshot.text)}</div>`;
    if (snapshot.refusal) content += `<div class="text-label">拒绝信息</div><div class="text-output">${e(snapshot.refusal)}</div>`;
    if (snapshot.reasoning) content += `<div class="text-label">推理内容</div><div class="text-output reasoning-output">${e(snapshot.reasoning)}</div>`;
    if (snapshot.reasoningSummary) content += `<div class="text-label">推理摘要</div><div class="text-output reasoning-output">${e(snapshot.reasoningSummary)}</div>`;
    for (const tool of snapshot.tools) {
      let valid = false;
      try { JSON.parse(tool.arguments);valid = true; } catch (_) { /* 参数中途不完整是正常的流式状态。 */ }
      content += `<article class="tool-card"><div class="tool-title"><span class="tool-icon">⌘</span><strong>${e(tool.name || '等待工具名')}</strong><span class="badge ${tool.complete ? 'good' : ''}">${tool.complete ? '已完成' : '接收中'}</span></div><div class="tool-locator">choice ${tool.choice} / tool ${tool.index}<br>call_id: ${e(tool.callID || '尚未收到')}${tool.itemID ? `<br>item_id: ${e(tool.itemID)}` : ''}</div><div class="arguments-label">ARGUMENTS <span class="argument-state ${valid ? '' : 'pending'}">${valid ? '可解析 JSON' : '尚未形成完整 JSON'}</span></div><pre class="arguments">${tool.arguments ? C.highlight(tool.arguments) : '<span class="argument-state pending">等待参数增量…</span>'}</pre></article>`;
    }
    if (!snapshot.text && !snapshot.refusal && !snapshot.tools.length && !snapshot.reasoning && !snapshot.reasoningSummary) content += '<div class="empty-state"><span class="empty-icon">{ … }</span>等待正文或工具增量<br>从左侧选择一条事件</div>';
    content += `<div class="usage-card"><div class="usage-head"><span>REQUEST USAGE</span><span>${snapshot.usage ? '整次请求快照' : '等待 usage 事件'}</span></div><div class="usage-grid">${[['input_tokens','输入'],['output_tokens','输出'],['total_tokens','总计']].map(([key,title]) => `<div class="${key === 'total_tokens' ? 'total' : ''}"><span>${title}</span><strong>${snapshot.usage?.[key] ?? '—'}</strong></div>`).join('')}</div>${U.breakdown(snapshot.usage,'snapshot')}</div>`;
    return content;
  }

  function renderCompare() {
    return `<p class="compare-intro">同一场景的两次独立真实请求。上游事件类型、序号和最终结果各自独立。</p><div class="compare-grid">${[scene,counterpart].sort((a,b) => a.protocol.localeCompare(b.protocol)).map(item => {
      const view = C.finalView(item), counts = {};
      item.sse.forEach(record => {const type = upstreamType(record);counts[type] = (counts[type] || 0)+1;});
      return `<article class="compare-card"><div class="compare-header"><h2>${protocolName(item.protocol)}</h2><span class="badge ${item.httpError ? 'warn' : 'good'}">HTTP ${item.httpStatus}</span></div><div class="compare-body"><div class="compare-facts"><div><span>SSE 事件</span><strong>${item.sse.length}</strong></div><div><span>工具</span><strong>${view.tools.length}</strong></div><div><span>总 token</span><strong>${item.httpError ? '—' : item.tokens}</strong></div></div>${item.httpError ? '<div class="notice">HTTP 错误没有 SSE 累积过程。符合预期的 400 拒绝仍计为场景通过。</div>' : `${U.breakdown(view.usage,'compare')}<div class="text-label">上游事件类型计数</div>${Object.entries(counts).map(([type,count]) => `<div class="compare-type-count"><span>${e(type)}</span><b>${count}</b></div>`).join('')}${view.tools.map(tool => `<div class="tool-card" style="margin-top:13px"><div class="tool-title"><strong>${e(tool.name)}</strong><span class="badge">tool ${tool.index}</span></div><pre class="arguments" style="margin-top:9px">${C.highlight(tool.arguments)}</pre></div>`).join('')}${view.text ? `<div class="text-label" style="margin-top:15px">完整正文</div><div class="text-output">${e(view.text)}</div>` : ''}`}<div class="compare-bottom"><a href="${href(item.id)}">打开此场景 ${icon('next',12)}</a></div></div></article>`;
    }).join('')}</div>`;
  }

  function renderResult() {
    const object = scene.result?.object || scene.httpError?.object;
    return `<div class="result-layout"><div class="result-code"><div class="inspector-head"><span>${scene.httpError ? 'HTTP ERROR · 非 SSE 响应' : 'RESULT · 日志终点原文（不随回放）'}</span><button data-action="copy" data-content="result">${icon('copy',11)} 复制 JSON</button></div><pre class="code" tabindex="0" aria-label="完整结果 JSON">${C.highlight(C.pretty(object))}</pre></div><aside class="panel result-aside"><div><h3>${scene.httpError ? '按预期拒绝' : statusLabel(final.status)}</h3><p>${scene.httpError ? '本场景使用无效模型名，官方接口返回 HTTP 400。错误正文不是 SSE，不生成工具或 usage。' : '这里展示整段记录结束后保存的原始对象，不随回放进度变化。usage 来自后面的用量事件；当前进度尚未收到时，两栏回放仍应为 null。回放视图会逐条拼接推理；旧日志遗漏的推理字段由 SSE 补全并标注来源，原文不变。'}</p>${scene.result ? `<p>覆盖本地 SSE #${scene.result.first_event_index}–${scene.result.last_event_index}。${scene.result.error ? `<br>${e(scene.result.error)}` : ''}</p>` : ''}</div><div><button class="outline-btn" data-action="download" data-content="result">${icon('download',13)} 下载完整对象</button><button class="outline-btn" data-action="download" data-content="business">${icon('download',13)} 下载统一事件</button></div><div class="proof-detail">完整源日志 SHA256<code>${e(scene.sourceSHA256)}</code><p>样本时间：${dataset.date}<br>模型：${dataset.model}<br>浏览、播放和下载均不请求模型。</p></div></aside></div>`;
  }

  function renderHTTP() {
    let body;
    try {body = JSON.parse(scene.httpError.object.body);} catch (_) {body = scene.httpError.object.body;}
    return `<div class="http-card"><div class="http-top"><span class="http-status">400</span><div><h2>无效模型，按预期拒绝</h2><p>真实 HTTP 错误样本 · 未建立 SSE 事件流</p></div></div><div class="http-code"><pre class="code" tabindex="0" aria-label="HTTP 错误正文">${C.highlight(C.pretty(body))}</pre></div><div class="http-facts"><div><strong>第一层 · 不适用</strong>没有 SSE data 事件</div><div><strong>第二层 · 不适用</strong>没有 Chat / Responses 合并对象</div><div><strong>第三层 · 不适用</strong>不补造工具、usage 或完成事件</div></div></div>`;
  }

  // 重建的是 SSE 事件语义，不冒充被删除的原始网络字节。
  function asFrame(record) {
    const payload = record.object ? JSON.stringify(record.object) : record.data || '';
    return `${record.event && record.event !== 'message' ? `event: ${record.event}\n` : ''}${record.id ? `id: ${record.id}\n` : ''}${payload.split('\n').map(line => `data: ${line}`).join('\n')}\n\n`;
  }

  // 地址保存页面状态；切换标签/阶段新增历史，连续回放只更新当前历史。
  function routeURL() {
    const url = new URL(location.href);
    for (const [key,value] of Object.entries({tab:state.tab,step:state.cursor,jstep:state.jcursor,stage:state.journeyStage,view:state.snapshotMode,result_view:state.resultMode,source:state.sourceMode})) url.searchParams.set(key,value);
    if (state.journeyTool) url.searchParams.set('call',state.journeyTool);
    else url.searchParams.delete('call');
    return url;
  }

  // 共享给地址栏和复制链接，避免两套序列化规则不一致。
  function syncRoute(mode='replace') {
    if (mode === 'none') return;
    const url = routeURL();
    document.querySelectorAll('a[data-scene]').forEach(link => {link.href = href(link.dataset.scene,true);});
    if (url.href !== location.href) history[mode === 'push' ? 'pushState' : 'replaceState'](null,'',url.href);
  }

  function selectTab(tab, historyMode='push') {
    state.tab = tab;
    syncRoute(historyMode);
    if (tab !== 'replay') stopPlayback();
    if (tab !== 'journey') stopJourney();
    for (const name of ['replay','journey','compare','result']) {
      const button = document.getElementById(`tab-${name}`);
      button.classList.toggle('active',name === tab);button.setAttribute('aria-selected',String(name === tab));button.tabIndex = name === tab ? 0 : -1;
      document.getElementById(`pane-${name}`).hidden = name !== tab;
    }
  }

  function setCursor(value) {
    state.cursor = Math.max(0,Math.min(scene.sse.length,Number(value) || 0));
    syncRoute();
    if (state.cursor === scene.sse.length) stopPlayback();
    if (!scene.httpError) renderPlayback();
  }

  // 过程播放独立计时，切换标签或浏览历史时暂停。
  function renderJourney() {
    const focused=document.activeElement?.id === 'journey-progress';
    document.getElementById('pane-journey').innerHTML=J.render(scene,state.journeyStage,state.journeyTool,state.jcursor,state.jplaying);
    if (focused) document.getElementById('journey-progress').focus({preventScroll:true});
  }

  // 过程步包括一次 SSE 引发的多个内容事件和最后的会话提交。
  function setJourneyCursor(value) {
    state.jcursor=Math.max(0,Math.min(J.timeline(scene,state.journeyTool).length-1,Math.trunc(Number(value)) || 0));
    if (state.jcursor===J.timeline(scene,state.journeyTool).length-1) stopJourney();
    syncRoute();renderJourney();
  }

  // 结束或离开过程视图后，不让后台计时器继续推进路由。
  function stopJourney() {
    if (state.jtimer) clearInterval(state.jtimer);
    state.jtimer=null;state.jplaying=false;
    const button=document.querySelector('[data-action="journey-play"]');
    if (button) {button.textContent='播放';button.setAttribute('aria-label','播放完整过程');}
  }

  // 自动播放仅替换当前历史，避免产生大量后退记录。
  function toggleJourney() {
    if (state.jplaying) {stopJourney();return;}
    if (state.jcursor===J.timeline(scene,state.journeyTool).length-1) setJourneyCursor(0);
    state.jplaying=true;
    state.jtimer=setInterval(()=>setJourneyCursor(state.jcursor+1),state.interval);
    renderJourney();
  }

  function stopPlayback() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;state.playing = false;
    const button = document.getElementById('play-toggle');
    if (button) {button.innerHTML = icon('play');button.setAttribute('aria-label','播放回放');}
  }

  function togglePlayback() {
    if (state.playing) {stopPlayback();return;}
    if (state.cursor === scene.sse.length) setCursor(0);
    state.playing = true;
    state.timer = setInterval(() => setCursor(state.cursor+1),state.interval);
    renderPlayback();
  }

  function notify(message) {
    const element = document.getElementById('toast');
    element.textContent = message;element.classList.add('visible');clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('visible'),2600);
  }

  async function copy(value) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const textarea = document.createElement('textarea');textarea.value = value;textarea.setAttribute('aria-hidden','true');document.body.append(textarea);textarea.select();
        const success = document.execCommand('copy');textarea.remove();if (!success) throw new Error('clipboard');
      }
      notify('已复制');
    } catch (_) {notify('复制未成功，请在 JSON 面板中手动选择复制。');}
  }

  function content(kind) {
    if (kind === 'result-view') return {text:C.pretty(V.object(scene,C.snapshot(scene,state.cursor))),name:scene.id+'-complete-view.json',type:'application/json'};
    if (kind === 'snapshot') return {text:C.pretty(V.object(scene,C.snapshot(scene,state.cursor))),name:scene.id+'-snapshot.json',type:'application/json'};
    if (kind === 'combined') return {text:scene.sourceText,name:`${scene.id}-stream.jsonl`,type:'application/x-ndjson'};
    if (kind === 'business') return {text:scene.business.map(record => JSON.stringify(record)).join('\n')+(scene.business.length ? '\n' : ''),name:`${scene.id}-events.jsonl`,type:'application/x-ndjson'};
    if (kind === 'source') {
      const record=scene.sse[state.cursor-1]; // 复制内容与当前检查器的 JSON/事件帧模式一致。
      const frame=state.sourceMode === 'frame';
      return {text:record ? (frame ? asFrame(record) : C.pretty(record.object ?? record.data)) : 'null',name:`${scene.id}-sse-${state.cursor}.${frame ? 'sse' : 'json'}`,type:frame ? 'text/plain' : 'application/json'};
    }
    return {text:C.pretty(scene.result?.object || scene.httpError?.object),name:`${scene.id}-result.json`,type:'application/json'};
  }

  function download(kind) {
    if (kind === 'business' && scene.httpError) {notify('HTTP 错误样本没有统一业务事件。');return;}
    const file = content(kind), url = URL.createObjectURL(new Blob([file.text],{type:file.type+';charset=utf-8'}));
    const anchor = document.createElement('a');anchor.href = url;anchor.download = file.name;document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  }

  // 使用事件委托，回放更新不会重复绑定点击处理器。
  app.addEventListener('click',event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tab) {selectTab(button.dataset.tab);return;}
    const action = button.dataset.action;
    if (['journey-reset','journey-prev','journey-next','journey-play'].includes(action)) {
      if (action === 'journey-play') toggleJourney();
      else {stopJourney();setJourneyCursor(action === 'journey-reset' ? 0 : state.jcursor+(action === 'journey-next' ? 1 : -1));}
      return;
    }
    if (action === 'journey-stage' || action === 'journey-tool') {
      if (action === 'journey-stage') state.journeyStage = button.dataset.stage;
      else state.journeyTool = button.dataset.tool;
      syncRoute('push');
      stopJourney();renderJourney();
      // 重绘后恢复到相同的阶段或调用按钮，保持键盘操作连续。
      const selected = [...document.querySelectorAll(`#pane-journey [data-action="${action}"]`)].find(item => action === 'journey-stage' ? item.dataset.stage === state.journeyStage : item.dataset.tool === state.journeyTool);
      selected?.focus({preventScroll:true});
    }
    if (action === 'journey-replay') {setCursor(button.dataset.index);selectTab('replay');}
    if (action === 'play') togglePlayback();
    if (action === 'reset') {stopPlayback();setCursor(0);}
    if (action === 'prev') {stopPlayback();setCursor(state.cursor-1);}
    if (action === 'next') {stopPlayback();setCursor(state.cursor+1);}
    if (action === 'jump') {stopPlayback();setCursor(button.dataset.index);}
    if (action === 'result-mode') {state.resultMode = state.resultMode === 'diff' ? 'json' : 'diff';renderPlayback();syncRoute();}
    if (action === 'snapshot-diff') {state.snapshotMode = state.snapshotMode === 'diff' ? 'json' : 'diff';renderPlayback();syncRoute();}
    if (action === 'snapshot-mode') {state.snapshotMode = state.snapshotMode === 'json' ? 'visual' : 'json';renderPlayback();syncRoute();}
    if (action === 'source-mode') {state.sourceMode = state.sourceMode === 'json' ? 'frame' : 'json';renderPlayback();syncRoute();}
    if (action === 'copy') copy(content(button.dataset.content).text);
    if (action === 'download') download(button.dataset.content);
    if (action === 'copy-link') {
      copy(routeURL().href);
    }
  });
  document.getElementById('scenario-search').addEventListener('input',event => {state.search = event.target.value;renderNav();});
  app.addEventListener('input',event => {if (event.target.id === 'journey-progress') {stopJourney();setJourneyCursor(event.target.value);return;}if (event.target.id === 'event-progress') {stopPlayback();setCursor(event.target.value);}});
  app.addEventListener('change',event => {if (event.target.id === 'playback-speed') {const playing = state.playing;stopPlayback();state.interval = Number(event.target.value);if (playing) togglePlayback();}});
  document.addEventListener('keydown',event => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();const names = ['replay','journey','compare','result'];const index = names.indexOf(state.tab);const next = names[(index+(event.key === 'ArrowRight' ? 1 : names.length-1))%names.length];selectTab(next);document.getElementById(`tab-${next}`).focus();return;
    }
    if (state.tab !== 'replay' || scene.httpError || event.target.closest('input,textarea,select,button,a,summary')) return;
    if (['ArrowLeft','ArrowRight'].includes(event.key)) {event.preventDefault();stopPlayback();setCursor(state.cursor+(event.key === 'ArrowRight' ? 1 : -1));}
  });
  // 浏览器前进后退恢复界面；不继续自动播放，也不产生额外历史。
  window.addEventListener('popstate',() => {
    stopPlayback();stopJourney();
    const route = new URLSearchParams(location.search);
    state.cursor = route.has('step') ? Math.max(0,Math.min(scene.sse.length,Math.trunc(Number(route.get('step'))) || 0)) : scene.sse.length;
    state.tab = ['replay','journey','compare','result'].includes(route.get('tab')) ? route.get('tab') : 'replay';
    state.journeyStage = J.stages.some(stage => stage.id === route.get('stage')) ? route.get('stage') : 'eventlog';
    state.journeyTool = route.get('call');
    state.jcursor=route.has('jstep') ? Math.max(0,Math.min(J.timeline(scene,state.journeyTool).length-1,Math.trunc(Number(route.get('jstep'))) || 0)) : J.position(scene,state.journeyTool,state.cursor);
    state.snapshotMode = ['json','visual','diff'].includes(route.get('view')) ? route.get('view') : 'diff';
    state.resultMode = route.get('result_view') === 'diff' ? 'diff' : 'json';
    state.sourceMode = route.get('source') === 'frame' ? 'frame' : 'json';
    document.getElementById('pane-journey').innerHTML = J.render(scene,state.journeyStage,state.journeyTool,state.jcursor,state.jplaying);
    selectTab(state.tab,'none');
    document.querySelectorAll('a[data-scene]').forEach(link => {link.href = href(link.dataset.scene,true);});
    if (!scene.httpError) renderPlayback();
  });
  window.addEventListener('pagehide',()=>{stopPlayback();stopJourney();});
  renderNav();renderScene();
})();
