package sse

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

// chatEvent 生成标准元数据及调用方指定的 choices，模拟真实 SSE data。
func chatEvent(choices, extra string) string {
	return `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":123,"model":"test-model","choices":` + choices + extra + "}\n\n"
}

// TestChatDecoderTextAndUsage 覆盖首块 role、空文本、null、结束原因和结束之后的用量块。
func TestChatDecoderTextAndUsage(t *testing.T) {
	input := ": heartbeat\r\n\r\n" + // 注释仍由底层解析器忽略。
		chatEvent(`[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]`, `,"usage":null`) +
		chatEvent(`[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]`, `,"future_field":{"keep":true}`) +
		chatEvent(`[{"index":0,"delta":{"content":null,"refusal":"拒绝片段"},"finish_reason":null}]`, "") +
		chatEvent(`[{"index":0,"delta":{},"finish_reason":"stop"}]`, "") +
		chatEvent(`[]`, `,"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5,"completion_tokens_details":{"reasoning_tokens":1}}`) +
		"data: [DONE]\n\n"
	for _, width := range []int{1, 2, 7, 4096} { // 相同输入按不同网络分块读取。
		decoder := NewChatDecoder(&chunkReader{reader: strings.NewReader(input), width: width}) // 直接复用任意 io.Reader。
		chunk, err := decoder.Next()                                                            // 首块允许空字符串，且与 null 区分。
		if err != nil || chunk.Choices[0].Delta.Role == nil || *chunk.Choices[0].Delta.Content != "" || chunk.Usage != nil {
			t.Fatalf("first chunk: %#v %v", chunk, err)
		}
		chunk, err = decoder.Next()
		if err != nil || *chunk.Choices[0].Delta.Content != "你好" || !strings.Contains(string(chunk.Raw), "future_field") {
			t.Fatalf("text chunk: %#v %v", chunk, err)
		}
		chunk, err = decoder.Next()
		if err != nil || chunk.Choices[0].Delta.Content != nil || *chunk.Choices[0].Delta.Refusal != "拒绝片段" {
			t.Fatalf("null/refusal chunk: %#v %v", chunk, err)
		}
		chunk, err = decoder.Next()
		if err != nil || *chunk.Choices[0].FinishReason != "stop" {
			t.Fatalf("finish chunk: %#v %v", chunk, err)
		}
		chunk, err = decoder.Next() // finish_reason 后必须继续接受 usage。
		if err != nil || len(chunk.Choices) != 0 || chunk.Usage == nil || chunk.Usage.TotalTokens != 5 || !json.Valid(chunk.Usage.CompletionTokensDetails) {
			t.Fatalf("usage chunk: %#v %v", chunk, err)
		}
		for repeat := 0; repeat < 2; repeat++ { // DONE 后重复读取也必须正常结束。
			if chunk, err := decoder.Next(); chunk != nil || err != io.EOF {
				t.Fatalf("done: %#v %v", chunk, err)
			}
		}
	}
}

// TestChatDecoderToolFragments 保留多 choice、多工具索引以及尚未组成 JSON 的参数片段。
func TestChatDecoderToolFragments(t *testing.T) {
	input := chatEvent(`[{"index":1,"delta":{"tool_calls":[{"index":3,"id":"call_1","type":"function","function":{"name":"weather","arguments":"{\"city\":"}}]},"finish_reason":null},{"index":0,"delta":{"content":"同时返回文字"},"finish_reason":null}]`, "") +
		chatEvent(`[{"index":1,"delta":{"tool_calls":[{"index":3,"function":{"arguments":"\"上海\"}"}},{"index":0,"id":"call_2","function":{"name":"clock","arguments":"{}"}}]},"finish_reason":"tool_calls"}]`, "") +
		"data:[DONE]\n\n" // 工具结束块也要继续读到 DONE。
	decoder := NewChatDecoder(strings.NewReader(input)) // 不强行合并候选或执行工具。
	chunk, err := decoder.Next()                        // 第一个片段的 arguments 是不完整 JSON。
	if err != nil {
		t.Fatal(err)
	}
	first := chunk.Choices[0] // 数组位置 0 对应 choice 编号 1。
	if first.Index != 1 || first.Delta.ToolCalls[0].Index != 3 || *first.Delta.ToolCalls[0].Function.Arguments != `{"city":` {
		t.Fatalf("first tool fragment: %#v", first)
	}
	chunk, err = decoder.Next()
	if err != nil || chunk.Choices[0].Delta.ToolCalls[0].ID != nil || len(chunk.Choices[0].Delta.ToolCalls) != 2 {
		t.Fatalf("continuation: %#v %v", chunk, err)
	}
	arguments := *first.Delta.ToolCalls[0].Function.Arguments + *chunk.Choices[0].Delta.ToolCalls[0].Function.Arguments // 仅在调用方按索引拼接后解码。
	if !json.Valid([]byte(arguments)) || arguments != `{"city":"上海"}` {
		t.Fatalf("arguments=%q", arguments)
	}
}

// TestChatDecoderErrors 检查缺 DONE、错误信封、错误 JSON、非流式响应和底层错误。
func TestChatDecoderErrors(t *testing.T) {
	cases := []struct {
		name  string // 场景名称。
		input string // 原始 SSE。
		want  error  // 期望可通过 errors.Is 匹配的错误。
	}{
		{"empty", "", io.ErrUnexpectedEOF},
		{"partial", "data:{", io.ErrUnexpectedEOF},
		{"invalid_json", "data:{\n\n", ErrInvalidChatChunk},
		{"null", "data:null\n\n", ErrInvalidChatChunk},
		{"array", "data:[]\n\n", ErrInvalidChatChunk},
		{"wrong_object", "data:{\"object\":\"chat.completion\"}\n\n", ErrInvalidChatChunk},
		{"null_choices", chatEvent("null", ""), ErrInvalidChatChunk},
		{"empty_data", "data:\n\n", ErrInvalidChatChunk},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			decoder := NewChatDecoder(strings.NewReader(tc.input)) // 错误必须终止读取。
			chunk, err := decoder.Next()
			if chunk != nil || !errors.Is(err, tc.want) {
				t.Fatalf("got %#v %v, want %v", chunk, err, tc.want)
			}
			if _, nextErr := decoder.Next(); nextErr != err {
				t.Fatalf("terminal changed: %v -> %v", err, nextErr)
			}
		})
	}
	decoder := NewChatDecoder(strings.NewReader(chatEvent(`[{"index":0,"delta":{},"finish_reason":"length"}]`, ""))) // 即使出现结束原因也不能省略 DONE。
	if _, err := decoder.Next(); err != nil {
		t.Fatal(err)
	}
	if _, err := decoder.Next(); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("missing DONE: %v", err)
	}
	decoder = NewChatDecoder(strings.NewReader("data:{\"error\":{\"message\":\"quota exceeded\",\"type\":\"quota\",\"code\":\"quota_limit\",\"param\":null}}\n\n"))
	_, err := decoder.Next() // 流内错误通过 errors.As 提取细节。
	var apiErr *APIError     // 提取错误信封。
	if !errors.As(err, &apiErr) || apiErr.Message != "quota exceeded" || apiErr.Error() != "chat completions: quota exceeded" {
		t.Fatalf("API error: %v", err)
	}
	failure := errors.New("network failed") // 网络错误应保留，不被转成 JSON 错误。
	decoder = NewChatDecoder(&finalErrorReader{err: failure})
	if _, err := decoder.Next(); !errors.Is(err, failure) {
		t.Fatalf("network error: %v", err)
	}
	decoder = NewChatDecoderWithConfig(strings.NewReader("data:123456\n\n"), Config{MaxLineBytes: 5})
	if _, err := decoder.Next(); !errors.Is(err, ErrLineTooLarge) {
		t.Fatalf("size limit: %v", err)
	}
}
