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

// 清理不影响内容去重复用的其他文件：A/B 同 oss_key（复用同一密文对象），
// 物理清理 A 只删 A 的行与历史版本行，B 完好且 oss_key 不变（OSS 对象零接触）
func TestPurgeKeepsDedupedSiblingsAndVersions(t *testing.T) {
	d := newTrashTestDB(t)
	trashCreate(t, d, "file-a", nil, false)
	trashCreate(t, d, "file-b", nil, false)

	// 给 A 插一条历史版本
	if _, err := d.conn.Exec(
		`INSERT INTO file_versions (file_id, version, oss_key, encrypted_file_key, iv, salt, file_size)
		 VALUES ('file-a', 1, 'files/x/old.enc', X'01', X'01', X'', 10)`,
	); err != nil {
		t.Fatal(err)
	}

	// A/B 必须共享同一 oss_key（模拟查重复用）
	var keyA, keyB string
	if err := d.conn.QueryRow(`SELECT oss_key FROM files WHERE id='file-a'`).Scan(&keyA); err != nil {
		t.Fatal(err)
	}
	if err := d.conn.QueryRow(`SELECT oss_key FROM files WHERE id='file-b'`).Scan(&keyB); err != nil {
		t.Fatal(err)
	}
	if keyA != keyB {
		t.Fatalf("test setup: keys differ %q vs %q", keyA, keyB)
	}

	if err := d.SoftDeleteFile("file-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.PurgeAllTrash(); err != nil {
		t.Fatal(err)
	}

	// A 的行与版本行都没了
	var cnt int
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM files WHERE id='file-a'`).Scan(&cnt); err != nil || cnt != 0 {
		t.Fatalf("file-a rows = %d, err=%v; want 0", cnt, err)
	}
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM file_versions WHERE file_id='file-a'`).Scan(&cnt); err != nil || cnt != 0 {
		t.Fatalf("file-a versions = %d, err=%v; want 0", cnt, err)
	}
	// B 完好，oss_key 不变
	if _, err := d.GetFile("file-b"); err != nil {
		t.Fatalf("deduped sibling lost: %v", err)
	}
	if err := d.conn.QueryRow(`SELECT oss_key FROM files WHERE id='file-b'`).Scan(&keyB); err != nil || keyB != keyA {
		t.Fatalf("file-b oss_key = %q err=%v, want %q", keyB, err, keyA)
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

// 删除台账生命周期：登记时机 = 物理清理（软删期间不登记，对象需支撑恢复）；
// 去重复用的共享对象即使 purge 也不登记（仍被兄弟文件引用）；引用消失后才登记。
func TestDeletedObjectLedgerLifecycle(t *testing.T) {
	d := newTrashTestDB(t)
	trashCreate(t, d, "file-a", nil, false)
	trashCreate(t, d, "file-b", nil, false)

	var shared string
	if err := d.conn.QueryRow(`SELECT oss_key FROM files WHERE id='file-a'`).Scan(&shared); err != nil {
		t.Fatal(err)
	}
	// 模拟 A 编辑：共享 key 沉淀为 A 的历史版本，A 换独立新主对象
	if _, err := d.conn.Exec(
		`INSERT INTO file_versions (file_id, version, oss_key, file_size) VALUES ('file-a', 1, ?, 10)`,
		shared,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := d.conn.Exec(
		`UPDATE files SET oss_key = 'files/x/unique-a-new.enc' WHERE id = 'file-a'`,
	); err != nil {
		t.Fatal(err)
	}

	// 1. 软删 A → 回收站期间不登记台账
	if err := d.SoftDeleteFile("file-a"); err != nil {
		t.Fatal(err)
	}
	if ledger, err := d.ListDeletedObjects(); err != nil || len(ledger) != 0 {
		t.Fatalf("ledger after soft delete = %d rows, err=%v; want 0", len(ledger), err)
	}
	// 2. 恢复 A → 行与历史版本完好，台账仍空
	if _, err := d.RestoreFile("file-a"); err != nil {
		t.Fatalf("RestoreFile: %v", err)
	}
	var vc int
	if err := d.conn.QueryRow(`SELECT COUNT(*) FROM file_versions WHERE file_id='file-a'`).Scan(&vc); err != nil || vc != 1 {
		t.Fatalf("versions after restore = %d, err=%v; want 1", vc, err)
	}
	// 3. 再删 A → purge：A 的新主对象无引用 → 登记；共享对象被 B 引用 → 不登记
	if err := d.SoftDeleteFile("file-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.PurgeAllTrash(); err != nil {
		t.Fatal(err)
	}
	ledger, err := d.ListDeletedObjects()
	if err != nil || len(ledger) != 1 {
		t.Fatalf("ledger after purge A = %+v, err=%v; want 1 row (unique key only)", ledger, err)
	}
	if ledger[0].OSSKey != "files/x/unique-a-new.enc" || ledger[0].IsVersion {
		t.Fatalf("ledger row = %+v, want main object unique-a-new.enc", ledger[0])
	}
	if _, err := d.GetFile("file-b"); err != nil {
		t.Fatalf("deduped sibling lost: %v", err)
	}
	// 4. 删除并 purge B → 共享对象此时已无任何引用 → 登记
	if err := d.SoftDeleteFile("file-b"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.PurgeAllTrash(); err != nil {
		t.Fatal(err)
	}
	ledger, err = d.ListDeletedObjects()
	if err != nil || len(ledger) != 2 {
		t.Fatalf("ledger after purge B = %+v, err=%v; want 2 rows (shared key now registered)", ledger, err)
	}
	found := false
	for _, o := range ledger {
		if o.OSSKey == shared && !o.IsVersion {
			found = true
		}
	}
	if !found {
		t.Fatalf("shared key %q not registered after last referrer purged: %+v", shared, ledger)
	}
}
