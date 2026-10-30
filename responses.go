package sse

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

var (
	// ErrInvalidResponseEvent 表示 Responses 事件格式或序号不合法。
	ErrInvalidResponseEvent = errors.New("sse: invalid response event")
	// ErrResponseFailed 表示服务端明确报告生成失败。
	ErrResponseFailed = errors.New("sse: response failed")
	// ErrResponseIncomplete 表示生成达到限制等原因导致未完成。
	ErrResponseIncomplete = errors.New("sse: response incomplete")
	// ErrResponseTooLarge 表示整次 Responses 事件 JSON 超过累计预算。
	ErrResponseTooLarge = errors.New("sse: response stream exceeds size limit")
)

// ResponseUsage 保存 Responses 专用的 token 字段，不与 Chat 的 prompt_tokens 混用。
type ResponseUsage struct {
	InputTokens         int64           `json:"input_tokens"`          // 输入 token 数。
	OutputTokens        int64           `json:"output_tokens"`         // 输出 token 数，已包含思考 token。
	TotalTokens         int64           `json:"total_tokens"`          // 请求总 token 数。
	InputTokensDetails  json.RawMessage `json:"input_tokens_details"`  // 缓存等输入明细。
	OutputTokensDetails json.RawMessage `json:"output_tokens_details"` // 思考等输出明细。
}

// ResponsePart 是常见消息内容块；未建模注解在 ResponseObject.Raw 中保留。
type ResponsePart struct {
	Type    string `json:"type"`              // output_text、refusal 等内容类型。
	Text    string `json:"text,omitempty"`    // 最终文本。
	Refusal string `json:"refusal,omitempty"` // 拒绝内容。
}

// ResponseItem 保存 output 中消息、函数调用或其他类型项目。
type ResponseItem struct {
	ID        string         `json:"id"`                  // output item 的标识，与函数 call_id 不同。
	Type      string         `json:"type"`                // message、function_call 或其他内置工具类型。
	Status    string         `json:"status,omitempty"`    // 当前项目状态。
	Role      string         `json:"role,omitempty"`      // 消息角色。
	Content   []ResponsePart `json:"content,omitempty"`   // 消息内容，按 content_index 排序。
	CallID    string         `json:"call_id,omitempty"`   // 回传函数执行结果时使用的标识。
	Name      string         `json:"name,omitempty"`      // 完整函数名。
	Arguments string         `json:"arguments,omitempty"` // 完整参数 JSON 字符串。
}

// ResponseObject 对应生命周期事件中的 response，Raw 保留完整服务端对象。
type ResponseObject struct {
	ID                string          `json:"id"`                 // 响应 ID。
	Status            string          `json:"status"`             // completed、failed、incomplete 等状态。
	Model             string          `json:"model"`              // 实际模型。
	Output            []ResponseItem  `json:"output"`             // 按 output_index 排序的最终输出。
	Usage             *ResponseUsage  `json:"usage"`              // 最终 token 用量，未收到时为 nil。
	Error             *APIError       `json:"error"`              // 服务端错误。
	IncompleteDetails json.RawMessage `json:"incomplete_details"` // 未完成原因，保留完整 JSON。
	Raw               json.RawMessage `json:"-"`                  // 未建模输出类型和字段仍可在此取得。
}

// OutputText 按 output/content 顺序连接正文，不拼入思考、拒绝或工具参数。
func (r ResponseObject) OutputText() string {
	var text strings.Builder // 避免多次复制全文。
	for _, item := range r.Output {
		if item.Type == "message" {
			for _, part := range item.Content {
				if part.Type == "output_text" {
					text.WriteString(part.Text)
				}
			}
		}
	}
	return text.String()
}

// ResponseEvent 保留常见事件字段；未知事件也原样返回 Raw，不静默丢弃。
type ResponseEvent struct {
	Type           string          `json:"type"`            // JSON 中的事件类型，必须与 SSE event 一致。
	SequenceNumber *int64          `json:"sequence_number"` // 序号必须存在，按收到顺序递增。
	OutputIndex    *int            `json:"output_index"`    // 可空以区分索引 0 与未提供。
	ContentIndex   *int            `json:"content_index"`   // 消息内容块编号。
	ItemID         string          `json:"item_id"`         // 文本或参数所对应的项目 ID。
	Delta          *string         `json:"delta"`           // 文本、拒绝或参数片段。
	Text           *string         `json:"text"`            // 文本 done 事件的完整值。
	Refusal        *string         `json:"refusal"`         // 拒绝 done 事件的完整值。
	Arguments      *string         `json:"arguments"`       // 参数 done 事件的完整值。
	Item           *ResponseItem   `json:"item"`            // output_item.added/done 的项目。
	Response       *ResponseObject `json:"response"`        // 生命周期事件的完整响应对象。
	Code           json.RawMessage `json:"code"`            // error 事件的错误码。
	Message        string          `json:"message"`         // error 事件的信息。
	Param          json.RawMessage `json:"param"`           // error 事件的参数。
	Raw            json.RawMessage `json:"-"`               // 原始事件 JSON。
}

// ResponseTerminalError 保存明确的失败/未完成事件，errors.Is 可判断具体状态。
type ResponseTerminalError struct {
	Event *ResponseEvent // 包含原始事件及服务端错误、用量和未完成原因。
	kind  error          // 对应 ErrResponseFailed 或 ErrResponseIncomplete。
}

// Error 返回可读错误；具体上游字段通过 Event 查询。
func (e *ResponseTerminalError) Error() string {
	return fmt.Sprintf("%v: %s", e.kind, e.Event.Type)
}

// Unwrap 支持 errors.Is 识别失败状态。
func (e *ResponseTerminalError) Unwrap() error { return e.kind }

// ResponseDecoder 直接解码 Responses HTTP SSE；不适用于 Realtime 或 WebSocket。
type ResponseDecoder struct {
	config       Config   // 原始流、解析事件和最终结果共用日志配置。
	sse          *Decoder // 复用通用协议解帧与原始日志。
	terminal     error    // 终止事件派发一次后保留其结果。
	lastSequence int64    // 上一事件序号，首个允许不是 0。
	hasSequence  bool     // 区分首个事件与已接收序号。
	responseID   string   // 拒绝不同 response 混入同一条流。
	usedBytes    int      // 累积事件 JSON 字节数，不只限制最终正文。
	maxBytes     int      // 默认 32 MiB，可通过 Config.MaxTotalBytes 修改。
}

// NewResponseDecoder 创建 Responses API 事件解码器。
func NewResponseDecoder(reader io.Reader) *ResponseDecoder {
	return NewResponseDecoderWithConfig(reader, Config{})
}

// NewResponseDecoderWithConfig 配置解帧、事件总预算和可选原始日志。
func NewResponseDecoderWithConfig(reader io.Reader, config Config) *ResponseDecoder {
	limit := config.MaxTotalBytes // 所有模式都保留有限默认值。
	if limit <= 0 {
		limit = DefaultMaxTotalBytes
	}
	decoder := &ResponseDecoder{sse: NewDecoderWithConfig(reader, config), maxBytes: limit, config: config}
	decoder.sse.protocol = "responses" // 标识第一层 SSE 日志来源。
	return decoder
}

// Next 将终止事件正常返回一次，下一次返回 EOF 或对应错误，方便调用方记录终止事件。
// 只有 response.completed 能产生正常 EOF，提前关闭或 DONE 都不能代替它。
func (d *ResponseDecoder) Next() (*ResponseEvent, error) {
	if d.terminal != nil {
		return nil, d.terminal
	}
	event, err := d.next() // 任意错误都会封存实例，避免跳过坏事件继续处理。
	if err != nil {
		d.terminal = err
	}
	return event, err
}

// next 校验单个事件，不在传输关闭时推断成功。
func (d *ResponseDecoder) next() (*ResponseEvent, error) {
	frame, err := d.sse.Next() // 先取得完整事件，网络读取不等于事件边界。
	if err != nil {
		if err == io.EOF {
			return nil, fmt.Errorf("responses: missing terminal event: %w", io.ErrUnexpectedEOF)
		}
		return nil, err
	}
	if len(frame.Data) > d.maxBytes-d.usedBytes {
		return nil, ErrResponseTooLarge
	}
	var event ResponseEvent // 每条事件独立持有 JSON 数据。
	if err := json.Unmarshal([]byte(frame.Data), &event); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidResponseEvent, err)
	}
	if event.Type == "" || (frame.Type != "message" && frame.Type != event.Type) {
		return nil, fmt.Errorf("%w: event type mismatch or missing type", ErrInvalidResponseEvent)
	}
	if event.SequenceNumber == nil || *event.SequenceNumber < 0 || (d.hasSequence && *event.SequenceNumber <= d.lastSequence) {
		return nil, fmt.Errorf("%w: missing or non-increasing sequence_number", ErrInvalidResponseEvent)
	}
	if err := validateResponseEvent(&event); err != nil {
		return nil, err
	}
	if event.Response != nil {
		if d.responseID != "" && d.responseID != event.Response.ID {
			return nil, fmt.Errorf("%w: response id changed", ErrInvalidResponseEvent)
		}
		d.responseID = event.Response.ID
		// 保存完整 response，包括 reasoning、内置工具和未来增加的字段。
		var fields map[string]json.RawMessage // 提取原始嵌套对象而非重新编码后的子集。
		_ = json.Unmarshal([]byte(frame.Data), &fields)
		event.Response.Raw = fields["response"]
	}
	event.Raw = json.RawMessage(frame.Data)
	d.usedBytes += len(frame.Data)
	d.lastSequence, d.hasSequence = *event.SequenceNumber, true
	switch event.Type {
	case "response.completed":
		d.terminal = io.EOF
	case "response.failed":
		d.terminal = &ResponseTerminalError{Event: &event, kind: ErrResponseFailed}
	case "response.incomplete":
		d.terminal = &ResponseTerminalError{Event: &event, kind: ErrResponseIncomplete}
	case "error":
		d.terminal = &APIError{Message: event.Message, Code: event.Code, Param: event.Param, Type: "error"}
	}
	return &event, nil
}

// validateResponseEvent 只严格检查当前处理的事件，其他事件保留 Raw 供调用方扩展。
func validateResponseEvent(event *ResponseEvent) error {
	invalid := func(reason string) error {
		return fmt.Errorf("%w: %s: %s", ErrInvalidResponseEvent, event.Type, reason)
	} // 给出可定位的事件类型。
	switch event.Type {
	case "response.created", "response.in_progress", "response.queued", "response.completed", "response.failed", "response.incomplete":
		if event.Response == nil || event.Response.ID == "" {
			return invalid("missing response id")
		}
		status := strings.TrimPrefix(event.Type, "response.") // 生命周期事件类型与 response.status 应一致。
		if status == "created" {
			// 创建后同步请求通常处于 in_progress，后台请求也可能先进入 queued。
			if event.Response.Status != "in_progress" && event.Response.Status != "queued" {
				return invalid("created response is not in_progress or queued")
			}
			return nil
		}
		if event.Response.Status != status {
			return invalid("response status mismatch")
		}
		if status == "completed" && (event.Response.Output == nil || event.Response.Error != nil) {
			return invalid("completed response missing output or contains error")
		}
	case "error":
		if event.Message == "" {
			return invalid("missing error message")
		}
	case "response.output_item.added", "response.output_item.done":
		if event.OutputIndex == nil || *event.OutputIndex < 0 || event.Item == nil || event.Item.ID == "" || event.Item.Type == "" {
			return invalid("missing output index or item")
		}
	case "response.output_text.delta", "response.output_text.done", "response.refusal.delta", "response.refusal.done", "response.function_call_arguments.delta", "response.function_call_arguments.done":
		if event.OutputIndex == nil || *event.OutputIndex < 0 || event.ItemID == "" {
			return invalid("missing output index or item id")
		}
		if !strings.HasPrefix(event.Type, "response.function_call_arguments.") && (event.ContentIndex == nil || *event.ContentIndex < 0) {
			return invalid("missing content index")
		}
		switch event.Type {
		case "response.output_text.done":
			if event.Text == nil {
				return invalid("missing text")
			}
		case "response.refusal.done":
			if event.Refusal == nil {
				return invalid("missing refusal")
			}
		case "response.function_call_arguments.done":
			if event.Arguments == nil {
				return invalid("missing arguments")
			}
		default:
			if event.Delta == nil {
				return invalid("missing delta")
			}
		}
	}
	return nil
}

// responsePartial 为断流时保留文本和工具参数，按 output/content index 隔离。
type responsePartial struct {
	object  ResponseObject                // 最近的生命周期元数据。
	items   map[int]*ResponseItem         // 输出项目，以 output_index 分组。
	parts   map[int]map[int]*ResponsePart // 文本或拒绝内容，以两个层级索引分组。
	buffers map[[3]int]*strings.Builder   // 输出/内容/字段联合键，追加时不反复复制前缀。
}

// write 将增量追加到缓冲区，或用 done 事件的完整值替换。
func (p *responsePartial) write(key [3]int, delta, full *string) {
	buffer := p.buffers[key] // 每个内容字段独立保存。
	if buffer == nil || full != nil {
		buffer = &strings.Builder{}
		p.buffers[key] = buffer
	}
	if full != nil {
		buffer.WriteString(*full)
	} else if delta != nil {
		buffer.WriteString(*delta)
	}
}

// apply 增量追加与 done 完整值替换分开，避免将参数全文重复追加。
func (p *responsePartial) apply(event *ResponseEvent) error {
	if event.Response != nil {
		p.object = *event.Response
	}
	if event.OutputIndex == nil {
		return nil
	}
	index := *event.OutputIndex // 已由解码器检查非负。
	switch event.Type {
	case "response.output_item.added", "response.output_item.done", "response.output_text.delta", "response.output_text.done", "response.refusal.delta", "response.refusal.done", "response.function_call_arguments.delta", "response.function_call_arguments.done":
	default:
		return nil // 不把思考、音频等扩展事件误认为正文或函数参数。
	}
	if event.Item != nil {
		copy := *event.Item // 接收 output item 的权威状态。
		if old := p.items[index]; old != nil && old.ID != copy.ID {
			return fmt.Errorf("%w: output item id changed", ErrInvalidResponseEvent)
		}
		p.items[index] = &copy
		if event.Type == "response.output_item.done" {
			delete(p.parts, index)
			for key := range p.buffers {
				if key[0] == index {
					delete(p.buffers, key)
				}
			}
		}
		return nil
	}
	if event.Delta == nil && event.Text == nil && event.Arguments == nil && event.Refusal == nil {
		return nil
	}
	item := p.items[index] // 不凭索引猜测工具元数据。
	if item == nil || item.ID != event.ItemID {
		return fmt.Errorf("%w: delta references unknown item", ErrInvalidResponseEvent)
	}
	if strings.HasPrefix(event.Type, "response.function_call_arguments.") {
		if item.Type != "function_call" {
			return fmt.Errorf("%w: arguments for non-function item", ErrInvalidResponseEvent)
		}
		key := [3]int{index, 0, 2} // 参数不依赖 content_index。
		if p.buffers[key] == nil && item.Arguments != "" {
			initial := item.Arguments
			p.write(key, nil, &initial)
		}
		p.write(key, event.Delta, event.Arguments)
		return nil
	}
	if event.ContentIndex == nil {
		return nil
	} // 未处理的扩展事件仅通过 Raw 交给调用方。
	if p.parts[index] == nil {
		p.parts[index] = make(map[int]*ResponsePart)
	}
	part := p.parts[index][*event.ContentIndex] // 同一个 output 可包含多个正文部分。
	if part == nil {
		part = &ResponsePart{}
		p.parts[index][*event.ContentIndex] = part
	}
	if strings.HasPrefix(event.Type, "response.output_text.") {
		part.Type = "output_text"
		p.write([3]int{index, *event.ContentIndex, 0}, event.Delta, event.Text)
	} else if strings.HasPrefix(event.Type, "response.refusal.") {
		part.Type = "refusal"
		p.write([3]int{index, *event.ContentIndex, 1}, event.Delta, event.Refusal)
	}
	return nil
}

// snapshot 按索引排序，错误时也提供此前已收到的可读结果。
func (p *responsePartial) snapshot() *ResponseObject {
	result := p.object                      // 不把临时 map 暴露给最终对象。
	indices := make([]int, 0, len(p.items)) // 使用排序避免按巨大稀疏索引分配数组。
	for index := range p.items {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	if len(indices) > 0 {
		result.Output = nil
	}
	for _, index := range indices {
		item := *p.items[index] // 复制项目并装配其内容。
		if arguments := p.buffers[[3]int{index, 0, 2}]; arguments != nil {
			item.Arguments = arguments.String()
		}
		if parts := p.parts[index]; len(parts) > 0 {
			contentIndices := make([]int, 0, len(parts)) // 正文部分同样按编号排序。
			for contentIndex := range parts {
				contentIndices = append(contentIndices, contentIndex)
			}
			sort.Ints(contentIndices)
			item.Content = nil
			for _, contentIndex := range contentIndices {
				part := *parts[contentIndex] // 从缓冲区取得已累积的字段。
				if text := p.buffers[[3]int{index, contentIndex, 0}]; text != nil {
					part.Text = text.String()
				}
				if refusal := p.buffers[[3]int{index, contentIndex, 1}]; refusal != nil {
					part.Refusal = refusal.String()
				}
				item.Content = append(item.Content, part)
			}
		}
		result.Output = append(result.Output, item)
	}
	return &result
}

// Collect 读取到明确终止事件；最终 response.output 是权威完整值，不重复追加增量。
// failed/incomplete 返回服务端最终对象和错误；断流则返回已经收到的部分结果和错误。
// 应从第一条事件开始调用；若先用 Next 消费了一部分事件，这里只累积剩余事件。
func (d *ResponseDecoder) Collect() (result *ResponseObject, err error) {
	business := businessLog{config: d.config, protocol: "responses", first: d.sse.eventIndex + 1}                                                          // 第三层与原拼接逻辑共用已校验的事件。
	defer func() { err = business.finish(d.sse.eventIndex, result, err) }()                                                                                // 成功或失败均记录最终对象。
	partial := responsePartial{items: make(map[int]*ResponseItem), parts: make(map[int]map[int]*ResponsePart), buffers: make(map[[3]int]*strings.Builder)} // 只保存本次读取状态。
	for {
		event, err := d.Next() // 终止事件先正常派发，下一次才返回其结果。
		if err != nil {
			return partial.snapshot(), err
		}
		if err := partial.apply(event); err != nil {
			d.terminal = err
			return partial.snapshot(), err
		}
		if err := business.response(d.sse.eventIndex, event, &partial); err != nil {
			d.terminal = err
			return partial.snapshot(), err
		}
		switch event.Type {
		case "response.completed":
			return event.Response, nil
		case "response.failed", "response.incomplete":
			return event.Response, d.terminal
		case "error":
			return partial.snapshot(), d.terminal
		}
	}
}
