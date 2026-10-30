/* Token 与缓存的展示层：只解释已有统计，不改写原始 usage，不推导价格。 */
(function () {
  'use strict';
  const C = window.StreamCore;
  const e = C.escapeHTML;
  const count = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const rate = value => value == null ? '—' : (value*100).toLocaleString('zh-CN',{maximumFractionDigits:1})+'%';

  // 概览展示整次请求的缓存命中；回放卡片则只展示当前位置已收到的统计。
  function overview(usage) {
    const known = usage?.cached_tokens != null;
    return `<div class="stat cache-stat" data-metric="cache"><div class="stat-name">缓存命中</div><div class="stat-value ${known && usage.cached_tokens > 0 ? 'good' : ''}"><span data-cache="cached">${count(usage?.cached_tokens)}</span><small>token</small></div><div class="cache-overview-rate">输入缓存命中率 <strong data-cache="rate">${rate(usage?.cache_hit_rate)}</strong></div><div class="stat-caption">${known ? `输入 ${count(usage.input_tokens)} · 未命中 ${count(usage.uncached_tokens)}` : usage ? '上游未返回缓存明细' : '未返回 usage'}</div></div>`;
  }

  // 缓存是输入的一部分；没有明确缓存统计时保持未知，不能补成 0。
  function breakdown(usage, context) {
    const known = usage?.cached_tokens != null;
    return `<div class="cache-breakdown" data-cache-context="${context}"><div class="cache-breakdown-head"><span>输入缓存</span><strong data-cache="rate">${rate(usage?.cache_hit_rate)}</strong></div>${known && usage.cache_hit_rate != null ? `<progress class="cache-progress" max="1" value="${usage.cache_hit_rate}" aria-label="输入缓存命中率">${rate(usage.cache_hit_rate)}</progress>` : '<div class="cache-progress-empty"></div>'}<div class="cache-breakdown-facts"><div><span>命中缓存</span><strong data-cache="cached">${count(usage?.cached_tokens)}</strong></div><div><span>未命中缓存</span><strong data-cache="uncached">${count(usage?.uncached_tokens)}</strong></div></div><div class="cache-explanation">${known ? `命中 ${count(usage.cached_tokens)} / 输入 ${count(usage.input_tokens)} token；缓存已包含在输入中` : usage ? '上游未返回 cached_tokens，不按 0 处理' : context === 'snapshot' ? '等待 usage 事件，当前统计未知' : '未返回 usage，缓存统计未知'}</div></div>`;
  }

  // 解释从上游原始 JSON 取值，避免 Go 类型中尚未建模的别名字段消失。
  function definitions(scene) {
    const wire = scene.sse.map(record => scene.protocol === 'chat' ? record.object?.usage : record.object?.response?.usage).filter(Boolean).slice(-1)[0];
    if (!wire) return '<div class="token-guide token-guide-empty">未返回 usage，无法展示 token 与缓存统计。</div>';
    const usage = C.normalizeUsage(wire,scene.protocol);
    const rows = scene.protocol === 'chat' ? [
      ['prompt_tokens',wire.prompt_tokens,'输入 token 总数，包含缓存命中和未命中两部分。'],
      ['completion_tokens',wire.completion_tokens,'输出 token 数，包含生成正文、工具调用及上游计入输出的思考 token。'],
      ['total_tokens',wire.total_tokens,'输入加输出；缓存命中不在这里额外相加。'],
      ['prompt_tokens_details.cached_tokens',wire.prompt_tokens_details?.cached_tokens,'输入中命中缓存的 token 数，是 prompt_tokens 的一部分。'],
      ['prompt_cache_hit_tokens',wire.prompt_cache_hit_tokens,'DeepSeek 缓存命中统计，与上面的 cached_tokens 表示同一份命中量，不能重复相加。'],
      ['prompt_cache_miss_tokens',wire.prompt_cache_miss_tokens,'DeepSeek 输入中未命中缓存的 token 数；与命中量之和应为输入总量。']
    ] : [
      ['input_tokens',wire.input_tokens,'输入 token 总数，包含缓存命中和未命中两部分。'],
      ['output_tokens',wire.output_tokens,'输出 token 数，包含生成正文、工具调用及上游计入输出的思考 token。'],
      ['total_tokens',wire.total_tokens,'输入加输出；缓存命中不在这里额外相加。'],
      ['input_tokens_details.cached_tokens',wire.input_tokens_details?.cached_tokens,'输入中命中缓存的 token 数，是 input_tokens 的一部分。']
    ];
    const reasoning = scene.protocol === 'chat' ? wire.completion_tokens_details?.reasoning_tokens : wire.output_tokens_details?.reasoning_tokens;
    if (reasoning != null) rows.push([scene.protocol === 'chat' ? 'completion_tokens_details.reasoning_tokens' : 'output_tokens_details.reasoning_tokens',reasoning,'输出中用于思考的 token，已经计入输出，不再次加到 total_tokens。']);
    const equation = usage.cached_tokens == null ? '未返回缓存明细，缓存命中率未知' : `输入 ${count(usage.input_tokens)} = 命中 ${count(usage.cached_tokens)} + 未命中 ${count(usage.uncached_tokens)}；命中率 ${rate(usage.cache_hit_rate)}`;
    return `<details class="token-guide"><summary><span><strong>Token 字段说明</strong><span class="token-equation">${equation}</span></span><span class="guide-toggle">展开中文解释 ▾</span></summary><div class="token-table-wrap"><table class="token-table"><thead><tr><th>上游字段</th><th>本次值</th><th>中文含义</th></tr></thead><tbody>${rows.map(([field,value,description]) => `<tr><td><code>${e(field)}</code></td><td>${count(value)}</td><td>${description}</td></tr>`).join('')}</tbody></table><p>总计 ${count(usage.total_tokens)} = 输入 ${count(usage.input_tokens)} + 输出 ${count(usage.output_tokens)}。命中率以输入为分母，不以总计为分母。这里解释的是上游数据，原始 JSON 保持不变。</p></div></details>`;
  }

  window.StreamUsageView = {overview,breakdown,definitions,count,rate,cacheLabel:'缓存命中'};
})();
