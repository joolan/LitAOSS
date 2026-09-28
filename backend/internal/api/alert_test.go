package api

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"lit-aoss/internal/config"
	"lit-aoss/internal/db"
)

func newAlertTestHandler(t *testing.T, ac config.AlertConfig) (*Handler, *db.Database) {
	t.Helper()
	d, err := db.New(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	cfg := &config.Config{
		Auth:  config.AuthConfig{LockoutDuration: 900},
		Alert: ac,
	}
	return NewHandler(d, nil, cfg, nil), d
}

// 达到阈值才发送；冷却期内重复触发不重发
func TestAlertFiresAtThresholdWithCooldown(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h, d := newAlertTestHandler(t, config.AlertConfig{
		WebhookURL:      srv.URL,
		FailThreshold:   2,
		CooldownSeconds: 3600,
	})

	for i := 0; i < 2; i++ {
		if err := d.RecordLoginAttempt("1.2.3.4", false); err != nil {
			t.Fatal(err)
		}
	}

	h.maybeAlertLoginFailure("1.2.3.4")
	// 异步发送，轮询等待
	deadline := time.Now().Add(3 * time.Second)
	for hits.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if hits.Load() != 1 {
		t.Fatalf("expected 1 webhook hit at threshold, got %d", hits.Load())
	}

	// 冷却期内再次触发（阈值仍满足）不得重发
	h.maybeAlertLoginFailure("1.2.3.4")
	time.Sleep(200 * time.Millisecond)
	if hits.Load() != 1 {
		t.Fatalf("cooldown violated: got %d hits", hits.Load())
	}
}

// 未达阈值不发送；webhook_url 为空直接关闭功能
func TestAlertBelowThresholdAndDisabled(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	h, d := newAlertTestHandler(t, config.AlertConfig{
		WebhookURL:      srv.URL,
		FailThreshold:   3,
		CooldownSeconds: 600,
	})
	if err := d.RecordLoginAttempt("5.6.7.8", false); err != nil {
		t.Fatal(err)
	}
	h.maybeAlertLoginFailure("5.6.7.8")
	time.Sleep(200 * time.Millisecond)
	if hits.Load() != 0 {
		t.Fatalf("alert fired below threshold: %d", hits.Load())
	}

	// 关闭状态：即使达到阈值也不发送
	for i := 0; i < 5; i++ {
		if err := d.RecordLoginAttempt("9.9.9.9", false); err != nil {
			t.Fatal(err)
		}
	}
	h.config.Alert.WebhookURL = ""
	h.maybeAlertLoginFailure("9.9.9.9")
	time.Sleep(200 * time.Millisecond)
	if hits.Load() != 0 {
		t.Fatalf("alert fired when disabled: %d", hits.Load())
	}
}
