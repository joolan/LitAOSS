package storage

import (
	"context"
	"time"
)

type ObjectInfo struct {
	Key          string
	Size         int64
	LastModified time.Time
	ContentType  string
}

type Storage interface {
	GeneratePresignedUploadURL(ctx context.Context, key string, expires time.Duration) (string, error)
	GeneratePresignedDownloadURL(ctx context.Context, key string, expires time.Duration) (string, error)
	Exists(ctx context.Context, key string) (bool, error)
	// Upload 由服务端直传对象（当前仅用于加密后的数据库备份副本）。
	Upload(ctx context.Context, key string, data []byte, contentType string) error
}
