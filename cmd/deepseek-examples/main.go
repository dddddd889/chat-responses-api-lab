// deepseek-examples 用真实 DeepSeek 请求覆盖两种流协议，并为每个场景单独保存日志。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sse"
)

// scenario 描述一个固定场景，不接受任意提示词或不受限的循环。
type scenario struct {
	name     string // 场景目录名。
	protocol string // chat 或 responses。
	prompt   string // 不包含密钥的固定测试输入。
	kind     string // text/json/tool/multi_tool/length/thinking/http_error。
}

// report 是汇总中的一个场景，保留实测结果，不把预期当作实际行为。
type report struct {
	Name       string `json:"name"`                   // 场景名称。
	Source     string `json:"source"`                 // live 或 offline。
	Protocol   string `json:"protocol"`               // 接口协议。
	HTTPStatus int    `json:"http_status,omitempty"`  // 实际 HTTP 状态。
	Status     string `json:"status"`                 // passed 或 failed。
	Detail     string `json:"detail,omitempty"`       // 差异或错误说明。
	Log        string `json:"log"`                    // 独立 JSONL 日志路径。
	Usage      int64  `json:"total_tokens,omitempty"` // 实际 token 用量。
}

// main 读取本机密钥，顺序执行有限场景；不自动重试付费请求。
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run 初始化场景输出目录，逐个请求并写入结果汇总。
func run() error {
	keyPath := flag.String("key-file", "", "本机密钥文件；留空时读取 DEEPSEEK_API_KEY")                   // 密钥从不放入参数或日志。
	baseURL := flag.String("base-url", "https://api.deepseek.com", "DeepSeek 官方或用户明确指定的兼容地址") // 请求地址不携带凭证。
	model := flag.String("model", "deepseek-flash", "模型名称")                                   // 当前官方文档使用的模型名。
	out := flag.String("out", "", "新的场景结果目录，默认 logs/deepseek-时间")                             // 不覆盖已有证据。
	offline := flag.Bool("offline", false, "只运行离线故障注入，不请求模型")                                 // 离线场景明确标记，不冒充真实输出。
	flag.Parse()
	key := strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY")) // 只在内存中使用密钥。
	if *keyPath != "" {
		info, err := os.Stat(*keyPath) // 拒绝可被其他用户读取的凭证文件。
		if err != nil {
			return fmt.Errorf("读取密钥文件信息失败: %w", err)
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return fmt.Errorf("密钥文件必须是仅当前用户可读写的普通文件，请 chmod 600")
		}
		data, err := os.ReadFile(*keyPath) // 不打印 data 或 key。
		if err != nil {
			return fmt.Errorf("读取密钥文件失败: %w", err)
		}
		key = strings.TrimSpace(string(data))
	}
	if key == "" && !*offline {
		return fmt.Errorf("未配置密钥，请设置 DEEPSEEK_API_KEY 或提供 -key-file；不要把密钥发到聊天里")
	}
	if *out == "" {
		*out = filepath.Join("logs", "deepseek-"+time.Now().Format("20060102-150405"))
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0700); err != nil {
		return err
	}
	if err := os.Mkdir(*out, 0700); err != nil {
		return err
	} // 输出目录必须是新建的。
	if *offline {
		reports, err := runOffline(*out) // 不需要密钥，也不会创建 HTTP 请求。
		if err != nil {
			return err
		}
		return saveJSON(filepath.Join(*out, "summary.json"), reports)
	}
	client := &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }} // 不自动跳转转发凭证。
	cases := liveScenarios()                                                                                                                                // 14 个固定调用，每次最多 384 个输出 token，无自动重试。
	var reports []report                                                                                                                                    // 每完成一个场景就落盘一次，方便中断后查看。
	for _, current := range cases {
		entry := runLive(client, strings.TrimRight(*baseURL, "/"), *model, key, *out, current)
		reports = append(reports, entry)
		fmt.Printf("%s %s %s\n", entry.Name, entry.Status, entry.Log)
		if err := saveJSON(filepath.Join(*out, "summary.json"), reports); err != nil {
			return err
		}
		if entry.HTTPStatus == 401 || entry.HTTPStatus == 402 || entry.HTTPStatus == 403 {
			return fmt.Errorf("认证/余额/访问失败，已停止后续付费调用；请查看 summary.json")
		}
	}
	return nil
}

// liveScenarios 列出正常文本、结构化输出、工具、长度和服务错误的真实接口路径。
func liveScenarios() []scenario {
	var cases []scenario // 两个协议使用同一组可对照场景。
	for _, protocol := range []string{"chat", "responses"} {
		for _, kind := range []string{"text", "json", "tool", "multi_tool", "length", "thinking", "http_error"} {
			prompt := "只输出这两行，不要解释：第一行：你好，世界 😀；第二行：路径 C:\\temp\\demo，引用\"hello\"。" // 覆盖中文、转义、换行和 emoji。
			switch kind {
			case "json":
				prompt = `只输出 JSON 对象：city 为上海，count 为整数 2，items 为 ["甲","乙"]。`
			case "tool":
				prompt = "请调用 weather 工具查询上海天气，不要自行回答。"
			case "multi_tool":
				prompt = "请分别调用 weather 工具查询上海和北京天气，每座城市独立调用一次，必须有两个调用。"
			case "length":
				prompt = "从1开始连续写出所有整数直到10000，不要省略，不要解释。"
			case "thinking":
				prompt = "计算 17*23，只输出最终数字。"
			}
			cases = append(cases, scenario{name: protocol + "-" + kind, protocol: protocol, prompt: prompt, kind: kind})
		}
	}
	return cases
}

// payload 按两种接口分别生成参数，不把 Chat 工具定义直接放进 Responses。
func payload(current scenario, model string) map[string]any {
	limit := 384 // 每次调用有限 token 预算。
	if current.kind == "length" {
		limit = 16
	}
	thinking := "disabled" // 正常场景避免思考消耗吞掉正文预算。
	if current.kind == "thinking" {
		thinking = "enabled"
	}
	body := map[string]any{"model": model, "stream": true, "thinking": map[string]string{"type": thinking}} // 先按 Chat 构建，Responses 分支替换思考配置。
	if current.kind == "http_error" {
		body["model"] = "codex-sse-invalid-model"
	} // 可重复得到 HTTP 参数错误，不制造高频限流。
	if current.protocol == "chat" {
		body["messages"] = []map[string]string{{"role": "user", "content": current.prompt}}
		body["max_tokens"] = limit
		body["stream_options"] = map[string]bool{"include_usage": true}
		if current.kind == "json" {
			body["response_format"] = map[string]string{"type": "json_object"}
		}
	} else {
		delete(body, "thinking") // Responses 用 reasoning.effort 控制思考，不能沿用 Chat 的 thinking 字段。
		effort := "none"         // 非思考场景不消耗推理预算。
		if current.kind == "thinking" {
			effort = "low"
		}
		body["reasoning"] = map[string]string{"effort": effort}
		body["input"] = current.prompt
		body["max_output_tokens"] = limit
		if current.kind == "json" {
			body["text"] = map[string]any{"format": map[string]string{"type": "json_object"}}
		}
	}
	if current.kind == "tool" || current.kind == "multi_tool" {
		function := map[string]any{"name": "weather", "description": "查询指定城市天气，这是协议测试工具，不执行真实天气查询", "parameters": map[string]any{"type": "object", "properties": map[string]any{"city": map[string]string{"type": "string"}}, "required": []string{"city"}}} // 只声明工具，不自动执行。
		if current.protocol == "chat" {
			body["tools"] = []any{map[string]any{"type": "function", "function": function}}
			body["tool_choice"] = map[string]any{"type": "function", "function": map[string]string{"name": "weather"}}
		} else {
			function["type"] = "function"
			body["tools"] = []any{function}
			body["tool_choice"] = map[string]string{"type": "function", "name": "weather"}
		}
	}
	return body
}

// runLive 发出一个请求，保存安全请求正文、HTTP 元信息、完整日志与解析结果。
func runLive(client *http.Client, baseURL, model, key, root string, current scenario) report {
	directory := filepath.Join(root, current.name) // 每个场景都有独立目录和文件。
	entry := report{Name: current.name, Source: "live", Protocol: current.protocol, Status: "failed", Log: filepath.Join(directory, "events.jsonl")}
	if err := os.Mkdir(directory, 0700); err != nil {
		entry.Detail = err.Error()
		return entry
	}
	body := payload(current, model) // 请求正文不包含 Authorization。
	if err := saveJSON(filepath.Join(directory, "request.json"), body); err != nil {
		entry.Detail = err.Error()
		return entry
	}
	encoded, _ := json.Marshal(body)
	endpoint := "/responses" // 按模式选择官方接口。
	if current.protocol == "chat" {
		endpoint = "/chat/completions"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second) // 单次请求与读取共享超时。
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+endpoint, bytes.NewReader(encoded))
	if err != nil {
		entry.Detail = "创建请求失败"
		return entry
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	response, err := client.Do(req) // 密钥不会写入 request.json 或日志。
	if err != nil {
		entry.Detail = err.Error()
		return entry
	}
	defer response.Body.Close()
	entry.HTTPStatus = response.StatusCode
	_ = saveJSON(filepath.Join(directory, "http.json"), map[string]any{"status": response.StatusCode, "content_type": response.Header.Get("Content-Type"), "request_id": response.Header.Get("x-request-id")}) // 只保存白名单响应字段。
	if response.StatusCode != http.StatusOK {
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 1024*1024))                                                                                                              // 错误正文有明确上限。
		_ = os.WriteFile(filepath.Join(directory, "http-error.body"), data, 0600)                                                                                                          // HTTP 错误不是 SSE，单独保留原文。
		object, _ := json.Marshal(map[string]any{"status": response.StatusCode, "body": string(data)})                                                                                     // JSON 或 HTML 正文都可记录。
		record, _ := json.Marshal(sse.StreamLogRecord{Time: time.Now().UTC().Format(time.RFC3339Nano), Kind: "http_error", Protocol: current.protocol, Object: object, Status: "partial"}) // HTTP 错误也保持一行一个对象。
		if err := os.WriteFile(entry.Log, append(record, '\n'), 0600); err != nil {
			entry.Detail = err.Error()
			return entry
		}
		entry.Detail = fmt.Sprintf("HTTP %d（正文为 HTTP 错误，非 SSE）", response.StatusCode)
		if current.kind == "http_error" && response.StatusCode == 400 && readErr == nil {
			entry.Status = "passed"
		}
		return entry
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/event-stream" {
		entry.Detail = "HTTP 200 但未返回 SSE"
		return entry
	}
	log, err := os.OpenFile(entry.Log, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600) // 每个场景单独的结构化日志。
	if err != nil {
		entry.Detail = err.Error()
		return entry
	}
	config := sse.Config{LogWriter: log, LogFormat: "jsonl"} // 三层记录：上游 SSE JSON、合并结果、统一业务事件。
	var result any                                           // 用同一汇总流程处理两种解析对象。
	var readErr error                                        // 保留真正的生成状态或断流错误。
	text := ""                                               // 用于检查 JSON 输出和文本是否存在。
	tools := 0                                               // 实际函数调用数量，不能把提示词要求当作实测数量。
	truncated := false                                       // 必须由真实终止原因确认截断。
	if current.protocol == "chat" {
		value, parseErr := sse.NewChatDecoderWithConfig(response.Body, config).Collect()
		result, readErr = value, parseErr
		if value != nil {
			for _, answer := range value.Choices {
				text += answer.Content
				tools += len(answer.ToolCalls)
				truncated = truncated || (answer.FinishReason != nil && *answer.FinishReason == "length")
			}
			if value.Usage != nil {
				entry.Usage = value.Usage.TotalTokens
			}
		}
	} else {
		value, parseErr := sse.NewResponseDecoderWithConfig(response.Body, config).Collect()
		result, readErr = value, parseErr
		if value != nil {
			text = value.OutputText()
			for _, item := range value.Output {
				if item.Type == "function_call" {
					tools++
				}
			}
			truncated = value.Status == "incomplete"
			if value.Usage != nil {
				entry.Usage = value.Usage.TotalTokens
			}
		}
	}
	closeErr := log.Close() // 即使解析失败也要关闭文件。
	if err := saveJSON(filepath.Join(directory, "result.json"), result); err != nil {
		entry.Detail = err.Error()
		return entry
	}
	if closeErr != nil {
		entry.Detail = closeErr.Error()
		return entry
	}
	// 长度截断只接受正常 Chat 结束或明确的 Responses incomplete；断流和日志失败仍报错。
	if current.kind == "length" && truncated && (readErr == nil || (errors.Is(readErr, sse.ErrResponseIncomplete) && !errors.Is(readErr, sse.ErrStreamLogWrite))) {
		entry.Status = "passed"
		entry.Detail = "真实触发长度上限"
		return entry
	}
	if readErr != nil {
		entry.Detail = readErr.Error()
		return entry
	}
	if current.kind == "http_error" {
		entry.Detail = "无效模型未被拒绝"
		return entry
	}
	if current.kind == "tool" && tools < 1 || current.kind == "multi_tool" && tools < 2 {
		entry.Detail = fmt.Sprintf("实测工具调用数 %d，未达到场景要求", tools)
		return entry
	}
	if current.kind == "json" && !json.Valid([]byte(text)) {
		entry.Detail = "未收到合法 JSON 正文"
		return entry
	}
	if (current.kind == "text" || current.kind == "thinking") && strings.TrimSpace(text) == "" {
		entry.Detail = "未收到正文"
		return entry
	}
	if current.kind == "length" {
		entry.Detail = "模型未实际触发长度上限"
		return entry
	}
	entry.Status = "passed"
	entry.Detail = fmt.Sprintf("文本字节=%d 工具调用=%d", len(text), tools)
	return entry
}

// saveJSON 将请求、结果或汇总以本人可读写的权限保存，保留实际换行。
func saveJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ") // 对象文件便于人工审查。
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0600)
}
