package db

import (
	"path/filepath"
	"testing"
	"time"

	"lit-aoss/internal/models"
)

// 内容寻址上线前的历史行 content_hash 为 NULL（ALTER 补列所致）。
// 读路径必须容忍 NULL（Scan 到 string 会报错，曾导致 GET /api/files 500）。
func TestReadFilesWithNullContentHash(t *testing.T) {
	dir := t.TempDir()
	d, err := New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	now := time.Now()
	f := &models.FileRecord{
		ID:               "f-null",
		NameEncrypted:    "bmFtZQ==",
		FileSize:         1,
		FileType:         "text/plain",
		OSSKey:           "files/x/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.enc",
		EncryptedFileKey: []byte{1},
		IV:               []byte{1},
		Salt:             []byte{},
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if err := d.CreateFile(f); err != nil {
		t.Fatal(err)
	}
	if _, err := d.conn.Exec(`UPDATE files SET content_hash = NULL WHERE id = ?`, f.ID); err != nil {
		t.Fatal(err)
	}

	files, err := d.GetFiles(nil)
	if err != nil {
		t.Fatalf("GetFiles must tolerate NULL content_hash: %v", err)
	}
	if len(files) != 1 || files[0].ContentHash != "" {
		t.Fatalf("got %d files, content_hash=%q", len(files), files[0].ContentHash)
	}

	got, err := d.GetFile(f.ID)
	if err != nil {
		t.Fatalf("GetFile must tolerate NULL content_hash: %v", err)
	}
	if got.ContentHash != "" {
		t.Fatalf("GetFile content_hash = %q, want empty", got.ContentHash)
	}
}
