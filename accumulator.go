package sse

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

// ErrInvalidChatDelta 表示增量混入了其他回答，或包含无效索引等冲突。
var ErrInvalidChatDelta = errors.New("sse: invalid chat completion delta")

var (
	// ErrIncompleteChatCompletion 表示收到 DONE 时，候选或工具仍不完整。
	ErrIncompleteChatCompletion = errors.New("sse: incomplete chat completion")
	// ErrChatTooLarge 表示全部增量累计的 JSON 数据量超过预算。
	ErrChatTooLarge = errors.New("sse: accumulated chat exceeds size limit")
	// ErrAccumulatorFinished 表示已完成校验的累积器不能继续追加。
	ErrAccumulatorFinished = errors.New("sse: chat accumulator is finished")
)

// ChatResult 保存已拼接的回答；Choices 的键是实际 choice.index，不是数组位置。
// Collect 返回错误时，这里仅包含失败前的部分结果，不能作为成功回答使用。
type ChatResult struct {
	ID      string             `json:"id"`      // 回答标识。
	Model   string             `json:"model"`   // 响应模型。
	Created int64              `json:"created"` // 回答创建时间。
	Choices map[int]ChatAnswer `json:"choices"` // 按候选编号隔离，支持乱序和稀疏索引。
	Usage   *ChatUsage         `json:"usage"`   // 请求级用量，未收到时为 nil，不伪造零用量。
}

// ChatAnswer 是一个候选的完整文本、拒绝信息和工具调用。
type ChatAnswer struct {
	Index        int                  `json:"index"`         // 候选编号。
	Role         string               `json:"role"`          // 保留上游提供的角色。
	Content      string               `json:"content"`       // 按顺序拼接的文本。
	Refusal      string               `json:"refusal"`       // 按顺序拼接的拒绝信息。
	FinishReason *string              `json:"finish_reason"` // 保留 stop、length、tool_calls 等原值。
	ToolCalls    map[int]ChatToolCall `json:"tool_calls"`    // 键是该候选内的工具编号。
	FunctionCall *ChatFunctionCall    `json:"function_call"` // 旧版 function_call 的拼接结果。
}

// ChatToolCall 保存一个工具调用；不同候选中的相同工具编号互不影响。
type ChatToolCall struct {
	Index    int              `json:"index"`    // 工具编号。
	ID       string           `json:"id"`       // 工具调用标识，后续缺省不会清空它。
	Type     string           `json:"type"`     // 工具类型，通常为 function。
	Function ChatFunctionCall `json:"function"` // 拼接后的函数名和参数。
}

// ChatFunctionCall 保留完整参数字符串，不自动执行函数或改变 JSON 数值类型。
type ChatFunctionCall struct {
	Name      string `json:"name"`      // 拼接后的函数名。
	Arguments string `json:"arguments"` // 拼接后的原始参数 JSON 字符串。
}

// DecodeArguments 将最终参数解码到调用方结构；模型生成的非法 JSON 会原样报错。
func (f ChatFunctionCall) DecodeArguments(target any) error {
	return json.Unmarshal([]byte(f.Arguments), target)
}

// functionBuilder 以追加方式拼接，避免每个增量都复制前面全部参数。
type functionBuilder struct {
	name      strings.Builder // 函数名片段。
	arguments strings.Builder // 参数片段。
}

// add 只追加存在的字段，不尝试提前解析尚未完整的参数 JSON。
func (b *functionBuilder) add(delta *ChatFunctionDelta) {
	if delta == nil {
		return
	}
	if delta.Name != nil {
		b.name.WriteString(*delta.Name)
	}
	if delta.Arguments != nil {
		b.arguments.WriteString(*delta.Arguments)
	}
}

// result 创建函数调用的值快照；后续追加不会修改已经返回的字符串。
func (b *functionBuilder) result() ChatFunctionCall {
	return ChatFunctionCall{Name: b.name.String(), Arguments: b.arguments.String()}
}

// toolBuilder 保存工具的元数据和独立的参数缓冲区。
type toolBuilder struct {
	id       string          // 工具调用 ID。
	kind     string          // 工具类型。
	function functionBuilder // 当前工具的函数信息。
}

// answerBuilder 为每个候选单独分配缓冲区，避免候选之间串数据。
type answerBuilder struct {
	role    string               // 上游返回的角色。
	content strings.Builder      // 文本增量。
	refusal strings.Builder      // 拒绝信息增量。
	finish  *string              // 最近收到的结束原因。
	tools   map[int]*toolBuilder // 该候选内部的工具表。
	legacy  *functionBuilder     // 旧版函数调用。
}

// ChatAccumulator 支持边消费增量边拼接；零值可用，同一实例应顺序调用。
// 它不推断 [DONE]，手工使用时由调用方检查 ChatDecoder 的结束错误。
// 会保存完整文本与工具参数，内存随结果大小增长；不缓存历史 chunk 或音频数据。
type ChatAccumulator struct {
	id        string                 // 当前回答 ID，用于拒绝混入其他请求。
	model     string                 // 当前模型。
	created   int64                  // 首个增量的创建时间。
	choices   map[int]*answerBuilder // 候选状态，使用 map 避免稀疏索引分配巨型数组。
	usage     *ChatUsage             // 请求级最终用量，按快照保存，不重复相加。
	err       error                  // 校验失败后停止继续接收，避免静默损坏结果。
	maxBytes  int                    // 总数据量预算，零值使用默认预算。
	usedBytes int                    // 已成功加入的数据量，失败块不计入。
	finished  bool                   // 通过 Finish 后封存，不再接受新增量。
}

// NewChatAccumulator 创建一个候选与工具均按索引隔离的累积器。
func NewChatAccumulator() *ChatAccumulator { return &ChatAccumulator{} }

// NewChatAccumulatorWithConfig 为手工 Add 模式配置整次累积大小预算。
func NewChatAccumulatorWithConfig(config Config) *ChatAccumulator {
	return &ChatAccumulator{maxBytes: config.MaxTotalBytes}
}

// Add 加入一个完整 JSON 增量；nil、负索引、请求 ID 混用等返回终止错误。
func (a *ChatAccumulator) Add(chunk *ChatChunk) error {
	if a.err != nil {
		return a.err
	}
	if a.finished {
		return ErrAccumulatorFinished
	}
	if err := a.validate(chunk); err != nil { // 先校验再更新，失败的整个块都不加入。
		a.err = err
		return err
	}
	// 重新编码避免调用方修改解码结果后，用较小的旧 Raw 绕过预算。
	encoded, err := json.Marshal(chunk) // 编码结果也覆盖空增量、元数据与 usage。
	if err != nil {
		a.err = fmt.Errorf("%w: cannot measure chunk: %v", ErrInvalidChatDelta, err)
		return a.err
	}
	size := len(encoded) // 同时保守计入原始 JSON 中尚未建模的字段。
	if len(chunk.Raw) > size {
		size = len(chunk.Raw)
	}
	limit := a.maxBytes // 零值和非正配置都不会关闭限制。
	if limit <= 0 {
		limit = DefaultMaxTotalBytes
	}
	if size > limit-a.usedBytes { // 减法比较，防止求和发生整数溢出。
		a.err = ErrChatTooLarge
		return a.err
	}
	a.usedBytes += size
	if a.choices == nil {
		a.id, a.model, a.created = chunk.ID, chunk.Model, chunk.Created
		a.choices = make(map[int]*answerBuilder)
	}
	if chunk.Usage != nil {
		a.usage = cloneUsage(chunk.Usage) // usage 是整次请求统计，不能按块求和。
	}
	for _, choice := range chunk.Choices { // 数组顺序与 choice.index 无关。
		answer := a.choices[choice.Index] // 查找该候选的独立状态。
		if answer == nil {
			answer = &answerBuilder{tools: make(map[int]*toolBuilder)}
			a.choices[choice.Index] = answer
		}
		if choice.Delta.Role != nil {
			answer.role = *choice.Delta.Role
		}
		if choice.Delta.Content != nil {
			answer.content.WriteString(*choice.Delta.Content)
		}
		if choice.Delta.Refusal != nil {
			answer.refusal.WriteString(*choice.Delta.Refusal)
		}
		if choice.FinishReason != nil {
			answer.finish = cloneString(choice.FinishReason)
		}
		if choice.Delta.FunctionCall != nil {
			if answer.legacy == nil {
				answer.legacy = &functionBuilder{}
			}
			answer.legacy.add(choice.Delta.FunctionCall)
		}
		for _, delta := range choice.Delta.ToolCalls { // 工具编号只在所属候选内查找。
			tool := answer.tools[delta.Index] // 不按工具 ID 分组，因为后续块通常不带 ID。
			if tool == nil {
				tool = &toolBuilder{}
				answer.tools[delta.Index] = tool
			}
			if delta.ID != nil {
				tool.id = *delta.ID
			}
			if delta.Type != nil {
				tool.kind = *delta.Type
			}
			tool.function.add(delta.Function)
		}
	}
	return nil
}

// Finish 应在 ChatDecoder 正常 EOF（已收到 DONE）后调用，校验后封存结果。
// 不验证参数 JSON 的业务合法性；需要时通过 DecodeArguments 显式解码。
func (a *ChatAccumulator) Finish() error {
	if a.err != nil {
		return a.err
	}
	if a.finished {
		return nil
	}
	a.err = a.validateCompletion() // 失败后保留原错误与部分结果，不允许悄悄继续追加。
	if a.err == nil {
		a.finished = true
	}
	return a.err
}

// validateCompletion 检查候选已结束，以及每个已出现工具的必要字段。
func (a *ChatAccumulator) validateCompletion() error {
	if len(a.choices) == 0 {
		return fmt.Errorf("%w: no choices received", ErrIncompleteChatCompletion)
	}
	indices := make([]int, 0, len(a.choices)) // 固定校验顺序，使多个错误并存时也能稳定复现。
	for index := range a.choices {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	for _, index := range indices {
		answer := a.choices[index] // 校验对应候选，不要求索引连续。
		if answer.finish == nil {
			return fmt.Errorf("%w: choice %d missing finish_reason", ErrIncompleteChatCompletion, index)
		}
		switch *answer.finish {
		case "stop", "length", "content_filter":
		case "tool_calls":
			if len(answer.tools) == 0 {
				return fmt.Errorf("%w: choice %d has no tool calls", ErrIncompleteChatCompletion, index)
			}
		case "function_call":
			if answer.legacy == nil {
				return fmt.Errorf("%w: choice %d has no function call", ErrIncompleteChatCompletion, index)
			}
		default:
			return fmt.Errorf("%w: choice %d invalid finish_reason %q", ErrIncompleteChatCompletion, index, *answer.finish)
		}
		toolIndices := make([]int, 0, len(answer.tools)) // 工具编号同样保持稳定的校验顺序。
		for toolIndex := range answer.tools {
			toolIndices = append(toolIndices, toolIndex)
		}
		sort.Ints(toolIndices)
		for _, toolIndex := range toolIndices {
			tool := answer.tools[toolIndex] // 不只检查 finish_reason 指向的工具。
			if strings.TrimSpace(tool.id) == "" || tool.kind != "function" || strings.TrimSpace(tool.function.name.String()) == "" || strings.TrimSpace(tool.function.arguments.String()) == "" {
				return fmt.Errorf("%w: choice %d tool %d missing id/type/name/arguments", ErrIncompleteChatCompletion, index, toolIndex)
			}
		}
		if answer.legacy != nil && (strings.TrimSpace(answer.legacy.name.String()) == "" || strings.TrimSpace(answer.legacy.arguments.String()) == "") {
			return fmt.Errorf("%w: choice %d incomplete function call", ErrIncompleteChatCompletion, index)
		}
	}
	return nil
}

// validate 检查整块索引和请求归属；同块重复工具索引的元数据也必须一致。
func (a *ChatAccumulator) validate(chunk *ChatChunk) error {
	if chunk == nil || chunk.ID == "" || chunk.Model == "" || chunk.Object != "chat.completion.chunk" || chunk.Choices == nil {
		return fmt.Errorf("%w: missing chunk metadata", ErrInvalidChatDelta)
	}
	if a.choices != nil && (chunk.ID != a.id || chunk.Model != a.model || chunk.Created != a.created) {
		return fmt.Errorf("%w: response metadata changed", ErrInvalidChatDelta)
	}
	type toolKey struct{ choice, tool int } // 将两个层级的编号作为联合键。
	seen := make(map[toolKey]toolBuilder)   // 只记录本次块中的元数据，不修改现有状态。
	seenChoices := make(map[int]bool)       // 同一标准块内一个候选编号只出现一次。
	for _, choice := range chunk.Choices {
		if choice.Index < 0 {
			return fmt.Errorf("%w: negative choice index", ErrInvalidChatDelta)
		}
		if seenChoices[choice.Index] {
			return fmt.Errorf("%w: duplicate choice index %d", ErrInvalidChatDelta, choice.Index)
		}
		seenChoices[choice.Index] = true
		if previous := a.choices[choice.Index]; previous != nil && previous.finish != nil {
			if choice.FinishReason != nil && *choice.FinishReason != *previous.finish {
				return fmt.Errorf("%w: choice %d finish_reason changed", ErrInvalidChatDelta, choice.Index)
			}
			if (choice.Delta.Content != nil && *choice.Delta.Content != "") || (choice.Delta.Refusal != nil && *choice.Delta.Refusal != "") || len(choice.Delta.ToolCalls) > 0 || choice.Delta.FunctionCall != nil {
				return fmt.Errorf("%w: choice %d received content after finish", ErrInvalidChatDelta, choice.Index)
			}
			// 允许结束之后的空块和音频元数据更新；usage 本身不包含 choice。
		}
		for _, delta := range choice.Delta.ToolCalls {
			if delta.Index < 0 {
				return fmt.Errorf("%w: negative tool index", ErrInvalidChatDelta)
			}
			key := toolKey{choice.Index, delta.Index} // 对同候选内相同编号做一致性检查。
			metadata, exists := seen[key]             // 元数据允许在后面的块中才出现。
			if !exists && a.choices[choice.Index] != nil && a.choices[choice.Index].tools[delta.Index] != nil {
				previous := a.choices[choice.Index].tools[delta.Index] // 只读取现有工具元数据。
				metadata.id, metadata.kind = previous.id, previous.kind
			}
			if delta.ID != nil {
				if metadata.id != "" && metadata.id != *delta.ID {
					return fmt.Errorf("%w: conflicting tool id", ErrInvalidChatDelta)
				}
				metadata.id = *delta.ID
			}
			if delta.Type != nil {
				if metadata.kind != "" && metadata.kind != *delta.Type {
					return fmt.Errorf("%w: conflicting tool type", ErrInvalidChatDelta)
				}
				metadata.kind = *delta.Type
			}
			seen[key] = metadata
		}
	}
	return nil
}

// Result 返回独立快照；修改返回值中的 map、指针、usage 不会影响累积器。
// 快照本身不说明传输成功，完整性以读取流时返回的错误为准。
func (a *ChatAccumulator) Result() ChatResult {
	result := ChatResult{ID: a.id, Model: a.model, Created: a.created, Choices: make(map[int]ChatAnswer), Usage: cloneUsage(a.usage)} // 返回值独立持有可变数据。
	for index, state := range a.choices {
		answer := ChatAnswer{Index: index, Role: state.role, Content: state.content.String(), Refusal: state.refusal.String(), FinishReason: cloneString(state.finish), ToolCalls: make(map[int]ChatToolCall)} // 单个候选的快照。
		for toolIndex, tool := range state.tools {
			answer.ToolCalls[toolIndex] = ChatToolCall{Index: toolIndex, ID: tool.id, Type: tool.kind, Function: tool.function.result()}
		}
		if state.legacy != nil {
			function := state.legacy.result() // 旧字段同样返回独立值。
			answer.FunctionCall = &function
		}
		result.Choices[index] = answer
	}
	return result
}

// cloneString 复制可空字符串，隔离调用方持有的指针。
func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value // 字符串不可变，只需复制保存字符串的变量。
	return &copy
}

// cloneUsage 复制统计及原始 JSON 明细，防止外部修改已保存的统计数据。
func cloneUsage(usage *ChatUsage) *ChatUsage {
	if usage == nil {
		return nil
	}
	copy := *usage // 标量字段按值复制。
	copy.PromptTokensDetails = append(json.RawMessage(nil), usage.PromptTokensDetails...)
	copy.CompletionTokensDetails = append(json.RawMessage(nil), usage.CompletionTokensDetails...)
	return &copy
}

// Collect 从当前位置读到 [DONE]，一次返回完整回答；应在第一次 Next 之前调用。
// 如果此前调用过 Next，调用方应使用 Add 手工加入那些已经读取的块。
// 失败时仍返回已累积的部分结果及错误；不关闭输入源，也不执行任何工具。
func (d *ChatDecoder) Collect() (result *ChatResult, err error) {
	business := businessLog{config: d.config, protocol: "chat", first: d.sse.eventIndex + 1} // 第三层只在 Collect 中根据完整拼接状态生成。
	defer func() { err = business.finish(d.sse.eventIndex, result, err) }()                  // 成功与部分结果都写日志。
	accumulator := NewChatAccumulatorWithConfig(d.config)                                    // 使用同一套调用配置。
	for {
		chunk, err := d.Next() // 继续读完结束原因之后的 usage，并等待 DONE。
		if err == io.EOF {
			err = accumulator.Finish() // DONE 仅表示传输结束，还要确认业务字段完整。
			result := accumulator.Result()
			return &result, err
		}
		if err == nil {
			err = accumulator.Add(chunk)
			if err == nil {
				err = business.chat(d.sse.eventIndex, chunk, accumulator)
			}
		}
		if err != nil {
			result := accumulator.Result() // 保留完整块已产生的部分内容，方便故障展示。
			return &result, err
		}
	}
}
