package sse

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

// TestObjectLogs 两种协议按完整事件记录上游 JSON、合并结果和统一业务事件，网络分块不影响日志内容。
func TestObjectLogs(t *testing.T) {
	for _, protocol := range []string{"chat", "responses"} {
		input := responseFrames(responseStart, responseTextItem, responseTextDelta, responseComplete) // Responses 正常流。
		if protocol == "chat" {
			input = chatEvent(`[{"index":0,"delta":{"content":"你好"},"finish_reason":"stop"}]`, `,"usage":{"total_tokens":3}`) + "data:[DONE]\n\n"
		}
		for _, width := range []int{1, 4096} { // 单字节读取也必须组成完整 UTF-8 事件再记录。
			var log bytes.Buffer // 同一目的地承载三种记录。
			config := Config{LogWriter: &log, LogFormat: "jsonl"}
			reader := &chunkReader{reader: strings.NewReader(input), width: width} // 模拟两种网络分块。
			if protocol == "chat" {
				if _, err := NewChatDecoderWithConfig(reader, config).Collect(); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := NewResponseDecoderWithConfig(reader, config).Collect(); err != nil {
					t.Fatal(err)
				}
			}
			decoder := json.NewDecoder(bytes.NewReader(log.Bytes())) // 每条都是独立 JSON 对象。
			counts := map[string]int{}                               // 校验 sse/event/result 三层都出现。
			for {
				var record StreamLogRecord // 不把 object 再解析成 JSON 字符串。
				if err := decoder.Decode(&record); err == io.EOF {
					break
				} else if err != nil {
					t.Fatal(err)
				}
				counts[record.Kind]++
				if record.Protocol != protocol || (record.Kind != "sse" && !json.Valid(record.Object)) || (record.Kind == "sse" && len(record.Object) == 0 && record.Data == nil) {
					t.Fatalf("invalid object: %#v", record)
				}
				if record.Kind == "result" && (record.Status != "complete" || record.Error != "") {
					t.Fatalf("invalid result status: %#v", record)
				}
			}
			if counts["raw"] != 0 || counts["parsed"] != 0 || counts["sse"] == 0 || counts["event"] == 0 || counts["result"] != 1 {
				t.Fatalf("counts=%v", counts)
			}
			restored, err := io.ReadAll(NewLogReplayReader(bytes.NewReader(log.Bytes()))) // 必须逐字节恢复原始流。
			if err != nil || canonicalFrames(t, string(restored)) != canonicalFrames(t, input) {
				t.Fatalf("replay differs: %v", err)
			}
		}
	}
}

// selectiveLogWriter 只在指定结构化记录出现时失败，检验日志错误不会被终止信号吞掉。
type selectiveLogWriter struct {
	kind string /* 需要模拟失败的记录类型。 */
}

// Write 按记录类型返回固定磁盘错误。
func (w selectiveLogWriter) Write(data []byte) (int, error) {
	if bytes.Contains(data, []byte(`"kind":"`+w.kind+`"`)) {
		return 0, os.ErrPermission
	}
	return len(data), nil
}

// TestObjectLogErrors 三层任一写失败都必须返回错误，并保留部分结果。
func TestObjectLogErrors(t *testing.T) {
	for _, protocol := range []string{"chat", "responses"} {
		for _, kind := range []string{"sse", "event", "result"} {
			config := Config{LogWriter: selectiveLogWriter{kind: kind}, LogFormat: "jsonl"} // 模拟日志的特定阶段失败。
			var err error                                                                   // 不同协议保持统一日志错误类型。
			if protocol == "chat" {
				_, err = NewChatDecoderWithConfig(strings.NewReader(chatEvent(`[{"index":0,"delta":{},"finish_reason":"stop"}]`, "")+"data:[DONE]\n\n"), config).Collect()
			} else {
				_, err = NewResponseDecoderWithConfig(strings.NewReader(responseFrames(responseComplete)), config).Collect()
			}
			if !errors.Is(err, ErrStreamLogWrite) || !errors.Is(err, os.ErrPermission) {
				t.Fatalf("protocol=%s kind=%s err=%v", protocol, kind, err)
			}
		}
	}
	config := Config{LogWriter: selectiveLogWriter{kind: "result"}, LogFormat: "jsonl"} // 同时发生断流和结果日志写失败。
	_, err := NewChatDecoderWithConfig(strings.NewReader(""), config).Collect()
	if !errors.Is(err, io.ErrUnexpectedEOF) || !errors.Is(err, ErrStreamLogWrite) || !strings.Contains(err.Error(), "logging result") {
		t.Fatalf("combined error lost: %v", err)
	}
	var log bytes.Buffer // 断流结果必须标为 partial，而不是 complete。
	_, err = NewResponseDecoderWithConfig(strings.NewReader(responseFrames(responseStart, responseTextItem, responseTextDelta)), Config{LogWriter: &log, LogFormat: "jsonl"}).Collect()
	if !errors.Is(err, io.ErrUnexpectedEOF) || !bytes.Contains(log.Bytes(), []byte(`"status":"partial"`)) || !bytes.Contains(log.Bytes(), []byte("你好")) {
		t.Fatalf("partial log missing: %v", err)
	}
}

// TestLogReplayFormats 原始 SSE、JSONL 和错误日志都按明确规则处理。
func TestLogReplayFormats(t *testing.T) {
	for _, input := range []string{"data:a\n\n", "", ": ping\n\n"} {
		data, err := io.ReadAll(NewLogReplayReader(strings.NewReader(input)))
		if err != nil || string(data) != input {
			t.Fatalf("raw replay: %v", err)
		}
	}
	for _, input := range []string{`{"kind":"unknown"}`, `{"kind":"raw","raw_base64":"bad!"}`, `{broken`, `{"kind":"sse"}`, `{"kind":"sse","event":"bad\nevent","object":{}}`} {
		if _, err := io.ReadAll(NewLogReplayReader(strings.NewReader(input))); err == nil {
			t.Fatalf("invalid log accepted: %s", input)
		}
	}
	reader := NewLogReplayReader(strings.NewReader(`{"kind":"raw","raw":"data:a\n\n"}`)) // 零长度读取不能消耗日志。
	if n, err := reader.Read(nil); n != 0 || err != nil {
		t.Fatalf("zero read: %d %v", n, err)
	}
}

// canonicalFrames 忽略心跳注释和 JSON 排版，只比较实际 SSE 事件及其完整 JSON 数据。
func canonicalFrames(t *testing.T, input string) string {
	t.Helper()
	decoder := NewDecoder(strings.NewReader(input)) // 独立校验日志回放语义，不依赖 JSONL 序列化方式。
	var result strings.Builder                      // 每条完整事件独立比较。
	for {
		event, err := decoder.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data := event.Data
		if json.Valid([]byte(data)) {
			var compact bytes.Buffer
			_ = json.Compact(&compact, []byte(data))
			data = compact.String()
		}
		result.WriteString(event.Type + "|" + event.ID + "|" + data + "\n")
	}
	return result.String()
}

// TestSSELogPreservesWireJSON 确保类型化前的事件完整保留未知字段、缺省状态和大整数。
func TestSSELogPreservesWireJSON(t *testing.T) {
	input := chatEvent(`[{"index":0,"delta":{"content":"甲"},"finish_reason":"stop"}]`, `,"future":{"large":9007199254740993},"usage":{"total_tokens":3}`) + "data:[DONE]\n\n" // 缺省字段不能变成 null。
	var log bytes.Buffer
	_, err := NewChatDecoderWithConfig(strings.NewReader(input), Config{LogWriter: &log, LogFormat: "jsonl"}).Collect()
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&log)
	var record StreamLogRecord // 第一条就是完整 JSON 事件，已经没有网络 raw 分块。
	if err := decoder.Decode(&record); err != nil {
		t.Fatal(err)
	}
	if record.Kind != "sse" || record.EventIndex != 1 || !bytes.Contains(record.Object, []byte(`9007199254740993`)) || bytes.Contains(record.Object, []byte(`"refusal":null`)) {
		t.Fatalf("wire JSON changed: %s", record.Object)
	}
}

// TestMalformedSSELog 非法 JSON 仍进入第一层；解帧之前就断开的内容不会被伪造为完整事件。
func TestMalformedSSELog(t *testing.T) {
	for _, input := range []string{"data:{bad}\n\n", "data:{bad"} {
		var log bytes.Buffer
		_, err := NewChatDecoderWithConfig(strings.NewReader(input), Config{LogWriter: &log, LogFormat: "jsonl"}).Collect()
		if err == nil {
			t.Fatal("malformed input accepted")
		}
		hasSSE := bytes.Contains(log.Bytes(), []byte(`"kind":"sse"`))
		if hasSSE != strings.HasSuffix(input, "\n\n") || !bytes.Contains(log.Bytes(), []byte(`"status":"partial"`)) {
			t.Fatalf("malformed log: %s", log.String())
		}
	}
}
