// responses-log 从标准输入或文件解码 Responses 或 Chat SSE，同时保存原始流，输出最终 JSON。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"sse"
)

// main 只处理命令行退出；文件关闭在 run 中执行，失败时返回非零退出码。
func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run 保留日志与部分结果，既支持 curl 管道，也支持已有日志回放。
func run(args []string, input io.Reader, output io.Writer) (err error) {
	flags := flag.NewFlagSet("responses-log", flag.ContinueOnError)                                  // 每次解析独立，便于测试完整命令流程。
	mode := flags.String("mode", "responses", "协议模式：responses 或 chat")                               // 保留默认 Responses 行为。
	inputPath := flags.String("input", "-", "SSE 输入文件，- 表示标准输入")                                     // 默认可接 curl 输出。
	logPath := flags.String("log", "", "新建日志路径，默认按模式命名，不覆盖已有文件")                                     // 每条流独占文件。
	maxBytes := flags.Int("max-bytes", sse.DefaultMaxTotalBytes, "整条流的 JSON 字节上限")                   // 沿用有限默认预算。
	logFormat := flags.String("log-format", "jsonl", "日志格式：jsonl（逐事件 JSON+合并结果+统一业务事件）或 raw（纯 SSE）") // 默认满足对象排查需求。
	if parseErr := flags.Parse(args); parseErr != nil {
		return parseErr
	}
	if *mode != "responses" && *mode != "chat" {
		return fmt.Errorf("不支持的 mode %q，只能是 responses 或 chat", *mode)
	}
	if *logFormat != "jsonl" && *logFormat != "raw" {
		return fmt.Errorf("不支持的 log-format %q", *logFormat)
	}
	if *logPath == "" {
		*logPath = *mode + ".sse.log"
	}
	if *inputPath != "-" {
		file, openErr := os.Open(*inputPath) // 回放模式仅只读打开已有日志。
		if openErr != nil {
			return openErr
		}
		defer file.Close()
		input = file
	}
	log, openErr := os.OpenFile(*logPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600) // 日志可包含模型输出，默认仅本人可读写。
	if openErr != nil {
		return openErr
	}
	defer func() {
		if closeErr := log.Close(); err == nil {
			err = closeErr
		}
	}() // 保留读取原错误，同时检查关闭失败。
	input = sse.NewLogReplayReader(input)                                                 // 自动恢复 JSONL 或原始 SSE 中的原始字节。
	config := sse.Config{LogWriter: log, MaxTotalBytes: *maxBytes, LogFormat: *logFormat} // 两种模式共用日志与累计预算。
	var result any                                                                        // 命令行只序列化结果，具体 Go 类型由选中的协议决定。
	var collectErr error                                                                  // 保留断流等错误，同时打印已经收到的部分结果。
	if *mode == "chat" {
		result, collectErr = sse.NewChatDecoderWithConfig(input, config).Collect()
	} else {
		result, collectErr = sse.NewResponseDecoderWithConfig(input, config).Collect()
	}
	encoder := json.NewEncoder(output) // 标准输出只打印最终 JSON，原始事件写入日志文件。
	encoder.SetIndent("", "  ")
	if encodeErr := encoder.Encode(result); encodeErr != nil {
		return encodeErr
	}
	return collectErr
}
