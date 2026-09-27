package config

import (
	"crypto/aes"
	"crypto/cipher"
	crypto_rand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/scrypt"
)

type Config struct {
	Server   ServerConfig   `json:"server"`
	Database DatabaseConfig `json:"database"`
	OSS      OSSConfig      `json:"oss"`
	Auth     AuthConfig     `json:"auth"`
	Backup   BackupConfig   `json:"backup"`
}

type ServerConfig struct {
	Port          string `json:"port"`
	Host          string `json:"host"`
	AllowedOrigin string `json:"allowed_origin,omitempty"`
	// TrustedProxies 可信代理 IP/CIDR 列表：只有来自这些地址的 X-Forwarded-For
	// 才会被采信（影响 ClientIP / 登录审计）。为空默认本机回环。
	TrustedProxies []string `json:"trusted_proxies,omitempty"`
}

type DatabaseConfig struct {
	Path string `json:"path"`
}

type BackupConfig struct {
	AutoBackup bool `json:"auto_backup"`
	BackupTime           string `json:"backup_time"`
	OnFileChange         bool   `json:"on_file_change"`
	MinIntervalSec       int    `json:"min_interval_sec"`
	MaxBackups           int    `json:"max_backups"`
	AutoBackupUploadOSS  bool   `json:"auto_backup_upload_oss"`
	OnFileChangeUploadOSS bool  `json:"on_file_change_upload_oss"`
}

type OSSConfig struct {
	Provider          string `json:"provider"`
	Endpoint          string `json:"endpoint"`
	AccessKey         string `json:"access_key"`
	SecretKey         string `json:"secret_key"`
	Bucket            string `json:"bucket"`
	Region            string `json:"region"`
	EncryptedSK       string `json:"encrypted_sk,omitempty"`
}

type AuthConfig struct {
	PBKDF2Iterations int  `json:"pbkdf2_iterations"`
	MaxLoginAttempts int  `json:"max_login_attempts"`
	LockoutDuration  int  `json:"lockout_duration_seconds"`
	MFAEnabled       bool `json:"mfa_enabled"`
}

func DefaultConfig() *Config {
	return &Config{
		Server: ServerConfig{
			Port: "8780",
			Host: "0.0.0.0",
		},
		Database: DatabaseConfig{
			Path: "./data/lit-aoss.db",
		},
		OSS: OSSConfig{
			Provider:  "aliyun",
			Endpoint:  "",
			AccessKey: "",
			SecretKey: "",
			Bucket:    "",
			Region:    "",
		},
		Auth: AuthConfig{
			PBKDF2Iterations: 500000,
			MaxLoginAttempts: 5,
			LockoutDuration:  900,
		},
		Backup: BackupConfig{
			AutoBackup:     false,
			BackupTime:     "03:00",
			OnFileChange:   false,
			MinIntervalSec: 300,
			MaxBackups:     10,
		},
	}
}

func Load(path string) (*Config, error) {
	cfg := DefaultConfig()

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}

	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}

	return cfg, nil
}

func (c *Config) Save(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	// 自愈: 明文配置 + 已有口令 → 转成 encrypted_sk，磁盘上不再出现明文
	if c.OSS.SecretKey != "" && c.OSS.EncryptedSK == "" {
		if passphrase := c.GetPassphrase(); passphrase != "" {
			if enc, err := EncryptString(c.OSS.SecretKey, passphrase); err == nil {
				c.OSS.EncryptedSK = enc
			}
		}
	}

	// 序列化副本：DecryptSK 解密进内存的明文 SecretKey 绝不写回磁盘
	out := *c
	if out.OSS.EncryptedSK != "" {
		out.OSS.SecretKey = ""
	}

	data, err := json.MarshalIndent(&out, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

func (c *Config) GetPassphrase() string {
	// 1. 环境变量优先
	if p := os.Getenv("LITAOSS_PASSPHRASE"); p != "" {
		return p
	}

	// 2. 文件 fallback: ./passphrase.txt
	exePath, _ := os.Executable()
	dir := filepath.Dir(exePath)
	passphraseFile := filepath.Join(dir, "passphrase.txt")

	// 也检查 config.json 同级目录
	configDir := filepath.Dir("config.json")
	if configDir != "." {
		passphraseFile2 := filepath.Join(configDir, "passphrase.txt")
		if data, err := os.ReadFile(passphraseFile2); err == nil {
			return strings.TrimSpace(string(data))
		}
	}

	if data, err := os.ReadFile(passphraseFile); err == nil {
		return strings.TrimSpace(string(data))
	}

	// 当前目录的 passphrase.txt
	if data, err := os.ReadFile("passphrase.txt"); err == nil {
		return strings.TrimSpace(string(data))
	}

	return ""
}

func (c *Config) DecryptSK() error {
	if c.OSS.EncryptedSK == "" {
		return nil
	}

	passphrase := c.GetPassphrase()
	if passphrase == "" {
		return fmt.Errorf("encrypted_sk found but no passphrase (set LITAOSS_PASSPHRASE env or create passphrase.txt)")
	}

	sk, err := DecryptString(c.OSS.EncryptedSK, passphrase)
	if err != nil {
		return fmt.Errorf("decrypt secret_key: %w", err)
	}

	c.OSS.SecretKey = sk
	return nil
}

func EncryptString(plaintext string, passphrase string) (string, error) {
	salt := make([]byte, 16)
	if _, err := io.ReadFull(crypto_rand.Reader, salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}

	key, err := scrypt.Key([]byte(passphrase), salt, 32768, 8, 1, 32)
	if err != nil {
		return "", fmt.Errorf("derive key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	nonce := make([]byte, aesgcm.NonceSize())
	if _, err := io.ReadFull(crypto_rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}

	ciphertext := aesgcm.Seal(nil, nonce, []byte(plaintext), nil)
	result := make([]byte, 0, len(salt)+len(nonce)+len(ciphertext))
	result = append(result, salt...)
	result = append(result, nonce...)
	result = append(result, ciphertext...)

	return hex.EncodeToString(result), nil
}

func DecryptString(encrypted string, passphrase string) (string, error) {
	data, err := hex.DecodeString(encrypted)
	if err != nil {
		return "", fmt.Errorf("invalid encrypted data")
	}

	if len(data) < 16+12+1 { // salt + nonce + at least 1 byte ciphertext
		return "", fmt.Errorf("invalid encrypted data length")
	}

	salt := data[:16]
	nonce := data[16:28]
	ciphertext := data[28:]

	key, err := scrypt.Key([]byte(passphrase), salt, 32768, 8, 1, 32)
	if err != nil {
		return "", fmt.Errorf("derive key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	plaintext, err := aesgcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt failed (wrong passphrase?)")
	}

	return string(plaintext), nil
}

// 备份文件加密格式: magic "LAOB" | 1B version | 16B salt | 12B nonce | AES-256-GCM ciphertext+tag
const (
	backupMagic   = "LAOB"
	backupVersion = byte(1)
)

// EncryptBackup 加密数据库备份文件内容（key = scrypt(passphrase, salt)），供上传 OSS 使用。
func EncryptBackup(plain []byte, passphrase string) ([]byte, error) {
	if passphrase == "" {
		return nil, fmt.Errorf("empty passphrase")
	}

	salt := make([]byte, 16)
	if _, err := io.ReadFull(crypto_rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("generate salt: %w", err)
	}

	key, err := scrypt.Key([]byte(passphrase), salt, 32768, 8, 1, 32)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create gcm: %w", err)
	}

	nonce := make([]byte, aesgcm.NonceSize())
	if _, err := io.ReadFull(crypto_rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}

	ciphertext := aesgcm.Seal(nil, nonce, plain, nil)
	out := make([]byte, 0, len(backupMagic)+1+16+len(nonce)+len(ciphertext))
	out = append(out, backupMagic...)
	out = append(out, backupVersion)
	out = append(out, salt...)
	out = append(out, nonce...)
	out = append(out, ciphertext...)
	return out, nil
}

// DecryptBackup 解密 EncryptBackup 产出的备份对象。
func DecryptBackup(blob []byte, passphrase string) ([]byte, error) {
	if passphrase == "" {
		return nil, fmt.Errorf("empty passphrase")
	}
	if len(blob) < len(backupMagic)+1+16+12+16 {
		return nil, fmt.Errorf("invalid backup blob: too short")
	}
	if string(blob[:len(backupMagic)]) != backupMagic {
		return nil, fmt.Errorf("invalid backup blob: bad magic")
	}
	if blob[len(backupMagic)] != backupVersion {
		return nil, fmt.Errorf("unsupported backup version: %d", blob[len(backupMagic)])
	}

	offset := len(backupMagic) + 1
	salt := blob[offset : offset+16]
	nonce := blob[offset+16 : offset+16+12]
	ciphertext := blob[offset+16+12:]

	key, err := scrypt.Key([]byte(passphrase), salt, 32768, 8, 1, 32)
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create gcm: %w", err)
	}

	plain, err := aesgcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt failed (wrong passphrase?)")
	}
	return plain, nil
}
