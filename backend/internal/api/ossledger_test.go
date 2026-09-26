package api

import (
	"testing"
)

func TestOSSBackupLedgerAppendAndQuery(t *testing.T) {
	dir := t.TempDir()
	l := NewOSSBackupLedger(dir, nil)

	if l.Latest() != nil {
		t.Fatal("empty ledger should have no latest")
	}

	if err := l.Append("a.db", "db-backups/a.db.enc", "md5-a", 100); err != nil {
		t.Fatal(err)
	}
	if err := l.Append("b.db", "db-backups/b.db.enc", "md5-b", 200); err != nil {
		t.Fatal(err)
	}

	latest := l.Latest()
	if latest == nil || latest.MD5 != "md5-b" || latest.Name != "b.db" {
		t.Fatalf("latest wrong: %+v", latest)
	}
	if e := l.GetByKey("db-backups/a.db.enc"); e == nil || e.MD5 != "md5-a" {
		t.Fatalf("getbykey wrong: %+v", e)
	}
	if l.GetByKey("db-backups/evil.enc") != nil {
		t.Fatal("unknown key must not resolve")
	}
	list := l.List()
	if len(list) != 2 || list[0].Name != "b.db" {
		t.Fatalf("list should be newest-first: %+v", list)
	}

	// 持久化后重新加载
	l2 := NewOSSBackupLedger(dir, nil)
	if latest := l2.Latest(); latest == nil || latest.MD5 != "md5-b" {
		t.Fatalf("reload wrong: %+v", latest)
	}
}
