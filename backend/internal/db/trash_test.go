package db

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lit-aoss/internal/models"

	"database/sql"
)

func newTrashTestDB(t *testing.T) *Database {
	t.Helper()
	d, err := New(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func trashCreate(t *testing.T, d *Database, id string, parent *string, isDir bool) {
	t.Helper()
	now := time.Now()
	f := &models.FileRecord{
		ID:            id,
		NameEncrypted: "bmFtZQ==",
		ParentID:      parent,
		IsDirectory:   isDir,
		FileSize:      1,
		FileType:      "text/plain",
		OSSKey:        "files/x/" + strings.Repeat("a", 72) + ".enc",
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := d.CreateFile(f); err != nil {
		t.Fatal(err)
	}
}

// 回收站列表 → 恢复回原位 → 列表清空；重复恢复报 ErrNoRows
func TestTrashListAndRestore(t *testing.T) {
	d := newTrashTestDB(t)
	trashCreate(t, d, "dir1", nil, true)
	parent := "dir1"
	trashCreate(t, d, "file1", &parent, false)

	if err := d.SoftDeleteFile("file1"); err != nil {
		t.Fatal(err)
	}
	items, err := d.ListTrash()
	if err != nil || len(items) != 1 || items[0].ID != "file1" {
		t.Fatalf("ListTrash = %+v, err=%v", items, err)
	}

	target, err := d.RestoreFile("file1")
	if err != nil {
		t.Fatalf("RestoreFile: %v", err)
	}
	if target == nil || *target != "dir1" {
		t.Fatalf("restored parent = %v, want dir1", target)
	}
	if _, err := d.GetFile("file1"); err != nil {
		t.Fatalf("GetFile after restore: %v", err)
	}
	if items, _ := d.ListTrash(); len(items) != 0 {
		t.Fatalf("trash not empty after restore: %+v", items)
	}
	if _, err := d.RestoreFile("file1"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("second restore: err=%v, want ErrNoRows", err)
	}
}

// 原父目录也在回收站时，恢复到根目录（返回 nil）
func TestTrashRestoreToRootWhenParentDeleted(t *testing.T) {
	d := newTrashTestDB(t)
	trashCreate(t, d, "dir1", nil, true)
	parent := "dir1"
	trashCreate(t, d, "file1", &parent, false)

	if err := d.SoftDeleteFile("dir1"); err != nil {
		t.Fatal(err)
	}
	if err := d.SoftDeleteFile("file1"); err != nil {
		t.Fatal(err)
	}
	// 回收站只列显式软删的行
	if items, _ := d.ListTrash(); len(items) != 2 {
		t.Fatalf("trash items = %d, want 2", len(items))
	}

	target, err := d.RestoreFile("file1")
	if err != nil {
		t.Fatalf("RestoreFile: %v", err)
	}
	if target != nil {
		t.Fatalf("parent = %v, want nil (root)", *target)
	}
}

// 过期清理：连同未标记的后代一并删除；未过期的保留；days=0 永不清理
func TestPurgeExpiredTrashCascadesToChildren(t *testing.T) {
	d := newTrashTestDB(t)
	trashCreate(t, d, "dir-old", nil, true)
	child := "dir-old"
	trashCreate(t, d, "child", &child, false)
	trashCreate(t, d, "file-fresh", nil, false)

	if err := d.SoftDeleteFile("dir-old"); err != nil {
		t.Fatal(err)
	}
	if err := d.SoftDeleteFile("file-fresh"); err != nil {
		t.Fatal(err)
	}
	// 把 dir-old 回拨到 40 天前（超过 30 天保留期）
	if _, err := d.conn.Exec(
		`UPDATE files SET deleted_at = datetime('now', '-40 days') WHERE id = 'dir-old'`,
	); err != nil {
		t.Fatal(err)
	}

	n, err := d.PurgeExpiredTrash(30)
	if err != nil {
		t.Fatal(err)
	}
	if n < 2 {
		t.Fatalf("purged %d rows, want >=2 (dir-old + child)", n)
	}
	if _, err := d.GetFile("dir-old"); err == nil {
		t.Fatal("expired dir still present")
	}
	// child 未标记 deleted_at，但随父一并清除
	var cnt int
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM files WHERE id = 'child'`).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 0 {
		t.Fatal("child of expired dir not purged")
	}
	// 未过期的软删行保留
	if items, _ := d.ListTrash(); len(items) != 1 || items[0].ID != "file-fresh" {
		t.Fatalf("fresh item lost: %+v", items)
	}

	// days=0 永不清理
	if n, err := d.PurgeExpiredTrash(0); err != nil || n != 0 {
		t.Fatalf("PurgeExpiredTrash(0) = %d, %v; want 0, nil", n, err)
	}
}

// 清空回收站：全部软删行（含后代）立即删除
func TestPurgeAllTrash(t *testing.T) {
	d := newTrashTestDB(t)
	trashCreate(t, d, "dir1", nil, true)
	parent := "dir1"
	trashCreate(t, d, "child", &parent, false)
	trashCreate(t, d, "keep", nil, false)

	if err := d.SoftDeleteFile("dir1"); err != nil {
		t.Fatal(err)
	}
	n, err := d.PurgeAllTrash()
	if err != nil || n < 2 {
		t.Fatalf("PurgeAllTrash = %d, %v; want >=2, nil", n, err)
	}
	var cnt int
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM files`).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 1 {
		t.Fatalf("files count = %d, want 1 (keep)", cnt)
	}
}
