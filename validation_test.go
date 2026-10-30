package sse

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// TestRequiredIndicesRegression 防止缺失/null 索引被默认为 0，并覆盖分块与原对象隔离。
func TestRequiredIndicesRegression(t *testing.T) {
	cases := []string{ // 所有这些输入都必须在返回增量之前失败。
		`[{"delta":{"content":"wrong"}}]`,
		`[{"index":null,"delta":{}}]`,
		`[{"index":-1,"delta":{}}]`,
		`[{"index":0.5,"delta":{}}]`,
		`[{"index":"0","delta":{}}]`,
		`[{"index":999999999999999999999999,"delta":{}}]`,
		`[null]`,
		`[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"}"}}]}}]`,
		`[{"index":0,"delta":{"tool_calls":[{"index":null}]}}]`,
		`[{"index":0,"delta":{"tool_calls":[{"index":-1}]}}]`,
		`[{"index":0,"delta":{"tool_calls":[{"index":0.5}]}}]`,
		`[{"index":0,"delta":{"tool_calls":[{"index":"0"}]}}]`,
		`[{"index":0,"delta":{"tool_calls":[null]}}]`,
	}
	prefix := chatEvent(`[{"index":0,"delta":{"content":"keep","tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"f","arguments":"{"}}]}}]`, "") // 已有工具 0 的参数前缀。
	for _, choices := range cases {
		for _, width := range []int{1, 4096} { // 缺少索引不能因网络分块而变成合法数据。
			decoder := NewChatDecoder(&chunkReader{reader: strings.NewReader(prefix + chatEvent(choices, "") + "data:[DONE]\n\n"), width: width})
			result, err := decoder.Collect() // 错误块不能写入此前的候选或工具。
			if !errors.Is(err, ErrInvalidChatChunk) || result.Choices[0].Content != "keep" || result.Choices[0].ToolCalls[0].Function.Arguments != "{" {
				t.Fatalf("choices=%s result=%#v err=%v", choices, result, err)
			}
			if _, nextErr := decoder.Next(); nextErr != err {
				t.Fatalf("terminal error changed: %v -> %v", err, nextErr)
			}
		}
	}
	// 显式 0 是合法索引，重新解码失败也不能破坏调用方原来的对象。
	choice := ChatChoice{Index: 7} // 用非零初值检测失败时是否被错误清空。
	if err := json.Unmarshal([]byte(`{"delta":{}}`), &choice); err == nil || choice.Index != 7 {
		t.Fatalf("choice modified on failure: %#v %v", choice, err)
	}
	tool := ChatToolCallDelta{Index: 8} // 工具解码同样应当原子更新。
	if err := json.Unmarshal([]byte(`{"index":null}`), &tool); err == nil || tool.Index != 8 {
		t.Fatalf("tool modified on failure: %#v %v", tool, err)
	}
}

// TestCompletionValidationRegression 覆盖 DONE 仅表示传输结束、各候选与工具仍需完成校验。
func TestCompletionValidationRegression(t *testing.T) {
	cases := []struct {
		name    string // 场景名称。
		choices string // 空字符串表示根本没有增量块。
	}{
		{"done_only", ""},
		{"usage_only", `[]`},
		{"no_finish", `[{"index":0,"delta":{"content":"half"}}]`},
		{"null_finish", `[{"index":0,"delta":{},"finish_reason":null}]`},
		{"empty_finish", `[{"index":0,"delta":{},"finish_reason":""}]`},
		{"unknown_finish", `[{"index":0,"delta":{},"finish_reason":"unknown"}]`},
		{"one_unfinished", `[{"index":2,"delta":{},"finish_reason":"stop"},{"index":0,"delta":{"content":"half"}}]`},
		{"no_tools", `[{"index":0,"delta":{},"finish_reason":"tool_calls"}]`},
		{"no_legacy", `[{"index":0,"delta":{},"finish_reason":"function_call"}]`},
		{"missing_id", `[{"index":0,"delta":{"tool_calls":[{"index":4,"type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]`},
		{"missing_type", `[{"index":0,"delta":{"tool_calls":[{"index":4,"id":"c","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]`},
		{"wrong_type", `[{"index":0,"delta":{"tool_calls":[{"index":4,"id":"c","type":"other","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]`},
		{"missing_name", `[{"index":0,"delta":{"tool_calls":[{"index":4,"id":"c","type":"function","function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]`},
		{"missing_arguments", `[{"index":0,"delta":{"tool_calls":[{"index":4,"id":"c","type":"function","function":{"name":"f"}}]},"finish_reason":"tool_calls"}]`},
		{"blank_fields", `[{"index":0,"delta":{"tool_calls":[{"index":4,"id":" ","type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]`},
		{"incomplete_legacy", `[{"index":0,"delta":{"function_call":{"name":"f"}},"finish_reason":"function_call"}]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := "data:[DONE]\n\n" // 即便有 DONE，也不能让业务不完整的结果静默成功。
			if tc.choices != "" {
				input = chatEvent(tc.choices, `,"usage":{"total_tokens":3}`) + input
			}
			result, err := NewChatDecoder(strings.NewReader(input)).Collect()
			if result == nil || !errors.Is(err, ErrIncompleteChatCompletion) {
				t.Fatalf("result=%#v err=%v", result, err)
			}
		})
	}
	for _, reason := range []string{"stop", "length", "content_filter"} { // 合法的非正常停止原因不被改成 stop。
		input := chatEvent(`[{"index":0,"delta":{},"finish_reason":"`+reason+`"}]`, "") + chatEvent(`[]`, `,"usage":{"total_tokens":3}`) + "data:[DONE]\n\n"
		result, err := NewChatDecoder(strings.NewReader(input)).Collect()
		if err != nil || *result.Choices[0].FinishReason != reason || result.Usage.TotalTokens != 3 {
			t.Fatalf("reason=%s result=%#v err=%v", reason, result, err)
		}
	}
	legacy := chatEvent(`[{"index":0,"delta":{"function_call":{"name":"old","arguments":"{}"}},"finish_reason":"function_call"}]`, "") // 保留旧版完整函数调用支持。
	if _, err := NewChatDecoder(strings.NewReader(legacy + "data:[DONE]\n\n")).Collect(); err != nil {
		t.Fatal(err)
	}
}

// TestAccumulatorFinishLifecycle 校验手工增量消费的完成与错误生命周期。
func TestAccumulatorFinishLifecycle(t *testing.T) {
	accumulator := NewChatAccumulator() // 手工模式在 EOF 后明确调用 Finish。
	if err := accumulator.Add(accumulatorChunk(t, `[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]`, "")); err != nil {
		t.Fatal(err)
	}
	if err := accumulator.Finish(); err != nil {
		t.Fatal(err)
	}
	before := accumulator.Result() // 封存后不能再修改结果。
	if err := accumulator.Add(nil); !errors.Is(err, ErrAccumulatorFinished) || !reflect.DeepEqual(before, accumulator.Result()) {
		t.Fatalf("append after finish: %v", err)
	}
	if err := accumulator.Finish(); err != nil { // 重复完成不应报错。
		t.Fatal(err)
	}
	var unfinished ChatAccumulator // 零值实例也执行相同完成校验。
	err := unfinished.Finish()     // 空回答校验失败后，错误保持不变。
	if !errors.Is(err, ErrIncompleteChatCompletion) || unfinished.Finish() != err || unfinished.Add(nil) != err {
		t.Fatalf("completion error not sticky: %v", err)
	}
	invalid := NewChatAccumulator() // Add 先失败时，Finish 必须保留原错误。
	addErr := invalid.Add(nil)
	if invalid.Finish() != addErr {
		t.Fatal("Finish masked Add error")
	}
}

// TestFinishedChoiceRegression 已结束的候选不能继续增加正文、工具参数或篡改结束原因。
func TestFinishedChoiceRegression(t *testing.T) {
	prefix := chatEvent(`[{"index":0,"delta":{"content":"keep"},"finish_reason":"stop"}]`, "") // 候选已结束，但流还没有 DONE。
	for _, choices := range []string{
		`[{"index":0,"delta":{"content":"extra"}}]`,
		`[{"index":0,"delta":{"refusal":"extra"}}]`,
		`[{"index":0,"delta":{"tool_calls":[{"index":0}]}}]`,
		`[{"index":0,"delta":{"function_call":{}}}]`,
		`[{"index":0,"delta":{},"finish_reason":"length"}]`,
		`[{"index":1,"delta":{}},{"index":1,"delta":{}}]`,
	} {
		result, err := NewChatDecoder(strings.NewReader(prefix + chatEvent(choices, "") + "data:[DONE]\n\n")).Collect()
		if !errors.Is(err, ErrInvalidChatDelta) || result.Choices[0].Content != "keep" || len(result.Choices) != 1 {
			t.Fatalf("post-finish/duplicate delta: %#v %v", result, err)
		}
	}
	// 合法的末尾音频过期信息、空更新与同值结束原因，不能被误判为新增正文。
	input := prefix + chatEvent(`[{"index":0,"delta":{"audio":{"expires_at":123},"content":""},"finish_reason":"stop"}]`, "") + "data:[DONE]\n\n"
	if _, err := NewChatDecoder(strings.NewReader(input)).Collect(); err != nil {
		t.Fatal(err)
	}
}

// chunkBudget 根据公开计量规则计算一个测试块的 JSON 数据量。
func chunkBudget(t *testing.T, chunk *ChatChunk) int {
	t.Helper()
	encoded, err := json.Marshal(chunk) // Raw 不参与结构编码。
	if err != nil {
		t.Fatal(err)
	}
	if len(chunk.Raw) > len(encoded) {
		return len(chunk.Raw)
	}
	return len(encoded)
}

// TestTotalSizeRegression 验证小块累计、精确边界、原子失败、零值限制和元数据不能绕过预算。
func TestTotalSizeRegression(t *testing.T) {
	first := accumulatorChunk(t, `[{"index":0,"delta":{"content":"你好","tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"f","arguments":"{"}}]}}]`, "") // UTF-8 字节与工具参数都计入。
	second := accumulatorChunk(t, `[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]`, "")
	usage := accumulatorChunk(t, `[]`, `,"usage":{"total_tokens":3,"completion_tokens_details":{"reasoning_tokens":2}}`) // 用量块也计入整次数据量。
	limit := chunkBudget(t, first) + chunkBudget(t, second) + chunkBudget(t, usage)                                      // 恰好容纳全部三个块。
	for _, offset := range []int{-1, 0, 1} {                                                                             // 预算少一字节必须失败，等于和多一字节都应通过。
		accumulator := NewChatAccumulatorWithConfig(Config{MaxTotalBytes: limit + offset})
		for _, chunk := range []*ChatChunk{first, second} {
			if err := accumulator.Add(chunk); err != nil {
				t.Fatal(err)
			}
		}
		before := accumulator.Result() // 超限块中的 usage 不能写入。
		err := accumulator.Add(usage)
		if offset < 0 {
			if !errors.Is(err, ErrChatTooLarge) || !reflect.DeepEqual(before, accumulator.Result()) || accumulator.Add(usage) != err || accumulator.Finish() != err {
				t.Fatalf("limit not enforced atomically: %v", err)
			}
		} else if err != nil || accumulator.Finish() != nil {
			t.Fatalf("exact boundary rejected: offset=%d err=%v", offset, err)
		}
	}
	input := chatEvent(`[{"index":0,"delta":{"content":"你好","tool_calls":[{"index":0,"id":"c","type":"function","function":{"name":"f","arguments":"{"}}]}}]`, "") + chatEvent(`[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]`, "") + chatEvent(`[]`, `,"usage":{"total_tokens":3,"completion_tokens_details":{"reasoning_tokens":2}}`) + "data:[DONE]\n\n"
	result, err := NewChatDecoderWithConfig(strings.NewReader(input), Config{MaxTotalBytes: limit - 1}).Collect() // Collect 必须沿用调用方配置。
	if !errors.Is(err, ErrChatTooLarge) || result.Usage != nil || result.Choices[0].Content != "你好" {
		t.Fatalf("Collect limit ignored: %#v %v", result, err)
	}
	result, err = NewChatDecoderWithConfig(strings.NewReader(input), Config{MaxTotalBytes: limit}).Collect()
	if err != nil || result.Usage.TotalTokens != 3 {
		t.Fatalf("Collect exact boundary: %#v %v", result, err)
	}
	modified := accumulatorChunk(t, `[{"index":0,"delta":{"content":"x"}}]`, "") // 修改解码后的字段不能利用旧 Raw 绕过限额。
	budget := chunkBudget(t, modified)
	modified.Choices[0].Delta.Content = cloneStringValue(strings.Repeat("x", budget+1))
	if err := NewChatAccumulatorWithConfig(Config{MaxTotalBytes: budget}).Add(modified); !errors.Is(err, ErrChatTooLarge) {
		t.Fatalf("stale Raw bypass: %v", err)
	}
	raw := accumulatorChunk(t, `[]`, "") // 未建模原始字段也采用保守预算。
	raw.Raw = json.RawMessage(strings.Repeat(" ", budget+1))
	if err := NewChatAccumulatorWithConfig(Config{MaxTotalBytes: budget}).Add(raw); !errors.Is(err, ErrChatTooLarge) {
		t.Fatalf("Raw payload bypass: %v", err)
	}
	invalid := accumulatorChunk(t, `[]`, "") // 手工构造的非法 RawMessage 不能污染已有结果。
	invalid.Moderation = json.RawMessage("{")
	if err := NewChatAccumulator().Add(invalid); !errors.Is(err, ErrInvalidChatDelta) {
		t.Fatalf("invalid JSON measurement: %v", err)
	}
}

// TestDefaultTotalLimit 验证默认构造、零值和非正配置都保留实际限制。
func TestDefaultTotalLimit(t *testing.T) {
	for _, limit := range []int{0, -1} { // 不提供不受限模式。
		accumulator := NewChatAccumulatorWithConfig(Config{MaxTotalBytes: limit})
		chunk := accumulatorChunk(t, `[{"index":0,"delta":{"content":"x"}}]`, "")
		chunk.Choices[0].Delta.Content = cloneStringValue(strings.Repeat("x", 1024*1024)) // 通过若干小块跨过 32 MiB 总上限。
		for count := 0; ; count++ {
			err := accumulator.Add(chunk)
			if err != nil {
				if !errors.Is(err, ErrChatTooLarge) || count == 0 || count > 32 || accumulator.usedBytes > DefaultMaxTotalBytes {
					t.Fatalf("default limit: count=%d bytes=%d err=%v", count, accumulator.usedBytes, err)
				}
				break
			}
			if count > 32 {
				t.Fatal("default total limit disabled")
			}
		}
	}
}
