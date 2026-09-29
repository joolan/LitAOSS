package db

import (
	"testing"
	"time"
)

// 登录日志完整保留（不再物理清零）+ 锁定计数按「晚于最近一次成功的失败」计算
func TestLoginHistoryKeptAndLockCountAfterSuccess(t *testing.T) {
	d := newTrashTestDB(t)

	// 两次密码错误：计数 2、历史 2 行
	if err := d.RecordLoginAttempt("1.1.1.1", false); err != nil {
		t.Fatal(err)
	}
	if err := d.RecordLoginAttempt("1.1.1.1", false); err != nil {
		t.Fatal(err)
	}
	if n, err := d.GetFailedLoginCount(time.Hour); err != nil || n != 2 {
		t.Fatalf("count after 2 failures = %d, err=%v; want 2", n, err)
	}

	// 成功登录：历史不删除，但旧失败不再计数
	if err := d.RecordLoginAttempt("1.1.1.1", true); err != nil {
		t.Fatal(err)
	}
	if n, err := d.GetFailedLoginCount(time.Hour); err != nil || n != 0 {
		t.Fatalf("count after success = %d, err=%v; want 0", n, err)
	}
	if n, err := d.GetFailedLoginCountByIP("1.1.1.1", time.Hour); err != nil || n != 0 {
		t.Fatalf("byIP count after success = %d, err=%v; want 0", n, err)
	}
	history, err := d.GetLoginHistory(50)
	if err != nil || len(history) != 3 {
		t.Fatalf("history after success = %d rows, err=%v; want 3 (失败行保留)", len(history), err)
	}

	// 成功之后的新失败：重新计数；同 IP 旧失败（成功前）不复活
	if err := d.RecordLoginAttempt("2.2.2.2", false); err != nil {
		t.Fatal(err)
	}
	if n, err := d.GetFailedLoginCount(time.Hour); err != nil || n != 1 {
		t.Fatalf("count after new failure = %d, err=%v; want 1", n, err)
	}
	if n, err := d.GetFailedLoginCountByIP("1.1.1.1", time.Hour); err != nil || n != 0 {
		t.Fatalf("byIP(1.1.1.1) = %d, err=%v; want 0", n, err)
	}
	if n, err := d.GetFailedLoginCountByIP("2.2.2.2", time.Hour); err != nil || n != 1 {
		t.Fatalf("byIP(2.2.2.2) = %d, err=%v; want 1", n, err)
	}
	if history, err := d.GetLoginHistory(50); err != nil || len(history) != 4 {
		t.Fatalf("history = %d rows, err=%v; want 4", len(history), err)
	}
}
