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

// 恢复码是长期 MFA 凭证：生成/重生成必须验证主密码（与 mfa/setup、mfa/disable 同策略）。

func newRecoveryGenerateRouter(t *testing.T, mfaEnabled bool) *gin.Engine {
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
	if mfaEnabled {
		if err := d.SetupMFA("TESTSECRET"); err != nil {
			t.Fatal(err)
		}
		if err := d.EnableMFA(); err != nil {
			t.Fatal(err)
		}
	}
	h := NewHandler(d, nil, &config.Config{}, nil)
	r := gin.New()
	r.POST("/mfa/recovery-codes", h.GenerateRecoveryCodes)
	return r
}

func postRecoveryCodes(t *testing.T, r *gin.Engine, body map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/mfa/recovery-codes", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestGenerateRecoveryCodesRequiresPassword(t *testing.T) {
	r := newRecoveryGenerateRouter(t, true)

	if w := postRecoveryCodes(t, r, map[string]string{}); w.Code != http.StatusBadRequest {
		t.Fatalf("missing password_hash: got %d (%s)", w.Code, w.Body.String())
	}

	if w := postRecoveryCodes(t, r, map[string]string{"password_hash": "wrong"}); w.Code != http.StatusBadRequest {
		t.Fatalf("wrong password: got %d (%s)", w.Code, w.Body.String())
	}

	w := postRecoveryCodes(t, r, map[string]string{"password_hash": "correct-hash"})
	if w.Code != http.StatusOK {
		t.Fatalf("correct password: got %d (%s)", w.Code, w.Body.String())
	}
	var resp struct {
		OK    bool     `json:"ok"`
		Codes []string `json:"codes"`
		Total int      `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || resp.Total != 10 || len(resp.Codes) != 10 {
		t.Fatalf("unexpected response: %s", w.Body.String())
	}
}

func TestGenerateRecoveryCodesRequiresMFAEnabled(t *testing.T) {
	r := newRecoveryGenerateRouter(t, false)

	w := postRecoveryCodes(t, r, map[string]string{"password_hash": "correct-hash"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("mfa disabled: got %d (%s)", w.Code, w.Body.String())
	}
}

func TestGenerateRecoveryCodesLockoutAfterRepeatedFailures(t *testing.T) {
	r := newRecoveryGenerateRouter(t, true)

	for i := 0; i < maxTOTPAttempts; i++ {
		w := postRecoveryCodes(t, r, map[string]string{"password_hash": "wrong"})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("attempt %d: got %d", i, w.Code)
		}
	}

	w := postRecoveryCodes(t, r, map[string]string{"password_hash": "correct-hash"})
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("expected %d after %d failures, got %d", http.StatusTooManyRequests, maxTOTPAttempts, w.Code)
	}
}
