package api

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"lit-aoss/internal/config"
	"lit-aoss/internal/db"
	"lit-aoss/internal/storage"

	"github.com/gin-gonic/gin"
)

// OSS 备份对象统一前缀，与 files/ 隔离
const ossBackupPrefix = "db-backups/"

// ossHTTPClient 从 OSS 下载备份对象用，限时防止挂死
var ossHTTPClient = &http.Client{Timeout: 2 * time.Minute}

type BackupManager struct {
	config         *config.Config
	store          storage.Storage
	db             *db.Database
	ledger         *OSSBackupLedger
	lastBackupTime time.Time
	mu             sync.Mutex
}

func NewBackupManager(cfg *config.Config, store storage.Storage, database *db.Database, ledger *OSSBackupLedger) *BackupManager {
	return &BackupManager{config: cfg, store: store, db: database, ledger: ledger}
}

func (bm *BackupManager) ShouldBackup() bool {
	if !bm.config.Backup.OnFileChange {
		return false
	}
	bm.mu.Lock()
	defer bm.mu.Unlock()
	interval := time.Duration(bm.config.Backup.MinIntervalSec) * time.Second
	if interval < 5*time.Minute {
		interval = 5 * time.Minute
	}
	return time.Since(bm.lastBackupTime) >= interval
}

func (bm *BackupManager) DoBackup() (string, error) {
	bm.mu.Lock()
	defer bm.mu.Unlock()

	if bm.db == nil {
		return "", fmt.Errorf("database not available")
	}

	backupDir := filepath.Join(filepath.Dir(bm.config.Database.Path), "backups")
	if err := os.MkdirAll(backupDir, 0700); err != nil {
		return "", fmt.Errorf("create backup dir: %w", err)
	}

	timestamp := time.Now().Format("20060102_150405")
	backupName := fmt.Sprintf("lit-aoss_%s.db", timestamp)
	backupPath := filepath.Join(backupDir, backupName)

	// VACUUM INTO: 含 WAL 未 checkpoint 数据的一致性快照（文件拷贝会漏掉 WAL）
	if err := bm.db.BackupTo(backupPath); err != nil {
		return "", fmt.Errorf("backup db: %w", err)
	}

	bm.lastBackupTime = time.Now()
	log.Printf("Database backup created: %s", backupPath)
	bm.cleanupOldBackups(backupDir)
	return backupPath, nil
}

// RunResult 是一次备份（含可选 OSS 上传）的完整结果。
type RunResult struct {
	Path      string
	OSSStatus string // not_requested | uploaded | skipped | failed
	OSSErr    error
	Err       error // 本地备份失败
}

// RunBackup 执行本地备份；uploadOSS=true 时按 MD5 跳过逻辑加密上传副本。
func (bm *BackupManager) RunBackup(uploadOSS bool) RunResult {
	path, err := bm.DoBackup()
	if err != nil {
		return RunResult{Err: err}
	}
	res := RunResult{Path: path, OSSStatus: "not_requested"}
	if uploadOSS {
		res.OSSStatus, res.OSSErr = bm.uploadBackupToOSS(path)
	}
	return res
}

func (bm *BackupManager) uploadBackupToOSS(path string) (string, error) {
	if bm.store == nil {
		return "failed", fmt.Errorf("storage not configured")
	}
	if bm.ledger == nil {
		return "failed", fmt.Errorf("backup ledger not available")
	}

	plain, err := os.ReadFile(path)
	if err != nil {
		return "failed", fmt.Errorf("read backup: %w", err)
	}
	sum := md5.Sum(plain)
	md5hex := hex.EncodeToString(sum[:])

	// 与台账最新一次成功上传比对：内容无变化则跳过（不依赖 OSS ListObjects 权限）
	if latest := bm.ledger.Latest(); latest != nil && latest.MD5 == md5hex {
		log.Printf("OSS backup skipped, content unchanged (md5=%s)", md5hex)
		return "skipped", nil
	}

	// 无口令即拒绝上传，杜绝明文备份上云
	passphrase := bm.config.GetPassphrase()
	if passphrase == "" {
		return "failed", fmt.Errorf("未配置数据库口令(LITAOSS_PASSPHRASE)，拒绝上传备份到 OSS")
	}

	blob, err := config.EncryptBackup(plain, passphrase)
	if err != nil {
		return "failed", fmt.Errorf("encrypt backup: %w", err)
	}

	name := filepath.Base(path)
	ossKey := ossBackupPrefix + name + ".enc"
	if err := bm.store.Upload(context.Background(), ossKey, blob, "application/octet-stream"); err != nil {
		return "failed", err
	}
	// 台账写独立文件（不进数据库），避免台账写入本身改变下一次备份的 md5
	if err := bm.ledger.Append(name, ossKey, md5hex, int64(len(blob))); err != nil {
		log.Printf("record oss backup failed (upload ok): %v", err)
	}
	log.Printf("OSS backup uploaded: %s (md5=%s)", ossKey, md5hex)
	return "uploaded", nil
}

func (bm *BackupManager) cleanupOldBackups(dir string) {
	maxBackups := bm.config.Backup.MaxBackups
	if maxBackups <= 0 {
		maxBackups = 10
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}

	var backups []os.DirEntry
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "lit-aoss_") && strings.HasSuffix(e.Name(), ".db") {
			backups = append(backups, e)
		}
	}

	if len(backups) <= maxBackups {
		return
	}

	sort.Slice(backups, func(i, j int) bool {
		iInfo, _ := backups[i].Info()
		jInfo, _ := backups[j].Info()
		return iInfo.ModTime().After(jInfo.ModTime())
	})

	for _, old := range backups[maxBackups:] {
		os.Remove(filepath.Join(dir, old.Name()))
	}
}

func (h *Handler) GetBackupConfig(c *gin.Context) {
	resp := gin.H{
		"ok": true,
		"config": gin.H{
			"auto_backup":             h.config.Backup.AutoBackup,
			"backup_time":             h.config.Backup.BackupTime,
			"on_file_change":          h.config.Backup.OnFileChange,
			"min_interval":            h.config.Backup.MinIntervalSec,
			"max_backups":             h.config.Backup.MaxBackups,
			"auto_backup_upload_oss":  h.config.Backup.AutoBackupUploadOSS,
			"on_file_change_upload_oss": h.config.Backup.OnFileChangeUploadOSS,
		},
	}
	// 最近一次 OSS 上传摘要（台账最新行）
	if latest := h.ledger.Latest(); latest != nil {
		resp["oss_backup"] = gin.H{
			"name":        latest.Name,
			"md5":         latest.MD5,
			"file_size":   latest.FileSize,
			"uploaded_at": latest.UploadedAt.Format(time.RFC3339),
		}
	} else {
		resp["oss_backup"] = nil
	}
	c.JSON(http.StatusOK, resp)
}

func (h *Handler) UpdateBackupConfig(c *gin.Context) {
	var req struct {
		AutoBackup          *bool   `json:"auto_backup"`
		BackupTime          *string `json:"backup_time"`
		OnFileChange        *bool   `json:"on_file_change"`
		MinIntervalSec      *int    `json:"min_interval"`
		MaxBackups          *int    `json:"max_backups"`
		AutoBackupUploadOSS *bool   `json:"auto_backup_upload_oss"`
		OnFileChangeUploadOSS *bool `json:"on_file_change_upload_oss"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request"})
		return
	}

	if req.AutoBackup != nil {
		h.config.Backup.AutoBackup = *req.AutoBackup
	}
	if req.BackupTime != nil {
		h.config.Backup.BackupTime = *req.BackupTime
	}
	if req.OnFileChange != nil {
		h.config.Backup.OnFileChange = *req.OnFileChange
	}
	if req.MinIntervalSec != nil {
		h.config.Backup.MinIntervalSec = *req.MinIntervalSec
	}
	if req.MaxBackups != nil {
		h.config.Backup.MaxBackups = *req.MaxBackups
	}
	if req.AutoBackupUploadOSS != nil {
		h.config.Backup.AutoBackupUploadOSS = *req.AutoBackupUploadOSS
	}
	if req.OnFileChangeUploadOSS != nil {
		h.config.Backup.OnFileChangeUploadOSS = *req.OnFileChangeUploadOSS
	}

	if err := h.config.Save("config.json"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "failed to save config"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) ManualBackup(c *gin.Context) {
	var req struct {
		UploadOSS bool `json:"upload_oss"`
	}
	if err := c.ShouldBindJSON(&req); err != nil && err != io.EOF {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request"})
		return
	}

	bm := NewBackupManager(h.config, h.storage, h.db, h.ledger)
	res := bm.RunBackup(req.UploadOSS)
	if res.Err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": res.Err.Error()})
		return
	}
	resp := gin.H{"ok": true, "path": res.Path, "oss": res.OSSStatus}
	if res.OSSErr != nil {
		resp["oss_error"] = res.OSSErr.Error()
	}
	c.JSON(http.StatusOK, resp)
}

func (h *Handler) ListBackups(c *gin.Context) {
	dbPath := h.config.Database.Path
	backupDir := filepath.Join(filepath.Dir(dbPath), "backups")

	entries, err := os.ReadDir(backupDir)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"ok": true, "backups": []gin.H{}})
		return
	}

	var backups []gin.H
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "lit-aoss_") || !strings.HasSuffix(e.Name(), ".db") {
			continue
		}
		info, _ := e.Info()
		backups = append(backups, gin.H{
			"name":      e.Name(),
			"size":      info.Size(),
			"created_at": info.ModTime().Format(time.RFC3339),
		})
	}

	sort.Slice(backups, func(i, j int) bool {
		return backups[i]["created_at"].(string) > backups[j]["created_at"].(string)
	})

	// OSS 加密备份台账（本地文件，不调用 OSS ListObjects）
	ossBackups := h.ledger.List()
	if ossBackups == nil {
		ossBackups = []OSSBackupLedgerEntry{}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "backups": backups, "oss_backups": ossBackups})
}

// restoreDBFrom 把 srcPath 的数据库内容暂存为 <db>.restore，重启时由
// applyPendingRestore 应用。不能直接覆盖主文件: 运行中的连接仍持有旧状态，
// 且启动时 decryptOnStart 会用旧 .db.enc 覆盖恢复结果、残留 -wal 会被重放。
func (h *Handler) restoreDBFrom(srcPath string) error {
	bm := NewBackupManager(h.config, h.storage, h.db, h.ledger)
	bm.DoBackup()

	src, err := os.Open(srcPath)
	if err != nil {
		return fmt.Errorf("open backup")
	}
	defer src.Close()

	stagingPath := h.config.Database.Path + ".restore"
	dst, err := os.OpenFile(stagingPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("create restore staging file")
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		return fmt.Errorf("restore failed")
	}
	return nil
}

func (h *Handler) RestoreBackup(c *gin.Context) {
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request"})
		return
	}

	if req.Name == "" || strings.Contains(req.Name, "/") || strings.Contains(req.Name, "\\") || strings.Contains(req.Name, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid backup name"})
		return
	}

	// 恢复数据库会覆盖 mfa/sessions 等敏感表，属于高危操作，启用 MFA 时需先验证
	if !h.requireDeleteMFA(c) {
		return
	}

	dbPath := h.config.Database.Path
	backupDir := filepath.Join(filepath.Dir(dbPath), "backups")
	backupPath := filepath.Join(backupDir, req.Name)

	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "backup not found"})
		return
	}

	if err := h.restoreDBFrom(backupPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	log.Printf("Database restored from backup: %s", backupPath)
	c.JSON(http.StatusOK, gin.H{"ok": true, "message": "restore staged, restart server to apply"})
}

// RestoreBackupOSS 从 OSS 下载加密备份、解密后走与本地恢复相同的覆盖流程。
func (h *Handler) RestoreBackupOSS(c *gin.Context) {
	var req struct {
		OSSKey string `json:"oss_key"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.OSSKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request"})
		return
	}
	if !strings.HasPrefix(req.OSSKey, ossBackupPrefix) {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid oss key"})
		return
	}

	// 与本地恢复同级的高危操作，启用 MFA 时需先验证
	if !h.requireDeleteMFA(c) {
		return
	}

	// 只允许恢复台账中记录过的对象，拒绝任意 key
	if h.ledger == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "backup ledger not available"})
		return
	}
	if h.ledger.GetByKey(req.OSSKey) == nil {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "backup not found in ledger"})
		return
	}

	passphrase := h.config.GetPassphrase()
	if passphrase == "" {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "未配置数据库口令(LITAOSS_PASSPHRASE)，无法解密 OSS 备份"})
		return
	}

	// 下载密文对象
	downloadURL, err := h.storage.GeneratePresignedDownloadURL(c.Request.Context(), req.OSSKey, 15*time.Minute)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "generate download url failed"})
		return
	}
	httpReq, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, downloadURL, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "build download request failed"})
		return
	}
	resp, err := ossHTTPClient.Do(httpReq)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "download oss backup failed"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": fmt.Sprintf("download failed: HTTP %d", resp.StatusCode)})
		return
	}
	const maxBackupSize = 256 << 20
	blob, err := io.ReadAll(io.LimitReader(resp.Body, maxBackupSize))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "read oss backup failed"})
		return
	}
	if len(blob) >= maxBackupSize {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "oss backup too large"})
		return
	}

	plain, err := config.DecryptBackup(blob, passphrase)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "decrypt oss backup failed: " + err.Error()})
		return
	}

	tmp, err := os.CreateTemp("", "lit-aoss-oss-restore-*.db")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "create temp file failed"})
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(plain); err != nil {
		tmp.Close()
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "write temp file failed"})
		return
	}
	if err := tmp.Close(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "write temp file failed"})
		return
	}

	if err := h.restoreDBFrom(tmpPath); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	log.Printf("Database restored from OSS backup: %s", req.OSSKey)
	c.JSON(http.StatusOK, gin.H{"ok": true, "message": "restore staged, restart server to apply"})
}

// ---- 恢复演练 (backup drill) ----

// DrillCheck 是恢复演练中单项检查的结果。
type DrillCheck struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// DrillReport 是一次恢复演练的完整报告。
type DrillReport struct {
	OK          bool         `json:"ok"`
	Name        string       `json:"name"`
	Size        int64        `json:"size"`
	CreatedAt   string       `json:"created_at"`
	Checks      []DrillCheck `json:"checks"`
	FileCount   int          `json:"file_count"`
	FolderCount int          `json:"folder_count"`
	DurationMS  int64        `json:"duration_ms"`
	Error       string       `json:"error,omitempty"`
}

// drillBackupFile 把备份复制到临时目录，走与真实恢复启动完全相同的路径
// （db.New → 建表/迁移 → 全量查询）做只读体检，全程不触碰线上数据库、
// 不写 .restore 暂存文件，因此可反复执行、无需 MFA 二次验证。
func drillBackupFile(backupPath string) DrillReport {
	start := time.Now()
	report := DrillReport{Name: filepath.Base(backupPath)}

	pass := func(name, detail string) {
		report.Checks = append(report.Checks, DrillCheck{Name: name, OK: true, Detail: detail})
	}
	fail := func(name, detail string) DrillReport {
		report.Checks = append(report.Checks, DrillCheck{Name: name, OK: false, Detail: detail})
		report.Error = detail
		report.DurationMS = time.Since(start).Milliseconds()
		return report
	}

	info, err := os.Stat(backupPath)
	if err != nil {
		return fail("备份文件", err.Error())
	}
	report.Size = info.Size()
	report.CreatedAt = info.ModTime().Format(time.RFC3339)
	pass("备份文件", fmt.Sprintf("%s（%d 字节）", filepath.Base(backupPath), info.Size()))

	tmpDir, err := os.MkdirTemp("", "lit-aoss-drill-*")
	if err != nil {
		return fail("临时目录", err.Error())
	}
	defer os.RemoveAll(tmpDir)

	// 与恢复暂存等价的字节级拷贝，绝不动线上文件
	src, err := os.Open(backupPath)
	if err != nil {
		return fail("复制备份", err.Error())
	}
	dstPath := filepath.Join(tmpDir, "backup.db")
	dst, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		src.Close()
		return fail("复制备份", err.Error())
	}
	_, err = io.Copy(dst, src)
	src.Close()
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fail("复制备份", err.Error())
	}
	pass("字节级拷贝", "已复制到临时目录（不写 .restore，不碰线上数据）")

	// db.New = 恢复后重启所执行的同一套初始化（建表 + 全量迁移 + 补列回填）
	d, err := db.New(dstPath)
	if err != nil {
		return fail("打开与迁移", err.Error())
	}
	defer d.Close()
	pass("打开与迁移", "建表与迁移全部通过（含历史库补列回填）")

	setup, err := d.IsSetupComplete()
	if err != nil {
		return fail("账号数据", err.Error())
	}
	if !setup {
		return fail("账号数据", "主密码哈希或加密密钥缺失，恢复后将无法登录")
	}
	pass("账号数据", "主密码哈希与加密密钥齐备")

	statRows, err := d.GetFileStatRows()
	if err != nil {
		return fail("文件全量扫描", err.Error())
	}
	for _, r := range statRows {
		if r.IsDirectory {
			report.FolderCount++
		} else {
			report.FileCount++
		}
	}
	pass("文件全量扫描", fmt.Sprintf("%d 个文件 / %d 个目录", report.FileCount, report.FolderCount))

	root, err := d.GetFiles(nil)
	if err != nil {
		return fail("根目录文件列表", err.Error())
	}
	pass("根目录文件列表", fmt.Sprintf("%d 条根目录记录可正常读取", len(root)))

	mfa, err := d.GetMFA()
	if err != nil {
		return fail("MFA 状态表", err.Error())
	}
	if mfa != nil {
		pass("MFA 状态表", "MFA 记录可读取")
	} else {
		pass("MFA 状态表", "未启用 MFA（表结构可读）")
	}

	report.OK = true
	report.DurationMS = time.Since(start).Milliseconds()
	return report
}

// BackupDrill 恢复演练：验证指定备份（缺省为最新一份）能被真实恢复流程打开、
// 迁移并读取。只读操作，始终以 200 返回体检报告（ok=false 表示体检失败，
// 由前端渲染失败项），仅“找不到备份”时返回 404。
func (h *Handler) BackupDrill(c *gin.Context) {
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil && err != io.EOF {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid request"})
		return
	}
	if strings.Contains(req.Name, "/") || strings.Contains(req.Name, "\\") || strings.Contains(req.Name, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "invalid backup name"})
		return
	}

	backupDir := filepath.Join(filepath.Dir(h.config.Database.Path), "backups")
	backupPath := ""

	if req.Name != "" {
		backupPath = filepath.Join(backupDir, req.Name)
		if _, err := os.Stat(backupPath); os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "backup not found"})
			return
		}
	} else {
		// 与 ListBackups 相同的命名规则，取修改时间最新的一份
		entries, err := os.ReadDir(backupDir)
		if err == nil {
			var latest string
			var latestMod time.Time
			for _, e := range entries {
				if e.IsDir() || !strings.HasPrefix(e.Name(), "lit-aoss_") || !strings.HasSuffix(e.Name(), ".db") {
					continue
				}
				if info, ierr := e.Info(); ierr == nil && info.ModTime().After(latestMod) {
					latestMod = info.ModTime()
					latest = e.Name()
				}
			}
			if latest != "" {
				backupPath = filepath.Join(backupDir, latest)
			}
		}
		if backupPath == "" {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "no backups found"})
			return
		}
	}

	report := drillBackupFile(backupPath)
	log.Printf("Backup drill %s: ok=%v (%dms)", report.Name, report.OK, report.DurationMS)
	c.JSON(http.StatusOK, gin.H{"ok": report.OK, "report": report})
}
