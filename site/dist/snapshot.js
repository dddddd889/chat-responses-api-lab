/* 第二层的可视化与 JSON 模式共用同一个回放状态；全程保持同一套展示字段。 */
(function () {
  'use strict';
  const C = window.StreamCore;
  const toggleLabel = mode => mode === 'json' ? '可视化' : 'JSON';

  // 全程输出累积状态；原始结果单独展示，避免终点切换 JSON 结构。
  function object(scene, snapshot) {
    return {preview:true,event_index:snapshot.step,status:snapshot.status,text:snapshot.text,refusal:snapshot.refusal,tools:snapshot.tools,usage:snapshot.usage};
  }

  function render(scene, snapshot) {
    const label = `截至 SSE #${snapshot.step} 的累积状态 · 演示 JSON`;
    return `<div class="snapshot-json-label">${label}</div><div class="snapshot-json"><pre class="code" tabindex="0" aria-label="合并对象 JSON">${C.highlight(C.pretty(object(scene,snapshot)))}</pre></div>`;
  }

  window.StreamSnapshotView = {object,render,toggleLabel,copyLabel:'复制当前合并对象 JSON'};
})();
