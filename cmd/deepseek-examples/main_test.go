package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeTransport 用内存响应验证真实运行器，不调用付费接口。
type fakeTransport struct {
	t      *testing.T // 当前测试，校验请求体与鉴权方式。
	status int        // 模拟服务端状态码。
	body   string     // 模拟返回正文。
}

// RoundTrip 捕获请求，不让密钥进入任何日志对象。
func (f fakeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Header.Get("Authorization") != "Bearer test-only-secret" {
		f.t.Fatal("missing authorization")
	}
	media := "text/event-stream" // 错误场景返回普通 JSON。
	if f.status != 200 {
		media = "application/json"
	}
	return &http.Response{StatusCode: f.status, Header: http.Header{"Content-Type": {media}}, Body: io.NopCloser(strings.NewReader(f.body)), Request: req}, nil
}

// TestPayloadMatrix 检查有限调用数、不同协议的思考参数与 token 限制。
func TestPayloadMatrix(t *testing.T) {
	cases := liveScenarios() // 构建参数不需要密钥。
	if len(cases) != 14 {
		t.Fatalf("unexpected paid request count %d", len(cases))
	}
	for _, current := range cases {
		body := payload(current, "deepseek-flash")
		if current.protocol == "chat" {
			if body["max_tokens"].(int) > 384 || body["thinking"] == nil || body["reasoning"] != nil {
				t.Fatalf("chat payload: %#v", body)
			}
		} else if body["max_output_tokens"].(int) > 384 || body["reasoning"] == nil || body["thinking"] != nil {
			t.Fatalf("responses payload: %#v", body)
		}
	}
}

// TestOfflineMatrix 每一个离线输入都必须得到预期结果，且日志不能混用目录。
func TestOfflineMatrix(t *testing.T) {
	reports, err := runOffline(t.TempDir()) // 每个场景真实写文件，但不访问模型。
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{} // 防止两个场景覆盖同一个日志。
	for _, entry := range reports {
		if entry.Status != "passed" || entry.Source != "offline" || seen[entry.Log] {
			t.Fatalf("offline regression: %#v", entry)
		}
		seen[entry.Log] = true
	}
	if len(reports) < 50 {
		t.Fatal("offline matrix unexpectedly shrank")
	}
}

// TestLiveRunnerCapture 用模拟传输验证两种真实运行器路径都写入对象日志与独立结果。
func TestLiveRunnerCapture(t *testing.T) {
	for _, protocol := range []string{"chat", "responses"} {
		fixture := protocol + ".sse" // 复用模块内两个协议的离线标准样本。
		data, err := os.ReadFile(filepath.Join("..", "..", "testdata", fixture))
		if err != nil {
			t.Fatal(err)
		}
		client := &http.Client{Transport: fakeTransport{t: t, status: 200, body: string(data)}} // 不监听端口。
		entry := runLive(client, "https://example.invalid", "test", "test-only-secret", t.TempDir(), scenario{name: protocol, protocol: protocol, kind: "text", prompt: "hello"})
		if entry.Status != "passed" {
			t.Fatalf("live runner: %#v", entry)
		}
		logged, err := os.ReadFile(entry.Log)
		if err != nil || !strings.Contains(string(logged), `"kind":"sse"`) || !strings.Contains(string(logged), `"kind":"result"`) {
			t.Fatalf("object logs missing: %v", err)
		}
		files, _ := os.ReadDir(filepath.Dir(entry.Log)) // 逐文件检查凭证没有泄露。
		for _, file := range files {
			value, _ := os.ReadFile(filepath.Join(filepath.Dir(entry.Log), file.Name()))
			if strings.Contains(string(value), "test-only-secret") {
				t.Fatal("credential leaked")
			}
		}
	}
}

// TestLiveHTTPError HTTP 错误的记录明确标记为 http_error，不冒充 SSE。
func TestLiveHTTPError(t *testing.T) {
	client := &http.Client{Transport: fakeTransport{t: t, status: 400, body: `{"error":{"message":"invalid model"}}`}}
	entry := runLive(client, "https://example.invalid", "test", "test-only-secret", t.TempDir(), scenario{name: "http", protocol: "chat", kind: "http_error"})
	if entry.Status != "passed" || entry.HTTPStatus != 400 {
		t.Fatalf("HTTP regression: %#v", entry)
	}
	data, _ := os.ReadFile(entry.Log)
	var record map[string]any // 错误日志本身也必须是合法 JSON 对象。
	if err := json.Unmarshal(data, &record); err != nil || record["kind"] != "http_error" {
		t.Fatalf("invalid HTTP log: %v", err)
	}
}

// TestLiveLengthMissingDone 长度结束原因不能掩盖真正的断流，稳定复现为删除 DONE。
func TestLiveLengthMissingDone(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "chat.sse")) // 仅修改现有样本的结束原因和终止帧。
	if err != nil {
		t.Fatal(err)
	}
	body := strings.ReplaceAll(string(data), `"finish_reason":"tool_calls"`, `"finish_reason":"length"`) // 保留完整内容及工具对象。
	body = strings.ReplaceAll(body, "data: [DONE]\n\n", "")
	client := &http.Client{Transport: fakeTransport{t: t, status: 200, body: body}} // 不访问外部接口。
	entry := runLive(client, "https://example.invalid", "test", "test-only-secret", t.TempDir(), scenario{name: "length-no-done", protocol: "chat", kind: "length"})
	if entry.Status != "failed" || !strings.Contains(entry.Detail, "missing [DONE]") {
		t.Fatalf("truncation masked missing DONE: %#v", entry)
	}
}
