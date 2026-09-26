package config

import (
	"bytes"
	"os"
	"strings"
	"testing"
)

// Save 绝不能把 DecryptSK 解密出的明文 SecretKey 写回磁盘。
func TestSaveNeverWritesPlaintextSK(t *testing.T) {
	path := t.TempDir() + "/config.json"
	cfg := DefaultConfig()
	cfg.OSS.EncryptedSK = "aabbcc"
	cfg.OSS.SecretKey = "PLAINTEXT-MARKER-should-not-appear"

	if err := cfg.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "PLAINTEXT-MARKER-should-not-appear") {
		t.Fatal("plaintext secret_key was written to disk")
	}
	if !strings.Contains(string(data), "encrypted_sk") {
		t.Fatal("encrypted_sk missing from saved config")
	}
	if cfg.OSS.SecretKey == "" {
		t.Fatal("in-memory SecretKey must be kept for SDK signing")
	}
}

// 明文配置 + 已配置口令 → Save 自愈转为 encrypted_sk，磁盘无明文。
func TestSaveSelfHealsPlaintextSK(t *testing.T) {
	t.Setenv("LITAOSS_PASSPHRASE", "test-passphrase")
	path := t.TempDir() + "/config.json"
	cfg := DefaultConfig()
	cfg.OSS.SecretKey = "PLAINTEXT-MARKER-should-not-appear"

	if err := cfg.Save(path); err != nil {
		t.Fatalf("save: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "PLAINTEXT-MARKER-should-not-appear") {
		t.Fatal("plaintext secret_key was written despite passphrase")
	}
	if !strings.Contains(string(data), "encrypted_sk") {
		t.Fatal("encrypted_sk not auto-created")
	}

	// 重新加载后 DecryptSK 能还原
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := loaded.DecryptSK(); err != nil {
		t.Fatalf("decrypt after self-heal: %v", err)
	}
	if loaded.OSS.SecretKey != "PLAINTEXT-MARKER-should-not-appear" {
		t.Fatalf("roundtrip mismatch: %q", loaded.OSS.SecretKey)
	}
}

func TestBackupEncryptRoundtrip(t *testing.T) {
	plain := []byte("sqlite-backup-bytes-\x00\x01\x02")

	blob, err := EncryptBackup(plain, "pass")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, plain) {
		t.Fatal("plaintext leaked into blob")
	}
	got, err := DecryptBackup(blob, "pass")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatal("roundtrip mismatch")
	}
	if _, err := DecryptBackup(blob, "wrong"); err == nil {
		t.Fatal("wrong passphrase must fail")
	}
	if _, err := DecryptBackup(blob[:10], "pass"); err == nil {
		t.Fatal("truncated blob must fail")
	}
	if _, err := EncryptBackup(plain, ""); err == nil {
		t.Fatal("empty passphrase must be rejected")
	}
}
