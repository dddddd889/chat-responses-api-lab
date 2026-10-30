# Chat / Responses API Lab

零第三方依赖的 Go SSE、Chat Completions 与 Responses 流解析器，附 14 个真实场景的交互静态站点。

- 在线站点：https://dddddd889.github.io/chat-responses-api-lab/
- 仓库：https://github.com/dddddd889/chat-responses-api-lab
- 站点源码：`site/web/`；静态输出：`site/dist/`。
- 本地预览：`python3 -m http.server 8765 --bind 127.0.0.1 --directory site/dist`。
- Go 验证：`go test -race ./...`；站点验证：`python3 site/build.py && node --test site/core.test.cjs`。

# Go SSE 流解析器

仅使用 Go 标准库，Go 1.19+。整个目录是独立模块；将目录下所有非 `_test.go` 的 Go 源文件复制到项目自己的 `sse` 包即可使用，不需要复制这里的 `go.mod`。

## 三层日志：上游 JSON、合并对象、统一业务事件

命令行默认 `-log-format jsonl`，每行一个 JSON 对象，同一文件以 `kind` 区分三层：

| 层 | kind | object 中的内容 |
|---|---|---|
| 1 | sse | 每条完整 SSE data 中的原始 JSON，保留未知字段、字段缺省及数值精度 |
| 2 | result | 跨事件合并的 ChatResult / ResponseObject，附 complete/partial 及错误 |
| 3 | event | 两种协议共用的 BusinessEvent，如工具开始、参数增量、完成、usage |

SSE 解帧只把 `event/id/data` 组装好；`data` 仍是 JSON 字符串。Chat/Responses 解码随后把它转成 Go 接口对象，Collect 再跨事件合并。第一层在 Go 对象解码前记录，因此不会补出原本缺省的 `null`，也不会丢掉尚未建模的扩展字段。JSON 排版和字符转义可能规范化，字段和值保持原意；需要保留原始网络字节时选择 `-log-format raw`。

```json
{"kind":"sse","protocol":"chat","event_index":3,"event":"message","object":{"id":"demo","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"city"}}]}}]}}
{"kind":"event","protocol":"chat","event_index":3,"first_event_index":3,"last_event_index":3,"object":{"type":"tool_arguments_delta","choice_index":0,"tool_index":0,"call_id":"call_demo","name":"weather","delta":"city"}}
```

示例省略时间等字段。每条完整 data 事件有从 1 开始的本地 `event_index`；Responses 自带的 `sequence_number` 原样保留在第一层 JSON 内，两者含义不同。工具按 choice/tool index 或 output index/item ID 拼接，不能按事件序号分组。第二层通过 `first_event_index/last_event_index` 指明合并范围，第三层通过 `event_index` 关联触发它的上游事件；tool_done 还记录工具开始至完成的范围。

第三层事件包括 `text_delta`、`refusal_delta`、`tool_start`、`tool_arguments_delta`、`tool_done`、`choice_done`（Chat 的原始结束原因）、`usage`、`done`、`error`。Chat 的工具 id 映射为 call_id；Responses 保留独立的 item_id 和 call_id，choice_index 固定为 0，tool_index 沿用 output_index，不重新编号。usage 统一使用 input_tokens/output_tokens/total_tokens，是整次请求的快照，不累加各事件。仅规范化常见文本、拒绝和函数工具；未知扩展（如未建模的思考/音频事件）在第一层完整保留，不推断其业务含义。

Chat 的 `[DONE]` 不是 JSON，第一层保存为 `{"kind":"sse","data":"[DONE]",...}`。完整事件里的非法 JSON 同样用 data 保存，再返回解析错误。解帧前的半截事件、非法 UTF-8、行长度超限等无法形成完整 JSON，只写 error/partial；若需保留这些原始字节，请使用 raw 模式。

Go 调用显式设置 `Config{LogWriter: file, LogFormat: "jsonl"}`；默认空值仍为纯 SSE 日志。`Next` 只记录第一层，`Collect` 额外输出第二、三层。业务事件根据已经通过拼接校验的内容生成，不执行工具；tool_done 的完整参数仍需调用方按业务 schema 验证。done 表示协议完整，Chat 生成截断保留在 choice_done.finish_reason=length 中；Responses incomplete 会输出 error 和 partial。

`NewLogReplayReader` 同时支持纯 SSE、旧 raw/parsed/result JSONL 和新版三层日志。新格式回放恢复 data/event/id 语义，不还原心跳注释、原始排版及网络读取边界。新的本地时间戳表示转换时间，不冒充原请求的到达时间。

最新真实请求的三层日志见 [场景验证索引](logs/deepseek-live-three-layer-20261030-103715/SCENARIOS.md)：14 个场景重新调用接口，包含 12 份 SSE 流和 2 份 HTTP 错误。未被该索引直接引用的历史日志已清理。

## Responses API 与原始事件日志

请求 `POST /v1/responses` 时设置 `"stream": true`。拿到 `resp` 后检查 HTTP 状态码和 `Content-Type: text/event-stream`，使用 `NewResponseDecoder` 或带配置的 `NewResponseDecoderWithConfig`。

**Responses 的终止信号是 `response.completed` / `response.failed` / `response.incomplete`，不是 Chat Completions 的 `[DONE]`。** 成功仅接受 `response.completed`；流内 `error`、未完成、失败和提前 EOF 都会返回错误。

### 把已有 resp.Body 写入日志并返回完整结果

以下函数导入 `fmt`、`mime`、`net/http`、`os` 和本包 `sse`。每条请求使用独立日志文件；`O_EXCL` 防止误覆盖已有排查证据。

```go
// readResponse 保存收到的 SSE 原始字节，并返回文本、函数调用与 usage。
func readResponse(resp *http.Response, logPath string) (result *sse.ResponseObject, err error) {
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("上游 HTTP 状态异常: %s", resp.Status)
    }
    contentType, _, parseErr := mime.ParseMediaType(resp.Header.Get("Content-Type"))
    if parseErr != nil || contentType != "text/event-stream" {
        return nil, fmt.Errorf("上游未返回 SSE: %q", resp.Header.Get("Content-Type"))
    }
    logFile, openErr := os.OpenFile(logPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
    if openErr != nil {
        return nil, openErr
    }
    defer func() { // 保留读取错误，同时检查文件关闭失败。
        if closeErr := logFile.Close(); err == nil {
            err = closeErr
        }
    }()
    decoder := sse.NewResponseDecoderWithConfig(resp.Body, sse.Config{
        LogWriter: logFile, // 同步记录原始流与解析对象。
        LogFormat: "jsonl", // sse / result / event 三层写入同一文件。
        MaxTotalBytes: 32 * 1024 * 1024, // 全部事件 JSON 的累计预算。
    })
    return decoder.Collect()
}
```

结果取法：

```go
fmt.Println(result.OutputText()) // 按 output/content 顺序连接完整正文。
for _, item := range result.Output {
    if item.Type == "function_call" {
        fmt.Println(item.ID, item.CallID, item.Name, item.Arguments)
    }
}
if result.Usage != nil {
    fmt.Println(result.Usage.InputTokens, result.Usage.OutputTokens, result.Usage.TotalTokens)
}
```

`item.ID` 是输出项目 ID，`item.CallID` 才是回传函数结果使用的 `call_id`。参数保留原始 JSON 字符串，通过标准库 `json.Unmarshal` 显式解码，不自动执行工具。最终结果采用终止事件里的完整 `response.output`，不会把 delta、arguments.done 和 item.done 的全文重复追加。未知工具类型、reasoning、注解等完整字段保存在 `result.Raw`，类型化字段只是常用子集，不是完整 Responses SDK。

### 逐个打印事件

```go
// decoder 配置方式同上；一条流选择 Next 或 Collect 模式，从头开始消费。
for {
    event, err := decoder.Next()
    if err == io.EOF {
        break // 只有此前收到 response.completed 才会正常 EOF。
    }
    if err != nil {
        return err
    }
    fmt.Printf("事件=%s 序号=%d JSON=%s\n", event.Type, *event.SequenceNumber, event.Raw)
}
```

终止事件先返回一次供调用方打印；下一次 Next 才返回 EOF 或对应错误。`response.failed` / `response.incomplete` 使用 `*ResponseTerminalError`，可用 `errors.Is(err, sse.ErrResponseFailed)` / `errors.Is(err, sse.ErrResponseIncomplete)` 判断状态，并从错误的 `Event` 中取上游原因。流内 `error` 返回 `*APIError`。提前 EOF 可以用 `errors.Is(err, io.ErrUnexpectedEOF)` 判断。Collect 出错时返回部分结果；不要只取结果忽略错误。

已处理正文 delta/done、拒绝信息 delta/done、函数参数 delta/done、output item added/done 以及响应生命周期。按 `output_index` / `content_index` 分组，工具按 output item 归属；要求相关索引和 item ID 存在，生命周期 response ID 一致；序号必需、非负并严格递增，但不要求连续或从 0 开始。未知事件通过 Raw 透传，不推断其业务意义。此实现面向 HTTP SSE，不处理 Realtime/WebSocket。

### 不访问模型，直接运行日志示例

在当前模块目录执行：

```sh
go run ./cmd/responses-log -input testdata/responses.sse -log responses-demo.sse.log
```

终端会输出最终 JSON（正文“你好世界”、weather 参数和总 token 数 30），逐事件上游 JSON、统一业务事件和合并对象保存在 `responses-demo.sse.log`（JSONL 格式）。文件已经存在时命令会报错，请为每次运行选择新文件名。可回放该日志并另存一份：

```sh
go run ./cmd/responses-log -input responses-demo.sse.log -log responses-replay.sse.log
```

`-input -` 从标准输入读取，可接到已有 HTTP 客户端或 `curl -N` 的 SSE 输出；`-max-bytes` 调整累计 JSON 预算。命令不负责 API 请求或凭证，失败退出码为 1，同时仍打印部分结果。

### Chat 模式：保存 Chat Completions 原始事件流

相同命令加上 `-mode chat` 即可切换协议。Chat 模式按 choice/tool index 拼接，读取到 `[DONE]` 后检查候选完整性，并保留结束原因之后的 usage。

```sh
go run ./cmd/responses-log -mode chat -input testdata/chat.sse -log chat-demo.sse.log
```

终端输出最终 JSON：`choices[0].content` 为“你好世界”，工具参数为 `{"city":"上海"}`，`usage.total_tokens` 为 30。日志默认包含逐事件上游 JSON、合并结果和统一业务事件；用 `-log-format raw` 可只保存原始 SSE。回放已有 Chat 日志：

```sh
go run ./cmd/responses-log -mode chat -input chat-demo.sse.log -log chat-replay.sse.log
```

从标准输入实时接收已有客户端输出时使用：

```sh
go run ./cmd/responses-log -mode chat -input - -log chat-live.sse.log
```

另一终端用 `tail -f chat-live.sse.log` 即可跟随查看三层记录。默认模式仍为 `responses`；不指定 `-log` 时，Chat 写入 `chat.sse.log`，Responses 写入 `responses.sse.log`。文件已存在就报错，不覆盖；重新运行请选新文件名。未知模式在创建日志前报错。缺失 DONE、超限或其他错误会保留日志与部分结果，命令以非零状态退出。

在 Go 业务代码中，确认响应状态码和 `Content-Type` 后，使用 `NewChatDecoderWithConfig`：

```go
// logFile 是调用方打开并负责关闭的独立日志文件。
decoder := sse.NewChatDecoderWithConfig(resp.Body, sse.Config{
    LogWriter: logFile,
    LogFormat: "jsonl", // 同时记录原始流、增量对象和最终对象。
    MaxTotalBytes: 32 * 1024 * 1024,
})
result, err := decoder.Collect() // 持续记录原始数据并拼接到 DONE。
```

打开文件、关闭文件并检查错误的完整写法与上面的 `readResponse` 相同，只需把 `ResponseObject` 换成 `ChatResult`、`NewResponseDecoderWithConfig` 换成 `NewChatDecoderWithConfig`。同样可选择逐块 `Next()`，日志仍会自动写入；日志的读取范围、短写入错误和换行规则对两种模式一致。

### 日志行为

- `LogWriter` 同样适用于通用 SSE 和 Chat Completions。默认 nil，不写任何文件。
- raw 模式按读取到的字节同步写入，保留原始 event/data、注释、换行和非法数据；jsonl 模式按完整事件记录上游 JSON，并写合并结果与统一业务事件，回放时重建 SSE 语义。
- raw 模式记录已经读取的响应正文，缓冲读取可能提前记录稍后的字节；jsonl 模式只记录已解帧的完整事件。终止事件后不继续排空连接，不保证捕获后续尾部字节。
- 写日志失败或短写入立即停止解码，返回可用 `errors.Is(err, sse.ErrStreamLogWrite)` 判断的错误，保留底层磁盘错误。调用方关闭文件；使用 `bufio.Writer` 时还必须自行 Flush 并检查错误。直接传 `*os.File` 可以即时用 `tail -f` 查看。
- 不记录请求头或鉴权凭证。正文与工具参数完整入日志；示例文件权限为 0600，库不创建目录、不自动轮转日志。
- `MaxTotalBytes` 默认 32 MiB，Responses 的 Next 和 Collect 都生效，计入最终对象与未知事件的 JSON 字节；不等于日志文件字节上限（注释、SSE 字段和读缓冲也会入日志）。日志保留和轮转由调用方管理。

协议依据：[官方 Responses SSE 事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)。

## 一次拿到完整回答、工具参数和 usage

已经检查 HTTP 状态码和响应类型后，直接读取 `resp.Body`：

```go
defer resp.Body.Close()

// decoder 从响应正文读取标准 Chat Completions 流。
decoder := sse.NewChatDecoder(resp.Body)
result, err := decoder.Collect() // 一直读取到 [DONE]，自动拼接文本与工具调用。
if err != nil {
    return err // result 可能有部分结果，但此时不能当成成功回答。
}
for index, answer := range result.Choices { // map 的键是实际 choice.index，遍历顺序不固定。
    fmt.Printf("候选 %d 完整回答: %s\n", index, answer.Content)
    for toolIndex, tool := range answer.ToolCalls { // 键是该候选内部的 tool.index。
        fmt.Printf("工具 %d: id=%s 名称=%s 参数=%s\n",
            toolIndex, tool.ID, tool.Function.Name, tool.Function.Arguments)
    }
}
if result.Usage != nil {
    fmt.Printf("输入=%d 输出=%d 合计=%d\n",
        result.Usage.PromptTokens, result.Usage.CompletionTokens, result.Usage.TotalTokens)
}
```

例如 `result.Choices[2].ToolCalls[4]` 是候选 2 的工具 4；候选 0 的工具 4 是另一份独立状态。索引不需要连续，内部使用 map，不会根据最大的 index 分配数组。要按编号显示时，调用方可以排序 map 的键。

用量属于整个请求，最终保存在 `result.Usage`，不按候选分配、不逐块相加；后续 `usage: null` 不会清空此前统计。未开启 `stream_options: {"include_usage": true}` 或没有收到用量时，`Usage == nil`。

`Arguments` 保留完整原始字符串；模型给出的内容可能不是合法 JSON，可按业务结构显式解码：

```go
// arguments 是业务需要的工具参数结构，不使用 map 自动转换数字。
var arguments struct {
    City string `json:"city"`
}
if err := tool.Function.DecodeArguments(&arguments); err != nil {
    return err
}
```

同一工具的参数按接收顺序追加，函数名片段也会追加；ID 和类型只更新存在的字段，后续缺省不清空，重复同值也不会被重复拼接。同一 choice/tool 编号对应不同 ID 或类型会报 `ErrInvalidChatDelta`。不同请求的 ID、模型、创建时间混入同一累积器也会报错，失败的整个块不会写入。

### 边展示增量，边保存完整结果

```go
// accumulator 是本次请求专用的累积器；同一实例顺序使用。
accumulator := sse.NewChatAccumulator()
for {
    chunk, err := decoder.Next() // 按前面的方式创建 decoder。
    if err == io.EOF {
        break // ChatDecoder 只有收到 DONE 才正常 EOF。
    }
    if err != nil {
        return err
    }
    if err := accumulator.Add(chunk); err != nil {
        return err
    }
    for _, choice := range chunk.Choices {
        if choice.Delta.Content != nil {
            fmt.Printf("候选 %d 增量: %s\n", choice.Index, *choice.Delta.Content)
        }
    }
}
if err := accumulator.Finish(); err != nil { // EOF 后检查候选与工具完整性，再封存累积器。
    return err
}
result := accumulator.Result() // 返回独立快照，改动 map、usage、结束原因不影响累积器。
```

`Result()` 也能在流式处理中调用以查看当前结果，但快照不证明流已正常结束。`Collect()` 应在第一次 `Next()` 之前调用；已经取出的块需要手工 `Add`，否则它只能拼接剩余流。出现错误时 `Collect()` 返回此前的部分结果和错误。手工模式需要在正常 EOF 后调用 `Finish()`；它不自行读取或验证 DONE，调用方必须先检查读取结果。重复 `Finish()` 幂等，封存后 `Add` 返回 `ErrAccumulatorFinished`。

### 索引、完成状态和总量校验

JSON 中每个 choice 和每个工具调用都必须显式包含非负整数 `index`。缺省、null、负数、小数、字符串或溢出值返回 `ErrInvalidChatChunk`，不会静默归入编号 0。显式 `index: 0` 和不连续的非负索引正常支持。对外仍保留 `Index int`；手工构造 Go 结构时，整数 0 就表示明确的编号 0。

`Collect()` 收到 `[DONE]` 后自动执行完成校验：至少收到一个候选；所有已出现候选都必须有有效 `finish_reason`；每个工具必须有非空 ID、`type: "function"`、非空函数名和参数。`tool_calls` / `function_call` 结束原因还必须有对应调用数据；旧函数调用也要求非空名称和参数。只收到 DONE、只有 usage 或部分候选未结束都会返回 `ErrIncompleteChatCompletion`。这里不要求正文非空，允许正常空回答。未出现过的候选数量无法从响应判断，本接口不校验请求中 `n` 的期望值。

结束原因 `length`、`content_filter` 保持原值，不伪装成 `stop`；调用方决定是否接受。参数字符串的 JSON 语法和业务结构仍由 `DecodeArguments` 检查，完成校验不保证模型参数合法。一个候选收到结束原因后，不允许继续增加正文、拒绝内容或工具参数，也不能改写结束原因；仍允许尾部空块、音频元数据和请求级 usage。异常增量返回 `ErrInvalidChatDelta`。`Next()` 本身只做逐块解码和传输结束判断，业务完成校验由累积器承担。

累积总预算默认 **32 MiB**，与单行/单事件限制相互独立。每次 `Add` 取原始 `chunk.Raw` 长度和当前结构 JSON 重新编码长度中的较大值计入预算；空增量、重复字段、usage 和额外原始字段都会计入。因此它限制的是累计 JSON 数据量，不只是最终正文长度，也不是 Go 堆内存的精确数值。修改已解码字段也不能利用较小的旧 Raw 绕过限制。所有计数按字节而非字符，超限块在写入任何候选或 usage 前返回 `ErrChatTooLarge`，此前结果保持不变；后续 Add/Finish 保留同一错误。

```go
// decoder 对当前请求使用 64 MiB 的累计预算，继续沿用默认单行/事件上限。
decoder := sse.NewChatDecoderWithConfig(resp.Body, sse.Config{
    MaxTotalBytes: 64 * 1024 * 1024,
})
result, err := decoder.Collect()

// accumulator 是手工逐块消费时的对应配置方式。
accumulator := sse.NewChatAccumulatorWithConfig(sse.Config{
    MaxTotalBytes: 64 * 1024 * 1024,
})
```

`MaxTotalBytes` 为零或负数时使用默认 32 MiB，不表示无限制。`ChatAccumulator` 零值也使用默认预算。限制作用于 `Collect()` 和 `Add()`，不限制单独调用 `Next()` 已交给调用方处理的历史数据。失败块不会污染已有结果；完成校验失败后同样不允许继续追加。

累积器保存文本、拒绝信息、工具调用、旧版 `function_call`、结束原因与 usage。不会聚合音频、logprobs 或审核数据，这些仍可逐块读取。文本和参数通过缓冲区追加，避免反复复制已拼接的前缀；最终结果的内存随回答及工具参数大小增长，并受累计数据量预算约束。调用方仍应配置请求超时和输出 token 上限。

工具拼接规则参考：[官方函数调用流式说明](https://developers.openai.com/api/docs/guides/function-calling#streaming)。

## Chat Completions 标准流（推荐入口）

请求 `/v1/chat/completions` 时设置 `stream: true`。拿到响应后，先检查 HTTP 状态码和 `Content-Type: text/event-stream`，再将 `resp.Body` 交给 `NewChatDecoder`。下面的函数运行在已有 HTTP 请求之后；导入 `fmt`、`io`、`mime`、`net/http` 及本包。

```go
// consumeChat 逐块处理标准 Chat Completions 响应，并负责关闭正文。
func consumeChat(resp *http.Response) error {
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("上游 HTTP 状态异常: %s", resp.Status)
    }
    contentType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type")) // 允许带 charset 参数的 SSE 类型。
    if err != nil || contentType != "text/event-stream" {
        return fmt.Errorf("上游未返回 SSE: %q", resp.Header.Get("Content-Type"))
    }
    decoder := sse.NewChatDecoder(resp.Body) // 共用底层 SSE 的全部分块和大小限制处理。
    for {
        chunk, err := decoder.Next() // 返回 chat.completion.chunk 的结构化增量。
        if err == io.EOF {
            return nil // 只有明确收到 data: [DONE]，才会正常 EOF。
        }
        if err != nil {
            return err // 包括缺失 DONE、JSON 错误、底层读取失败和流内 APIError。
        }
        for _, choice := range chunk.Choices { // 不假设只有 choices[0]；用量块允许空数组。
            if choice.Delta.Content != nil {
                fmt.Printf("候选 %d 文本增量: %s\n", choice.Index, *choice.Delta.Content)
            }
            for _, tool := range choice.Delta.ToolCalls { // 工具参数是字符串增量，不是完整 JSON。
                if tool.Function != nil && tool.Function.Arguments != nil {
                    fmt.Printf("候选 %d 工具 %d 参数增量: %s\n", choice.Index, tool.Index, *tool.Function.Arguments)
                }
            }
            if choice.FinishReason != nil {
                fmt.Printf("候选 %d 结束原因: %s\n", choice.Index, *choice.FinishReason)
                // 此处继续读取，后面仍可能有其他候选、音频更新或最终用量块。
            }
        }
        if chunk.Usage != nil {
            fmt.Printf("总 token 数: %d\n", chunk.Usage.TotalTokens)
        }
    }
}
```

`Content` / `Refusal` / `FinishReason` 等可空字段使用指针，区分空字符串和缺省/null。支持多候选、多工具调用、旧 `function_call` 字段；音频、logprobs、审核和用量明细保留原始 JSON。`chunk.Raw` 保存完整原始 JSON，新增字段不会在透传时丢失。

`Next()` 逐块返回，不缓存整个回答；需要自动拼接时使用上面的 `Collect()` 或 `ChatAccumulator`。结束原因 `length`、`content_filter` 等会原样返回，由调用方决定是否接受这次结果，不会伪装成 `stop`。

`stream_options: {"include_usage": true}` 时，最终用量块可以是 `choices: []`。看到 `finish_reason` 就退出会漏掉用量；`ChatDecoder` 只在 `[DONE]` 后返回正常 `io.EOF`。若连接在完整 JSON 块之后提前关闭，也会返回可用 `errors.Is(err, io.ErrUnexpectedEOF)` 检查的错误。即使已拿到部分文本，也不能据此认为整次请求已正常完成。

流内 `{"error": {...}}` 返回 `*APIError`，可用 `errors.As` 取错误信息；非流式 HTTP 错误应在创建解码器之前处理。`ErrInvalidChatChunk` 表示 JSON 无法解析或缺少关键增量元数据。该接口是流式解码器，不是完整 JSON Schema 校验器。大小上限可以通过 `NewChatDecoderWithConfig` 调整。

协议依据：[官方创建接口](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[官方增量结构](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)。

## 通用 SSE：直接读取 HTTP 响应

下面的函数接收已经发出请求得到的 `resp`，导入本项目时使用 `"sse"`，复制到其他项目后将导入路径改为该项目的包路径。

```go
import (
    "fmt"
    "io"
    "mime"
    "net/http"

    "sse"
)

// consumeSSE 读取响应，逐条处理事件，并负责关闭响应正文。
func consumeSSE(resp *http.Response) error {
    defer resp.Body.Close()
    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        return fmt.Errorf("上游 HTTP 状态异常: %s", resp.Status)
    }
    contentType, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type")) // 检查服务端是否真的返回 SSE。
    if err != nil || contentType != "text/event-stream" {
        return fmt.Errorf("上游未返回 SSE: %q", resp.Header.Get("Content-Type"))
    }
    decoder := sse.NewDecoder(resp.Body) // 直接使用响应正文，无需一次性读完。
    for {
        event, err := decoder.Next() // 一次得到一条完整事件。
        if err == io.EOF {
            return io.ErrUnexpectedEOF // 本示例约定必须收到 [DONE]，提前 EOF 属于业务断流。
        }
        if err != nil {
            return fmt.Errorf("读取 SSE 失败: %w", err)
        }
        if event.Data == "[DONE]" {
            return nil // 只适用于明确约定使用 [DONE] 的上游。
        }
        fmt.Printf("类型=%s id=%s 内容=%s\n", event.Type, event.ID, event.Data)
        // 在此解码 event.Data 的 JSON，处理文本增量或工具调用参数。
    }
}
```

其他协议可能用完成事件代替 `[DONE]`，需要按上游约定调整结束判断。请求超时和取消应通过 `http.NewRequestWithContext` 配置在原始 HTTP 请求上；解析器不创建 goroutine，也不自动重发请求。

## 行为与边界

| 输入情况 | 处理方式 |
|---|---|
| 任意网络分块、中文字符拆开、多条事件一次到达 | 缓冲并逐行组装，不把网络读取当作事件边界 |
| LF、CRLF、单独 CR、混合换行 | 均支持；CR 后立即结束该行，不额外等待字节 |
| 多行 `data`、空 `data`、多个空 `data` | 用 `\n` 连接，只去掉组装时最后添加的一个换行 |
| 冒号、前后空格 | 仅按第一个冒号分隔；仅移除值开头的一个 ASCII 空格 |
| `: heartbeat`、未知字段、字段大小写 | 忽略注释和未知字段，字段名区分大小写 |
| `event` | 同一块最后一个值生效；缺省/空值为 `message`，下一块重置 |
| `id` | 跨块保留；空值清空；含 NUL 的值忽略；控制块可用 `LastEventID()` 查询 |
| `retry` | 只接受 ASCII 数字并保存毫秒数，通过 `RetryMillis()` 查询，不执行重连 |
| BOM | 仅移除整个流开头的一个 UTF-8 BOM |
| 不合法 UTF-8 | 返回 `ErrInvalidUTF8`；严格拒绝，不采用浏览器的替换字符策略 |
| 完整块之后 EOF | 返回 `io.EOF`；这仅说明传输结束，不代表模型已成功完成 |
| 非注释字段块缺少最后空行就 EOF | 丢弃未完成事件，返回 `io.ErrUnexpectedEOF`；比浏览器静默丢弃更严格 |
| 底层读取失败 | 保留原始错误；此前已完整缓冲的事件先派发，半条事件不会派发 |
| 终止错误后再次调用 | 返回同一个终止错误 |

只包含注释的尾部可以正常 EOF。所有行都必须使用合法 UTF-8；EOF 前未结束的行直接作为不完整输入丢弃。超过 `int64` 范围的 `retry` 忽略，不进行可能溢出的 `time.Duration` 换算。

默认单行上限 **1 MiB**，单个事件块上限 **8 MiB**，允许正常解析超过 64 KiB 的行。事件块大小按每个非空行原始字节数加一个规范化换行字节计算，包含注释、未知字段；空行后重置。流首 BOM 计入单行原始大小，但不计入事件块大小。超限返回可直接用 `errors.Is` 判断的 `ErrLineTooLarge` / `ErrEventTooLarge`。总内存随这些上限增长，不随整个响应长度增长。

```go
// decoder 使用更大的上限，适合确实需要超大单条事件的上游。
decoder := sse.NewDecoderWithConfig(resp.Body, sse.Config{
    MaxLineBytes:  4 * 1024 * 1024,
    MaxEventBytes: 16 * 1024 * 1024,
})
```

同一个解析器应顺序使用。返回字符串在下一次 `Next()` 后仍有效。解析器不会关闭 `resp.Body`，调用方必须关闭正文；底层读取阻塞时，取消原始 HTTP 请求或关闭正文以解除阻塞。

## 验证

在此目录执行：

```sh
go test -race -cover ./...
go vet ./...
go test -run '^$' -fuzz FuzzDecoderChunkBoundaries -fuzztime 10s
```

测试覆盖协议规则、单字节分块、读取同时返回字节和错误、超过 64 KiB、大小上限、真实 HTTP POST 响应，以及连接保持打开时单独 CR 不能阻塞事件派发。另包含索引缺失/null/非法值、候选未完成、工具元数据不完整、结束后追加、总预算精确边界、小块累积超限、usage 预算、默认 32 MiB 限制和失败原子性的回归测试。模糊测试验证任意输入在不同分块下结果一致。

协议参考：[WHATWG SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)。

## DeepSeek 真实场景与离线故障矩阵

本次验证的逐场景日志索引见 [场景验证索引](logs/deepseek-live-three-layer-20261030-103715/SCENARIOS.md)，其中明确区分真实请求与离线注入。运行器默认使用当前官方文档中的 `deepseek-flash`，Chat 请求发到 `/chat/completions`，Responses 请求发到 `/responses`。Chat 用 `thinking.type` 控制思考，Responses 用 `reasoning.effort`。

```sh
# 只在进程内读取本机密钥，每个场景单独落日志，不自动重试。
go run ./cmd/deepseek-examples -key-file /private/tmp/deepseek-api-key.txt -out logs/my-live-run

# 离线故障注入，不需要密钥，不请求模型。
go run ./cmd/deepseek-examples -offline -out logs/my-offline-run
```

真实运行器包含两种协议各 7 个场景：文本、JSON、单工具、多工具、长度截断、思考与无效模型 HTTP 错误。共 14 个固定请求，每次最多 384 输出 token；遇到认证、访问或余额错误停止后续调用，不自动重试。工具只声明，不执行真实天气查询；多工具场景检查实际调用数，而不是假定模型遵守了提示词。

每个真实场景保存 `request.json`（不含凭证）、`http.json`（白名单响应元信息）、`events.jsonl`、`result.json`；非 200 响应保存 `http-error.body`，并在日志标注 http_error。每个离线场景保存 `input.sse`、`events.jsonl`、`result.json` 和 `expectation.json`。日志写入失败场景可能没有完整日志，这是故障本身；输入、预期与实际错误仍在各自目录中保留。汇总在各次运行根目录的 `summary.json`。

这里的覆盖范围是当前模块的 HTTP SSE、Chat 文本/函数工具和 Responses 文本/函数工具协议。网络、模型和供应商的所有可能行为是无限集合，不能声称通过这些样本穷尽；真实拒绝、服务过载、限流、音视频、图片与内置搜索等并未被本次付费请求验证。拒绝/未完成/失败和损坏流等可重复路径由离线场景及回归测试覆盖。

## GitHub Pages 发布

源码分支为 `main`，站点分支为 `gh-pages`，仅发布 `site/dist/`。不向浏览器提供 Go 源码、密钥或本机环境。重新生成并提交静态输出后发布：

```sh
python3 site/build.py
git add site
git commit -m "更新交互站点"
git push origin main
git subtree push --prefix site/dist origin gh-pages
```

首次发布由 GitHub Pages 从 `gh-pages` 分支根目录构建。
