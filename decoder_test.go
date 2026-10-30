package sse

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

// chunkReader 刻意把 UTF-8 字符、字段和 CRLF 拆在不同读取中。
type chunkReader struct {
	reader io.Reader // 真正的数据源。
	width  int       // 单次最多返回的字节数。
}

// Read 限制每次读取大小，用确定性输入复现网络分块。
func (r *chunkReader) Read(buffer []byte) (int, error) {
	if len(buffer) > r.width {
		buffer = buffer[:r.width]
	}
	return r.reader.Read(buffer)
}

// TestDecoderProtocol 用协议结果检查完整事件，并以多个分块大小重复验证。
func TestDecoderProtocol(t *testing.T) {
	cases := []struct {
		name  string  // 场景名称。
		input string  // 原始 SSE 字节。
		want  []Event // 应当收到的完整事件。
	}{
		{"basic", "data: 你好\n\n", []Event{{Type: "message", Data: "你好"}}},
		{"multiple", "data: a\n\ndata:b\n\n", []Event{{Type: "message", Data: "a"}, {Type: "message", Data: "b"}}},
		{"multiline", "data: 你好\ndata: 世界\n\n", []Event{{Type: "message", Data: "你好\n世界"}}},
		{"crlf", "data: 你好\r\ndata: 世界\r\n\r\n", []Event{{Type: "message", Data: "你好\n世界"}}},
		{"cr", "data:a\rdata:b\r\r", []Event{{Type: "message", Data: "a\nb"}}},
		{"mixed", "data:a\r\ndata:b\rdata:c\n\n", []Event{{Type: "message", Data: "a\nb\nc"}}},
		{"empty_data", "data\n\n", []Event{{Type: "message"}}},
		{"empty_data_colon", "data:\n\n", []Event{{Type: "message"}}},
		{"two_empty_data", "data\ndata\n\n", []Event{{Type: "message", Data: "\n"}}},
		{"trailing_empty_data", "data:a\ndata:\n\n", []Event{{Type: "message", Data: "a\n"}}},
		{"spaces", "data:  hello  \n\n", []Event{{Type: "message", Data: " hello  "}}},
		{"tab", "data:\t hello\n\n", []Event{{Type: "message", Data: "\t hello"}}},
		{"first_colon", "data: https://a:b\n\n", []Event{{Type: "message", Data: "https://a:b"}}},
		{"type", "event: delta\ndata:a\n\n", []Event{{Type: "delta", Data: "a"}}},
		{"last_type_wins", "event:a\nevent:b\ndata:c\n\n", []Event{{Type: "b", Data: "c"}}},
		{"empty_type", "event:a\nevent:\ndata:c\n\n", []Event{{Type: "message", Data: "c"}}},
		{"type_reset", "event:a\n\ndata:c\n\n", []Event{{Type: "message", Data: "c"}}},
		{"id_inherits", "id:1\n\ndata:a\n\ndata:b\n\n", []Event{{Type: "message", Data: "a", ID: "1"}, {Type: "message", Data: "b", ID: "1"}}},
		{"id_reset", "id:1\n\nid\ndata:a\n\n", []Event{{Type: "message", Data: "a"}}},
		{"invalid_id_ignored", "id:1\nid:bad\x00id\ndata:a\n\n", []Event{{Type: "message", Data: "a", ID: "1"}}},
		{"heartbeat", ": ping\n\n: another\ndata:a\n\n", []Event{{Type: "message", Data: "a"}}},
		{"unknown_case_sensitive", "Data:ignored\nunknown:x\ndata:a\n\n", []Event{{Type: "message", Data: "a"}}},
		{"bom", "\ufeffdata:你好\n\n", []Event{{Type: "message", Data: "你好"}}},
		{"bom_only_at_start", "data:\ufeffa\n\n\ufeffdata:ignored\n\n", []Event{{Type: "message", Data: "\ufeffa"}}},
		{"done_is_payload", "data:[DONE]\n\n", []Event{{Type: "message", Data: "[DONE]"}}},
		{"empty_stream", "", nil},
		{"blank_stream", "\n\r\n\r", nil},
		{"bom_only", "\ufeff", nil},
		{"comment_only", ": ping\n", nil},
		{"partial_comment", ": ping", nil},
	}
	for _, tc := range cases { // 每个场景都覆盖字符和换行符被拆分的读取方式。
		t.Run(tc.name, func(t *testing.T) {
			for _, width := range []int{1, 2, 3, 7, 4096} { // 小分块和大分块应有完全相同的结果。
				decoder := NewDecoder(&chunkReader{reader: strings.NewReader(tc.input), width: width}) // 被测实例。
				var got []Event                                                                        // 收集实际事件。
				for {
					event, err := decoder.Next() // 读取下一条完整事件。
					if err == io.EOF {
						break
					}
					if err != nil {
						t.Fatalf("width=%d: %v", width, err)
					}
					got = append(got, event)
				}
				if !reflect.DeepEqual(got, tc.want) {
					t.Fatalf("width=%d: got %#v, want %#v", width, got, tc.want)
				}
				if _, err := decoder.Next(); err != io.EOF { // EOF 后不再尝试读取底层连接。
					t.Fatalf("terminal error: %v", err)
				}
			}
		})
	}
}

// TestDecoderTruncation 确认缺失终止空行的事件不会被当成成功结果。
func TestDecoderTruncation(t *testing.T) {
	for _, input := range []string{"data:a", "data:a\n", "data:a\r\n", "data:\n", "event:delta\n", "id:1\n", "data:a\n:ping"} {
		decoder := NewDecoder(strings.NewReader(input)) // 每个输入都是独立断流场景。
		if event, err := decoder.Next(); err != io.ErrUnexpectedEOF || event != (Event{}) {
			t.Errorf("input=%q: event=%#v err=%v", input, event, err)
		}
		if _, err := decoder.Next(); err != io.ErrUnexpectedEOF {
			t.Errorf("terminal error changed: %v", err)
		}
	}
}

// TestDecoderLimits 覆盖超长行、事件累积上限和恰好达到上限的情况。
func TestDecoderLimits(t *testing.T) {
	large := strings.Repeat("中", 40000)                                // 超过 Scanner 默认上限的单行有效 UTF-8。
	decoder := NewDecoder(strings.NewReader("data:" + large + "\n\n")) // 默认允许超过 64 KiB。
	if event, err := decoder.Next(); err != nil || event.Data != large {
		t.Fatalf("large event: len=%d err=%v", len(event.Data), err)
	}
	cases := []struct {
		input  string // 待检测的事件块。
		config Config // 自定义上限。
		want   error  // 预期结果。
	}{
		{"data:a\n\n", Config{MaxLineBytes: 6, MaxEventBytes: 7}, nil},
		{"data:a\n\n", Config{MaxLineBytes: 5}, ErrLineTooLarge},
		{"data:a\n\n", Config{MaxEventBytes: 6}, ErrEventTooLarge},
		{"data:a\ndata:b\n\n", Config{MaxEventBytes: 13}, ErrEventTooLarge},
		{"data:a\ndata:b\n\n", Config{MaxEventBytes: 14}, nil},
		{"data:a\n\ndata:b\n\n", Config{MaxEventBytes: 7}, nil},
		{":12345\ndata:a\n\n", Config{MaxEventBytes: 13}, ErrEventTooLarge},
		{"unknown:123\ndata:a\n\n", Config{MaxEventBytes: 12}, ErrEventTooLarge},
	}
	for _, tc := range cases {
		decoder := NewDecoderWithConfig(strings.NewReader(tc.input), tc.config) // 独立上限实例。
		if _, err := decoder.Next(); err != tc.want {
			t.Errorf("input=%q config=%+v: got %v, want %v", tc.input, tc.config, err, tc.want)
		}
	}
}

// TestDecoderMetadata 检查无 data 块中的 id、retry，以及非法 retry 不覆盖前值。
func TestDecoderMetadata(t *testing.T) {
	decoder := NewDecoder(strings.NewReader("id:42\nretry:0\n\n")) // 控制字段不派发业务事件。
	if _, ok := decoder.RetryMillis(); ok {
		t.Fatal("retry unexpectedly present")
	}
	if _, err := decoder.Next(); err != io.EOF || decoder.LastEventID() != "42" {
		t.Fatalf("metadata: id=%q err=%v", decoder.LastEventID(), err)
	}
	if retry, ok := decoder.RetryMillis(); !ok || retry != 0 {
		t.Fatalf("retry=%d present=%v", retry, ok)
	}
	for _, invalid := range []string{"", "-1", "+1", "1.5", "  10", "10 ", "１２", "999999999999999999999999"} {
		decoder := NewDecoder(strings.NewReader("retry:123\nretry:" + invalid + "\n\n")) // 非法值不能清空已收到的间隔。
		if _, err := decoder.Next(); err != io.EOF {
			t.Fatal(err)
		}
		if retry, ok := decoder.RetryMillis(); !ok || retry != 123 {
			t.Errorf("invalid=%q: retry=%d present=%v", invalid, retry, ok)
		}
	}
}

// finalErrorReader 在返回最后一批数据时同时返回错误，模拟 io.Reader 的合法边界。
type finalErrorReader struct {
	input string // 尚未读取的数据。
	err   error  // 数据耗尽时返回的错误。
}

// Read 允许同一次调用既返回有效字节又返回错误。
func (r *finalErrorReader) Read(buffer []byte) (int, error) {
	n := copy(buffer, r.input) // 本次实际复制的字节数。
	r.input = r.input[n:]
	if r.input == "" {
		return n, r.err
	}
	return n, nil
}

// TestDecoderReadErrors 保留底层错误，且先派发错误之前已经完整读取的事件。
func TestDecoderReadErrors(t *testing.T) {
	failure := errors.New("connection reset") // 可通过 errors.Is 识别的底层错误。
	for _, terminal := range []error{io.EOF, failure} {
		decoder := NewDecoder(&finalErrorReader{input: "data:你好\n\n", err: terminal}) // 同次读取返回数据和错误。
		if event, err := decoder.Next(); err != nil || event.Data != "你好" {
			t.Fatalf("complete event lost: %#v %v", event, err)
		}
		if _, err := decoder.Next(); !errors.Is(err, terminal) {
			t.Fatalf("lost terminal error: %v", err)
		}
	}
	decoder := NewDecoder(&finalErrorReader{input: "data:half", err: failure}) // 半条事件不能派发。
	if event, err := decoder.Next(); event != (Event{}) || !errors.Is(err, failure) {
		t.Fatalf("partial event: %#v %v", event, err)
	}
	if _, err := NewDecoder(nil).Next(); err != ErrNilReader {
		t.Fatalf("nil reader: %v", err)
	}
	if _, err := NewDecoder(strings.NewReader("data:\xff\n\n")).Next(); err != ErrInvalidUTF8 {
		t.Fatalf("invalid UTF-8: %v", err)
	}
}

// TestDecoderCRDoesNotWaitForMoreData 保证单独 CR 已结束事件时不等待额外网络字节。
func TestDecoderCRDoesNotWaitForMoreData(t *testing.T) {
	reader, writer := io.Pipe() // 保持连接打开，复现服务器暂时不再发送数据的情况。
	defer reader.Close()
	defer writer.Close()
	go func() { _, _ = io.WriteString(writer, "data:ready\r\r") }()
	done := make(chan error, 1) // 将阻塞读取结果交回测试线程。
	go func() {
		event, err := NewDecoder(reader).Next() // 此时写端仍然打开。
		if err == nil && event.Data != "ready" {
			err = errors.New("unexpected event")
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("decoder waited after a complete CR-terminated event")
	}
}

// TestDecoderHTTPBody 使用真实 POST 响应验证直接读取 resp.Body。
func TestDecoderHTTPBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method=%s", r.Method)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event:delta\ndata:你好\n\ndata:[DONE]\n\n")
	})) // 本地服务器不依赖外部网络或模型服务。
	defer server.Close()
	resp, err := server.Client().Post(server.URL, "application/json", strings.NewReader("{}")) // 发送模型接口常见的 POST。
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	decoder := NewDecoder(resp.Body) // 直接交给解析器。
	if event, err := decoder.Next(); err != nil || event != (Event{Type: "delta", Data: "你好"}) {
		t.Fatalf("HTTP event: %#v %v", event, err)
	}
	if event, err := decoder.Next(); err != nil || event.Data != "[DONE]" {
		t.Fatalf("HTTP done: %#v %v", event, err)
	}
}

// FuzzDecoderChunkBoundaries 验证任意字节流改变分块后结果不变，且大小限制保证终止。
func FuzzDecoderChunkBoundaries(f *testing.F) {
	f.Add("\ufeffid:1\r\ndata:你好\r\ndata:世界\r\n\r\n")
	f.Add("data:\xff\n\n")
	f.Add("data:unfinished")
	f.Fuzz(func(t *testing.T, input string) {
		if len(input) > 4096 {
			t.Skip()
		}
		read := func(width int) ([]Event, error) { // 使用不同分块方式解析同一输入。
			decoder := NewDecoderWithConfig(&chunkReader{reader: strings.NewReader(input), width: width}, Config{MaxLineBytes: 256, MaxEventBytes: 512})
			var events []Event // 保存派发的完整事件。
			for {
				event, err := decoder.Next() // 终止错误也必须和分块无关。
				if err != nil {
					return events, err
				}
				events = append(events, event)
			}
		}
		want, wantErr := read(4096) // 整块读取作为对照。
		got, gotErr := read(1)      // 每次只读取一个字节。
		if !reflect.DeepEqual(got, want) || gotErr != wantErr {
			t.Fatalf("chunk-dependent result: %#v/%v != %#v/%v", got, gotErr, want, wantErr)
		}
	})
}
