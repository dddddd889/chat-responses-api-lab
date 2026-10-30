# SSE 流观察室

使用已有的 14 个 DeepSeek 真实请求样本，交互查看从 SSE 事件到累积对象与完整结果的过程。所有浏览、回放和下载都在浏览器内执行，不需要密钥，不会调用模型。旧文档和源日志不做修改。

## 打开

在仓库根目录运行 `python3 -m http.server 8766 --directory site/dist`，打开 `http://localhost:8766/`。数据以普通脚本加载，没有 fetch、外部字体或 CDN，启动本地服务器后断网也可以使用。路由依赖浏览器 History API，请通过 HTTP 地址访问。每个场景有独立页面，例如：

- `dist/scenarios/chat-multi_tool/index.html`
- `dist/scenarios/responses-multi_tool/index.html`

也可以在当前目录启动静态服务：

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

访问 `http://127.0.0.1:8765/`。整个 `dist/` 可以复制到任意静态托管服务，支持子目录部署，无需路由重写。

## 交互

- 侧栏按接口筛选、搜索场景；右上角切换同一场景的 Chat / Responses 实测页面。
- 逐步回放支持播放、暂停、速度、单步按钮、进度条，以及焦点不在表单控件时的左右方向键。回放控制条滚动时吸顶，查看三列及字段变化时也可随时操作。
- 三块区域展示“上游 SSE、拼接状态、完整结果”。桌面端上游区域内为左侧事件列表、右侧 JSON/事件帧，下方累积状态与完整结果并排；窄屏按阅读顺序堆叠。上游列表展示完整 Responses type；Chat 展示 SSE event（默认 message），并单独标注 JSON object。点击事件联动当前累积对象，也可以查看按事件重建的 SSE 帧。重建帧保留语义，不冒充原始网络字节。
- 拼接状态默认展示 Git 风格 diff，红色减号为本条处理前，绿色加号为本条处理后；比较上一条 SSE 与当前 SSE 的累积对象。点击 JSON 可查看完整对象，逐条重放 SSE；从开头到终点都采用日志结果的字段布局，不读取最终日志反填。Chat 使用项目 Go ChatResult（choices/tool_calls 是按编号保存的对象，并非官方响应数组），Responses 使用 Go ResponseObject 已建模字段。差异标记随当前事件重新计算，复制按钮始终复制完整累积对象 JSON；当前状态取消代码框高度限制，完整随页面展开；可切换“内容摘要”查看正文、工具与缓存指标。
- 完整结果默认展示截至当前 SSE 的完整累积 JSON；切换 Diff 查看上一条到当前条的变化，仅到终点才核对日志。回放结果区与“完整结果”标签页均取消代码框高度限制，使用页面滚动完整阅读。原来下方重复的“拼接状态 → 完整结果”表格已移除。Responses 的终止事件使用事件内 response 完整值校准，不从日志结果反填。
- 新增“完整过程”视图：模型响应 → 适配器转换 → 写入会话 → 执行工具 → 下一次请求。可选择单个调用并追踪上游 ID、pi-ai/Harness ID、工具参数和 EventLog 外壳；支持跳回该调用开始的 SSE，复制链接保留阶段与调用选择。
- 现有样本只有 API 实测数据。pi-ai 工具块、Harness 消息及 EventLog 片段是依据源码的结构演示，省略未采集的 id/source/replayState、seq/time/turn/step 等字段；没有实际运行适配器或写入会话。工具执行与第二次请求明确标为未采集，不生成模拟执行结果或已发送请求。
- 转换规则核对自 `deepseek-ai/deepseek-harness` 提交 `687f282e8625c6b8d11ff58211a90524be2e4317` 的 `llm-pi-ai/src/stream.ts`、`agent-loop/src/agent.ts`、`agent-loop/src/tool-calls.ts` 及 `session/src/index.ts`；界面提供固定提交的源码链接。采集真实运行时还需记录实际 pi-ai 版本、provider 和模型配置。
- “协议对照”并排查看同类型的两次独立请求；“完整结果”保留项目 Go 累积器保存的日志对象、复制和 JSON 下载。
- HTTP 400、Chat length、Responses incomplete 分开说明。usage 未到达时显示未知，不显示伪造的零用量。

页面的累积结果按项目 Go 类型展示已建模字段；其他扩展在上游事件 JSON 中完整保留。参数即使语法上是合法 JSON，也不代表满足工具业务 schema；页面不会执行工具。

## 重新生成与验证

生成器只读 `../logs/deepseek-live-three-layer-20261030-103715/`，不修改来源文件，不产生 API 调用。

```sh
python3 build.py
node --check web/core.js
node --check web/app.js
node --test core.test.cjs
```

`web/` 为页面源码，`build.py` 将静态资源和数据复制到 `dist/`，并生成首页和 14 个独立页面。运行时和这些数据测试均不依赖第三方包。

数据源日期为 2026-10-30，总计 1815 token；页面中的 SSE 序号是本地 event_index。Responses 的 sequence_number 原样显示在上游对象内，两种接口的序号不强行对齐。

## 可选 DOM 交互测试

数据测试只使用 Node 标准库。另有可选 DOM 测试，验证页面脚本执行、播放暂停、来源联动、标签切换和搜索；测试依赖仅安装在临时目录，不进入静态站点：

```sh
npm install --prefix /private/tmp/sse-site-dom-test --no-audit --no-fund --ignore-scripts jsdom@26.1.0
SSE_DOM_MODULE=/private/tmp/sse-site-dom-test/node_modules/jsdom node --test dom.test.cjs
```

DOM 测试不包含真实浏览器的屏幕和布局验收。当前验证结果见 `verification.json`。离线分发包是 `stream-lab-static.zip`，解压后打开其中的 `index.html`。

### 推理内容与来源

Chat 的 `reasoning_content` 是提供方扩展字段，逐条追加；Responses 的 `reasoning_text.delta` 和 `reasoning_summary_text.delta` 分别按输出项、内容索引或摘要索引累积。done 全文覆盖校准，避免重复追加；推理正文、推理摘要和回答分开展示。两栏 JSON 和 Diff 均随当前事件变化。

历史 Chat Go 日志没有保存推理字段：终点对照副本仅从上游 SSE 补入缺失推理并标明来源，“完整结果”标签页和下载仍保留日志原文。Responses 的遗漏摘要同样只在对照副本补入，终止事件中的 response 校准当前状态。

实现核对了 Harness 锁定的 pi-ai 1.1.0（不是本地旧版 node_modules）：pi-ai 累积 thinking 并发出 thinking_delta，Harness 适配成 reasoning-delta，assembler 按内容块累积。Harness 的 pi-ai 补丁只涉及工具参数解析，未改变推理逻辑。本次做源码核对和观察室回放验证，没有运行 Harness 或 pi-ai 的模型请求。

参考：[Harness 适配器](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-pi-ai/src/stream.ts)、[OpenAI Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events#response.reasoning_text.delta)。

用量来源：回放两栏的 usage 仅来自当前进度已经收到的上游事件，未收到时保持 null。右栏标出用量来源的 SSE 序号。顶部概览、字段说明和“完整结果”标签页明确标为日志终点数据，不随回放变化。

完整过程同时展示正文、推理和工具块：pi-ai start/delta/end → Harness chunks → 内容累积 → EventLog 事件片段。无工具时仅执行工具阶段不适用，下一次请求仍标未采集。长度上限保留已生成内容并标注 max-tokens；HTTP 错误不生成 assistant 消息。usage 单独放在 EventLog data.usage，按 pi-ai 扣除缓存后的 input 映射。未采集的消息 ID、签名、seq/time、turn/step、stream 不伪造。

独立过程进度 `jstep` 每步保留当时的累积值；一次 SSE 可引发多个映射步骤。终止检查后才单独展示 session.append，提交前 EventLog 为 null。旧链接没有 jstep 时按 step 定位，step=0 对应空起点。Chat 提交后另展示 reasoning → thinking → reasoning_content 的同源历史字段映射，不冒充已发送请求。当前只采集一次模型请求，不是包含工具闭环的完整 turn。

参考 pi-ai 1.1.0 的 openai-completions/openai-responses-shared，以及 Harness 固定提交的 stream.ts、assembler.ts、agent.ts。离线加载真实适配器因本地缺少 @deepseek-ai/dsh-brand 工作区依赖未成功；验证限于源码核对、真实样本投影和观察室交互测试，没有捕获实际 Harness EventLog。

左侧只列 7 种场景，右上角保留 Chat / Responses 协议标签。协议写入 URL 路径，切换时保留主标签、阶段和展示模式；进度限制在目标样本范围内，无效的工具选择清除。移除首屏五张统计卡片，HTTP 状态使用紧凑标记；事件总数、Token 字段说明与回放用量仍保留在对应区域。

路由状态：URL 查询参数 `tab` 保存主标签，`step` 保存回放 SSE 序号，`jstep` 保存完整过程映射步骤，`stage` 保存过程阶段，`call` 保存选中工具，`view/result_view/source` 保存展示模式。交互实时更新地址；刷新、分享和前进后退恢复状态。标签、阶段与工具切换新增历史；连续进度变化替换当前历史，恢复历史时暂停播放。
