package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"lit-aoss/internal/config"
	"lit-aoss/internal/db"

	"github.com/gin-gonic/gin"
)

// MFASetup 必须验证主密码：仅持会话（如会话被盗）不允许重置 TOTP 密钥。

func newMFATestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	d, err := db.New(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := d.SetupAuth("correct-hash", "salt"); err != nil {
		t.Fatal(err)
	}
	h := NewHandler(d, nil, &config.Config{}, nil)
	r := gin.New()
	r.POST("/mfa/setup", h.MFASetup)
	return r
}

func postMFASsetup(t *testing.T, r *gin.Engine, body map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/mfa/setup", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestMFASetupRequiresPassword(t *testing.T) {
	r := newMFATestRouter(t)

	if w := postMFASsetup(t, r, map[string]string{}); w.Code != http.StatusBadRequest {
		t.Fatalf("missing password_hash: got %d (%s)", w.Code, w.Body.String())
	}

	if w := postMFASsetup(t, r, map[string]string{"password_hash": "wrong"}); w.Code != http.StatusBadRequest {
		t.Fatalf("wrong password: got %d (%s)", w.Code, w.Body.String())
	}

	w := postMFASsetup(t, r, map[string]string{"password_hash": "correct-hash"})
	if w.Code != http.StatusOK {
		t.Fatalf("correct password: got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		OK     bool   `json:"ok"`
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || resp.Secret == "" {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
}

func TestMFASetupLockoutAfterRepeatedFailures(t *testing.T) {
	r := newMFATestRouter(t)

	for i := 0; i < maxTOTPAttempts; i++ {
		w := postMFASsetup(t, r, map[string]string{"password_hash": "wrong"})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d: got %d", i, w.Code)
		}
	}

	w := postMFASsetup(t, r, map[string]string{"password_hash": "correct-hash"})
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected %d after %d failures, got %d", http.StatusTooManyRequests, maxTOTPAttempts, w.Code)
	}
}
