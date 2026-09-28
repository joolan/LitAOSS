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

func newTrashTestRouter(t *testing.T) *gin.Engine {
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
	h := NewHandler(d, nil, &config.Config{}, nil)
	r := gin.New()
	r.POST("/folders", h.CreateFolder)
	r.DELETE("/files/:id", h.DeleteFile)
	r.GET("/trash", h.ListTrash)
	r.POST("/trash/purge", h.PurgeTrash)
	r.POST("/trash/:id/restore", h.RestoreFile)
	r.GET("/audit", h.ListAudit)
	return r
}

func trashDo(t *testing.T, r *gin.Engine, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// 回收站 API 流程：删除 → 列表可见 → 恢复 → 列表清空 → 再删 → 清空 → 审计留痕
func TestTrashFlowAPI(t *testing.T) {
	r := newTrashTestRouter(t)

	// 建文件
	w := trashDo(t, r, "POST", "/folders", map[string]any{
		"name_encrypted": "ZGly",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("create folder: %d (%s)", w.Code, w.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.ID == "" {
		t.Fatalf("bad folder response: %s", w.Body.String())
	}

	// 删除
	if w := trashDo(t, r, "DELETE", "/files/"+created.ID, map[string]string{"id": created.ID}); w.Code != http.StatusOK {
		t.Fatalf("delete: %d (%s)", w.Code, w.Body.String())
	}

	// 回收站列表可见
	w = trashDo(t, r, "GET", "/trash", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list trash: %d", w.Code)
	}
	var list struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		RetentionDays int `json:"retention_days"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Items) != 1 {
		t.Fatalf("trash list = %s, err=%v", w.Body.String(), err)
	}
	if list.RetentionDays != 0 {
		t.Fatalf("retention_days = %d, want 0 (test config zero value)", list.RetentionDays)
	}

	// 恢复
	wRestore := trashDo(t, r, "POST", "/trash/"+created.ID+"/restore", nil)
	if wRestore.Code != http.StatusOK {
		t.Fatalf("restore: %d (%s)", wRestore.Code, wRestore.Body.String())
	}
	w = trashDo(t, r, "GET", "/trash", nil)
	if w.Code != http.StatusOK {
		t.Fatal("list after restore failed")
	}
	var after struct {
		Items []json.RawMessage `json:"items"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &after)
	if len(after.Items) != 0 {
		t.Fatalf("trash not empty after restore: %s", w.Body.String())
	}

	// 恢复不存在的条目 → 404
	if w := trashDo(t, r, "POST", "/trash/no-such-id/restore", nil); w.Code != http.StatusNotFound {
		t.Fatalf("restore missing: got %d", w.Code)
	}

	// 再删 → 清空
	if w := trashDo(t, r, "DELETE", "/files/"+created.ID, map[string]string{"id": created.ID}); w.Code != http.StatusOK {
		t.Fatalf("delete 2: %d", w.Code)
	}
	w = trashDo(t, r, "POST", "/trash/purge", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("purge: %d (%s)", w.Code, w.Body.String())
	}
	var purged struct {
		Purged int64 `json:"purged"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &purged); err != nil || purged.Purged != 1 {
		t.Fatalf("purge response: %s", w.Body.String())
	}

	// 审计留痕：delete ×2 + restore + purge_trash
	w = trashDo(t, r, "GET", "/audit?page=1&page_size=50", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("audit: %d", w.Code)
	}
	var audit struct {
		Items []struct {
			Action string `json:"action"`
		} `json:"items"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &audit); err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, it := range audit.Items {
		counts[it.Action]++
	}
	if counts["delete"] != 2 || counts["restore"] != 1 || counts["purge_trash"] != 1 {
		t.Fatalf("audit counts = %v, want delete=2 restore=1 purge_trash=1", counts)
	}
}
