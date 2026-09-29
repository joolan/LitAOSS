package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"lit-aoss/internal/config"
	"lit-aoss/internal/db"
	"lit-aoss/internal/models"
	"lit-aoss/internal/storage"
	"lit-aoss/internal/version"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	maxTOTPAttempts     = 5
	totpLockoutDuration = 15 * time.Minute
)

// fileOSSKeyPattern 仅放行 GenerateOSSKey 生成的对象键（files/<uuid>/<hex>.enc），
// 防止持会话者对桶内任意前缀（如 db-backups/）申请预签名读写。
var fileOSSKeyPattern = regexp.MustCompile(
	`^files/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[0-9a-f]{72}\.enc$`,
)

type Handler struct {
	db             *db.Database
	storage        storage.Storage
	config         *config.Config
	sessions       *SessionStore
	setupMutex     sync.Mutex
	backupManager  *BackupManager
	ledger         *OSSBackupLedger
	lastBackupTime time.Time
	backupMutex    sync.Mutex
	// 登录失败告警冷却：ip → 上次发送时间（内存态，重启重置）
	alertMu   sync.Mutex
	alertLast map[string]time.Time
}

// NewHandler ledger 由调用方创建并在 scheduler 间共享（单一实例保证台账缓存一致）。
func NewHandler(database *db.Database, store storage.Storage, cfg *config.Config, ledger *OSSBackupLedger) *Handler {
	return &Handler{
		db:            database,
		storage:       store,
		config:        cfg,
		sessions:      NewSessionStore(),
		backupManager: NewBackupManager(cfg, store, database, ledger),
		ledger:        ledger,
		alertLast:     make(map[string]time.Time),
	}
}

// audit 尽力记录操作审计（失败仅记日志、不影响业务）；文件名存密文保持零知识，
// IP 经 SetTrustedProxies 后由 c.ClientIP 给出（只采信可信代理提交的转发头）。
func (h *Handler) audit(c *gin.Context, action, targetType, targetID, targetName, detail string) {
	if err := h.db.RecordAudit(action, targetType, targetID, targetName, detail, c.ClientIP()); err != nil {
		log.Printf("audit record failed (%s): %v", action, err)
	}
}

func (h *Handler) RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.GetHeader("X-Session-Token")
		if token == "" {
			c.JSON(http.StatusUnauthorized, models.MessageResponse{OK: false, Error: "unauthorized"})
			c.Abort()
			return
		}
		if !h.sessions.Validate(token) {
			c.JSON(http.StatusUnauthorized, models.MessageResponse{OK: false, Error: "invalid or expired session"})
			c.Abort()
			return
		}

		if h.config.Auth.MFAEnabled && h.sessions.IsPendingMFA(token) {
			c.JSON(http.StatusForbidden, models.MessageResponse{OK: false, Error: "MFA verification required"})
			c.Abort()
			return
		}

		c.Next()
	}
}

func (h *Handler) RequireAuthNoMFA() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.GetHeader("X-Session-Token")
		if token == "" {
			c.JSON(http.StatusUnauthorized, models.MessageResponse{OK: false, Error: "unauthorized"})
			c.Abort()
			return
		}
		if !h.sessions.Validate(token) {
			c.JSON(http.StatusUnauthorized, models.MessageResponse{OK: false, Error: "invalid or expired session"})
			c.Abort()
			return
		}
		c.Next()
	}
}

func (h *Handler) SetupRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		complete, err := h.db.IsSetupComplete()
		if err != nil {
			c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"setup_complete": complete})
	}
}

func (h *Handler) Setup(c *gin.Context) {
	h.setupMutex.Lock()
	defer h.setupMutex.Unlock()

	var req models.SetupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	complete, _ := h.db.IsSetupComplete()
	if complete {
		c.JSON(http.StatusConflict, models.MessageResponse{OK: false, Error: "already setup"})
		return
	}

	if err := h.db.SetupAuth(req.PasswordHash, req.Salt); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "setup failed"})
		return
	}

	if err := h.db.UpdateEncryptedAccountKey(req.EncryptedAccountKey); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "setup failed"})
		return
	}

	c.JSON(http.StatusOK, models.SetupResponse{OK: true})
}

func (h *Handler) Login(c *gin.Context) {
	ip := c.ClientIP()

	failedCount, _ := h.db.GetFailedLoginCount(time.Duration(h.config.Auth.LockoutDuration) * time.Second)
	if failedCount >= h.config.Auth.MaxLoginAttempts {
		c.JSON(http.StatusTooManyRequests, models.LoginResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed attempts, try again in %d seconds", h.config.Auth.LockoutDuration),
		})
		return
	}

	var req models.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.LoginResponse{OK: false, Error: "invalid request"})
		return
	}

	ok, err := h.db.VerifyPassword(req.AuthHash)
	if err != nil || !ok {
		h.db.RecordLoginAttempt(ip, false)
		h.maybeAlertLoginFailure(ip)
		c.JSON(http.StatusUnauthorized, models.LoginResponse{OK: false, Error: "invalid credentials"})
		return
	}

	encKey, err := h.db.GetEncryptedAccountKey()
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.LoginResponse{OK: false, Error: err.Error()})
		return
	}

	salt, err := h.db.GetAuthSalt()
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.LoginResponse{OK: false, Error: err.Error()})
		return
	}

	mfaRequired := false
	if h.config.Auth.MFAEnabled {
		mfaRecord, _ := h.db.GetMFA()
		if mfaRecord != nil && mfaRecord.Enabled {
			mfaRequired = true
		}
	}

	// 成功记录 = 完整登录：MFA 关闭时密码正确即记；开启时由 VerifyTOTP/恢复码
	// 通过后再记。历史失败行一律保留（审计），锁定计数按「晚于最近成功的失败」计算。
	if !mfaRequired {
		h.db.RecordLoginAttempt(ip, true)
	}

	var token string
	if mfaRequired {
		token = h.sessions.CreatePendingMFA()
	} else {
		token = h.sessions.Create()
	}

	// 单会话在线：新登录成功即踢下线此前的所有会话（含停留在 MFA 验证页的会话）
	h.sessions.DeleteAllExcept(token)

	c.JSON(http.StatusOK, models.LoginResponse{
		OK:                 true,
		EncryptedAccountKey: encKey,
		Salt:               salt,
		SessionToken:       token,
		MFARequired:        mfaRequired,
		Version:            version.Version,
	})
}

func (h *Handler) Logout(c *gin.Context) {
	token := c.GetHeader("X-Session-Token")
	if token != "" {
		h.sessions.Delete(token)
	}
	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) GetSalt(c *gin.Context) {
	salt, err := h.db.GetAuthSalt()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get salt"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"salt": salt})
}

func (h *Handler) GetLoginHistory(c *gin.Context) {
	attempts, err := h.db.GetLoginHistory(50)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "failed to load history"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"attempts": attempts})
}

// ListAudit 操作审计分页列表：page（1 起）、page_size（默认 50、上限 200）、action 过滤
func (h *Handler) ListAudit(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("page"))
	pageSize, _ := strconv.Atoi(c.Query("page_size"))
	action := c.Query("action")
	if action != "" {
		switch action {
		case "upload", "download", "delete", "rename", "move", "edit", "change_password",
			"create_folder", "restore", "purge_trash":
		default:
			c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid action"})
			return
		}
	}
	items, total, err := h.db.ListAudit(page, pageSize, action)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "failed to load audit log"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "total": total})
}

func (h *Handler) UpdateKey(c *gin.Context) {
	var req struct {
		EncryptedAccountKey []byte `json:"encrypted_account_key" binding:"required"`
		PasswordHash        string `json:"password_hash" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	failedCount, _ := h.db.GetFailedVerificationCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	ok, _ := h.db.VerifyPassword(req.PasswordHash)
	if !ok {
		h.db.RecordVerificationAttempt(false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid password"})
		return
	}
	h.db.RecordVerificationAttempt(true)

	if err := h.db.UpdateEncryptedAccountKey(req.EncryptedAccountKey); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "failed to update key"})
		return
	}

	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) ChangePassword(c *gin.Context) {
	var req struct {
		OldPasswordHash     string `json:"old_password_hash" binding:"required"`
		NewPasswordHash     string `json:"new_password_hash" binding:"required"`
		NewEncryptedAccountKey []byte `json:"new_encrypted_account_key" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	failedCount, _ := h.db.GetFailedVerificationCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	ok, _ := h.db.VerifyPassword(req.OldPasswordHash)
	if !ok {
		h.db.RecordVerificationAttempt(false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "旧密码错误"})
		return
	}
	h.db.RecordVerificationAttempt(true)

	if err := h.db.UpdatePassword(req.NewPasswordHash, req.NewEncryptedAccountKey); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "failed to update password"})
		return
	}

	h.audit(c, "change_password", "account", "", "", "")

	// 改密码后注销所有会话（含其它设备/被盗会话），强制全部重新登录
	h.sessions.DeleteAll()

	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) ListFiles(c *gin.Context) {
	parentID := c.Query("parent_id")
	var pid *string
	if parentID != "" {
		pid = &parentID
	}

	files, err := h.db.GetFiles(pid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.FileListResponse{})
		return
	}

	if files == nil {
		files = []models.FileRecord{}
	}

	c.JSON(http.StatusOK, models.FileListResponse{Files: files})
}

func (h *Handler) GetFile(c *gin.Context) {
	id := c.Param("id")
	file, err := h.db.GetFile(id)
	if err != nil {
		c.JSON(http.StatusNotFound, models.MessageResponse{OK: false, Error: "file not found"})
		return
	}
	c.JSON(http.StatusOK, file)
}

func (h *Handler) CreateFolder(c *gin.Context) {
	var req struct {
		NameEncrypted string  `json:"name_encrypted" binding:"required"`
		ParentID      *string `json:"parent_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	file := &models.FileRecord{
		ID:              uuid.New().String(),
		NameEncrypted:   req.NameEncrypted,
		ParentID:        req.ParentID,
		IsDirectory:     true,
		FileSize:        0,
		FileType:        "",
		OSSKey:          "",
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
	}

	if err := h.db.CreateFile(file); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	h.audit(c, "create_folder", "folder", file.ID, req.NameEncrypted, "")
	c.JSON(http.StatusOK, file)
}

func (h *Handler) CreateFileRecord(c *gin.Context) {
	var req models.FileUploadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	var pid *string
	if req.ParentID != "" {
		pid = &req.ParentID
	}

	file := &models.FileRecord{
		ID:               uuid.New().String(),
		NameEncrypted:    req.NameEncrypted,
		ParentID:         pid,
		IsDirectory:      false,
		FileSize:         req.FileSize,
		FileType:         req.FileType,
		OSSKey:           req.OSSKey,
		EncryptedFileKey: req.EncryptedFileKey,
		IV:               req.IV,
		Salt:             req.Salt,
		ContentHash:      req.ContentHash,
		CreatedAt:        time.Now(),
		UpdatedAt:        time.Now(),
	}

	if err := h.db.CreateFile(file); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	h.audit(c, "upload", "file", file.ID, req.NameEncrypted, strconv.FormatInt(req.FileSize, 10))
	h.triggerBackup()
	c.JSON(http.StatusOK, file)
}

func (h *Handler) UpdateFileContent(c *gin.Context) {
	id := c.Param("id")
	var req struct {
		FileSize         int64  `json:"file_size"`
		FileType         string `json:"file_type"`
		EncryptedFileKey []byte `json:"encrypted_file_key" binding:"required"`
		IV               []byte `json:"iv" binding:"required"`
		Salt             []byte `json:"salt"`
		OSSKey           string `json:"oss_key" binding:"required"`
		ContentHash      string `json:"content_hash"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	if err := h.db.UpdateFileContent(id, req.FileSize, req.FileType, req.EncryptedFileKey, req.IV, req.Salt, req.OSSKey, req.ContentHash); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	if f, err := h.db.GetFile(id); err == nil {
		h.audit(c, "edit", "file", id, f.NameEncrypted, "")
	}
	h.triggerBackup()
	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

// CheckDedup 内容寻址查重：客户端提交内容哈希，命中则返回既有文件的
// 密钥封装字段，客户端可跳过 OSS 上传、复用同一密文对象建记录。
func (h *Handler) CheckDedup(c *gin.Context) {
	var req struct {
		ContentHash string `json:"content_hash" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	existing, err := h.db.FindFileByContentHash(req.ContentHash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusOK, gin.H{"found": false})
			return
		}
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"found": true, "file": existing})
}

func (h *Handler) PresignUpload(c *gin.Context) {
	var req models.PresignRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.OSSKey == "" {
		c.JSON(http.StatusBadRequest, models.PresignResponse{})
		return
	}
	if !fileOSSKeyPattern.MatchString(req.OSSKey) {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid oss_key"})
		return
	}

	expires := 3600 * time.Second
	if req.Expires > 0 {
		expires = time.Duration(req.Expires) * time.Second
	}

	url, err := h.storage.GeneratePresignedUploadURL(context.Background(), req.OSSKey, expires)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.PresignResponse{})
		return
	}

	c.JSON(http.StatusOK, models.PresignResponse{URL: url})
}

func (h *Handler) PresignDownload(c *gin.Context) {
	var req models.PresignRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.OSSKey == "" {
		c.JSON(http.StatusBadRequest, models.PresignResponse{})
		return
	}
	if !fileOSSKeyPattern.MatchString(req.OSSKey) {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid oss_key"})
		return
	}

	expires := 3600 * time.Second
	if req.Expires > 0 {
		expires = time.Duration(req.Expires) * time.Second
	}

	url, err := h.storage.GeneratePresignedDownloadURL(context.Background(), req.OSSKey, expires)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.PresignResponse{})
		return
	}

	// 仅显式声明 purpose=download 的请求计入下载审计（预览/编辑器加载不传）
	if req.Purpose == "download" {
		fid, name, err := h.db.FindFileNameByOSSKey(req.OSSKey)
		if err != nil {
			fid, name = "", ""
		}
		h.audit(c, "download", "file", fid, name, "")
	}

	c.JSON(http.StatusOK, models.PresignResponse{URL: url})
}

func (h *Handler) DeleteFile(c *gin.Context) {
	if !h.requireDeleteMFA(c) {
		return
	}

	var req models.FileDeleteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	file, err := h.db.GetFile(req.ID)
	if err != nil {
		c.JSON(http.StatusNotFound, models.MessageResponse{OK: false, Error: "file not found"})
		return
	}

	// 软删仅标记：删除台账在物理清理（purge）时按剩余引用登记，见 db.purgeTrash
	if err := h.db.SoftDeleteFile(req.ID); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	h.audit(c, "delete", "file", req.ID, file.NameEncrypted, "单个删除")
	h.triggerBackup()
	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) RenameFile(c *gin.Context) {
	var req struct {
		ID            string `json:"id" binding:"required"`
		NameEncrypted string `json:"name_encrypted" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	oldName := ""
	if f, err := h.db.GetFile(req.ID); err == nil {
		oldName = f.NameEncrypted
	}

	if err := h.db.UpdateFile(req.ID, req.NameEncrypted); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	// detail 存改名前的密文名，前端会话内解密展示「旧名 → 新名」
	h.audit(c, "rename", "file", req.ID, req.NameEncrypted, oldName)
	h.triggerBackup()
	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) ListFileVersions(c *gin.Context) {
	fileID := c.Param("id")
	if fileID == "" {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "file id required"})
		return
	}

	versions, err := h.db.GetFileVersions(fileID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "failed to list versions"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"versions": versions})
}

func (h *Handler) CreateFileVersion(c *gin.Context) {
	fileID := c.Param("id")
	if fileID == "" {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "file id required"})
		return
	}

	var req struct {
		OSSKey           string `json:"oss_key" binding:"required"`
		EncryptedFileKey string `json:"encrypted_file_key"`
		IV               string `json:"iv"`
		Salt             string `json:"salt"`
		FileSize         int64  `json:"file_size"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	encKey, _ := base64Decode(req.EncryptedFileKey)
	iv, _ := base64Decode(req.IV)
	salt, _ := base64Decode(req.Salt)

	if err := h.db.CreateFileVersion(fileID, req.OSSKey, encKey, iv, salt, req.FileSize); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "failed to create version"})
		return
	}

	h.triggerBackup()
	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) GenerateOSSKey(c *gin.Context) {
	folder := c.Query("folder")
	if folder == "" {
		folder = "files"
	}
	// 仅允许文件命名空间；备份对象键由后端自行生成，不经此接口
	if folder != "files" {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid folder"})
		return
	}

	key := fmt.Sprintf("%s/%s/%s.enc", folder, uuid.New().String(), hex.EncodeToString([]byte(uuid.New().String())))
	c.JSON(http.StatusOK, gin.H{"oss_key": key})
}

func (h *Handler) GetFileInfo(c *gin.Context) {
	id := c.Param("id")
	file, err := h.db.GetFile(id)
	if err != nil {
		c.JSON(http.StatusNotFound, models.MessageResponse{OK: false, Error: "not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":               file.ID,
		"name_encrypted":   file.NameEncrypted,
		"file_size":        file.FileSize,
		"file_type":        file.FileType,
		"oss_key":          file.OSSKey,
		"encrypted_file_key": file.EncryptedFileKey,
		"iv":               file.IV,
		"salt":             file.Salt,
		"is_directory":     file.IsDirectory,
		"parent_id":        file.ParentID,
	})
}

// MoveFile 将文件/文件夹移动到指定目录（parent_id 为空/null 表示根目录）。
// 校验目标存在且为文件夹；移动文件夹时拒绝移动到自身或自身的后代（防环）。
func (h *Handler) MoveFile(c *gin.Context) {
	id := c.Param("id")
	var req struct {
		ParentID *string `json:"parent_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	file, err := h.db.GetFile(id)
	if err != nil {
		c.JSON(http.StatusNotFound, models.MessageResponse{OK: false, Error: "file not found"})
		return
	}

	destName := "" // 空 = 移动到根目录
	if req.ParentID != nil {
		if *req.ParentID == id {
			c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "不能移动到自身"})
			return
		}
		parent, err := h.db.GetFile(*req.ParentID)
		if err != nil {
			c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "目标文件夹不存在"})
			return
		}
		if !parent.IsDirectory {
			c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "目标不是文件夹"})
			return
		}
		destName = parent.NameEncrypted
		if file.IsDirectory {
			for cur, depth := parent, 0; cur != nil && depth < 256; depth++ {
				if cur.ID == id {
					c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "不能移动到自身的子文件夹"})
					return
				}
				if cur.ParentID == nil {
					break
				}
				next, err := h.db.GetFile(*cur.ParentID)
				if err != nil {
					break
				}
				cur = next
			}
		}
	}

	if err := h.db.UpdateFileParent(id, req.ParentID); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	// detail 存目标目录密文名（空 = 根目录），前端解密展示
	h.audit(c, "move", "file", id, file.NameEncrypted, destName)
	h.triggerBackup()
	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) BatchDelete(c *gin.Context) {
	if !h.requireDeleteMFA(c) {
		return
	}

	var req struct {
		IDs []string `json:"ids" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	for _, id := range req.IDs {
		if file, err := h.db.GetFile(id); err == nil {
			h.audit(c, "delete", "file", id, file.NameEncrypted, "批量删除")
		}
		h.db.SoftDeleteFile(id)
	}

	h.triggerBackup()
	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

// GetDeletedObjects 软删除台账查询: 列出所有保留在 OSS 上但已逻辑删除的对象
func (h *Handler) GetDeletedObjects(c *gin.Context) {
	objects, err := h.db.ListDeletedObjects()
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}
	if objects == nil {
		objects = []db.DeletedObject{}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "deleted_objects": objects})
}

// ListTrash 回收站列表；retention_days=0 表示从不自动清理
func (h *Handler) ListTrash(c *gin.Context) {
	items, err := h.db.ListTrash()
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"items":          items,
		"retention_days": h.config.Trash.RetentionDays,
	})
}

// RestoreFile 恢复回收站条目到原位置（原目录已删则回根目录）
func (h *Handler) RestoreFile(c *gin.Context) {
	id := c.Param("id")
	target, err := h.db.RestoreFile(id)
	if errors.Is(err, sql.ErrNoRows) {
		c.JSON(http.StatusNotFound, models.MessageResponse{OK: false, Error: "not in trash"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	name := ""
	if f, gerr := h.db.GetFile(id); gerr == nil {
		name = f.NameEncrypted
	}
	detail := ""
	if target == nil {
		detail = "原目录已删除，恢复到根目录"
	}
	h.audit(c, "restore", "file", id, name, detail)
	h.triggerBackup()
	c.JSON(http.StatusOK, gin.H{"ok": true, "parent_id": target})
}

// PurgeTrash 清空回收站（立即物理删除，不可撤销）——与删除同受 MFA 二次验证保护
func (h *Handler) PurgeTrash(c *gin.Context) {
	if !h.requireDeleteMFA(c) {
		return
	}
	n, err := h.db.PurgeAllTrash()
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}
	h.audit(c, "purge_trash", "trash", "", "", strconv.FormatInt(n, 10))
	h.triggerBackup()
	c.JSON(http.StatusOK, gin.H{"ok": true, "purged": n})
}

func (h *Handler) GetStorageStats(c *gin.Context) {
	files, _ := h.db.GetFiles(nil)
	totalSize := int64(0)
	fileCount := 0
	folderCount := 0

	for _, f := range files {
		if f.IsDirectory {
			folderCount++
		} else {
			fileCount++
			totalSize += f.FileSize
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"total_size":   totalSize,
		"file_count":   fileCount,
		"folder_count": folderCount,
	})
}

type statBucket struct {
	Count int   `json:"count"`
	Size  int64 `json:"size"`
}

// GetStatsSummary 全库统计：总量、类型分布、顶层目录占用 Top 10。
// 目录名返回加密形态，由客户端解密后展示（零知识不变）。
func (h *Handler) GetStatsSummary(c *gin.Context) {
	rows, err := h.db.GetFileStatRows()
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	totalSize := int64(0)
	fileCount, folderCount := 0, 0
	typeAgg := map[string]*statBucket{}
	dirNames := map[string]string{}
	parentOf := map[string]*string{}

	for i := range rows {
		r := &rows[i]
		parentOf[r.ID] = r.ParentID
		if r.IsDirectory {
			folderCount++
			dirNames[r.ID] = r.NameEncrypted
			continue
		}
		fileCount++
		totalSize += r.FileSize
		key := r.FileType
		if key == "" {
			key = "unknown"
		}
		if typeAgg[key] == nil {
			typeAgg[key] = &statBucket{}
		}
		typeAgg[key].Count++
		typeAgg[key].Size += r.FileSize
	}

	// 每个文件向上走到顶层目录，累计到该目录（根目录散文件归入 ""）
	dirAgg := map[string]*statBucket{}
	for i := range rows {
		r := &rows[i]
		if r.IsDirectory {
			continue
		}
		cur := r.ParentID
		var root *string
		for depth := 0; cur != nil && depth < 256; depth++ {
			root = cur
			pp := parentOf[*cur]
			if pp == nil {
				break
			}
			cur = pp
		}
		key := ""
		if root != nil {
			key = *root
		}
		if dirAgg[key] == nil {
			dirAgg[key] = &statBucket{}
		}
		dirAgg[key].Count++
		dirAgg[key].Size += r.FileSize
	}

	types := make([]gin.H, 0, len(typeAgg))
	for k, v := range typeAgg {
		types = append(types, gin.H{"file_type": k, "count": v.Count, "size": v.Size})
	}
	sort.Slice(types, func(i, j int) bool {
		return types[i]["size"].(int64) > types[j]["size"].(int64)
	})

	topDirs := make([]gin.H, 0, len(dirAgg))
	for id, v := range dirAgg {
		name := ""
		if id != "" {
			name = dirNames[id]
		}
		topDirs = append(topDirs, gin.H{
			"id": id, "name_encrypted": name, "count": v.Count, "size": v.Size,
		})
	}
	sort.Slice(topDirs, func(i, j int) bool {
		return topDirs[i]["size"].(int64) > topDirs[j]["size"].(int64)
	})
	if len(topDirs) > 10 {
		topDirs = topDirs[:10]
	}

	c.JSON(http.StatusOK, gin.H{
		"totals": gin.H{
			"total_size":   totalSize,
			"file_count":   fileCount,
			"folder_count": folderCount,
		},
		"types":    types,
		"top_dirs": topDirs,
	})
}

// GetLoginStats 近 N 天（默认 30，上限 90）每日成功登录次数
func (h *Handler) GetLoginStats(c *gin.Context) {
	days, _ := strconv.Atoi(c.DefaultQuery("days", "30"))
	if days < 1 || days > 90 {
		days = 30
	}
	list, err := h.db.GetLoginSuccessDaily(days)
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"days": list})
}

func (h *Handler) CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Add("Vary", "Origin")
		origin := c.GetHeader("Origin")
		allowedOrigins := map[string]bool{
			"http://localhost:3000":  true,
			"http://localhost:5173": true,
			"http://127.0.0.1:3000":  true,
			"http://127.0.0.1:5173": true,
		}

		if h.config.Server.AllowedOrigin != "" {
			allowedOrigins[h.config.Server.AllowedOrigin] = true
		}

		if allowedOrigins[origin] {
			c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
		}

		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Session-Token")
		c.Writer.Header().Set("Access-Control-Expose-Headers", "X-Session-Token")
		c.Writer.Header().Set("Access-Control-Max-Age", "86400")
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}

func (h *Handler) SecurityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Set("X-Content-Type-Options", "nosniff")
		c.Writer.Header().Set("X-Frame-Options", "DENY")
		c.Writer.Header().Set("X-XSS-Protection", "1; mode=block")
		c.Writer.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		c.Writer.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob: https://*.aliyuncs.com; font-src 'self' data:; "+
				"connect-src 'self' https://*.aliyuncs.com; object-src 'none'; "+
				"frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		c.Next()
	}
}

func (h *Handler) HealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (h *Handler) EncryptSecret(c *gin.Context) {
	var req struct {
		Plaintext  string `json:"plaintext" binding:"required"`
		Passphrase string `json:"passphrase" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}

	encrypted, err := config.EncryptString(req.Plaintext, req.Passphrase)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "encryption failed"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"encrypted": encrypted})
}

func (h *Handler) DecryptSecret(c *gin.Context) {
	var req struct {
		Encrypted  string `json:"encrypted" binding:"required"`
		Passphrase string `json:"passphrase" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}

	failedCount, _ := h.db.GetFailedVerificationCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, gin.H{
			"ok":    false,
			"error": fmt.Sprintf("too many failed attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	plaintext, err := config.DecryptString(req.Encrypted, req.Passphrase)
	if err != nil {
		h.db.RecordVerificationAttempt(false)
		c.JSON(http.StatusBadRequest, gin.H{"error": "decryption failed (wrong passphrase?)"})
		return
	}
	h.db.RecordVerificationAttempt(true)

	c.JSON(http.StatusOK, gin.H{"plaintext": plaintext})
}

func (h *Handler) MFASetup(c *gin.Context) {
	var req struct {
		PasswordHash string `json:"password_hash" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	// 已启用时拒绝重新生成密钥：SetupMFA 会将 enabled 置 0，等于静默关闭 MFA
	if mfaRecord, _ := h.db.GetMFA(); mfaRecord != nil && mfaRecord.Enabled {
		c.JSON(http.StatusConflict, models.MFASetupResponse{OK: false, Error: "MFA already enabled, disable it first"})
		return
	}

	// 重置 TOTP 密钥必须证明持有主密码：仅凭会话（如会话被盗）不得偷换认证器
	failedCount, _ := h.db.GetFailedVerificationCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	ok, err := h.db.VerifyPassword(req.PasswordHash)
	if err != nil || !ok {
		h.db.RecordVerificationAttempt(false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid password"})
		return
	}
	h.db.RecordVerificationAttempt(true)

	secret, uri, err := GenerateTOTPSecret()
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MFASetupResponse{OK: false, Error: err.Error()})
		return
	}

	if err := h.db.SetupMFA(secret); err != nil {
		c.JSON(http.StatusInternalServerError, models.MFASetupResponse{OK: false, Error: err.Error()})
		return
	}

	c.JSON(http.StatusOK, models.MFASetupResponse{
		OK:     true,
		Secret: secret,
		URI:    uri,
	})
}

func (h *Handler) MFAEnable(c *gin.Context) {
	var req models.TOTPVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	token := c.GetHeader("X-Session-Token")

	failedCount, _ := h.db.GetFailedTOTPCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed TOTP attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	mfaRecord, err := h.db.GetMFA()
	if err != nil || mfaRecord == nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "MFA not set up"})
		return
	}

	if !VerifyTOTP(mfaRecord.Secret, req.Code) {
		h.db.RecordTOTPAttempt(false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid TOTP code"})
		return
	}

	h.db.RecordTOTPAttempt(true)

	if err := h.db.EnableMFA(); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "failed to enable MFA"})
		return
	}

	h.sessions.CompleteMFA(token)
	// 启用 MFA 后踢掉其它已存在的会话，强制它们重新登录并完成 TOTP
	h.sessions.DeleteAllExcept(token)
	h.config.Auth.MFAEnabled = true

	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) MFADisable(c *gin.Context) {
	var req models.TOTPVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	if req.PasswordHash == "" {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "password required to disable MFA"})
		return
	}

	// Rate limit password verification
	failedCount, _ := h.db.GetFailedVerificationCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	ok, err := h.db.VerifyPassword(req.PasswordHash)
	if err != nil || !ok {
		h.db.RecordVerificationAttempt(false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid password"})
		return
	}
	h.db.RecordVerificationAttempt(true)

	// Rate limit TOTP verification
	failedTOTPCount, _ := h.db.GetFailedTOTPCount(totpLockoutDuration)
	if failedTOTPCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed TOTP attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	mfaRecord, err := h.db.GetMFA()
	if err != nil || mfaRecord == nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "MFA not set up"})
		return
	}

	if !VerifyTOTP(mfaRecord.Secret, req.Code) {
		h.db.RecordTOTPAttempt(false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid TOTP code"})
		return
	}

	h.db.RecordTOTPAttempt(true)

	if err := h.db.DisableMFA(); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "failed to disable MFA"})
		return
	}

	h.config.Auth.MFAEnabled = false

	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) MFAStatus(c *gin.Context) {
	mfaRecord, err := h.db.GetMFA()
	enabled := false
	if err == nil && mfaRecord != nil {
		enabled = mfaRecord.Enabled
	}
	total, remaining, _ := h.db.CountRecoveryCodes()

	c.JSON(http.StatusOK, models.MFAStatusResponse{
		OK:                true,
		Enabled:           enabled,
		RecoveryTotal:     total,
		RecoveryRemaining: remaining,
	})
}

func (h *Handler) VerifyTOTPEndpoint(c *gin.Context) {
	token := c.GetHeader("X-Session-Token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, models.MessageResponse{OK: false, Error: "unauthorized"})
		return
	}

	if !h.sessions.Validate(token) {
		c.JSON(http.StatusUnauthorized, models.MessageResponse{OK: false, Error: "invalid or expired session"})
		return
	}

	if !h.sessions.IsPendingMFA(token) {
		c.JSON(http.StatusOK, models.MessageResponse{OK: true})
		return
	}

	var req models.TOTPVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	failedCount, _ := h.db.GetFailedTOTPCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed TOTP attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	mfaRecord, err := h.db.GetMFA()
	if err != nil || mfaRecord == nil || !mfaRecord.Enabled {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "MFA not enabled"})
		return
	}

	if !VerifyTOTP(mfaRecord.Secret, req.Code) {
		h.db.RecordTOTPAttempt(false)
		h.db.RecordLoginAttempt(c.ClientIP(), false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid TOTP code"})
		return
	}

	h.db.RecordTOTPAttempt(true)
	h.db.RecordLoginAttempt(c.ClientIP(), true)
	h.sessions.CompleteMFA(token)

	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

const recoveryCodeCount = 10

// normalizeRecoveryCode 统一为纯大写字母+数字（容忍大小写、横线、空格粘贴）
func normalizeRecoveryCode(code string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(code) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// hashRecoveryCode SHA-256(规范化码) 的十六进制。
// 码为 96 bit 密码学随机值，服务端只存哈希，离线暴力枚举不可行（零知识口径不受影响）。
func hashRecoveryCode(code string) string {
	sum := sha256.Sum256([]byte(normalizeRecoveryCode(code)))
	return hex.EncodeToString(sum[:])
}

// generateRecoveryCode 生成形如 ABCD-EFGH-JKLM-NPQR-STUV 的 96-bit 恢复码
func generateRecoveryCode() (plain string, hash string, err error) {
	buf := make([]byte, 12)
	if _, err = rand.Read(buf); err != nil {
		return "", "", err
	}
	s := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteByte(s[i])
	}
	plain = b.String()
	return plain, hashRecoveryCode(plain), nil
}

// GenerateRecoveryCodes 生成（或整体重新生成）10 个一次性 MFA 恢复码，明文仅本次返回。
// 重新生成即令旧码全部失效。需完整会话、MFA 已启用，且必须证明持有主密码：
// 恢复码是长期 MFA 凭证，与 mfa/setup、mfa/disable 同策略，防止仅持会话
// 预置自己的恢复码或静默作废号主的找回码。
func (h *Handler) GenerateRecoveryCodes(c *gin.Context) {
	var req struct {
		PasswordHash string `json:"password_hash" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	mfaRecord, err := h.db.GetMFA()
	if err != nil || mfaRecord == nil || !mfaRecord.Enabled {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "MFA not enabled"})
		return
	}

	failedCount, _ := h.db.GetFailedVerificationCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	ok, err := h.db.VerifyPassword(req.PasswordHash)
	if err != nil || !ok {
		h.db.RecordVerificationAttempt(false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid password"})
		return
	}
	h.db.RecordVerificationAttempt(true)

	codes := make([]string, 0, recoveryCodeCount)
	hashes := make([]string, 0, recoveryCodeCount)
	for i := 0; i < recoveryCodeCount; i++ {
		plain, hash, genErr := generateRecoveryCode()
		if genErr != nil {
			c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: genErr.Error()})
			return
		}
		codes = append(codes, plain)
		hashes = append(hashes, hash)
	}
	if err := h.db.ReplaceRecoveryCodes(hashes); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "codes": codes, "total": len(codes)})
}

// VerifyRecoveryCode 恢复码验证：与 TOTP 共用 pending 会话流转与失败锁定；
// 命中即原子消费（一次性），已用过的码再提交按失败计数。
func (h *Handler) VerifyRecoveryCode(c *gin.Context) {
	token := c.GetHeader("X-Session-Token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, models.MessageResponse{OK: false, Error: "unauthorized"})
		return
	}
	if !h.sessions.Validate(token) {
		c.JSON(http.StatusUnauthorized, models.MessageResponse{OK: false, Error: "invalid or expired session"})
		return
	}
	if !h.sessions.IsPendingMFA(token) {
		c.JSON(http.StatusOK, models.MessageResponse{OK: true})
		return
	}

	var req models.TOTPVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	failedCount, _ := h.db.GetFailedTOTPCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed TOTP attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	mfaRecord, err := h.db.GetMFA()
	if err != nil || mfaRecord == nil || !mfaRecord.Enabled {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "MFA not enabled"})
		return
	}

	ok, err := h.db.ConsumeRecoveryCode(hashRecoveryCode(req.Code))
	if err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: "recovery verification failed"})
		return
	}
	if !ok {
		h.db.RecordTOTPAttempt(false)
		h.db.RecordLoginAttempt(c.ClientIP(), false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid or already used recovery code"})
		return
	}

	h.db.RecordTOTPAttempt(true)
	h.db.RecordLoginAttempt(c.ClientIP(), true)
	h.sessions.CompleteMFA(token)

	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

// requireDeleteMFA: 启用 TOTP 时，每个 session 首次删除前需单独完成一次 MFA 验证
func (h *Handler) requireDeleteMFA(c *gin.Context) bool {
	if !h.config.Auth.MFAEnabled {
		return true
	}
	token := c.GetHeader("X-Session-Token")
	if token != "" && h.sessions.IsDeleteMFAVerified(token) {
		return true
	}
	c.JSON(http.StatusForbidden, gin.H{
		"ok":            false,
		"mfa_required":  true,
		"error":         "MFA verification required for delete",
	})
	return false
}

func (h *Handler) VerifyDeleteMFA(c *gin.Context) {
	token := c.GetHeader("X-Session-Token")
	if token == "" || !h.sessions.Validate(token) {
		c.JSON(http.StatusUnauthorized, models.MessageResponse{OK: false, Error: "unauthorized"})
		return
	}

	if !h.config.Auth.MFAEnabled {
		c.JSON(http.StatusOK, models.MessageResponse{OK: true})
		return
	}

	var req models.TOTPVerifyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	failedCount, _ := h.db.GetFailedTOTPCount(totpLockoutDuration)
	if failedCount >= maxTOTPAttempts {
		c.JSON(http.StatusTooManyRequests, models.MessageResponse{
			OK:    false,
			Error: fmt.Sprintf("too many failed TOTP attempts, try again in %d minutes", int(totpLockoutDuration.Minutes())),
		})
		return
	}

	mfaRecord, err := h.db.GetMFA()
	if err != nil || mfaRecord == nil || !mfaRecord.Enabled {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "MFA not enabled"})
		return
	}

	if !VerifyTOTP(mfaRecord.Secret, req.Code) {
		h.db.RecordTOTPAttempt(false)
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid TOTP code"})
		return
	}

	h.db.RecordTOTPAttempt(true)
	h.sessions.MarkDeleteMFAVerified(token)

	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func parseInt(s string) int64 {
	i, _ := strconv.ParseInt(s, 10, 64)
	return i
}

func base64Decode(s string) ([]byte, error) {
	if s == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(s)
}

func (h *Handler) triggerBackup() {
	if h.backupManager.ShouldBackup() {
		uploadOSS := h.config.Backup.OnFileChangeUploadOSS
		go func() {
			res := h.backupManager.RunBackup(uploadOSS)
			if res.Err != nil {
				log.Printf("auto backup failed: %v", res.Err)
				return
			}
			if res.OSSErr != nil {
				log.Printf("auto backup oss upload failed: %v", res.OSSErr)
			}
		}()
	}
}
