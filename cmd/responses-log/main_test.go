package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sse"
)

// TestRunModes 两种模式都写原始文件、输出完整结果，日志可再次回放。
func TestRunModes(t *testing.T) {
	for _, mode := range []string{"chat", "responses"} {
		t.Run(mode, func(t *testing.T) {
			fixture := "chat.sse" // 选取当前协议的离线流。
			if mode == "responses" {
				fixture = "responses.sse"
			}
			input, err := os.ReadFile(filepath.Join("..", "..", "testdata", fixture))
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "stream.sse.log") // 不写入用户实际日志目录。
			var output bytes.Buffer                              // 捕获最终 JSON，验证不含原始 SSE 帧。
			args := []string{"-mode", mode, "-log", path}        // 用标准输入路径验证 curl 管道模式。
			if mode == "responses" {
				args = []string{"-log", path}
			} // 省略模式继续使用默认 Responses。
			if err := run(args, bytes.NewReader(input), &output); err != nil {
				t.Fatal(err)
			}
			logged, err := os.ReadFile(path)                                                   // 原始字节不能被终端 JSON 编码改写。
			restored, replayErr := io.ReadAll(sse.NewLogReplayReader(bytes.NewReader(logged))) // JSONL 的对象记录不参与回放。
			if err != nil || replayErr != nil || len(restored) == 0 || !bytes.Contains(logged, []byte(`"kind":"sse"`)) || !bytes.Contains(logged, []byte(`"kind":"result"`)) {
				t.Fatalf("raw log differs: %v", err)
			}
			if mode == "chat" {
				var result sse.ChatResult // 验证文本、工具参数和终止块后的用量。
				if err := json.Unmarshal(output.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if result.Choices[0].Content != "你好世界" || result.Choices[0].ToolCalls[0].Function.Arguments != `{"city":"上海"}` || result.Usage.TotalTokens != 30 {
					t.Fatalf("chat result: %#v", result)
				}
			} else {
				var result sse.ResponseObject // 保证原模式没有退化。
				if err := json.Unmarshal(output.Bytes(), &result); err != nil {
					t.Fatal(err)
				}
				if result.OutputText() != "你好世界" || result.Usage.TotalTokens != 30 {
					t.Fatalf("responses result: %#v", result)
				}
			}
			var replay bytes.Buffer // 回放模式从文件读，输出应与首次消费一致。
			if err := run([]string{"-mode", mode, "-input", path, "-log", path + ".replay"}, nil, &replay); err != nil {
				t.Fatal(err)
			}
			if replay.String() != output.String() {
				t.Fatal("replay changed result")
			}
		})
	}
}

// TestRunChatFailures 验证缺 DONE、累计超限、无效模式及已存在日志的处理。
func TestRunChatFailures(t *testing.T) {
	input, err := os.ReadFile(filepath.Join("..", "..", "testdata", "chat.sse")) // 使用相同 fixture 稳定复现断流。
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string   // 场景名称。
		body string   // 模拟标准输入。
		args []string // 额外命令参数。
		want error    // 可通过 errors.Is 匹配的错误。
	}{
		{"missing_done", strings.Replace(string(input), "data: [DONE]\n\n", "", 1), nil, io.ErrUnexpectedEOF},
		{"over_budget", string(input), []string{"-max-bytes", "1"}, sse.ErrChatTooLarge},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "stream.log") // 每个失败场景都独立记录原始流。
			var output bytes.Buffer                          // 失败时仍有可解析的部分结果。
			args := append([]string{"-mode", "chat", "-log", path}, tc.args...)
			if err := run(args, strings.NewReader(tc.body), &output); !errors.Is(err, tc.want) {
				t.Fatalf("got %v want %v", err, tc.want)
			}
			if !json.Valid(output.Bytes()) {
				t.Fatalf("partial result not JSON: %q", output.String())
			}
			logged, err := os.ReadFile(path)
			restored, replayErr := io.ReadAll(sse.NewLogReplayReader(bytes.NewReader(logged))) // 失败时也保留原始输入。
			if err != nil || replayErr != nil || len(restored) == 0 || !bytes.Contains(logged, []byte(`"status":"partial"`)) {
				t.Fatalf("failed stream not logged: %v", err)
			}
		})
	}
	path := filepath.Join(t.TempDir(), "existing.log") // 无效模式不应创建文件。
	if err := run([]string{"-mode", "invalid", "-log", path}, strings.NewReader(""), io.Discard); err == nil {
		t.Fatal("invalid mode accepted")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid mode created file: %v", err)
	}
	if err := os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-mode", "chat", "-log", path}, bytes.NewReader(input), io.Discard); !errors.Is(err, os.ErrExist) {
		t.Fatalf("overwrote existing log: %v", err)
	}
	if data, _ := os.ReadFile(path); string(data) != "keep" {
		t.Fatal("existing log changed")
	}
}

// TestRunRawFormat 验证显式 raw 模式仍逐字节保存 SSE，且非法格式不会创建日志。
func TestRunRawFormat(t *testing.T) {
	for _, mode := range []string{"chat", "responses"} {
		input, err := os.ReadFile(filepath.Join("..", "..", "testdata", mode+".sse")) // 两种协议都验证兼容模式。
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), "raw.log") // 原始字节独立保存，避免污染真实日志。
		if err := run([]string{"-mode", mode, "-log-format", "raw", "-log", path}, bytes.NewReader(input), io.Discard); err != nil {
			t.Fatal(err)
		}
		logged, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(logged, input) {
			t.Fatalf("raw changed: %v", err)
		}
	}
	path := filepath.Join(t.TempDir(), "invalid.log") // 无效配置先校验，不能创建空文件。
	if err := run([]string{"-log-format", "invalid", "-log", path}, strings.NewReader(""), io.Discard); err == nil {
		t.Fatal("invalid format accepted")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid format created log: %v", err)
	}
}
