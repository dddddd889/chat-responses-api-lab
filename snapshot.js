/* 第二层的可视化与 JSON 模式共用同一个回放状态；最终对象不增加展示字段。 */
(function () {
  'use strict';
  const C = window.StreamCore;
  const toggleLabel = mode => mode === 'json' ? '可视化' : 'JSON';

  // 终点直接取日志原对象；中途是演示状态，明确标识，不冒充服务端或 Go 的返回对象。
  function object(scene, snapshot) {
    if (snapshot.authoritative) return scene.result.object;
    return {preview:true,event_index:snapshot.step,status:snapshot.status,text:snapshot.text,refusal:snapshot.refusal,tools:snapshot.tools,usage:snapshot.usage};
  }

  function render(scene, snapshot) {
    const label = snapshot.authoritative ? `已记录的${scene.result.status === 'partial' ? '部分' : '最终'}合并对象 · 原始 JSON` : `截至 SSE #${snapshot.step} 的累积状态 · 演示 JSON`;
    return `<div class="snapshot-json-label">${label}</div><div class="snapshot-json"><pre class="code" tabindex="0" aria-label="合并对象 JSON">${C.highlight(C.pretty(object(scene,snapshot)))}</pre></div>`;
  }

  window.StreamSnapshotView = {object,render,toggleLabel,copyLabel:'复制当前合并对象 JSON'};
})();
