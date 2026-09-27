package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"lit-aoss/internal/db"
	"lit-aoss/internal/models"
)

// makeDrillBackup 构造一份带账号数据与文件行的备份，返回备份文件路径。
func makeDrillBackup(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	src, err := db.New(filepath.Join(dir, "src.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()

	if err := src.SetupAuth("hash", "salt"); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := src.CreateFile(&models.FileRecord{
		ID: "dir-1", NameEncrypted: "ZGly", IsDirectory: true,
		Salt: []byte{}, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := src.CreateFile(&models.FileRecord{
		ID: "f-1", NameEncrypted: "ZmlsZQ==", FileSize: 3, FileType: "text/plain",
		OSSKey: "files/x/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.enc",
		EncryptedFileKey: []byte{1}, IV: []byte{1}, Salt: []byte{1},
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	backupPath := filepath.Join(dir, "lit-aoss_20260927_000000.db")
	if err := src.BackupTo(backupPath); err != nil {
		t.Fatal(err)
	}
	return backupPath
}

func TestDrillBackupFilePassesOnRealBackup(t *testing.T) {
	backupPath := makeDrillBackup(t)

	report := drillBackupFile(backupPath)
	if !report.OK {
		t.Fatalf("drill failed: %+v", report)
	}
	if report.FileCount != 1 || report.FolderCount != 1 {
		t.Fatalf("counts = %d files / %d folders, want 1/1", report.FileCount, report.FolderCount)
	}
	if len(report.Checks) < 6 {
		t.Fatalf("expected at least 6 checks, got %d", len(report.Checks))
	}
	for _, ck := range report.Checks {
		if !ck.OK {
			t.Errorf("check %q unexpectedly failed: %s", ck.Name, ck.Detail)
		}
	}
	if report.Error != "" {
		t.Errorf("unexpected error field: %q", report.Error)
	}
}

func TestDrillBackupFileFailsOnCorruptFile(t *testing.T) {
	dir := t.TempDir()
	corrupt := filepath.Join(dir, "lit-aoss_corrupt.db")
	if err := os.WriteFile(corrupt, []byte("not a sqlite database at all"), 0600); err != nil {
		t.Fatal(err)
	}

	report := drillBackupFile(corrupt)
	if report.OK {
		t.Fatal("corrupt file must fail drill")
	}
	if report.Error == "" {
		t.Fatal("failed drill must record error")
	}
	last := report.Checks[len(report.Checks)-1]
	if last.OK {
		t.Fatalf("last check must be the failed one, got %+v", last)
	}
}

func TestDrillBackupFileFailsOnMissingFile(t *testing.T) {
	report := drillBackupFile(filepath.Join(t.TempDir(), "nope.db"))
	if report.OK {
		t.Fatal("missing file must fail drill")
	}
	if report.Checks[0].Name != "备份文件" || report.Checks[0].OK {
		t.Fatalf("first check = %+v", report.Checks[0])
	}
}
