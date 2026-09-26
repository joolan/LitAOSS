package db

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// BackupTo 必须包含未 checkpoint 的 WAL 写入——文件拷贝拿不到这部分数据。
func TestBackupToIncludesWAL(t *testing.T) {
	dir := t.TempDir()
	d, err := New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	if _, err := d.conn.Exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('committed')"); err != nil {
		t.Fatal(err)
	}

	backupPath := filepath.Join(dir, "snapshot.db")
	if err := d.BackupTo(backupPath); err != nil {
		t.Fatal(err)
	}

	bd, err := New(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	defer bd.Close()

	var v string
	if err := bd.conn.QueryRow("SELECT v FROM t").Scan(&v); err != nil {
		t.Fatalf("snapshot missing un-checkpointed WAL content: %v", err)
	}
	if v != "committed" {
		t.Fatalf("got %q", v)
	}
}

// 同一状态下两次快照字节一致——MD5 跳过逻辑依赖这一点。
func TestBackupToDeterministic(t *testing.T) {
	dir := t.TempDir()
	d, err := New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	if _, err := d.conn.Exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x')"); err != nil {
		t.Fatal(err)
	}

	a := filepath.Join(dir, "a.db")
	b := filepath.Join(dir, "b.db")
	if err := d.BackupTo(a); err != nil {
		t.Fatal(err)
	}
	if err := d.BackupTo(b); err != nil {
		t.Fatal(err)
	}

	da, err := os.ReadFile(a)
	if err != nil {
		t.Fatal(err)
	}
	db, err := os.ReadFile(b)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(da, db) {
		t.Fatal("two backups of unchanged db differ, md5 skip would never trigger")
	}
}

// 启动时应用 .restore: 恢复内容生效、旧 -wal 清除、.enc 同步、标记删除、幂等。
func TestApplyPendingRestore(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "lit.db")

	os.WriteFile(dbPath, []byte("OLD-STATE"), 0600)
	os.WriteFile(dbPath+"-wal", []byte("STALE-WAL"), 0600)
	os.WriteFile(dbPath+".restore", []byte("RESTORED-STATE"), 0600)

	if err := applyPendingRestore(dbPath, "pass"); err != nil {
		t.Fatalf("apply: %v", err)
	}

	data, _ := os.ReadFile(dbPath)
	if string(data) != "RESTORED-STATE" {
		t.Fatalf("db not restored: %q", data)
	}
	if _, err := os.Stat(dbPath + "-wal"); !os.IsNotExist(err) {
		t.Fatal("stale -wal not removed, would replay onto restored db")
	}
	if _, err := os.Stat(dbPath + ".restore"); !os.IsNotExist(err) {
		t.Fatal("staging marker not removed")
	}

	enc, err := os.ReadFile(dbPath + ".enc")
	if err != nil {
		t.Fatalf(".enc not synced: %v", err)
	}
	plain, err := decryptAES(enc, "pass")
	if err != nil || string(plain) != "RESTORED-STATE" {
		t.Fatalf(".enc content wrong: %v %q", err, plain)
	}

	// 无挂起标记时幂等
	if err := applyPendingRestore(dbPath, "pass"); err != nil {
		t.Fatalf("second apply: %v", err)
	}
}
