// offline 为无法可靠由模型触发的异常场景生成独立证据，明确标注合成来源。
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"sse"
)

// offlineCase 描述一个独立输入及预期的错误类别。
type offlineCase struct {
	name     string     // 独立目录名称。
	protocol string     // 使用哪种协议解码。
	input    string     // 原始合成 SSE 输入。
	want     error      // nil 表示预期成功，非 nil 要求 errors.Is 匹配。
	config   sse.Config // 测试特定的行、事件或总预算。
	failKind string     // 在 raw/sse/event/result 写入时模拟磁盘故障。
}

// faultWriter 只让指定类型写入失败，已记录的原始字节仍保留在文件。
type faultWriter struct {
	file io.Writer // 当前场景实际日志文件。
	kind string    // 需要模拟失败的 JSONL 记录类型。
}

// Write 为日志失败路径提供确定性复现，避免操作真实磁盘容量或权限。
func (w faultWriter) Write(data []byte) (int, error) {
	if w.kind == "raw" {
		return 0, os.ErrPermission
	} // 纯 SSE 模式直接模拟原始日志写失败。
	if w.kind != "" && bytes.Contains(data, []byte(`"kind":"`+w.kind+`"`)) {
		return 0, os.ErrPermission
	}
	return w.file.Write(data)
}

// chatFrame 构造单个标准 Chat 增量块。
func chatFrame(choices string) string {
	return `data:{"id":"offline","model":"offline","created":1,"object":"chat.completion.chunk","choices":` + choices + "}\n\n"
}

// responseFrame 构造带类型和序号的 Responses 事件。
func responseFrame(sequence int, fields string) string {
	var event map[string]json.RawMessage // 只用于构造测试输入，不经过第三方包。
	if err := json.Unmarshal([]byte(fields), &event); err != nil {
		panic(err)
	}
	event["sequence_number"] = json.RawMessage(fmt.Sprint(sequence))
	data, _ := json.Marshal(event)
	return "event:" + strings.Trim(string(event["type"]), `"`) + "\ndata:" + string(data) + "\n\n"
}

// offlineScenarios 枚举当前解析器支持的正常边界和可确定触发的故障类别。
func offlineScenarios() []offlineCase {
	chatOK := chatFrame(`[{"index":0,"delta":{"content":"你好😀"},"finish_reason":"stop"}]`) + "data:[DONE]\n\n" // 完整基准输入。
	responseOK := responseFrame(0, `{"type":"response.completed","response":{"id":"offline","status":"completed","output":[{"id":"msg","type":"message","content":[{"type":"output_text","text":"你好😀"}]}],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`)
	cases := []offlineCase{
		{name: "chat-valid", protocol: "chat", input: chatOK},
		{name: "chat-no-done", protocol: "chat", input: strings.Replace(chatOK, "data:[DONE]\n\n", "", 1), want: io.ErrUnexpectedEOF},
		{name: "chat-partial-frame", protocol: "chat", input: "data:{", want: io.ErrUnexpectedEOF},
		{name: "chat-invalid-json", protocol: "chat", input: "data:{bad}\n\n", want: sse.ErrInvalidChatChunk},
		{name: "chat-missing-choice-index", protocol: "chat", input: chatFrame(`[{"delta":{"content":"bad"}}]`), want: sse.ErrInvalidChatChunk},
		{name: "chat-null-choice-index", protocol: "chat", input: chatFrame(`[{"index":null,"delta":{}}]`), want: sse.ErrInvalidChatChunk},
		{name: "chat-negative-index", protocol: "chat", input: chatFrame(`[{"index":-1,"delta":{}}]`), want: sse.ErrInvalidChatChunk},
		{name: "chat-missing-tool-index", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{"tool_calls":[{"id":"bad"}]}}]`), want: sse.ErrInvalidChatChunk},
		{name: "chat-done-only", protocol: "chat", input: "data:[DONE]\n\n", want: sse.ErrIncompleteChatCompletion},
		{name: "chat-no-finish", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{"content":"half"}}]`) + "data:[DONE]\n\n", want: sse.ErrIncompleteChatCompletion},
		{name: "chat-incomplete-tool", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{"tool_calls":[{"index":0}]},"finish_reason":"tool_calls"}]`) + "data:[DONE]\n\n", want: sse.ErrIncompleteChatCompletion},
		{name: "chat-after-finish", protocol: "chat", input: strings.Replace(chatOK, "data:[DONE]\n\n", chatFrame(`[{"index":0,"delta":{"content":"bad"}}]`)+"data:[DONE]\n\n", 1), want: sse.ErrInvalidChatDelta},
		{name: "chat-duplicate-choice", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{}},{"index":0,"delta":{}}]`), want: sse.ErrInvalidChatDelta},
		{name: "chat-total-budget", protocol: "chat", input: chatOK, config: sse.Config{MaxTotalBytes: 1}, want: sse.ErrChatTooLarge},
		{name: "chat-line-limit", protocol: "chat", input: chatOK, config: sse.Config{MaxLineBytes: 8}, want: sse.ErrLineTooLarge},
		{name: "chat-event-limit", protocol: "chat", input: chatOK, config: sse.Config{MaxEventBytes: 8}, want: sse.ErrEventTooLarge},
		{name: "chat-multiple-choices-tools", protocol: "chat", input: chatFrame(`[{"index":2,"delta":{"content":"候选2","tool_calls":[{"index":3,"id":"a","type":"function","function":{"name":"f","arguments":"{"}}]}},{"index":0,"delta":{"content":"候选0","tool_calls":[{"index":3,"id":"b","type":"function","function":{"name":"g","arguments":"{"}}]}}]`) + chatFrame(`[{"index":0,"delta":{"content":"完成","tool_calls":[{"index":3,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"},{"index":2,"delta":{"content":"完成","tool_calls":[{"index":3,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]`) + "data:[DONE]\n\n"},
		{name: "chat-empty-text", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{"content":""},"finish_reason":"stop"}]`) + "data:[DONE]\n\n"},
		{name: "chat-refusal", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{"refusal":"无法回答"},"finish_reason":"content_filter"}]`) + "data:[DONE]\n\n"},
		{name: "chat-length", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{"content":"部分结果"},"finish_reason":"length"}]`) + "data:[DONE]\n\n"},
		{name: "chat-legacy-function", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{"function_call":{"name":"old","arguments":"{}"}},"finish_reason":"function_call"}]`) + "data:[DONE]\n\n"},
		{name: "chat-over-64k", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{"content":"`+strings.Repeat("大", 24000)+`"},"finish_reason":"stop"}]`) + "data:[DONE]\n\n"},
		{name: "chat-invalid-utf8", protocol: "chat", input: "data:\xff\n\n", want: sse.ErrInvalidUTF8},
		{name: "chat-conflicting-tool-id", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"a"}]}}]`) + chatFrame(`[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"b"}]}}]`), want: sse.ErrInvalidChatDelta},
		{name: "chat-unknown-finish", protocol: "chat", input: chatFrame(`[{"index":0,"delta":{},"finish_reason":"unknown"}]`) + "data:[DONE]\n\n", want: sse.ErrIncompleteChatCompletion},
		{name: "responses-valid", protocol: "responses", input: responseOK},
		{name: "responses-no-terminal", protocol: "responses", input: responseFrame(0, `{"type":"response.created","response":{"id":"offline","status":"in_progress","output":[]}}`), want: io.ErrUnexpectedEOF},
		{name: "responses-incomplete", protocol: "responses", input: responseFrame(0, `{"type":"response.incomplete","response":{"id":"offline","status":"incomplete","output":[],"incomplete_details":{"reason":"max_output_tokens"}}}`), want: sse.ErrResponseIncomplete},
		{name: "responses-failed", protocol: "responses", input: responseFrame(0, `{"type":"response.failed","response":{"id":"offline","status":"failed","output":[],"error":{"message":"simulated","code":"server_error"}}}`), want: sse.ErrResponseFailed},
		{name: "responses-invalid-json", protocol: "responses", input: "data:{bad}\n\n", want: sse.ErrInvalidResponseEvent},
		{name: "responses-wrong-terminator", protocol: "responses", input: "data:[DONE]\n\n", want: sse.ErrInvalidResponseEvent},
		{name: "responses-missing-index", protocol: "responses", input: responseFrame(0, `{"type":"response.output_text.delta","item_id":"msg","content_index":0,"delta":"bad"}`), want: sse.ErrInvalidResponseEvent},
		{name: "responses-no-sequence", protocol: "responses", input: "data:{\"type\":\"response.future\"}\n\n", want: sse.ErrInvalidResponseEvent},
		{name: "responses-repeated-sequence", protocol: "responses", input: responseFrame(0, `{"type":"response.future"}`) + responseOK, want: sse.ErrInvalidResponseEvent},
		{name: "responses-event-mismatch", protocol: "responses", input: strings.Replace(responseOK, "event:response.completed", "event:wrong", 1), want: sse.ErrInvalidResponseEvent},
		{name: "responses-unknown-event", protocol: "responses", input: responseFrame(0, `{"type":"response.future","extra":true}`) + responseFrame(1, `{"type":"response.completed","response":{"id":"offline","status":"completed","output":[]}}`)},
		{name: "responses-total-budget", protocol: "responses", input: responseOK, config: sse.Config{MaxTotalBytes: 1}, want: sse.ErrResponseTooLarge},
		{name: "responses-missing-content-index", protocol: "responses", input: responseFrame(0, `{"type":"response.output_text.delta","output_index":0,"item_id":"msg","delta":"bad"}`), want: sse.ErrInvalidResponseEvent},
		{name: "responses-completed-wrong-status", protocol: "responses", input: responseFrame(0, `{"type":"response.completed","response":{"id":"offline","status":"in_progress","output":[]}}`), want: sse.ErrInvalidResponseEvent},
		{name: "responses-unknown-item", protocol: "responses", input: responseFrame(0, `{"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg","delta":"bad"}`), want: sse.ErrInvalidResponseEvent},
		{name: "responses-empty-output", protocol: "responses", input: responseFrame(0, `{"type":"response.completed","response":{"id":"offline","status":"completed","output":[]}}`)},
		{name: "responses-function-done-replacement", protocol: "responses", input: responseFrame(0, `{"type":"response.output_item.added","output_index":0,"item":{"id":"fc","type":"function_call","call_id":"call","name":"f","arguments":""}}`) + responseFrame(1, `{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc","delta":"{"}`) + responseFrame(2, `{"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc","arguments":"{\"a\":1}"}`) + responseFrame(3, `{"type":"response.completed","response":{"id":"offline","status":"completed","output":[{"id":"fc","type":"function_call","call_id":"call","name":"f","arguments":"{\"a\":1}"}]}}`)},
	}
	for _, protocol := range []string{"chat", "responses"} {
		input := chatOK // 对同一日志机制运行两种模式。
		if protocol == "responses" {
			input = responseOK
		}
		for _, ending := range []struct{ name, value string }{{"crlf", "\r\n"}, {"cr", "\r"}} {
			cases = append(cases, offlineCase{name: protocol + "-" + ending.name, protocol: protocol, input: "\ufeff" + strings.ReplaceAll(input, "\n", ending.value)})
		}
		for _, kind := range []string{"raw", "sse", "event", "result"} {
			cases = append(cases, offlineCase{name: protocol + "-log-" + kind + "-failure", protocol: protocol, input: input, failKind: kind, want: sse.ErrStreamLogWrite})
		}
	}
	return cases
}

// runOffline 为所有合成场景各写 input.sse、events.jsonl、result.json 和预期说明。
func runOffline(root string) ([]report, error) {
	var reports []report // 汇总明确标记 offline，不能充当真实模型证据。
	for _, current := range offlineScenarios() {
		directory := filepath.Join(root, current.name)
		if err := os.Mkdir(directory, 0700); err != nil {
			return reports, err
		}
		if err := os.WriteFile(filepath.Join(directory, "input.sse"), []byte(current.input), 0600); err != nil {
			return reports, err
		}
		path := filepath.Join(directory, "events.jsonl") // 每个异常场景独占日志。
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return reports, err
		}
		config := current.config // 保留场景设定的大小限制。
		config.LogWriter = faultWriter{file: file, kind: current.failKind}
		config.LogFormat = "jsonl"
		if current.failKind == "raw" {
			config.LogFormat = "raw"
		} // 纯 SSE 日志仍可独立选择。
		var result any    // 按协议保存具体对象。
		var readErr error // 实际观察到的错误。
		if current.protocol == "chat" {
			result, readErr = sse.NewChatDecoderWithConfig(strings.NewReader(current.input), config).Collect()
		} else {
			result, readErr = sse.NewResponseDecoderWithConfig(strings.NewReader(current.input), config).Collect()
		}
		if err := file.Close(); err != nil {
			return reports, err
		}
		if err := saveJSON(filepath.Join(directory, "result.json"), result); err != nil {
			return reports, err
		}
		entry := report{Name: current.name, Source: "offline", Protocol: current.protocol, Log: path, Status: "passed"} // 验证实际错误类别而非错误字符串。
		if !errors.Is(readErr, current.want) {
			entry.Status = "failed"
		}
		entry.Detail = fmt.Sprintf("expected=%v actual=%v", current.want, readErr)
		if err := saveJSON(filepath.Join(directory, "expectation.json"), entry); err != nil {
			return reports, err
		}
		reports = append(reports, entry)
		fmt.Printf("%s %s %s\n", entry.Name, entry.Status, entry.Log)
	}
	return reports, nil
}
