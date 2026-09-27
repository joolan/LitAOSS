package db

import (
	"path/filepath"
	"testing"
)

// 恢复码：整体替换（旧码失效）+ 一次性消费语义
func TestRecoveryCodesLifecycle(t *testing.T) {
	dir := t.TempDir()
	d, err := New(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	if err := d.ReplaceRecoveryCodes([]string{"hash-a", "hash-b", "hash-c"}); err != nil {
		t.Fatal(err)
	}
	total, remaining, err := d.CountRecoveryCodes()
	if err != nil || total != 3 || remaining != 3 {
		t.Fatalf("got total=%d remaining=%d err=%v", total, remaining, err)
	}

	// 一次性消费：首次命中，重放拒绝
	ok, err := d.ConsumeRecoveryCode("hash-a")
	if err != nil || !ok {
		t.Fatalf("first consume: ok=%v err=%v", ok, err)
	}
	ok, err = d.ConsumeRecoveryCode("hash-a")
	if err != nil || ok {
		t.Fatalf("replay must fail: ok=%v err=%v", ok, err)
	}

	_, remaining, _ = d.CountRecoveryCodes()
	if remaining != 2 {
		t.Fatalf("remaining = %d, want 2", remaining)
	}

	// 未命中不改变状态
	ok, err = d.ConsumeRecoveryCode("hash-unknown")
	if err != nil || ok {
		t.Fatalf("unknown code: ok=%v err=%v", ok, err)
	}

	// 重新生成：旧码全部失效
	if err := d.ReplaceRecoveryCodes([]string{"hash-x"}); err != nil {
		t.Fatal(err)
	}
	ok, _ = d.ConsumeRecoveryCode("hash-b")
	if ok {
		t.Fatal("old code must be invalid after replace")
	}
	total, remaining, _ = d.CountRecoveryCodes()
	if total != 1 || remaining != 1 {
		t.Fatalf("after replace: total=%d remaining=%d", total, remaining)
	}
}
