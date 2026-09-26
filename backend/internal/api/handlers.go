package api

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"strconv"
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
		c.JSON(http.StatusUnauthorized, models.LoginResponse{OK: false, Error: "invalid credentials"})
		return
	}

	h.db.RecordLoginAttempt(ip, true)

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

	var token string
	if mfaRequired {
		token = h.sessions.CreatePendingMFA()
	} else {
		token = h.sessions.Create()
	}

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
		CreatedAt:        time.Now(),
		UpdatedAt:        time.Now(),
	}

	if err := h.db.CreateFile(file); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

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
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid request"})
		return
	}

	if err := h.db.UpdateFileContent(id, req.FileSize, req.FileType, req.EncryptedFileKey, req.IV, req.Salt, req.OSSKey); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

	h.triggerBackup()
	c.JSON(http.StatusOK, models.MessageResponse{OK: true})
}

func (h *Handler) PresignUpload(c *gin.Context) {
	var req models.PresignRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.PresignResponse{})
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
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, models.PresignResponse{})
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

	c.JSON(http.StatusOK, models.PresignResponse{URL: url})
}

// recordFileDeletion 软删除台账: 不再调用 OSS DeleteObject，对象保留在 OSS 上，
// 主对象与该文件的全部历史版本对象一并登记到 deleted_objects（文件名存密文，保持零知识）
func (h *Handler) recordFileDeletion(file *models.FileRecord, reason string) {
	if file.IsDirectory || file.OSSKey == "" {
		return
	}
	if err := h.db.RecordDeletedObject(file.ID, file.NameEncrypted, file.OSSKey, file.FileType, reason, file.FileSize, false); err != nil {
		log.Printf("record deleted object failed (%s): %v", file.OSSKey, err)
	}
	versions, err := h.db.GetFileVersions(file.ID)
	if err != nil {
		log.Printf("list versions for deletion ledger failed (file %s): %v", file.ID, err)
		return
	}
	for _, v := range versions {
		if v.OSSKey == "" || v.OSSKey == file.OSSKey {
			continue
		}
		if err := h.db.RecordDeletedObject(file.ID, file.NameEncrypted, v.OSSKey, file.FileType, reason, v.FileSize, true); err != nil {
			log.Printf("record deleted version object failed (%s): %v", v.OSSKey, err)
		}
	}
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

	h.recordFileDeletion(file, "单个删除")

	if err := h.db.SoftDeleteFile(req.ID); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

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

	if err := h.db.UpdateFile(req.ID, req.NameEncrypted); err != nil {
		c.JSON(http.StatusInternalServerError, models.MessageResponse{OK: false, Error: err.Error()})
		return
	}

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
		file, err := h.db.GetFile(id)
		if err == nil {
			h.recordFileDeletion(file, "批量删除")
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

func (h *Handler) CORS() gin.HandlerFunc {
	return func(c *gin.Context) {
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

func (h *Handler) RateLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
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
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "+
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
	// 已启用时拒绝重新生成密钥：SetupMFA 会将 enabled 置 0，等于静默关闭 MFA
	if mfaRecord, _ := h.db.GetMFA(); mfaRecord != nil && mfaRecord.Enabled {
		c.JSON(http.StatusConflict, models.MFASetupResponse{OK: false, Error: "MFA already enabled, disable it first"})
		return
	}

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

	c.JSON(http.StatusOK, models.MFAStatusResponse{
		OK:      true,
		Enabled: enabled,
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
		c.JSON(http.StatusBadRequest, models.MessageResponse{OK: false, Error: "invalid TOTP code"})
		return
	}

	h.db.RecordTOTPAttempt(true)
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
