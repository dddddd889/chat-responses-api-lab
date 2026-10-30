package sse

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// loggedBusiness 解码第三层，并检查每条来源序号确实指向第一层事件。
func loggedBusiness(t *testing.T, data []byte) []BusinessEvent {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data)) // 三层记录在同一个 JSONL 文件中交错出现。
	sources := map[uint64]bool{}                      // 不把物理日志行号误当成 SSE 事件号。
	var events []BusinessEvent
	var final StreamLogRecord
	for {
		var record StreamLogRecord
		if err := decoder.Decode(&record); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		switch record.Kind {
		case "sse":
			if record.EventIndex != uint64(len(sources)+1) {
				t.Fatal("SSE ordinal is not contiguous")
			}
			sources[record.EventIndex] = true
		case "event":
			if record.EventIndex > 0 && !sources[record.EventIndex] {
				t.Fatalf("unknown source: %#v", record)
			}
			var event BusinessEvent
			if err := json.Unmarshal(record.Object, &event); err != nil {
				t.Fatal(err)
			}
			events = append(events, event)
		case "result":
			final = record
		default:
			t.Fatalf("unexpected log layer: %s", record.Kind)
		}
	}
	if final.Kind != "result" || final.FirstEventIndex != 1 || final.LastEventIndex != uint64(len(sources)) {
		t.Fatalf("invalid result range: %#v", final)
	}
	return events
}

// TestBusinessChatInterleaved 不同候选使用相同工具 index，交错增量也必须各自生成正确完整参数。
func TestBusinessChatInterleaved(t *testing.T) {
	input := chatEvent(`[{"index":2,"delta":{"tool_calls":[{"index":3,"id":"a","type":"function","function":{"name":"weather","arguments":"{\"city\":"}}]}},{"index":0,"delta":{"tool_calls":[{"index":3,"id":"b","type":"function","function":{"name":"weather","arguments":"{\"city\":"}}]}}]`, "") + chatEvent(`[{"index":0,"delta":{"tool_calls":[{"index":3,"function":{"arguments":"\"北京\"}"}}]},"finish_reason":"tool_calls"},{"index":2,"delta":{"tool_calls":[{"index":3,"function":{"arguments":"\"上海\"}"}}]},"finish_reason":"tool_calls"}]`, "") + chatEvent(`[]`, `,"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}`) + "data:[DONE]\n\n"
	var log bytes.Buffer
	result, err := NewChatDecoderWithConfig(strings.NewReader(input), Config{LogWriter: &log, LogFormat: "jsonl"}).Collect()
	if err != nil {
		t.Fatal(err)
	}
	events := loggedBusiness(t, log.Bytes())
	starts, ends, usage, done := 0, 0, 0, 0 // 同一个工具的 delta、finish 不应重复生成开始事件。
	for _, event := range events {
		switch event.Type {
		case "tool_start":
			starts++
		case "tool_done":
			ends++
			expected := result.Choices[*event.ChoiceIndex].ToolCalls[*event.ToolIndex]
			if event.CallID != expected.ID || event.Arguments == nil || *event.Arguments != expected.Function.Arguments {
				t.Fatalf("wrong tool: %#v", event)
			}
		case "usage":
			usage++
			if event.Usage.InputTokens != 2 || event.Usage.OutputTokens != 3 || event.Usage.TotalTokens != 5 {
				t.Fatalf("usage not normalized: %#v", event)
			}
		case "done":
			done++
		}
	}
	if starts != 2 || ends != 2 || usage != 1 || done != 1 {
		t.Fatalf("counts %d %d %d %d", starts, ends, usage, done)
	}
}

// TestBusinessResponsesToolDone 参数 done、item done、response completed 中的全文不能变成三次完成。
func TestBusinessResponsesToolDone(t *testing.T) {
	input := responseFrames(responseStart,
		`{"type":"response.output_item.added","output_index":0,"item":{"id":"fc","type":"function_call","call_id":"call","name":"weather","arguments":""}}`,
		`{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc","delta":"{\"city\":"}`,
		`{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc","delta":"\"上海\"}"}`,
		`{"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc","arguments":"{\"city\":\"上海\"}"}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"id":"fc","type":"function_call","status":"completed","call_id":"call","name":"weather","arguments":"{\"city\":\"上海\"}"}}`,
		`{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"id":"fc","type":"function_call","status":"completed","call_id":"call","name":"weather","arguments":"{\"city\":\"上海\"}"}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}`)
	var log bytes.Buffer
	_, err := NewResponseDecoderWithConfig(strings.NewReader(input), Config{LogWriter: &log, LogFormat: "jsonl"}).Collect()
	if err != nil {
		t.Fatal(err)
	}
	events := loggedBusiness(t, log.Bytes())
	starts, ends, usage := 0, 0, 0
	var arguments strings.Builder // 仅拼第三层的 delta，与 tool_done 全文核对。
	for _, event := range events {
		switch event.Type {
		case "tool_start":
			starts++
		case "tool_arguments_delta":
			arguments.WriteString(*event.Delta)
		case "tool_done":
			ends++
			if event.CallID != "call" || event.ItemID != "fc" || event.Arguments == nil || *event.Arguments != arguments.String() {
				t.Fatalf("wrong tool: %#v", event)
			}
		case "usage":
			usage++
			if event.Usage.TotalTokens != 5 {
				t.Fatal("usage changed")
			}
		}
	}
	if starts != 1 || ends != 1 || usage != 1 || arguments.String() != `{"city":"上海"}` {
		t.Fatalf("duplicates: %d %d %d %s", starts, ends, usage, arguments.String())
	}
}

// TestBusinessPartialError 断流时允许保留增量，但不能发出请求 done 或未完成工具的 tool_done。
func TestBusinessPartialError(t *testing.T) {
	input := chatEvent(`[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"f","arguments":"{"}}]}}]`, "")
	var log bytes.Buffer
	_, err := NewChatDecoderWithConfig(strings.NewReader(input), Config{LogWriter: &log, LogFormat: "jsonl"}).Collect()
	if err == nil {
		t.Fatal("missing DONE accepted")
	}
	events := loggedBusiness(t, log.Bytes())
	errors := 0
	for _, event := range events {
		if event.Type == "done" || event.Type == "tool_done" {
			t.Fatalf("false success: %#v", event)
		}
		if event.Type == "error" {
			errors++
		}
	}
	if errors != 1 {
		t.Fatalf("errors=%d", errors)
	}
}
