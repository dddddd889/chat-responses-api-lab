package sse

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// ErrInvalidChatChunk 表示收到的内容不是有效的 Chat Completions 增量对象。
var ErrInvalidChatChunk = errors.New("sse: invalid chat completion chunk")

// ChatChunk 对应 chat.completion.chunk；每次返回增量，不累积整段回答。
type ChatChunk struct {
	ID                string          `json:"id"`                 // 同一次回答的标识。
	Object            string          `json:"object"`             // 固定为 chat.completion.chunk。
	Created           int64           `json:"created"`            // 回答创建时间，Unix 秒。
	Model             string          `json:"model"`              // 实际响应模型。
	Choices           []ChatChoice    `json:"choices"`            // 可包含多个候选，用量块中允许为空数组。
	Usage             *ChatUsage      `json:"usage"`              // null 或缺省时为 nil。
	ServiceTier       *string         `json:"service_tier"`       // 实际服务层级。
	SystemFingerprint *string         `json:"system_fingerprint"` // 服务端配置标识。
	Obfuscation       *string         `json:"obfuscation"`        // 填充字段，不应当拼入正文。
	Moderation        json.RawMessage `json:"moderation"`         // 保留审核数据的完整结构。
	Raw               json.RawMessage `json:"-"`                  // 原始 JSON，保留未建模字段，便于透传。
}

// ChatChoice 是单个候选的增量；应按 Index 区分多个候选。
type ChatChoice struct {
	Index        int             `json:"index"`         // 候选编号，不等于当前数组位置。
	Delta        ChatDelta       `json:"delta"`         // 本次内容变化。
	FinishReason *string         `json:"finish_reason"` // nil 表示还未收到结束原因。
	Logprobs     json.RawMessage `json:"logprobs"`      // 原样保留 token 概率数据。
}

// UnmarshalJSON 区分明确的 index:0 与缺失/null，保持对外 Index 为 int 的接口。
func (c *ChatChoice) UnmarshalJSON(data []byte) error {
	type choiceAlias ChatChoice // 避免递归调用自身的解码方法。
	var value choiceAlias       // 先解码临时值，失败时不修改原对象。
	wire := struct {
		Index *int `json:"index"` // 显式字段覆盖嵌入类型中的 Index。
		*choiceAlias
	}{choiceAlias: &value}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.Index == nil || *wire.Index < 0 {
		return fmt.Errorf("%w: choice index must be a non-negative integer", ErrInvalidChatChunk)
	}
	value.Index = *wire.Index
	*c = ChatChoice(value)
	return nil
}

// ChatDelta 保留文本、拒绝信息、音频以及工具调用增量。
type ChatDelta struct {
	Role         *string             `json:"role"`          // 常在第一个块出现。
	Content      *string             `json:"content"`       // nil 与空字符串有不同含义。
	Refusal      *string             `json:"refusal"`       // 拒绝信息片段。
	ToolCalls    []ChatToolCallDelta `json:"tool_calls"`    // 按工具 Index 组装，参数字符串可能还不是完整 JSON。
	FunctionCall *ChatFunctionDelta  `json:"function_call"` // 兼容已弃用的函数调用字段。
	Audio        json.RawMessage     `json:"audio"`         // 音频增量原始 JSON，避免丢失音频字段。
}

// ChatToolCallDelta 是单个工具调用的片段。
type ChatToolCallDelta struct {
	Index    int                `json:"index"`    // 工具编号，应结合所属 choice 的 Index 使用。
	ID       *string            `json:"id"`       // 工具调用标识，后续块可能省略。
	Type     *string            `json:"type"`     // 当前标准值为 function。
	Function *ChatFunctionDelta `json:"function"` // 函数名和参数增量。
}

// UnmarshalJSON 防止缺失工具索引被 Go 零值静默归入工具 0。
func (t *ChatToolCallDelta) UnmarshalJSON(data []byte) error {
	type toolAlias ChatToolCallDelta // 避免解码递归。
	var value toolAlias              // 成功之后再更新接收对象。
	wire := struct {
		Index *int `json:"index"` // null 和缺省都保持 nil。
		*toolAlias
	}{toolAlias: &value}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.Index == nil || *wire.Index < 0 {
		return fmt.Errorf("%w: tool index must be a non-negative integer", ErrInvalidChatChunk)
	}
	value.Index = *wire.Index
	*t = ChatToolCallDelta(value)
	return nil
}

// ChatFunctionDelta 不会尝试解码 Arguments；只有拼接完参数后才能按 JSON 使用。
type ChatFunctionDelta struct {
	Name      *string `json:"name"`      // 函数名片段。
	Arguments *string `json:"arguments"` // 参数字符串片段，按接收顺序拼接。
}

// ChatUsage 是整次请求的用量，明细作为原始 JSON 保留。
type ChatUsage struct {
	PromptTokens            int64           `json:"prompt_tokens"`             // 输入 token 数。
	CompletionTokens        int64           `json:"completion_tokens"`         // 输出 token 数。
	TotalTokens             int64           `json:"total_tokens"`              // 总 token 数。
	PromptTokensDetails     json.RawMessage `json:"prompt_tokens_details"`     // 输入 token 明细。
	CompletionTokensDetails json.RawMessage `json:"completion_tokens_details"` // 输出 token 明细。
}

// APIError 保存流内 {"error": {...}} 错误；可通过 errors.As 提取。
type APIError struct {
	Message string          `json:"message"` // 上游错误信息。
	Type    string          `json:"type"`    // 上游错误分类。
	Code    json.RawMessage `json:"code"`    // 原样保存错误码，包括字符串和 null。
	Param   json.RawMessage `json:"param"`   // 出错参数，可能为 null。
}

// Error 让 APIError 可直接作为 Go error 返回。
func (e *APIError) Error() string { return "chat completions: " + e.Message }

// ChatDecoder 在通用 SSE 解帧上增加 Chat Completions 的 JSON 和结束判断。
// 同一实例顺序使用；不关闭正文，不发请求，不自动重连。
type ChatDecoder struct {
	sse      *Decoder // 共用已验证的 SSE 协议边界处理。
	terminal error    // [DONE] 后为 io.EOF，其他终止错误保留原值。
	config   Config   // 将累积预算传递给 Collect，不重复缓冲整段回答。
}

// NewChatDecoder 直接读取流式 Chat Completions 的 resp.Body。
func NewChatDecoder(reader io.Reader) *ChatDecoder {
	return NewChatDecoderWithConfig(reader, Config{})
}

// NewChatDecoderWithConfig 自定义底层 SSE 的行和事件大小上限。
func NewChatDecoderWithConfig(reader io.Reader, config Config) *ChatDecoder {
	decoder := &ChatDecoder{sse: NewDecoderWithConfig(reader, config), config: config}
	decoder.sse.protocol = "chat" // 标识第一层 SSE 日志来源。
	return decoder
}

// Next 返回一个 JSON 增量块；只有收到 [DONE] 后才返回正常 io.EOF。
// finish_reason 不结束读取，因为后面可能仍有 usage 或其他候选的增量。
// 传输提前 EOF 返回 io.ErrUnexpectedEOF；不会把半条回答当成成功。
func (d *ChatDecoder) Next() (*ChatChunk, error) {
	if d.terminal != nil {
		return nil, d.terminal
	}
	event, err := d.sse.Next() // 先获取完整 SSE 事件，不能直接按网络字节解码 JSON。
	if err != nil {
		if err == io.EOF {
			err = fmt.Errorf("chat completions: missing [DONE]: %w", io.ErrUnexpectedEOF)
		}
		d.terminal = err
		return nil, err
	}
	if event.Data == "[DONE]" {
		d.terminal = io.EOF
		return nil, io.EOF
	}
	var envelope struct { // 同时识别正常增量和上游错误，避免把错误当空正文吞掉。
		ChatChunk
		Error *APIError `json:"error"` // 兼容流内错误信封。
	}
	if err := json.Unmarshal([]byte(event.Data), &envelope); err != nil {
		d.terminal = fmt.Errorf("%w: %v", ErrInvalidChatChunk, err)
		return nil, d.terminal
	}
	if envelope.Error != nil {
		d.terminal = envelope.Error
		return nil, d.terminal
	}
	// 检查关键必需字段；空 choices 数组合法，缺省或 null 则不能代表标准增量。
	if envelope.Object != "chat.completion.chunk" || envelope.ID == "" || envelope.Model == "" || envelope.Choices == nil {
		d.terminal = fmt.Errorf("%w: expected chat.completion.chunk with id, model and choices array", ErrInvalidChatChunk)
		return nil, d.terminal
	}
	envelope.Raw = json.RawMessage(event.Data)
	return &envelope.ChatChunk, nil
}
