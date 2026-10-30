package sse

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// StreamLogRecord 是三层 JSONL 日志；sse 保存上游事件，result 保存合并结果，event 保存统一业务事件。
type StreamLogRecord struct {
	Time            string          `json:"time"`                        // 日志生成时间，离线回放时不是原始网络到达时间。
	Kind            string          `json:"kind"`                        // sse、result、event；raw/parsed 仅用于兼容旧日志回放。
	Protocol        string          `json:"protocol,omitempty"`          // chat 或 responses。
	EventIndex      uint64          `json:"event_index,omitempty"`       // 本次流内从 1 开始的本地序号，含 Chat 的 DONE；区别于上游 sequence_number。
	EventType       string          `json:"event,omitempty"`             // SSE event 字段，缺省为 message。
	EventID         string          `json:"id,omitempty"`                // SSE 的有效 id，允许从前面的事件继承。
	FirstEventIndex uint64          `json:"first_event_index,omitempty"` // 合并对象或业务事件覆盖的首条 SSE。
	LastEventIndex  uint64          `json:"last_event_index,omitempty"`  // 合并对象或业务事件覆盖的末条 SSE。
	Object          json.RawMessage `json:"object,omitempty"`            // 第一层直接嵌入上游 JSON，保留未知字段及字段缺省状态。
	Data            *string         `json:"data,omitempty"`              // 非 JSON 数据，例如 [DONE]、空数据或非法 JSON，保留原文。
	Raw             string          `json:"raw,omitempty"`               // 兼容旧版原始网络片段。
	RawBytes        []byte          `json:"raw_base64,omitempty"`        // 兼容旧版 base64 网络片段。
	Status          string          `json:"status,omitempty"`            // complete 或 partial，仅 result 使用。
	Error           string          `json:"error,omitempty"`             // 读取失败详情，仅 result 使用。
}

// writeEventLog 在 JSON 类型校验前记录完整 SSE data，避免非法业务事件被静默丢弃。
func writeEventLog(config Config, protocol string, index uint64, event Event) error {
	if config.LogWriter == nil || config.LogFormat != "jsonl" {
		return nil
	}
	record := StreamLogRecord{Kind: "sse", Protocol: protocol, EventIndex: index, EventType: event.Type, EventID: event.ID} // 事件序号与第二、三层关联。
	if json.Valid([]byte(event.Data)) {
		record.Object = json.RawMessage(event.Data)
	} else {
		record.Data = &event.Data
	} // 仅 JSON 数据作为对象直接嵌入。
	return writeLogRecord(config.LogWriter, record)
}

// writeLogRecord 同步写出一行结构化日志，并检查短写入。
func writeLogRecord(writer io.Writer, record StreamLogRecord) error {
	record.Time = time.Now().UTC().Format(time.RFC3339Nano)
	data, err := json.Marshal(record) // 每条记录独立，不缓冲整个请求。
	if err != nil {
		return &streamLogError{cause: err}
	}
	_, err = (streamLogWriter{writer: writer}).Write(append(data, '\n')) // 直接写底层，避免再次编码。
	return err
}

// writeObjectLog 只在显式选择 jsonl 时记录对象，原始 SSE 模式保持字节不变。
func writeObjectLog(config Config, protocol, kind string, object any, readErr error, first, last uint64) error {
	if config.LogWriter == nil || config.LogFormat != "jsonl" {
		return nil
	}
	data, err := json.Marshal(object) // JSON 编码 Go 对象，可空字段等按类型定义输出。
	if err != nil {
		return &streamLogError{cause: err}
	}
	record := StreamLogRecord{Kind: kind, Protocol: protocol, Object: data} // 不把原始流当作解析对象。
	if kind == "result" {
		record.FirstEventIndex, record.LastEventIndex = first, last
		record.Status = "complete"
		if readErr != nil {
			record.Status = "partial"
			record.Error = readErr.Error()
		}
	}
	return writeLogRecord(config.LogWriter, record)
}

// resultLogError 同时保留读取错误和最终日志写入失败，兼容 Go 1.19。
type resultLogError struct {
	read error // 原始读取/解析错误。
	log  error // 最后写日志时发生的错误。
}

// Error 同时呈现两类错误，避免掩盖原始断流或磁盘问题。
func (e *resultLogError) Error() string { return fmt.Sprintf("%v; logging result: %v", e.read, e.log) }

// Unwrap 优先保留原始读取错误链。
func (e *resultLogError) Unwrap() error { return e.read }

// Is 两条错误链都支持 errors.Is 查询。
func (e *resultLogError) Is(target error) bool {
	return errors.Is(e.read, target) || errors.Is(e.log, target)
}

// finishObjectLog 在 Collect 返回前记录完整或部分结果，不把错误结果标为 complete。
func finishObjectLog(config Config, protocol string, result any, readErr error, first, last uint64) error {
	if err := writeObjectLog(config, protocol, "result", result, readErr, first, last); err != nil {
		if readErr != nil {
			return &resultLogError{read: readErr, log: err}
		}
		return err
	}
	return readErr
}

// NewLogReplayReader 自动识别纯 SSE、新版逐事件 JSONL 和旧版 raw JSONL。
// 新日志回放保持 data/event/id 语义；不还原注释和原始网络分块，输入由调用方关闭。
func NewLogReplayReader(reader io.Reader) io.Reader {
	buffer := bufio.NewReader(reader) // Peek 只读极少字节，不预加载整个日志。
	first, _ := buffer.Peek(1)        // 原始 SSE 的行不会以 JSON 对象开头。
	if len(first) > 0 && first[0] == '{' {
		return &jsonLogReader{decoder: json.NewDecoder(buffer)}
	}
	return buffer
}

// jsonLogReader 顺序解码原始片段，保持原始网络边界以内的字节顺序。
type jsonLogReader struct {
	decoder *json.Decoder // 逐条读日志记录，避免 Scanner 的行长度限制。
	current *bytes.Reader // 当前 raw 片段尚未交付的字节。
}

// Read 跳过对象快照和最终结果，只恢复原始 SSE 字节。
func (r *jsonLogReader) Read(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	for {
		if r.current != nil && r.current.Len() > 0 {
			return r.current.Read(data)
		}
		var record StreamLogRecord // 每次只保留当前日志记录。
		if err := r.decoder.Decode(&record); err != nil {
			return 0, err
		}
		switch record.Kind {
		case "parsed", "result", "event":
			continue
		case "sse":
			if strings.ContainsAny(record.EventType+record.EventID, "\r\n") {
				return 0, fmt.Errorf("sse: invalid replay event metadata")
			}
			payload := string(record.Object) // 第一层记录保留未知字段，直接交回协议解码器。
			if record.Data != nil {
				payload = *record.Data
			} else if len(record.Object) == 0 {
				return 0, fmt.Errorf("sse: replay event missing object/data")
			}
			var frame strings.Builder // 支持 data 中包含换行的 JSON。
			if record.EventType != "" {
				frame.WriteString("event:" + record.EventType + "\n")
			}
			if record.EventID != "" {
				frame.WriteString("id:" + record.EventID + "\n")
			}
			for _, line := range strings.Split(payload, "\n") {
				frame.WriteString("data:" + line + "\n")
			}
			frame.WriteByte('\n')
			r.current = bytes.NewReader([]byte(frame.String()))
		case "raw":
			if record.RawBytes != nil {
				r.current = bytes.NewReader(record.RawBytes)
			} else {
				r.current = bytes.NewReader([]byte(record.Raw))
			}
		default:
			return 0, fmt.Errorf("sse: unknown log record kind %q", record.Kind)
		}
	}
}
