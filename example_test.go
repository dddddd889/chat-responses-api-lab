package sse_test

import (
	"fmt"
	"io"
	"strings"

	"sse"
)

// ExampleDecoder_Next 展示流式读取；实际调用时将 strings.NewReader 替换为 resp.Body。
func ExampleDecoder_Next() {
	decoder := sse.NewDecoder(strings.NewReader("event:delta\ndata:你好\n\ndata:[DONE]\n\n")) // 直接接收 io.Reader。
	for {
		event, err := decoder.Next() // 每次拿到完整 SSE 事件。
		if err == io.EOF {
			break
		}
		if err != nil {
			fmt.Println("读取失败:", err)
			return
		}
		if event.Data == "[DONE]" {
			break // 结束标记属于上游约定，解析器本身不特殊处理。
		}
		fmt.Println(event.Type, event.Data)
	}
	// Output: delta 你好
}

// ExampleChatDecoder_Next 展示标准 Chat Completions 的增量读取与自动识别 DONE。
func ExampleChatDecoder_Next() {
	input := "data: " + `{"id":"chatcmpl-example","object":"chat.completion.chunk","created":123,"model":"test-model","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}` + "\n\ndata: [DONE]\n\n" // 模拟标准上游字节。
	decoder := sse.NewChatDecoder(strings.NewReader(input))                                                                                                                                                            // 真实请求直接使用 resp.Body。
	for {
		chunk, err := decoder.Next() // JSON 已解码，DONE 自动转成正常 EOF。
		if err == io.EOF {
			break
		}
		if err != nil {
			fmt.Println("读取失败:", err)
			return
		}
		for _, choice := range chunk.Choices { // 最终用量块允许没有候选。
			if choice.Delta.Content != nil {
				fmt.Print(*choice.Delta.Content)
			}
		}
	}
	// Output: 你好
}

// ExampleChatDecoder_Collect 展示一次得到候选的全文、工具参数以及最终 usage。
func ExampleChatDecoder_Collect() {
	// input 模拟两个工具参数片段和一个位于结束原因之后的用量块。
	input := `data: {"id":"example","model":"test-model","object":"chat.completion.chunk","created":123,"choices":[{"index":2,"delta":{"content":"正在","tool_calls":[{"index":4,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{\"city\":"}}]}}]}

data: {"id":"example","model":"test-model","object":"chat.completion.chunk","created":123,"choices":[{"index":2,"delta":{"content":"查询","tool_calls":[{"index":4,"function":{"arguments":"\"上海\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"example","model":"test-model","object":"chat.completion.chunk","created":123,"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}

data: [DONE]

`
	decoder := sse.NewChatDecoder(strings.NewReader(input)) // 实际使用时换成 resp.Body。
	result, err := decoder.Collect()                        // 自动读取和拼接到 DONE。
	if err != nil {
		fmt.Println("读取失败:", err)
		return
	}
	answer := result.Choices[2] // 根据实际 choice.index 直接取结果。
	tool := answer.ToolCalls[4] // 在候选内部按工具 index 取参数。
	fmt.Println(answer.Content)
	fmt.Println(tool.Function.Name, tool.Function.Arguments)
	fmt.Println(result.Usage.TotalTokens)
	// Output:
	// 正在查询
	// weather {"city":"上海"}
	// 30
}
