# SSE 流观察室

使用已有的 14 个 DeepSeek 真实请求样本，交互查看从 SSE 事件到累积对象与完整结果的过程。所有浏览、回放和下载都在浏览器内执行，不需要密钥，不会调用模型。旧文档和源日志不做修改。

## 打开

直接双击 `dist/index.html`。数据以普通脚本加载，没有 fetch、外部字体或 CDN，断网也可以使用。每个场景有独立页面，例如：

- `dist/scenarios/chat-multi_tool/index.html`
- `dist/scenarios/responses-multi_tool/index.html`

也可以在当前目录启动静态服务：

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

访问 `http://127.0.0.1:8765/`。整个 `dist/` 可以复制到任意静态托管服务，支持子目录部署，无需路由重写。

## 交互

- 侧栏按接口筛选、搜索场景；右上角切换同一场景的 Chat / Responses 实测页面。
- 逐步回放支持播放、暂停、速度、单步按钮、进度条，以及焦点不在表单控件时的左右方向键。
- 三列依次展示“上游 SSE、拼接状态、完整结果”。上游列表展示完整 Responses type；Chat 展示 SSE event（默认 message），并单独标注 JSON object。点击事件联动当前累积对象，也可以查看按事件重建的 SSE 帧。重建帧保留语义，不冒充原始网络字节。
- 第二层默认展示累积对象 JSON，逐条重放 SSE；从开头到终点都采用日志结果的字段布局，不读取最终日志反填。Chat 使用项目 Go ChatResult（choices/tool_calls 是按编号保存的对象，并非官方响应数组），Responses 使用 Go ResponseObject 已建模字段。可切换“内容摘要”查看正文、工具与缓存指标。
- “拼接状态 → 完整结果”显示本条 SSE 更新的字段路径、当前值与日志最终值；到终点应显示“逐字段一致”。日志完整结果独立保留，不随回放变化。Responses 的终止事件使用事件内 response 完整值校准；这属于流协议本身，不是从日志结果反填。
- 第三列固定展示同一次请求保存的 Go 累积器完整结果；中间列随 SSE 更新，到终点可与第三列直接逐字段对照。统一业务事件不再作为页面列展示，原始日志和下载数据仍保留。
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
