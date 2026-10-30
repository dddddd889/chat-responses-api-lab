package sse

import (
	"errors"
	"fmt"
	"io"
)

// ErrStreamLogWrite 表示原始 SSE 日志写入失败，读取随即终止。
var ErrStreamLogWrite = errors.New("sse: stream log write failed")

// streamLogWriter 保留原始字节，统一报告磁盘错误和短写入。
type streamLogWriter struct {
	writer io.Writer // 调用方提供的文件或其他输出，不在这里关闭。
}

// streamLogError 同时支持识别日志错误与其底层错误，兼容 Go 1.19。
type streamLogError struct {
	cause error /* 磁盘或短写入的原始错误。 */
}

// Error 返回带日志上下文的错误信息。
func (e *streamLogError) Error() string { return fmt.Sprintf("%v: %v", ErrStreamLogWrite, e.cause) }

// Unwrap 保留底层错误供 errors.Is 检查。
func (e *streamLogError) Unwrap() error { return e.cause }

// Is 允许 errors.Is(err, ErrStreamLogWrite) 识别日志失败。
func (e *streamLogError) Is(target error) bool { return target == ErrStreamLogWrite }

// streamLogReader 在日志失败时立即中止，避免读缓冲吞掉错误后误报响应成功。
type streamLogReader struct {
	reader io.Reader       // 原始响应正文。
	writer streamLogWriter // 原始字节同步写入目的地。
}

// Read 仅将已成功记录的字节交给解析器，底层同时返回 n 和 EOF 时也先记录字节。
func (r *streamLogReader) Read(data []byte) (int, error) {
	n, err := r.reader.Read(data) // 保留网络原始分块。
	if n > 0 {
		if _, logErr := r.writer.Write(data[:n]); logErr != nil {
			return 0, logErr
		}
	}
	return n, err
}

// Write 同步写日志，不添加时间戳或转义，因此日志可直接回放。
func (w streamLogWriter) Write(data []byte) (int, error) {

	n, err := w.writer.Write(data) // 同一次读取的原始字节只写一次。
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		return n, &streamLogError{cause: err}
	}
	return n, nil
}
