package sse

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

// responseFrames 用真实 SSE 帧生成 Responses 测试流，每条事件按顺序赋予序号。
func responseFrames(events ...string) string {
	var stream strings.Builder // 不预先连接大对象。
	for sequence, data := range events {
		var event map[string]json.RawMessage // 测试用原始事件对象。
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			panic(err)
		}
		event["sequence_number"] = json.RawMessage(fmt.Sprint(sequence))
		encoded, _ := json.Marshal(event) // 固定字段输入可被编码。
		fmt.Fprintf(&stream, "event: %s\ndata: %s\n\n", strings.Trim(string(event["type"]), `"`), encoded)
	}
	return stream.String()
}

const (
	// responseStart 是合法响应的起始事件。
	responseStart = `{"type":"response.created","response":{"id":"resp_1","status":"in_progress","output":[]}}`
	// responseTextItem 是正文项目的起始信息。
	responseTextItem = `{"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}`
	// responseTextDelta 是中文增量，用于检验单字节网络分块。
	responseTextDelta = `{"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_1","delta":"你好"}`
	// responseComplete 是带文本、函数调用、扩展字段和用量的权威最终结果。
	responseComplete = `{"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"test","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"你好世界","annotations":[]}]},{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"weather","arguments":"{\"city\":\"上海\"}"}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5,"output_tokens_details":{"reasoning_tokens":1}},"future_field":{"preserved":true}}}`
)

// TestResponseCollect 验证终止信号、文本、工具全文替换以及 usage，避免 delta/done 重复拼接。
func TestResponseCollect(t *testing.T) {
	input := responseFrames(responseStart, responseTextItem, responseTextDelta,
		`{"type":"response.output_text.done","output_index":0,"content_index":0,"item_id":"msg_1","text":"你好世界"}`,
		`{"type":"response.output_item.added","output_index":1,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"weather","arguments":""}}`,
		`{"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"{\"city\":"}`,
		`{"type":"response.function_call_arguments.done","output_index":1,"item_id":"fc_1","arguments":"{\"city\":\"上海\"}"}`,
		responseComplete)
	for _, width := range []int{1, 2, 4096} {
		decoder := NewResponseDecoder(&chunkReader{reader: strings.NewReader(input), width: width}) // 任意分块都应有同样结果。
		result, err := decoder.Collect()
		if err != nil || result.OutputText() != "你好世界" || result.Output[1].Arguments != `{"city":"上海"}` || result.Output[1].CallID != "call_1" || result.Usage.TotalTokens != 5 || !strings.Contains(string(result.Raw), "future_field") {
			t.Fatalf("width=%d result=%#v err=%v", width, result, err)
		}
		if _, err := decoder.Next(); err != io.EOF {
			t.Fatalf("completed not terminal: %v", err)
		}
	}
}

// TestResponseTerminalStates failed/incomplete 与普通 error 都必须可区分，且终止事件能被打印。
func TestResponseTerminalStates(t *testing.T) {
	for _, state := range []string{"failed", "incomplete"} {
		input := responseFrames(responseStart, fmt.Sprintf(`{"type":"response.%s","response":{"id":"resp_1","status":"%s","output":[],"error":{"message":"failed"},"incomplete_details":{"reason":"max_output_tokens"}}}`, state, state))
		result, err := NewResponseDecoder(strings.NewReader(input)).Collect()
		want := ErrResponseFailed // 明确区分未完成与服务失败。
		if state == "incomplete" {
			want = ErrResponseIncomplete
		}
		var terminal *ResponseTerminalError // 上游完整对象仍随错误可取得。
		if !errors.Is(err, want) || !errors.As(err, &terminal) || result.Status != state || terminal.Event.Response.ID != "resp_1" {
			t.Fatalf("state=%s result=%#v err=%v", state, result, err)
		}
	}
	input := responseFrames(`{"type":"error","code":"server_error","message":"failed","param":null}`)
	decoder := NewResponseDecoder(strings.NewReader(input)) // 终止事件先正常返回一次。
	if event, err := decoder.Next(); err != nil || event.Type != "error" {
		t.Fatalf("error event: %#v %v", event, err)
	}
	_, err := decoder.Next()
	var apiErr *APIError // APIError 支持提取服务端信息。
	if !errors.As(err, &apiErr) || apiErr.Message != "failed" {
		t.Fatal(err)
	}
	if _, again := decoder.Next(); again != err {
		t.Fatal("terminal error changed")
	}
}

// TestResponsePartialResults 断流时按 output/content index 排序，并保留 done 的完整字段。
func TestResponsePartialResults(t *testing.T) {
	input := responseFrames(responseStart, responseTextItem,
		`{"type":"response.output_text.delta","output_index":0,"content_index":2,"item_id":"msg_1","delta":"后"}`,
		responseTextDelta,
		`{"type":"response.refusal.delta","output_index":0,"content_index":1,"item_id":"msg_1","delta":"拒"}`,
		`{"type":"response.refusal.done","output_index":0,"content_index":1,"item_id":"msg_1","refusal":"拒绝"}`,
		`{"type":"response.output_item.added","output_index":4,"item":{"id":"fc","type":"function_call","call_id":"call","name":"f","arguments":"{"}}`,
		`{"type":"response.function_call_arguments.delta","output_index":4,"item_id":"fc","delta":"\"a\":1"}`,
		`{"type":"response.function_call_arguments.done","output_index":4,"item_id":"fc","arguments":"{\"a\":1}"}`,
		`{"type":"response.reasoning_text.delta","output_index":9,"item_id":"reasoning","delta":"private"}`)
	result, err := NewResponseDecoder(strings.NewReader(input)).Collect()
	if !errors.Is(err, io.ErrUnexpectedEOF) || result.OutputText() != "你好后" || result.Output[0].Content[1].Refusal != "拒绝" || result.Output[1].Arguments != `{"a":1}` {
		t.Fatalf("partial=%#v err=%v", result, err)
	}
	// output_item.done 自带的完整内容不再次叠加之前的 delta。
	input = responseFrames(responseTextItem, responseTextDelta, `{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","content":[{"type":"output_text","text":"最终"}]}}`)
	result, err = NewResponseDecoder(strings.NewReader(input)).Collect()
	if !errors.Is(err, io.ErrUnexpectedEOF) || result.OutputText() != "最终" {
		t.Fatalf("done replacement: %#v %v", result, err)
	}
}

// TestResponseValidation 对索引、序号、事件类型和生命周期进行严格边界检查。
func TestResponseValidation(t *testing.T) {
	for _, data := range []string{
		`{"type":"response.output_text.delta","item_id":"x","content_index":0,"delta":"a"}`,
		`{"type":"response.output_text.delta","output_index":0,"item_id":"x","delta":"a"}`,
		`{"type":"response.function_call_arguments.delta","output_index":null,"item_id":"x","delta":"a"}`,
		`{"type":"response.output_text.done","output_index":0,"content_index":0,"item_id":"x"}`,
		`{"type":"response.refusal.done","output_index":0,"content_index":0,"item_id":"x"}`,
		`{"type":"response.function_call_arguments.done","output_index":0,"item_id":"x"}`,
		`{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"x"}`,
		`{"type":"response.output_item.added","output_index":-1,"item":{"id":"x","type":"message"}}`,
		`{"type":"response.completed","response":{"id":"x","status":"in_progress","output":[]}}`,
		`{"type":"response.completed","response":{"id":"x","status":"completed"}}`,
		`{"type":"response.created"}`,
		`{"type":"error"}`,
	} {
		decoder := NewResponseDecoder(strings.NewReader(responseFrames(data))) // 缺失字段不能默认归为索引零。
		if _, err := decoder.Next(); !errors.Is(err, ErrInvalidResponseEvent) {
			t.Fatalf("data=%s err=%v", data, err)
		}
	}
	for _, input := range []string{
		"data:[DONE]\n\n",
		"data:{broken}\n\n",
		"data:{\"type\":\"future\"}\n\n",
		"event:wrong\ndata:{\"type\":\"future\",\"sequence_number\":0}\n\n",
		responseFrames(responseStart) + responseFrames(responseTextItem), // 序号从 0 重新开始。
		responseFrames(responseStart, `{"type":"response.in_progress","response":{"id":"other","status":"in_progress"}}`),
	} {
		_, err := NewResponseDecoder(strings.NewReader(input)).Collect()
		if !errors.Is(err, ErrInvalidResponseEvent) {
			t.Fatalf("input=%s err=%v", input, err)
		}
	}
	// 未知事件原样透传，不影响后面的终止响应。
	decoder := NewResponseDecoder(strings.NewReader(responseFrames(`{"type":"response.future","future":true}`, responseComplete)))
	if event, err := decoder.Next(); err != nil || !strings.Contains(string(event.Raw), `"future":true`) {
		t.Fatalf("unknown event: %#v %v", event, err)
	}
	if _, err := decoder.Collect(); err != nil {
		t.Fatal(err)
	}
}

// TestResponseItemOwnership 断流时不把错误 item ID 或非函数项目的参数拼进结果。
func TestResponseItemOwnership(t *testing.T) {
	for _, tail := range []string{
		`{"type":"response.output_text.delta","output_index":1,"content_index":0,"item_id":"missing","delta":"bad"}`,
		`{"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"wrong","delta":"bad"}`,
		`{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"msg_1","delta":"bad"}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"id":"other","type":"message"}}`,
	} {
		result, err := NewResponseDecoder(strings.NewReader(responseFrames(responseTextItem, responseTextDelta, tail))).Collect()
		if !errors.Is(err, ErrInvalidResponseEvent) || result.OutputText() != "你好" {
			t.Fatalf("item ownership: %#v %v", result, err)
		}
	}
}

// TestResponseBudget 总限制包括重复传输的最终全文和未知事件，不依赖最终文本长度。
func TestResponseBudget(t *testing.T) {
	input := responseFrames(responseComplete)
	decoder := NewResponseDecoder(strings.NewReader(input)) // 先拿到实际 JSON 字节长度。
	event, err := decoder.Next()
	if err != nil {
		t.Fatal(err)
	}
	for _, difference := range []int{-1, 0, 1} {
		_, err := NewResponseDecoderWithConfig(strings.NewReader(input), Config{MaxTotalBytes: len(event.Raw) + difference}).Collect()
		if difference < 0 && !errors.Is(err, ErrResponseTooLarge) {
			t.Fatalf("limit not enforced: %v", err)
		}
		if difference >= 0 && err != nil {
			t.Fatalf("exact boundary rejected: %v", err)
		}
	}
	failure := errors.New("connection failed") // 网络错误不能误报为正常 EOF。
	if _, err := NewResponseDecoder(&finalErrorReader{err: failure}).Next(); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if _, err := NewResponseDecoder(nil).Next(); !errors.Is(err, ErrNilReader) {
		t.Fatal(err)
	}
}
