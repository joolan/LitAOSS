package storage

import (
	"context"
	"fmt"
	"time"
)

type NoopStorage struct{}

func (n *NoopStorage) GeneratePresignedUploadURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	return "", fmt.Errorf("storage not configured")
}

func (n *NoopStorage) GeneratePresignedDownloadURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	return "", fmt.Errorf("storage not configured")
}

func (n *NoopStorage) Exists(ctx context.Context, key string) (bool, error) {
	return false, fmt.Errorf("storage not configured")
}

func (n *NoopStorage) Upload(ctx context.Context, key string, data []byte, contentType string) error {
	return fmt.Errorf("storage not configured")
}
