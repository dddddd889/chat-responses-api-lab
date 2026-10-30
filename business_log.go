package sse

import (
	"encoding/json"
	"sort"
)

// StreamUsage 统一两种接口的用量字段；保存整次快照，不按事件求和。
type StreamUsage struct {
	InputTokens         int64           `json:"input_tokens"`                    // Chat prompt_tokens 或 Responses input_tokens。
	OutputTokens        int64           `json:"output_tokens"`                   // Chat completion_tokens 或 Responses output_tokens。
	TotalTokens         int64           `json:"total_tokens"`                    // 上游提供的总量，不额外累加明细。
	InputTokensDetails  json.RawMessage `json:"input_tokens_details,omitempty"`  // 保留缓存等输入明细。
	OutputTokensDetails json.RawMessage `json:"output_tokens_details,omitempty"` // 保留思考等输出明细。
}

// BusinessEvent 是第三层统一业务事件；仅记录生成过程，不执行工具。
type BusinessEvent struct {
	Type         string       `json:"type"`                    // text_delta/refusal_delta/tool_start/tool_arguments_delta/tool_done/choice_done/usage/done/error。
	ChoiceIndex  *int         `json:"choice_index,omitempty"`  // Chat 原始候选号；Responses 为单一候选 0。
	ToolIndex    *int         `json:"tool_index,omitempty"`    // Chat 工具 index；Responses 使用 output_index，不重新编号。
	ItemID       string       `json:"item_id,omitempty"`       // Responses output item ID，与 call_id 分开。
	CallID       string       `json:"call_id,omitempty"`       // Chat 工具 id 或 Responses call_id。
	Name         string       `json:"name,omitempty"`          // 当前已知工具名，tool_done 中为完整名称。
	Delta        *string      `json:"delta,omitempty"`         // 原始增量，参数仍是字符串片段。
	Arguments    *string      `json:"arguments,omitempty"`     // tool_done 的完整参数；不重复追加 done 全文。
	FinishReason string       `json:"finish_reason,omitempty"` // Chat 候选原始结束原因。
	Usage        *StreamUsage `json:"usage,omitempty"`         // 统一字段的请求用量快照。
	Status       string       `json:"status,omitempty"`        // complete 或 partial，表示对应事件的完成状态。
	Error        string       `json:"error,omitempty"`         // 失败原因。
}

// businessLog 为一次 Collect 保留工具生命周期去重信息，不额外累积参数正文。
type businessLog struct {
	config   Config            // 与另外两层使用同一个目的地。
	protocol string            // 原始接口类型仍保留，方便追踪。
	first    uint64            // Collect 开始后的首条事件号。
	started  map[[2]int]uint64 // 每个候选/工具开始时的 SSE 序号。
	closed   map[[2]int]bool   // done 全文出现多次也只输出一次 tool_done。
	usage    string            // 最近一次用量快照，用于去掉相同的重复快照。
}

// enabled 不开启 JSONL 时跳过第三层，保持纯 SSE 日志兼容。
func (l *businessLog) enabled() bool {
	return l.config.LogWriter != nil && l.config.LogFormat == "jsonl"
}

// emit 将业务事件直接作为 object 写出，并关联触发它的本地 SSE 序号。
func (l *businessLog) emit(index, first uint64, event BusinessEvent) error {
	if !l.enabled() {
		return nil
	}
	data, err := json.Marshal(event) // object 为嵌套 JSON，不是转义后的 JSON 字符串。
	if err != nil {
		return &streamLogError{cause: err}
	}
	return writeLogRecord(l.config.LogWriter, StreamLogRecord{Kind: "event", Protocol: l.protocol, EventIndex: index, FirstEventIndex: first, LastEventIndex: index, Object: data})
}

// tool 统一输出工具开始、参数增量和完成；完整参数只在 tool_done 中出现。
func (l *businessLog) tool(index uint64, choice, tool int, itemID, callID, name string, delta *string, arguments *string) error {
	if !l.enabled() {
		return nil
	}
	key := [2]int{choice, tool} // 同一工具编号在不同候选内独立。
	if l.started == nil {
		l.started = make(map[[2]int]uint64)
		l.closed = make(map[[2]int]bool)
	}
	event := BusinessEvent{ChoiceIndex: &choice, ToolIndex: &tool, ItemID: itemID, CallID: callID, Name: name} // 所有工具事件使用相同定位字段。
	if l.started[key] == 0 {
		event.Type = "tool_start"
		if err := l.emit(index, index, event); err != nil {
			return err
		}
		l.started[key] = index
	}
	if delta != nil && *delta != "" {
		event.Type = "tool_arguments_delta"
		event.Delta = delta
		if err := l.emit(index, index, event); err != nil {
			return err
		}
		event.Delta = nil
	}
	if arguments != nil && !l.closed[key] {
		event.Type = "tool_done"
		event.Arguments = arguments
		event.Status = "complete"
		if err := l.emit(index, l.started[key], event); err != nil {
			return err
		}
		l.closed[key] = true
	}
	return nil
}

// usageEvent 统一用量命名；重复全文不重复发出，也不累加到旧快照。
func (l *businessLog) usageEvent(index uint64, usage *StreamUsage) error {
	if !l.enabled() || usage == nil {
		return nil
	}
	encoded, err := json.Marshal(usage) // 明细与主计数一起比较。
	if err != nil {
		return &streamLogError{cause: err}
	}
	if string(encoded) == l.usage {
		return nil
	}
	if err := l.emit(index, index, BusinessEvent{Type: "usage", Usage: usage}); err != nil {
		return err
	}
	l.usage = string(encoded)
	return nil
}

// chat 在增量成功加入累积器后发出业务事件，坏事件只保留第一层和最终错误。
func (l *businessLog) chat(index uint64, chunk *ChatChunk, accumulator *ChatAccumulator) error {
	if !l.enabled() {
		return nil
	}
	for _, choice := range chunk.Choices {
		ci := choice.Index // 指针指向本轮独立的候选编号。
		for _, part := range []struct {
			kind  string
			delta *string
		}{{"text_delta", choice.Delta.Content}, {"refusal_delta", choice.Delta.Refusal}} {
			if part.delta != nil && *part.delta != "" {
				if err := l.emit(index, index, BusinessEvent{Type: part.kind, ChoiceIndex: &ci, Delta: part.delta}); err != nil {
					return err
				}
			}
		}
		answer := accumulator.choices[ci] // 只读已经成功校验的状态，不复制整次结果。
		for _, change := range choice.Delta.ToolCalls {
			tool := answer.tools[change.Index]
			var delta *string // 仅记录这一次收到的参数片段。
			if change.Function != nil {
				delta = change.Function.Arguments
			}
			if err := l.tool(index, ci, change.Index, "", tool.id, tool.function.name.String(), delta, nil); err != nil {
				return err
			}
		}
		if choice.FinishReason != nil {
			if *choice.FinishReason == "tool_calls" {
				keys := make([]int, 0, len(answer.tools)) // 工具按 index 排序，使回放事件顺序稳定。
				for key := range answer.tools {
					keys = append(keys, key)
				}
				sort.Ints(keys)
				for _, key := range keys {
					tool := answer.tools[key]
					arguments := tool.function.arguments.String()
					name := tool.function.name.String() // 完整值来自原累积器。
					if tool.id != "" && tool.kind != "" && name != "" && arguments != "" {
						if err := l.tool(index, ci, key, "", tool.id, name, nil, &arguments); err != nil {
							return err
						}
					}
				}
			}
			if err := l.emit(index, index, BusinessEvent{Type: "choice_done", ChoiceIndex: &ci, FinishReason: *choice.FinishReason}); err != nil {
				return err
			}
		}
	}
	if chunk.Usage != nil {
		u := chunk.Usage // Chat 字段映射成统一的 input/output 命名。
		return l.usageEvent(index, &StreamUsage{InputTokens: u.PromptTokens, OutputTokens: u.CompletionTokens, TotalTokens: u.TotalTokens, InputTokensDetails: u.PromptTokensDetails, OutputTokensDetails: u.CompletionTokensDetails})
	}
	return nil
}

// response 将 Responses 的多个生命周期事件折叠成同一套业务事件，不重复发出 done 全文。
func (l *businessLog) response(index uint64, event *ResponseEvent, partial *responsePartial) error {
	if !l.enabled() {
		return nil
	}
	ci := 0 // Responses 没有多个 choice，统一事件固定为单候选 0。
	switch event.Type {
	case "response.output_text.delta", "response.refusal.delta":
		if event.Delta != nil && *event.Delta != "" {
			kind := "text_delta"
			if event.Type == "response.refusal.delta" {
				kind = "refusal_delta"
			}
			if err := l.emit(index, index, BusinessEvent{Type: kind, ChoiceIndex: &ci, ItemID: event.ItemID, Delta: event.Delta}); err != nil {
				return err
			}
		}
	case "response.output_item.added", "response.output_item.done":
		item := event.Item // 仅规范化函数工具，其他扩展类型仍在第一层完整保留。
		if item != nil && item.Type == "function_call" {
			var arguments *string // added 中的空值不能当成参数增量，done 中的全文直接取最终值。
			if event.Type == "response.output_item.done" && (item.Status == "" || item.Status == "completed") {
				arguments = &item.Arguments
			}
			if err := l.tool(index, ci, *event.OutputIndex, item.ID, item.CallID, item.Name, nil, arguments); err != nil {
				return err
			}
		}
	case "response.function_call_arguments.delta":
		item := partial.items[*event.OutputIndex] // partial.apply 已检查输出项目归属。
		if err := l.tool(index, ci, *event.OutputIndex, item.ID, item.CallID, item.Name, event.Delta, nil); err != nil {
			return err
		}
	case "response.completed":
		for ti := range event.Response.Output { // 终止对象可能直接给出完整工具，不能依赖一定有 delta。
			item := &event.Response.Output[ti]
			if item.Type == "function_call" {
				if err := l.tool(index, ci, ti, item.ID, item.CallID, item.Name, nil, &item.Arguments); err != nil {
					return err
				}
			}
		}
	}
	if event.Response != nil && event.Response.Usage != nil {
		u := event.Response.Usage // 原样保留已有统计，不按工具数量复制。
		return l.usageEvent(index, &StreamUsage{InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, TotalTokens: u.TotalTokens, InputTokensDetails: u.InputTokensDetails, OutputTokensDetails: u.OutputTokensDetails})
	}
	return nil
}

// finish 在最后记录统一 done/error 和合并对象；任一层写失败都不能假装成功。
func (l *businessLog) finish(last uint64, result any, readErr error) error {
	if !l.enabled() {
		return readErr
	}
	event := BusinessEvent{Type: "done", Status: "complete"} // 完成指协议完整，Chat 的 length 仍由 choice_done 保留。
	if readErr != nil {
		event.Type = "error"
		event.Status = "partial"
		event.Error = readErr.Error()
	}
	first := l.first // 空流没有有效事件范围。
	if last < first {
		first = 0
	}
	if err := l.emit(last, first, event); err != nil {
		if readErr != nil {
			readErr = &resultLogError{read: readErr, log: err}
		} else {
			readErr = err
		}
	}
	return finishObjectLog(l.config, l.protocol, result, readErr, first, last)
}
