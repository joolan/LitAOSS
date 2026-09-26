package storage

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/aliyun/aliyun-oss-go-sdk/oss"
)

type AliyunOSS struct {
	client *oss.Client
	bucket *oss.Bucket
	config *AliyunConfig
}

type AliyunConfig struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	Bucket    string
	Region    string
}

func NewAliyunOSS(cfg *AliyunConfig) (*AliyunOSS, error) {
	client, err := oss.New(cfg.Endpoint, cfg.AccessKey, cfg.SecretKey)
	if err != nil {
		return nil, fmt.Errorf("create aliyun oss client: %w", err)
	}

	bucket, err := client.Bucket(cfg.Bucket)
	if err != nil {
		return nil, fmt.Errorf("get bucket: %w", err)
	}

	return &AliyunOSS{
		client: client,
		bucket: bucket,
		config: cfg,
	}, nil
}

func (a *AliyunOSS) GeneratePresignedUploadURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	signedURL, err := a.bucket.SignURL(key, oss.HTTPPut, int64(expires.Seconds()))
	if err != nil {
		return "", fmt.Errorf("sign upload url: %w", err)
	}
	return signedURL, nil
}

func (a *AliyunOSS) GeneratePresignedDownloadURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	signedURL, err := a.bucket.SignURL(key, oss.HTTPGet, int64(expires.Seconds()))
	if err != nil {
		return "", fmt.Errorf("sign download url: %w", err)
	}
	return signedURL, nil
}

func (a *AliyunOSS) Exists(ctx context.Context, key string) (bool, error) {
	exist, err := a.bucket.IsObjectExist(key)
	if err != nil {
		return false, fmt.Errorf("check object exist: %w", err)
	}
	return exist, nil
}

func (a *AliyunOSS) Upload(ctx context.Context, key string, data []byte, contentType string) error {
	var opts []oss.Option
	if contentType != "" {
		opts = append(opts, oss.ContentType(contentType))
	}
	if err := a.bucket.PutObject(key, bytes.NewReader(data), opts...); err != nil {
		return fmt.Errorf("upload object: %w", err)
	}
	return nil
}
