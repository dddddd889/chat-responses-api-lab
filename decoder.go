// Package sse 使用标准库解析通用 SSE、Chat Completions 和 Responses，支持原始日志，不发送 HTTP 请求。
package sse

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	// DefaultMaxLineBytes 是默认单行上限，支持超过 Scanner 默认 64 KiB 的行。
	DefaultMaxLineBytes = 1024 * 1024
	// DefaultMaxEventBytes 是默认事件块上限，防止多行累积占用无限内存。
	DefaultMaxEventBytes = 8 * 1024 * 1024
	// DefaultMaxTotalBytes 是 Chat 累积与 Responses 解码的默认 JSON 数据量预算。
	DefaultMaxTotalBytes = 32 * 1024 * 1024
)

var (
	// ErrLineTooLarge 表示单行原始字节数超过配置上限。
	ErrLineTooLarge = errors.New("sse: line exceeds size limit")
	// ErrEventTooLarge 表示事件块累积大小超过配置上限。
	ErrEventTooLarge = errors.New("sse: event exceeds size limit")
	// ErrInvalidUTF8 表示上游包含不合法的 UTF-8；采用明确报错的严格策略。
	ErrInvalidUTF8 = errors.New("sse: invalid UTF-8")
	// ErrNilReader 表示没有提供可读取的数据源。
	ErrNilReader = errors.New("sse: nil reader")
)

// Event 是遇到空行后组装完成的事件；返回的字符串不会被后续读取修改。
type Event struct {
	Type string // 事件类型；没有 event 字段或字段为空时使用 message。
	Data string // 多行 data 使用换行连接，保留正文空格。
	ID   string // 最近一次有效 id，允许从前面的事件块继承。
}

// Config 控制内存上限；非正数使用默认值，不提供无限制模式。
type Config struct {
	MaxLineBytes  int       // 单行原始字节数，不包含 CR/LF，包含流首 BOM。
	MaxEventBytes int       // 一个块内每行字节数加 1 的总和，包含注释和未知字段。
	MaxTotalBytes int       // Chat 累积或 Responses 解码总预算；不影响通用 SSE，非正数使用默认值。
	LogWriter     io.Writer // 可选原始 SSE 日志目的地，调用方负责关闭；不要多个流共用同一文件。
	LogFormat     string    // 空值/raw 为原始 SSE；jsonl 写逐事件 JSON、合并结果和统一业务事件。
}

// Decoder 顺序读取一个 SSE 流；同一实例不能被多个 goroutine 并发调用。
// 它不关闭输入源；resp.Body 的关闭与请求取消由调用方负责。
type Decoder struct {
	protocol   string        // Chat/Responses 设置日志协议；通用 SSE 为空。
	eventIndex uint64        // 已收到的完整 data 事件数，包含 Chat 的 DONE。
	reader     *bufio.Reader // 缓冲读取，网络分块不会成为事件边界。
	config     Config        // 已填充默认值的限制配置。
	line       []byte        // 复用的单行缓冲区。
	firstLine  bool          // 只允许在整个流开头去除一次 BOM。
	skipLF     bool          // CR 已结束一行，下次读取时跳过紧随的 LF。
	lastID     string        // 跨事件保留的有效 id。
	retry      int64         // 最近收到的有效重连间隔，单位毫秒。
	hasRetry   bool          // 区分未收到 retry 与收到 retry: 0。
	terminal   error         // 终止后重复调用返回同一错误。
}

// NewDecoder 创建可直接读取 resp.Body 的解析器。
func NewDecoder(reader io.Reader) *Decoder {
	return NewDecoderWithConfig(reader, Config{})
}

// NewDecoderWithConfig 创建带自定义行大小、事件大小限制的解析器。
func NewDecoderWithConfig(reader io.Reader, config Config) *Decoder {
	if config.MaxLineBytes <= 0 {
		config.MaxLineBytes = DefaultMaxLineBytes
	}
	if config.MaxEventBytes <= 0 {
		config.MaxEventBytes = DefaultMaxEventBytes
	}
	decoder := &Decoder{config: config, firstLine: true} // 保存跨事件状态。
	if reader == nil {
		decoder.terminal = ErrNilReader
	} else {
		if config.LogWriter != nil && config.LogFormat != "jsonl" {
			reader = &streamLogReader{reader: reader, writer: streamLogWriter{writer: config.LogWriter}}
		}
		decoder.reader = bufio.NewReader(reader)
	}
	return decoder
}

// LastEventID 返回最近有效 id，包含仅设置 id 而没有 data 的事件块。
func (d *Decoder) LastEventID() string { return d.lastID }

// RetryMillis 返回最近有效的 retry 毫秒数及是否收到过该字段；不执行重连。
// 超出 int64 范围的 retry 与非法值一样忽略。
func (d *Decoder) RetryMillis() (int64, bool) { return d.retry, d.hasRetry }

// Next 阻塞直到得到完整事件或错误；正常结束返回 io.EOF。
// EOF 前没有终止空行的非注释事件块会被丢弃，并返回 io.ErrUnexpectedEOF。
// 这是严格模式：不把连接关闭当作事件结束；底层错误保留原值。
func (d *Decoder) Next() (Event, error) {
	if d.terminal != nil {
		return Event{}, d.terminal
	}
	var data strings.Builder  // 当前事件的数据，多个 data 字段之间保留换行。
	var eventType string      // 当前事件类型，在空行后重置。
	var hasData, pending bool // 空 data 仍能触发事件；pending 标记尚未结束的字段块。
	var eventBytes int        // 当前块大小，含注释和未知字段，避免绕过上限。
	for {
		line, err := d.readLine() // 返回一整行，与底层网络读取次数无关。
		if d.firstLine {
			line = bytes.TrimPrefix(line, []byte{0xef, 0xbb, 0xbf})
			d.firstLine = false
		}
		if err != nil {
			if err == io.EOF && (pending || (len(line) > 0 && line[0] != ':')) {
				err = io.ErrUnexpectedEOF
			}
			d.terminal = err
			return Event{}, err
		}
		if !utf8.Valid(line) {
			d.terminal = ErrInvalidUTF8
			return Event{}, d.terminal
		}
		if len(line) == 0 {
			if hasData {
				if eventType == "" {
					eventType = "message"
				}
				event := Event{Type: eventType, Data: strings.TrimSuffix(data.String(), "\n"), ID: d.lastID} // 完整事件才进入第一层日志。
				d.eventIndex++
				if err := writeEventLog(d.config, d.protocol, d.eventIndex, event); err != nil {
					d.terminal = err
					return Event{}, err
				}
				return event, nil
			}
			eventType, pending, eventBytes = "", false, 0
			continue
		}
		// 减法比较避免累计整数溢出；每行计入一个规范化的换行字节。
		if len(line) >= d.config.MaxEventBytes-eventBytes {
			d.terminal = ErrEventTooLarge
			return Event{}, d.terminal
		}
		eventBytes += len(line) + 1
		if line[0] == ':' {
			continue // 心跳注释不构成业务事件。
		}
		pending = true
		field, value, _ := strings.Cut(string(line), ":") // 仅第一个冒号分隔字段和值。
		value = strings.TrimPrefix(value, " ")            // 只移除一个 ASCII 空格，不能 TrimSpace。
		switch field {
		case "data":
			data.WriteString(value)
			data.WriteByte('\n')
			hasData = true
		case "event":
			eventType = value
		case "id":
			if !strings.ContainsRune(value, '\x00') {
				d.lastID = value
			}
		case "retry":
			if asciiDigits(value) {
				if retry, parseErr := strconv.ParseInt(value, 10, 64); parseErr == nil { // 防止溢出。
					d.retry, d.hasRetry = retry, true
				}
			}
		}
	}
}

// readLine 识别 LF、CRLF 和单独 CR；CR 后立即返回，避免等待下一次网络写入。
func (d *Decoder) readLine() ([]byte, error) {
	d.line = d.line[:0]
	for {
		value, err := d.reader.ReadByte() // 字节只在完整行组装后才作为 UTF-8 检查。
		if err != nil {
			return d.line, err
		}
		if d.skipLF {
			d.skipLF = false
			if value == '\n' {
				continue
			}
		}
		switch value {
		case '\r':
			d.skipLF = true
			return d.line, nil
		case '\n':
			return d.line, nil
		default:
			if len(d.line) >= d.config.MaxLineBytes {
				return d.line, ErrLineTooLarge
			}
			d.line = append(d.line, value)
		}
	}
}

// asciiDigits 严格接受 ASCII 十进制数字，拒绝符号、空格和其他 Unicode 数字。
func asciiDigits(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ { // 按字节判断，匹配 SSE 字段规则。
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}
