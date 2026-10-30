package sse

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestStreamLogFile 真实写文件并回放，原始 event、注释、中文及换行不被改变。
func TestStreamLogFile(t *testing.T) {
	input := ": heartbeat\r\n\r\n" + strings.ReplaceAll(responseFrames(responseStart, responseTextItem, responseTextDelta, responseComplete), "\n", "\r\n")
	path := filepath.Join(t.TempDir(), "responses.sse.log") // 测试独占临时文件。
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	result, readErr := NewResponseDecoderWithConfig(strings.NewReader(input), Config{LogWriter: file}).Collect() // 原始换行与 UTF-8 字节都不改写。
	closeErr := file.Close()                                                                                     // 文件生命周期由调用方管理。
	if readErr != nil || closeErr != nil {
		t.Fatalf("read=%v close=%v", readErr, closeErr)
	}
	data, err := os.ReadFile(path) // 检查日志字节而不仅是打印结果。
	if err != nil || string(data) != input {
		t.Fatalf("raw stream changed: err=%v", err)
	}
	replay, err := NewResponseDecoder(bytes.NewReader(data)).Collect() // 相同解码器可直接回放日志。
	if err != nil || replay.OutputText() != result.OutputText() {
		t.Fatalf("replay: %#v %v", replay, err)
	}
}

// brokenLogWriter 模拟磁盘错误、短写入，以及已写完字节却同时报错。
type brokenLogWriter struct {
	mode int /* 选择确定性的写入失败方式。 */
}

// Write 制造标准 io.Writer 边界。
func (w brokenLogWriter) Write(data []byte) (int, error) {
	switch w.mode {
	case 0:
		return 0, os.ErrPermission
	case 1:
		return len(data) - 1, nil
	default:
		return len(data), os.ErrPermission
	}
}

// TestStreamLogErrors 日志错误即使紧挨 completed 也不能被 EOF 掩盖。
func TestStreamLogErrors(t *testing.T) {
	for _, mode := range []int{0, 1, 2} {
		_, err := NewResponseDecoderWithConfig(strings.NewReader(responseFrames(responseComplete)), Config{LogWriter: brokenLogWriter{mode: mode}}).Collect()
		underlying := error(os.ErrPermission) // 短写入对应 io.ErrShortWrite。
		if mode == 1 {
			underlying = io.ErrShortWrite
		}
		if !errors.Is(err, ErrStreamLogWrite) || !errors.Is(err, underlying) || !strings.Contains(err.Error(), "log write failed") {
			t.Fatalf("mode=%d err=%v", mode, err)
		}
	}
	var log bytes.Buffer // 即使最后一次读取同时返回 n 和 EOF，也必须写出所有字节。
	decoder := NewDecoderWithConfig(&finalErrorReader{input: "data:你好\n\n", err: io.EOF}, Config{LogWriter: &log})
	if _, err := decoder.Next(); err != nil || log.String() != "data:你好\n\n" {
		t.Fatalf("n+EOF log=%q err=%v", log.String(), err)
	}
	if _, err := decoder.Next(); err != io.EOF {
		t.Fatal(err)
	}
}

// TestStreamLogMalformedAndChat 不合法帧与 Chat Completions 同样可以记录，便于复现问题。
func TestStreamLogMalformedAndChat(t *testing.T) {
	for _, input := range []string{"data:{bad}\n\n", chatEvent(`[{"index":0,"delta":{},"finish_reason":"stop"}]`, "") + "data:[DONE]\n\n"} {
		var log bytes.Buffer // 每条流单独持有日志目的地。
		_, _ = NewChatDecoderWithConfig(strings.NewReader(input), Config{LogWriter: &log}).Collect()
		if log.String() != input {
			t.Fatalf("raw log missing: %q", log.String())
		}
	}
}

// TestStreamLogSingleByteCRLF 终止空行的 CR 已足够派发，不能为了记录 LF 阻塞等待更多网络字节。
func TestStreamLogSingleByteCRLF(t *testing.T) {
	input := strings.ReplaceAll(responseFrames(responseComplete), "\n", "\r\n") // 单字节切分 CRLF。
	var log bytes.Buffer                                                        // 仅记录真正已经从输入读取的字节。
	result, err := NewResponseDecoderWithConfig(&chunkReader{reader: strings.NewReader(input), width: 1}, Config{LogWriter: &log}).Collect()
	if err != nil || log.String() != strings.TrimSuffix(input, "\n") {
		t.Fatalf("unexpected capture: %q %v", log.String(), err)
	}
	replay, err := NewResponseDecoder(strings.NewReader(log.String())).Collect() // 日志以 CR 结束仍可回放。
	if err != nil || replay.OutputText() != result.OutputText() {
		t.Fatalf("CR replay: %#v %v", replay, err)
	}
}
