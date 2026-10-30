package sse

import (
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

// accumulatorChunk 用真实解码入口构造增量，确保测试符合传输结构。
func accumulatorChunk(t *testing.T, choices, extra string) *ChatChunk {
	t.Helper()
	chunk, err := NewChatDecoder(strings.NewReader(chatEvent(choices, extra))).Next() // 只取一个完整块。
	if err != nil {
		t.Fatal(err)
	}
	return chunk
}

// TestCollectInterleaved 验证乱序候选、相同工具编号、多工具以及跨块参数不会混在一起。
func TestCollectInterleaved(t *testing.T) {
	input := chatEvent(`[{"index":2,"delta":{"role":"assistant","content":"候选二","tool_calls":[{"index":4,"id":"call_two","type":"function","function":{"name":"wea","arguments":"{\"city\":"}}]}},{"index":0,"delta":{"role":"assistant","content":"候选零","tool_calls":[{"index":4,"function":{"arguments":"{\"n\":"}}]}}]`, "") +
		chatEvent(`[{"index":0,"delta":{"content":"完成","tool_calls":[{"index":4,"id":"call_zero","type":"function","function":{"name":"count","arguments":"42}"}},{"index":1,"id":"call_clock","type":"function","function":{"name":"clock","arguments":"{}"}}]},"finish_reason":"tool_calls"},{"index":2,"delta":{"content":"完成","tool_calls":[{"index":4,"function":{"name":"ther","arguments":"\"上海\"}"}}]},"finish_reason":"tool_calls"}]`, "") +
		chatEvent(`[]`, `,"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}`) + "data:[DONE]\n\n"
	for _, width := range []int{1, 3, 4096} { // 每个字节拆开发送和整块发送必须一致。
		result, err := NewChatDecoder(&chunkReader{reader: strings.NewReader(input), width: width}).Collect() // 全程调用一次即可拿最终结果。
		if err != nil {
			t.Fatal(err)
		}
		if result.ID != "chatcmpl-test" || result.Model != "test-model" || result.Created != 123 || len(result.Choices) != 2 {
			t.Fatalf("metadata: %#v", result)
		}
		zero, two := result.Choices[0], result.Choices[2] // 编号 2 不会被重排为 1。
		if zero.Content != "候选零完成" || two.Content != "候选二完成" || zero.Role != "assistant" || *two.FinishReason != "tool_calls" {
			t.Fatalf("answers: %#v %#v", zero, two)
		}
		if len(zero.ToolCalls) != 2 || len(two.ToolCalls) != 1 || zero.ToolCalls[4].ID != "call_zero" || two.ToolCalls[4].ID != "call_two" {
			t.Fatalf("tool isolation: %#v %#v", zero.ToolCalls, two.ToolCalls)
		}
		if two.ToolCalls[4].Function.Name != "weather" || two.ToolCalls[4].Function.Arguments != `{"city":"上海"}` || zero.ToolCalls[4].Function.Arguments != `{"n":42}` {
			t.Fatalf("tool arguments: %#v %#v", zero.ToolCalls, two.ToolCalls)
		}
		if zero.ToolCalls[1].Function.Arguments != "{}" || result.Usage == nil || result.Usage.TotalTokens != 30 {
			t.Fatalf("final usage/tools: %#v", result)
		}
		var arguments struct {
			City string `json:"city"`
		} // 按业务结构解析完整参数。
		if err := two.ToolCalls[4].Function.DecodeArguments(&arguments); err != nil || arguments.City != "上海" {
			t.Fatalf("decode arguments: %#v %v", arguments, err)
		}
	}
}

// TestAccumulatorSnapshots 验证输入、返回快照、后续增量相互隔离，且 usage 不按块相加。
func TestAccumulatorSnapshots(t *testing.T) {
	var accumulator ChatAccumulator                                                                                                                                                                                                                                                                                                     // 零值可直接使用。
	chunk := accumulatorChunk(t, `[{"index":9,"delta":{"content":"a","refusal":"拒","function_call":{"name":"old","arguments":"{"},"tool_calls":[{"index":8,"id":"call","type":"function","function":{"name":"f","arguments":"{"}}]},"finish_reason":null}]`, `,"usage":{"total_tokens":5,"prompt_tokens_details":{"cached_tokens":1}}`) // 同时覆盖旧函数调用。
	if err := accumulator.Add(chunk); err != nil {
		t.Fatal(err)
	}
	before := accumulator.Result() // 在加入新增量前保存快照。
	chunk.Usage.TotalTokens = 999
	chunk.Usage.PromptTokensDetails[0] = 'x'
	next := accumulatorChunk(t, `[{"index":9,"delta":{"content":null,"refusal":"绝","function_call":{"arguments":"}"},"tool_calls":[{"index":8,"id":"call","type":"function","function":{"arguments":"}"}}]},"finish_reason":"length"}]`, `,"usage":null`) // 元数据重复不会重复拼接 ID 或类型。
	if err := accumulator.Add(next); err != nil {
		t.Fatal(err)
	}
	*next.Choices[0].FinishReason = "tampered" // 修改原始增量不应影响已保存状态。
	after := accumulator.Result()              // 新快照包含新片段。
	if before.Choices[9].ToolCalls[8].Function.Arguments != "{" || before.Choices[9].Refusal != "拒" || after.Choices[9].Refusal != "拒绝" {
		t.Fatalf("snapshot changed: %#v %#v", before, after)
	}
	answer := after.Choices[9] // 当前完整候选。
	if answer.Content != "a" || answer.FunctionCall.Name != "old" || answer.FunctionCall.Arguments != "{}" || *answer.FinishReason != "length" {
		t.Fatalf("legacy/refusal/null: %#v", answer)
	}
	if after.Usage.TotalTokens != 5 || !json.Valid(after.Usage.PromptTokensDetails) {
		t.Fatalf("usage alias: %#v", after.Usage)
	}
	*after.Choices[9].FinishReason = "mutated" // 修改返回值中的可变字段。
	answer.FunctionCall.Name = "mutated"
	delete(answer.ToolCalls, 8)
	after.Usage.TotalTokens = 100
	after.Usage.PromptTokensDetails[0] = 'x'
	delete(after.Choices, 9)
	if fresh := accumulator.Result(); !reflect.DeepEqual(fresh.Choices[9].ToolCalls[8].Function, ChatFunctionCall{Name: "f", Arguments: "{}"}) || *fresh.Choices[9].FinishReason != "length" || fresh.Choices[9].FunctionCall.Name != "old" || fresh.Usage.TotalTokens != 5 || !json.Valid(fresh.Usage.PromptTokensDetails) {
		t.Fatalf("result aliases accumulator: %#v", fresh)
	}
	if err := accumulator.Add(accumulatorChunk(t, `[]`, `,"usage":{"total_tokens":7}`)); err != nil {
		t.Fatal(err)
	}
	if usage := accumulator.Result().Usage; usage.TotalTokens != 7 {
		t.Fatalf("usage must replace, not sum: %#v", usage)
	}
}

// TestAccumulatorValidation 检查失败块不污染结果，且停止接受后续数据。
func TestAccumulatorValidation(t *testing.T) {
	cases := []struct {
		name string           // 冲突场景。
		edit func(*ChatChunk) // 修改合法增量的方法。
	}{
		{"object", func(c *ChatChunk) { c.Object = "chat.completion" }},
		{"missing_id", func(c *ChatChunk) { c.ID = "" }},
		{"null_choices", func(c *ChatChunk) { c.Choices = nil }},
		{"mixed_id", func(c *ChatChunk) { c.ID = "other-request" }},
		{"mixed_model", func(c *ChatChunk) { c.Model = "other-model" }},
		{"mixed_created", func(c *ChatChunk) { c.Created++ }},
		{"negative_choice", func(c *ChatChunk) { c.Choices[0].Index = -1 }},
		{"negative_tool", func(c *ChatChunk) { c.Choices[0].Delta.ToolCalls[0].Index = -1 }},
		{"conflicting_id", func(c *ChatChunk) { c.Choices[0].Delta.ToolCalls[0].ID = cloneStringValue("different") }},
		{"conflicting_type", func(c *ChatChunk) { c.Choices[0].Delta.ToolCalls[0].Type = cloneStringValue("different") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			accumulator := NewChatAccumulator() // 每个场景从同一个有效状态开始。
			chunk := accumulatorChunk(t, `[{"index":0,"delta":{"content":"original","tool_calls":[{"index":0,"id":"call","type":"function","function":{"arguments":"{}"}}]}}]`, "")
			if err := accumulator.Add(chunk); err != nil {
				t.Fatal(err)
			}
			before := accumulator.Result() // 失败块应完全不写入。
			tc.edit(chunk)
			err := accumulator.Add(chunk) // 含有冲突的增量。
			if !errors.Is(err, ErrInvalidChatDelta) || !reflect.DeepEqual(before, accumulator.Result()) {
				t.Fatalf("invalid delta modified state: %v", err)
			}
			if nextErr := accumulator.Add(nil); nextErr != err {
				t.Fatalf("terminal error changed: %v", nextErr)
			}
		})
	}
	if err := NewChatAccumulator().Add(nil); !errors.Is(err, ErrInvalidChatDelta) {
		t.Fatalf("nil chunk: %v", err)
	}
	accumulator := NewChatAccumulator() // 同块重复编号也要预先检查。
	chunk := accumulatorChunk(t, `[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a"},{"index":0,"id":"b"}]}}]`, "")
	if err := accumulator.Add(chunk); !errors.Is(err, ErrInvalidChatDelta) || len(accumulator.Result().Choices) != 0 {
		t.Fatalf("within-chunk conflict: %v", err)
	}
}

// cloneStringValue 为测试构造可空字符串字段。
func cloneStringValue(value string) *string { return &value }

// TestCollectPartialResults 确认缺 DONE、流内错误、非法 JSON 和归属冲突均保留部分结果并返回错误。
func TestCollectPartialResults(t *testing.T) {
	prefix := chatEvent(`[{"index":0,"delta":{"content":"部分回答"},"finish_reason":"stop"}]`, "") // 有结束原因也不表示流正常完成。
	cases := []struct {
		tail string // 出错尾部。
		want error  // 可识别的错误。
	}{
		{"", io.ErrUnexpectedEOF},
		{"data:{broken}\n\n", ErrInvalidChatChunk},
		{chatEvent(`[{"index":-1,"delta":{}}]`, ""), ErrInvalidChatChunk},
	}
	for _, tc := range cases {
		result, err := NewChatDecoder(strings.NewReader(prefix + tc.tail)).Collect() // 部分结果不能当成功使用。
		if !errors.Is(err, tc.want) || result.Choices[0].Content != "部分回答" {
			t.Fatalf("partial result: %#v %v", result, err)
		}
	}
	result, err := NewChatDecoder(strings.NewReader(prefix + "data:{\"error\":{\"message\":\"failed\"}}\n\n")).Collect() // 流内上游错误保持原类型。
	var apiErr *APIError                                                                                                 // 提取错误详情。
	if !errors.As(err, &apiErr) || result.Choices[0].Content != "部分回答" {
		t.Fatalf("API partial result: %#v %v", result, err)
	}
	result, err = NewChatDecoder(strings.NewReader(chatEvent(`[{"index":0,"delta":{},"finish_reason":"stop"}]`, "") + "data:[DONE]\n\n")).Collect()
	if err != nil || result.Usage != nil || result.Choices[0].Content != "" || len(result.Choices[0].ToolCalls) != 0 {
		t.Fatalf("no usage or tools: %#v %v", result, err)
	}
	if err := (ChatFunctionCall{Arguments: "{"}).DecodeArguments(&map[string]any{}); err == nil {
		t.Fatal("invalid argument JSON silently accepted")
	}
}
