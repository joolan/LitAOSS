package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"lit-aoss/internal/config"
	"lit-aoss/internal/db"

	"github.com/gin-gonic/gin"
	"github.com/pquerna/otp/totp"
)

func newLoginLogTestRouter(t *testing.T) (*gin.Engine, *db.Database) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	d, err := db.New(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := d.SetupAuth("hash", "salt"); err != nil {
		t.Fatal(err)
	}
	if err := d.SetupMFA("TESTSECRET"); err != nil {
		t.Fatal(err)
	}
	if err := d.EnableMFA(); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{}
	cfg.Auth.MFAEnabled = true
	cfg.Auth.MaxLoginAttempts = 5
	cfg.Auth.LockoutDuration = 900
	h := NewHandler(d, nil, cfg, nil)
	r := gin.New()
	r.POST("/login", h.Login)
	r.POST("/verify-totp", h.VerifyTOTPEndpoint)
	r.GET("/login/history", h.GetLoginHistory)
	return r, d
}

func loginDo(t *testing.T, r *gin.Engine, path string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("X-Session-Token", token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func loginHistoryCount(t *testing.T, r *gin.Engine) int {
	t.Helper()
	req := httptest.NewRequest("GET", "/login/history", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("history status = %d, body=%s", w.Code, w.Body)
	}
	var resp struct {
		Attempts []any `json:"attempts"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return len(resp.Attempts)
}

// 密码错误与 MFA 码错误都必须进入登录日志；历史失败行永不物理清零；
// 成功登录后旧失败不再计入锁定计数。
func TestLoginHistoryRecordsPasswordAndMFAFailures(t *testing.T) {
	r, d := newLoginLogTestRouter(t)

	// 1. 密码错误 → 401 + 日志 1 行
	wrong := gin.H{"auth_hash": "wrong", "salt": "s"}
	right := gin.H{"auth_hash": "hash", "salt": "s"}
	if w := loginDo(t, r, "/login", wrong, ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password status = %d, want 401", w.Code)
	}
	if n := loginHistoryCount(t, r); n != 1 {
		t.Fatalf("history after wrong password = %d, want 1", n)
	}

	// 2. 密码正确（MFA 开启）→ 200 但为 pending；完整登录未完成，暂无 success 行
	w := loginDo(t, r, "/login", right, "")
	if w.Code != http.StatusOK {
		t.Fatalf("login status = %d, body=%s", w.Code, w.Body)
	}
	var lr struct {
		OK           bool   `json:"ok"`
		MFARequired  bool   `json:"mfa_required"`
		SessionToken string `json:"session_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &lr); err != nil {
		t.Fatal(err)
	}
	if !lr.OK || !lr.MFARequired || lr.SessionToken == "" {
		t.Fatalf("login resp = %+v, want mfa_required with token", lr)
	}
	if n := loginHistoryCount(t, r); n != 1 {
		t.Fatalf("history after password-ok pending MFA = %d, want 1 (success 延迟记录)", n)
	}

	// 3. MFA 错码 → 400 + 日志新增 1 行失败
	if w := loginDo(t, r, "/verify-totp", gin.H{"code": "000000"}, lr.SessionToken); w.Code != http.StatusBadRequest {
		t.Fatalf("wrong totp status = %d, want 400", w.Code)
	}
	if n := loginHistoryCount(t, r); n != 2 {
		t.Fatalf("history after wrong TOTP = %d, want 2", n)
	}
	if cnt, err := d.GetFailedLoginCount(time.Hour); err != nil || cnt != 2 {
		t.Fatalf("failed count = %d, err=%v; want 2", cnt, err)
	}

	// 4. 有效 TOTP 码 → 200 + success 行
	code, err := totp.GenerateCode("TESTSECRET", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if w := loginDo(t, r, "/verify-totp", gin.H{"code": code}, lr.SessionToken); w.Code != http.StatusOK {
		t.Fatalf("valid totp status = %d, body=%s", w.Code, w.Body)
	}
	if n := loginHistoryCount(t, r); n != 3 {
		t.Fatalf("history after successful MFA = %d, want 3", n)
	}
	// 成功后：历史 3 行全保留，但旧失败不再计数
	if cnt, err := d.GetFailedLoginCount(time.Hour); err != nil || cnt != 0 {
		t.Fatalf("failed count after success = %d, err=%v; want 0", cnt, err)
	}

	// 5. 成功之后的新失败：入日志并重新计数
	if w := loginDo(t, r, "/login", wrong, ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password after success status = %d", w.Code)
	}
	if n := loginHistoryCount(t, r); n != 4 {
		t.Fatalf("history = %d, want 4 (旧失败保留 + 新失败)", n)
	}
	if cnt, err := d.GetFailedLoginCount(time.Hour); err != nil || cnt != 1 {
		t.Fatalf("failed count = %d, err=%v; want 1", cnt, err)
	}
}
