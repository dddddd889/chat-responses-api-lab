/* 页面层：所有交互都在浏览器内完成，数据仅来自打包的真实日志。 */
(function () {
  'use strict';
  const C = window.StreamCore;
  const U = window.StreamUsageView;
  const V = window.StreamSnapshotView;
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
  const state = {cursor:params.has('step') ? Math.max(0,Math.min(scene.sse.length,Number(params.get('step')) || 0)) : scene.sse.length, tab:['replay','compare','result'].includes(params.get('tab')) ? params.get('tab') : 'replay', filter:'all', search:'', selectedBusiness:null, sourceMode:'json', snapshotMode:params.get('view') === 'json' ? 'json' : 'visual', playing:false, interval:650, timer:null};
  let toastTimer;
  const icon = (name,size=15) => {
    const paths = {play:'<path d="m8 5 11 7-11 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',back:'<path d="M6 5v14m12-14L8 12l10 7Z"/>',prev:'<path d="m15 5-7 7 7 7"/>',next:'<path d="m9 5 7 7-7 7"/>',code:'<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-5 2 2-16"/>',flow:'<rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="15" width="6" height="5" rx="1"/><path d="M6 9v8h9m-1-4 4 4-4 4"/>',braces:'<path d="M9 3H7v6l-3 3 3 3v6h2m6-18h2v6l3 3-3 3v6h-2"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',compare:'<path d="M12 3v18M4 7h4v10H4M16 7h4v10h-4"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',check:'<path d="m5 12 4 4L19 6"/>',link:'<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>'};
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.code}</svg>`;
  };
  const e = C.escapeHTML;
  const href = id => `${base}scenarios/${id}/index.html`;
  const protocolName = protocol => protocol === 'chat' ? 'Chat Completions' : 'Responses API';
  const statusLabel = status => ({waiting:'未开始',streaming:'拼接中',complete:'协议完整',partial:'部分结果',truncated:'生成截断',http_error:'HTTP 错误'}[status] || status);

  // 侧栏过滤只影响场景列表，当前场景与回放状态保持不变。
  function renderNav() {
    const query = state.search.toLowerCase();
    let html = '';
    for (const protocol of ['chat','responses']) {
      if (state.filter !== 'all' && state.filter !== protocol) continue;
      const matches = scenes.filter(item => item.protocol === protocol && `${item.id} ${item.title} ${item.description}`.toLowerCase().includes(query));
      if (!matches.length) continue;
      html += `<div class="nav-group-label">${protocol === 'chat' ? 'CHAT COMPLETIONS' : 'RESPONSES API'} <span>${matches.length}</span></div>`;
      html += matches.map(item => `<a class="scenario-link ${item.id === scene.id ? 'active' : ''} ${['length','http_error'].includes(item.kind) ? 'warn' : ''}" href="${href(item.id)}" ${item.id === scene.id ? 'aria-current="page"' : ''}><span class="scenario-number">${item.number}</span><span>${e(item.title)}</span><span class="scene-status" aria-hidden="true"></span></a>`).join('');
    }
    document.getElementById('scenario-nav').innerHTML = html || '<div class="empty-state">没有匹配的场景</div>';
    document.querySelectorAll('[data-filter]').forEach(button => {button.classList.toggle('active',button.dataset.filter === state.filter);button.setAttribute('aria-pressed',String(button.dataset.filter === state.filter));});
  }

  // 页面框架与回放内容分开渲染，拖动进度条时保留焦点和控制按钮。
  function renderScene() {
    const count = final.tools.length;
    const isError = !!scene.httpError;
    document.title = `${scene.title} · ${protocolName(scene.protocol)} · SSE 流观察室`;
    document.getElementById('dataset-meta').textContent = `${dataset.date} · ${dataset.totalTokens.toLocaleString()} tokens`;
    document.getElementById('main').innerHTML = `
      <div class="topbar"><div class="breadcrumb">场景浏览器 <span class="sep">/</span> ${protocolName(scene.protocol)} <span class="sep">/</span><span>${e(scene.title)}</span></div><div class="topbar-note">14 个实测场景 · 浏览不产生 API 调用</div></div>
      <header class="hero"><div><div class="eyebrow"><span>SCENARIO ${scene.number}</span> / LIVE CAPTURE · ${dataset.date}</div><h1>${e(scene.title)}<span style="color:#c2cdd5;font-weight:400">.</span></h1><p>${e(scene.description)}</p></div><nav class="protocol-switch" aria-label="同场景切换接口">${['chat','responses'].map(protocol => `<a class="${scene.protocol === protocol ? 'active' : ''}" href="${href(`${protocol}-${scene.kind}`)}" ${scene.protocol === protocol ? 'aria-current="page"' : ''}>${protocol === 'chat' ? 'Chat' : 'Responses'}</a>`).join('')}</nav></header>
      <div class="stats">
        ${stat('HTTP 状态',scene.httpStatus,isError ? '按预期拒绝' : '上游响应成功',isError ? 'warn':'good','check')}
        ${stat('完整 SSE 事件',scene.sse.length,isError ? '未进入 SSE 流' : scene.protocol === 'chat' ? '含最后一条 [DONE]' : '含响应生命周期事件','','flow')}
        ${stat('工具调用',count,count ? '独立 index · 独立参数' : '此场景没有函数工具调用','','braces')}
        ${stat('整次请求用量',isError ? '—' : scene.tokens,isError ? '未返回 usage' : '输入 + 输出 · 不按事件累加','','clock')}
        ${U.overview(final.usage)}
      </div>
      ${U.definitions(scene)}
      <div class="tabs" role="tablist" aria-label="日志查看模式">
        <button class="tab" role="tab" id="tab-replay" aria-controls="pane-replay" data-tab="replay">${icon('flow')}逐步回放<span class="tiny-count">${scene.sse.length}</span></button>
        <button class="tab" role="tab" id="tab-compare" aria-controls="pane-compare" data-tab="compare">${icon('compare')}协议对照</button>
        <button class="tab" role="tab" id="tab-result" aria-controls="pane-result" data-tab="result">${icon('braces')}完整结果</button>
      </div>
      <section id="pane-replay" role="tabpanel" aria-labelledby="tab-replay">
        ${isError ? renderHTTP() : `
        ${scene.kind === 'length' ? `<div class="notice"><strong>这次生成触发了长度上限。</strong> ${scene.protocol === 'chat' ? '收到了 finish_reason=length 与 [DONE]，传输完整，但正文被截断。' : '最后收到 response.incomplete，合并对象标记 partial，统一事件保留 error。'}</div>` : ''}
        ${scene.kind === 'thinking' ? '<div class="notice">思考扩展完整保留在第一层。当前 Go 实现只把常见正文、拒绝与函数工具规范化；第三层不包含未建模的思考事件。</div>' : ''}
        <div class="playback-bar"><button class="control-btn" data-action="reset" aria-label="回到开头" title="回到开头">${icon('back')}</button><button class="control-btn" data-action="prev" aria-label="上一条 SSE" title="上一条 SSE">${icon('prev')}</button><button class="play-button" id="play-toggle" data-action="play" aria-label="播放回放">${icon('play')}</button><button class="control-btn" data-action="next" aria-label="下一条 SSE" title="下一条 SSE">${icon('next')}</button><div class="playback-slider"><input id="event-progress" type="range" min="0" max="${scene.sse.length}" value="${state.cursor}" aria-label="回放到第几条 SSE"><span class="playback-step" id="playback-step"></span></div><div class="playback-meta"><span class="keyboard-hint">逐条探索</span><span class="keycap">← →</span><select id="playback-speed" aria-label="回放速度"><option value="1200">慢速</option><option value="650" selected>正常</option><option value="250">快速</option></select></div></div>
        <div class="workbench">
          <section class="panel"><div class="panel-head"><span class="layer-number">01</span><span class="panel-title">上游事件<small>SSE / JSON</small></span><span class="panel-count">${scene.sse.length}</span></div><div class="panel-description">每条完整 data 的原始 JSON。点击序号查看内容。</div><div class="event-list" id="sse-list"></div><div class="inspector"><div class="inspector-head"><span id="source-title">事件检查器</span><div><button data-action="source-mode" id="source-mode-button">查看 SSE 帧</button> <button data-action="copy" data-content="source" aria-label="复制当前上游事件">${icon('copy',11)}</button></div></div><pre class="code" id="source-code" tabindex="0" aria-label="上游事件 JSON"></pre></div></section>
          <section class="panel"><div class="panel-head"><span class="layer-number two">02</span><span class="panel-title">拼接状态<small>ACCUMULATED OBJECT</small></span><span class="panel-count" id="snapshot-count"></span><div class="panel-actions"><button data-action="snapshot-mode" aria-pressed="false">JSON</button><button data-action="copy" data-content="snapshot" aria-label="${V.copyLabel}">${icon('copy',11)}</button></div></div><div class="panel-description">中途状态由上游增量重放；终点采用已记录的合并对象。</div><div class="snapshot-body" id="snapshot-body"></div><div class="snapshot-foot">delta 按归属追加，done 全文替换。完整参数仍是 JSON 字符串，工具不会自动执行。</div></section>
          <section class="panel business-panel"><div class="panel-head"><span class="layer-number three">03</span><span class="panel-title">统一业务事件<small>NORMALIZED EVENTS</small></span><span class="panel-count">${scene.business.length}</span></div><div class="panel-description">两种接口使用相同事件名称。点击可联动来源范围。</div><div class="business-list" id="business-list"></div></section>
        </div>
        <div class="workbench-caption"><span>${icon('link',12)} 序号是本地 event_index；上游 sequence_number 保留在 JSON 中。</span><span>回放速率为演示速度，不代表真实网络耗时。</span></div>
        <div class="flow-strip"><b>resp.Body</b><span class="arrow">→</span><span>SSE 解帧</span><span class="arrow">→</span><span>Chat / Responses 解码</span><span class="arrow">→</span><span>按 index 合并</span><span class="arrow">→</span><b>result + business events</b></div>`}
      </section>
      <section id="pane-compare" role="tabpanel" aria-labelledby="tab-compare" hidden>${renderCompare()}</section>
      <section id="pane-result" role="tabpanel" aria-labelledby="tab-result" hidden>${renderResult()}</section>
      <footer class="page-footer"><div>真实样本 · ${dataset.model} · 所有交互均在浏览器内进行</div><div class="footer-actions"><button data-action="copy-link">${icon('link',11)} 复制当前视图链接</button><button data-action="download" data-content="combined">${icon('download',11)} 下载完整日志</button></div></footer>`;
    selectTab(state.tab);
    if (!isError) renderPlayback();
  }

  function stat(label,value,caption,color,name) {
    return `<div class="stat"><span class="stat-icon">${icon(name,14)}</span><div class="stat-name">${label}</div><div class="stat-value ${color}">${value}</div><div class="stat-caption">${caption}</div></div>`;
  }

  // 每次仅根据当前位置计算展示；usage 到达之前展示待接收状态。
  function renderPlayback() {
    const snapshot = C.snapshot(scene,state.cursor);
    const selected = state.selectedBusiness == null ? null : scene.business[state.selectedBusiness];
    document.getElementById('sse-list').innerHTML = scene.sse.map(record => {
      const label = C.describe(record,scene.protocol), index = record.event_index;
      const inRange = selected && index >= selected.first_event_index && index <= selected.last_event_index;
      return `<button class="sse-row ${index === state.cursor ? 'selected' : ''} ${index > state.cursor ? 'future' : ''} ${inRange ? 'in-range' : ''}" data-action="jump" data-index="${index}" aria-label="查看 SSE 第 ${index} 条：${e(label.type)}" aria-pressed="${index === state.cursor}"><span class="event-ordinal">${String(index).padStart(2,'0')}</span><span class="event-dot ${label.category}"></span><span class="event-row-copy"><span class="event-row-title">${e(label.type)}</span><span class="event-row-detail">${e(label.detail)}</span></span>${record.object?.sequence_number != null ? `<span class="upstream-seq">s${record.object.sequence_number}</span>` : ''}</button>`;
    }).join('');
    const source = scene.sse[state.cursor-1];
    document.getElementById('source-title').textContent = source ? `SSE #${source.event_index} · ${state.sourceMode === 'json' ? '上游 JSON' : '重建事件帧'}` : '等待第一条事件';
    document.getElementById('source-mode-button').textContent = state.sourceMode === 'json' ? '查看 SSE 帧' : '查看 JSON';
    const value = source ? source.object ?? source.data : null;
    document.getElementById('source-code').innerHTML = source ? state.sourceMode === 'json' ? C.highlight(C.pretty(value)) : e(asFrame(source)) : '<span class="json-key">点击播放或选择一条事件开始。</span>';
    document.getElementById('snapshot-count').textContent = `#${state.cursor}`;
    document.getElementById('snapshot-body').innerHTML = state.snapshotMode === 'json' ? V.render(scene,snapshot) : renderSnapshot(snapshot);
    const snapshotToggle = document.querySelector('[data-action="snapshot-mode"]');
    snapshotToggle.textContent = V.toggleLabel(state.snapshotMode);
    snapshotToggle.classList.toggle('active',state.snapshotMode === 'json');
    snapshotToggle.setAttribute('aria-pressed',String(state.snapshotMode === 'json'));
    document.getElementById('business-list').innerHTML = scene.business.map((record,index) => renderBusiness(record,index)).join('');
    document.getElementById('playback-step').innerHTML = `<b>${String(state.cursor).padStart(2,'0')}</b> / ${String(scene.sse.length).padStart(2,'0')} SSE`;
    document.getElementById('event-progress').value = state.cursor;
    document.getElementById('event-progress').setAttribute('aria-valuetext',`已接收 ${state.cursor} 条，共 ${scene.sse.length} 条 SSE`);
    const play = document.getElementById('play-toggle');
    play.innerHTML = icon(state.playing ? 'pause' : 'play');play.setAttribute('aria-label',state.playing ? '暂停回放' : '播放回放');
    document.querySelector('[data-action="prev"]').disabled = state.cursor === 0;
    document.querySelector('[data-action="next"]').disabled = state.cursor === scene.sse.length;
  }

  function renderSnapshot(snapshot) {
    let content = `<div class="snapshot-state"><span>${snapshot.authoritative ? '已记录的最终合并对象' : `截至 SSE #${snapshot.step} 的状态`}</span><span class="badge ${snapshot.status === 'complete' ? 'good' : ['partial','truncated'].includes(snapshot.status) ? 'warn' : ''}">${statusLabel(snapshot.status)}</span></div>`;
    if (snapshot.text) content += `<div class="text-label">回答正文</div><div class="text-output">${e(snapshot.text)}</div>`;
    if (snapshot.refusal) content += `<div class="text-label">拒绝信息</div><div class="text-output">${e(snapshot.refusal)}</div>`;
    if (snapshot.reasoning) content += `<details><summary class="text-label">上游思考扩展 · 未纳入合并对象</summary><div class="text-output">${e(snapshot.reasoning)}</div></details>`;
    for (const tool of snapshot.tools) {
      let valid = false;
      try { JSON.parse(tool.arguments);valid = true; } catch (_) { /* 参数中途不完整是正常的流式状态。 */ }
      content += `<article class="tool-card"><div class="tool-title"><span class="tool-icon">⌘</span><strong>${e(tool.name || '等待工具名')}</strong><span class="badge ${tool.complete ? 'good' : ''}">${tool.complete ? '已完成' : '接收中'}</span></div><div class="tool-locator">choice ${tool.choice} / tool ${tool.index}<br>call_id: ${e(tool.callID || '尚未收到')}${tool.itemID ? `<br>item_id: ${e(tool.itemID)}` : ''}</div><div class="arguments-label">ARGUMENTS <span class="argument-state ${valid ? '' : 'pending'}">${valid ? '可解析 JSON' : '尚未形成完整 JSON'}</span></div><pre class="arguments">${tool.arguments ? C.highlight(tool.arguments) : '<span class="argument-state pending">等待参数增量…</span>'}</pre></article>`;
    }
    if (!snapshot.text && !snapshot.refusal && !snapshot.tools.length && !snapshot.reasoning) content += '<div class="empty-state"><span class="empty-icon">{ … }</span>等待正文或工具增量<br>从左侧选择一条事件</div>';
    content += `<div class="usage-card"><div class="usage-head"><span>REQUEST USAGE</span><span>${snapshot.usage ? '整次请求快照' : '等待 usage 事件'}</span></div><div class="usage-grid">${[['input_tokens','输入'],['output_tokens','输出'],['total_tokens','总计']].map(([key,title]) => `<div class="${key === 'total_tokens' ? 'total' : ''}"><span>${title}</span><strong>${snapshot.usage?.[key] ?? '—'}</strong></div>`).join('')}</div>${U.breakdown(snapshot.usage,'snapshot')}</div>`;
    return content;
  }

  function renderBusiness(record,index) {
    const event = record.object;
    const cache = event.usage ? C.normalizeUsage(event.usage,'responses') : null;
    let detail = event.delta != null ? `<code>${e(event.delta)}</code>` : event.arguments != null ? `<code>${e(event.arguments)}</code>` : event.usage ? `${event.usage.input_tokens} 输入 / ${event.usage.output_tokens} 输出 / ${event.usage.total_tokens} 总计<span class="business-cache">${U.cacheLabel} ${U.count(cache.cached_tokens)} token / ${U.rate(cache.cache_hit_rate)}</span>` : e(event.name || event.finish_reason || event.error || (event.type === 'done' ? '请求协议完整' : ''));
    const range = record.first_event_index === record.last_event_index ? `#${record.event_index}` : `#${record.first_event_index}–${record.last_event_index}`;
    return `<button class="business-row ${event.type === 'error' ? 'error' : ''} ${record.event_index > state.cursor ? 'future' : ''} ${state.selectedBusiness === index ? 'selected' : ''}" data-action="business" data-business-index="${index}" aria-label="${e(event.type)}，来源 SSE ${range}"><span class="business-node"></span><span class="business-copy"><span class="business-type">${e(event.type)}<span class="business-index">SSE ${range}</span></span>${detail ? `<span class="business-detail">${detail}</span>` : ''}${event.tool_index != null ? `<span class="business-meta">choice ${event.choice_index} · tool ${event.tool_index}</span>` : ''}</span></button>`;
  }

  function renderCompare() {
    return `<p class="compare-intro">同一场景的两次独立真实请求。原始事件数和序号各自独立；第三层用统一名称表达业务过程。</p><div class="compare-grid">${[scene,counterpart].sort((a,b) => a.protocol.localeCompare(b.protocol)).map(item => {
      const view = C.finalView(item), counts = {};
      item.business.forEach(record => {const type = record.object.type;counts[type] = (counts[type] || 0)+1;});
      return `<article class="compare-card"><div class="compare-header"><h2>${protocolName(item.protocol)}</h2><span class="badge ${item.httpError ? 'warn' : 'good'}">HTTP ${item.httpStatus}</span></div><div class="compare-body"><div class="compare-facts"><div><span>SSE 事件</span><strong>${item.sse.length}</strong></div><div><span>工具</span><strong>${view.tools.length}</strong></div><div><span>总 token</span><strong>${item.httpError ? '—' : item.tokens}</strong></div></div>${item.httpError ? '<div class="notice">HTTP 错误没有 SSE 三层对象。符合预期的 400 拒绝仍计为场景通过。</div>' : `${U.breakdown(view.usage,'compare')}<div class="text-label">统一业务事件计数</div>${Object.entries(counts).map(([type,count]) => `<div class="compare-type-count"><span>${e(type)}</span><b>${count}</b></div>`).join('')}${view.tools.map(tool => `<div class="tool-card" style="margin-top:13px"><div class="tool-title"><strong>${e(tool.name)}</strong><span class="badge">tool ${tool.index}</span></div><pre class="arguments" style="margin-top:9px">${C.highlight(tool.arguments)}</pre></div>`).join('')}${view.text ? `<div class="text-label" style="margin-top:15px">完整正文</div><div class="text-output">${e(view.text)}</div>` : ''}`}<div class="compare-bottom"><a href="${href(item.id)}">打开此场景 ${icon('next',12)}</a></div></div></article>`;
    }).join('')}</div>`;
  }

  function renderResult() {
    const object = scene.result?.object || scene.httpError?.object;
    return `<div class="result-layout"><div class="result-code"><div class="inspector-head"><span>${scene.httpError ? 'HTTP ERROR · 非 SSE 响应' : 'RESULT · 已记录的合并对象'}</span><button data-action="copy" data-content="result">${icon('copy',11)} 复制 JSON</button></div><pre class="code" tabindex="0" aria-label="完整结果 JSON">${C.highlight(C.pretty(object))}</pre></div><aside class="panel result-aside"><div><h3>${scene.httpError ? '按预期拒绝' : statusLabel(final.status)}</h3><p>${scene.httpError ? '本场景使用无效模型名，官方接口返回 HTTP 400。错误正文不是 SSE，不生成工具或 usage。' : '这里展示此次真实请求保存的完整对象。回放终点直接采用该对象，中间状态仅用于解释增量如何拼接。'}</p>${scene.result ? `<p>覆盖本地 SSE #${scene.result.first_event_index}–${scene.result.last_event_index}。${scene.result.error ? `<br>${e(scene.result.error)}` : ''}</p>` : ''}</div><div><button class="outline-btn" data-action="download" data-content="result">${icon('download',13)} 下载完整对象</button><button class="outline-btn" data-action="download" data-content="business">${icon('download',13)} 下载统一事件</button></div><div class="proof-detail">完整源日志 SHA256<code>${e(scene.sourceSHA256)}</code><p>样本时间：${dataset.date}<br>模型：${dataset.model}<br>浏览、播放和下载均不请求模型。</p></div></aside></div>`;
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

  function selectTab(tab) {
    state.tab = tab;
    if (tab !== 'replay') stopPlayback();
    for (const name of ['replay','compare','result']) {
      const button = document.getElementById(`tab-${name}`);
      button.classList.toggle('active',name === tab);button.setAttribute('aria-selected',String(name === tab));button.tabIndex = name === tab ? 0 : -1;
      document.getElementById(`pane-${name}`).hidden = name !== tab;
    }
  }

  function setCursor(value, preserveBusiness=false) {
    state.cursor = Math.max(0,Math.min(scene.sse.length,Number(value) || 0));
    if (!preserveBusiness) state.selectedBusiness = null;
    if (state.cursor === scene.sse.length) stopPlayback();
    if (!scene.httpError) renderPlayback();
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
    if (button.dataset.filter) {state.filter = button.dataset.filter;renderNav();return;}
    if (button.dataset.tab) {selectTab(button.dataset.tab);return;}
    const action = button.dataset.action;
    if (action === 'play') togglePlayback();
    if (action === 'reset') {stopPlayback();setCursor(0);}
    if (action === 'prev') {stopPlayback();setCursor(state.cursor-1);}
    if (action === 'next') {stopPlayback();setCursor(state.cursor+1);}
    if (action === 'jump') {stopPlayback();setCursor(button.dataset.index);}
    if (action === 'business') {
      stopPlayback();state.selectedBusiness = Number(button.dataset.businessIndex);
      setCursor(scene.business[state.selectedBusiness].event_index,true);
    }
    if (action === 'snapshot-mode') {state.snapshotMode = state.snapshotMode === 'json' ? 'visual' : 'json';renderPlayback();}
    if (action === 'source-mode') {state.sourceMode = state.sourceMode === 'json' ? 'frame' : 'json';renderPlayback();}
    if (action === 'copy') copy(content(button.dataset.content).text);
    if (action === 'download') download(button.dataset.content);
    if (action === 'copy-link') {
      const url = new URL(location.href);url.searchParams.set('step',state.cursor);url.searchParams.set('tab',state.tab);url.searchParams.set('view',state.snapshotMode);copy(url.href);
    }
  });
  document.getElementById('scenario-search').addEventListener('input',event => {state.search = event.target.value;renderNav();});
  app.addEventListener('input',event => {if (event.target.id === 'event-progress') {stopPlayback();setCursor(event.target.value);}});
  app.addEventListener('change',event => {if (event.target.id === 'playback-speed') {const playing = state.playing;stopPlayback();state.interval = Number(event.target.value);if (playing) togglePlayback();}});
  document.addEventListener('keydown',event => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();const names = ['replay','compare','result'];const index = names.indexOf(state.tab);const next = names[(index+(event.key === 'ArrowRight' ? 1 : 2))%3];selectTab(next);document.getElementById(`tab-${next}`).focus();return;
    }
    if (state.tab !== 'replay' || scene.httpError || event.target.closest('input,textarea,select,button,a,summary')) return;
    if (['ArrowLeft','ArrowRight'].includes(event.key)) {event.preventDefault();stopPlayback();setCursor(state.cursor+(event.key === 'ArrowRight' ? 1 : -1));}
  });
  window.addEventListener('pagehide',stopPlayback);
  renderNav();renderScene();
})();
