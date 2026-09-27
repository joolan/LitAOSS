package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"lit-aoss/internal/api"
	"lit-aoss/internal/config"
	"lit-aoss/internal/db"
	"lit-aoss/internal/storage"

	"github.com/gin-gonic/gin"
)

func main() {
	configPath := "config.json"
	if len(os.Args) > 1 {
		configPath = os.Args[1]
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	if cfg.OSS.EncryptedSK != "" {
		if err := cfg.DecryptSK(); err != nil {
			log.Printf("WARNING: %v", err)
		} else {
			log.Println("SecretKey decrypted from encrypted_sk")
		}
	}

	accessKey := cfg.OSS.AccessKey
	secretKey := cfg.OSS.SecretKey

	if accessKey == "" || secretKey == "" || cfg.OSS.Bucket == "" {
		log.Println("WARNING: OSS not fully configured. Set access_key, secret_key, and bucket in config.json")
	}

	passphrase := cfg.GetPassphrase()
	if passphrase != "" {
		log.Println("Database encryption enabled (using passphrase)")
	} else {
		log.Println("Database encryption disabled (no passphrase)")
	}

	encryptedDB, err := db.NewEncrypted(cfg.Database.Path, passphrase)
	if err != nil {
		log.Fatalf("init database: %v", err)
	}
	defer encryptedDB.Close()

	var store storage.Storage
	switch cfg.OSS.Provider {
	case "aliyun":
		aliyunCfg := &storage.AliyunConfig{
			Endpoint:  cfg.OSS.Endpoint,
			AccessKey: accessKey,
			SecretKey: secretKey,
			Bucket:    cfg.OSS.Bucket,
			Region:    cfg.OSS.Region,
		}
		if accessKey == "" || secretKey == "" {
			log.Println("WARNING: OSS credentials empty. Using noop storage.")
			store = &storage.NoopStorage{}
		} else {
			store, err = storage.NewAliyunOSS(aliyunCfg)
			if err != nil {
				log.Printf("WARNING: Failed to init aliyun oss: %v", err)
				store = &storage.NoopStorage{}
			}
		}
	default:
		log.Fatalf("unsupported storage provider: %s", cfg.OSS.Provider)
	}

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery())

	// 可信代理：只有可信代理提交的 X-Forwarded-For 才会被采信，
	// 防止伪造 IP 绕过登录审计/污染失败记录；跨机反代需在配置中显式声明。
	trustedProxies := cfg.Server.TrustedProxies
	if len(trustedProxies) == 0 {
		trustedProxies = []string{"127.0.0.1/32", "::1/128"}
	}
	if err := router.SetTrustedProxies(trustedProxies); err != nil {
		log.Fatalf("trusted proxies: %v", err)
	}

	// OSS 备份台账独立于数据库（见 ossledger.go），创建一次供 handler 与调度器共享
	backupDir := filepath.Join(filepath.Dir(cfg.Database.Path), "backups")
	ossLedger := api.NewOSSBackupLedger(backupDir, encryptedDB.Database)

	handler := api.NewHandler(encryptedDB.Database, store, cfg, ossLedger)

	// MFA 状态以数据库 mfa 表为唯一事实源：启动时覆盖 config 中的 mfa_enabled。
	// 避免「启用 MFA 后重启 → TOTP 静默失效」与「config/DB 不一致 → 删除接口死锁」。
	if mfaRec, err := encryptedDB.Database.GetMFA(); err == nil && mfaRec != nil && mfaRec.Enabled {
		cfg.Auth.MFAEnabled = true
	} else {
		cfg.Auth.MFAEnabled = false
	}

	router.Use(handler.CORS())
	router.Use(handler.SecurityHeaders())

	router.GET("/api/health", handler.HealthCheck)
	router.GET("/api/setup/status", handler.SetupRequired())
	router.POST("/api/setup", handler.Setup)
	router.POST("/api/auth/login", handler.Login)
	router.GET("/api/auth/salt", handler.GetSalt)

	authOnly := router.Group("/api")
	authOnly.Use(handler.RequireAuthNoMFA())
	{
		authOnly.POST("/auth/verify-totp", handler.VerifyTOTPEndpoint)
		authOnly.POST("/auth/verify-recovery", handler.VerifyRecoveryCode)
		authOnly.POST("/auth/logout", handler.Logout)
	}

	protected := router.Group("/api")
	protected.Use(handler.RequireAuth())
	{
		protected.POST("/auth/update-key", handler.UpdateKey)
		protected.POST("/auth/verify-totp-delete", handler.VerifyDeleteMFA)
		protected.POST("/auth/change-password", handler.ChangePassword)

		protected.POST("/mfa/setup", handler.MFASetup)
		protected.POST("/mfa/enable", handler.MFAEnable)
		protected.POST("/mfa/disable", handler.MFADisable)
		protected.POST("/mfa/recovery-codes", handler.GenerateRecoveryCodes)
		protected.GET("/mfa/status", handler.MFAStatus)

		protected.POST("/secret/encrypt", handler.EncryptSecret)
		protected.POST("/secret/decrypt", handler.DecryptSecret)

		protected.GET("/files", handler.ListFiles)
		protected.GET("/files/:id", handler.GetFile)
		protected.GET("/files/:id/info", handler.GetFileInfo)
		protected.GET("/files/:id/versions", handler.ListFileVersions)
		protected.POST("/files/:id/versions", handler.CreateFileVersion)
		protected.POST("/files", handler.CreateFileRecord)
		protected.POST("/files/dedup-check", handler.CheckDedup)
		protected.PUT("/files/:id/content", handler.UpdateFileContent)
		protected.PUT("/files/:id/rename", handler.RenameFile)
		protected.PUT("/files/:id/move", handler.MoveFile)
		protected.DELETE("/files/:id", handler.DeleteFile)
		protected.POST("/files/batch-delete", handler.BatchDelete)
		protected.GET("/deleted-objects", handler.GetDeletedObjects)

		protected.POST("/folders", handler.CreateFolder)

		protected.POST("/presign/upload", handler.PresignUpload)
		protected.POST("/presign/download", handler.PresignDownload)

		protected.POST("/oss/key", handler.GenerateOSSKey)

		protected.GET("/stats", handler.GetStorageStats)
		protected.GET("/stats/summary", handler.GetStatsSummary)
		protected.GET("/auth/login-history", handler.GetLoginHistory)
		protected.GET("/auth/login-stats", handler.GetLoginStats)

		protected.GET("/backup/config", handler.GetBackupConfig)
		protected.POST("/backup/config", handler.UpdateBackupConfig)
		protected.POST("/backup/now", handler.ManualBackup)
		protected.GET("/backup/list", handler.ListBackups)
		protected.POST("/backup/restore", handler.RestoreBackup)
		protected.POST("/backup/restore-oss", handler.RestoreBackupOSS)
		protected.POST("/backup/drill", handler.BackupDrill)
	}

	addr := fmt.Sprintf("%s:%s", cfg.Server.Host, cfg.Server.Port)
	log.Printf("Server starting on %s", addr)
	startBackupScheduler(cfg, store, encryptedDB.Database, ossLedger)
	if err := router.Run(addr); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// startBackupScheduler 每 30 秒重读配置触发当日定时备份：
// 开关/时间/上传 OSS 开关修改后无需重启；停机错过的当日备份启动后补跑一次。
func startBackupScheduler(cfg *config.Config, store storage.Storage, database *db.Database, ledger *api.OSSBackupLedger) {
	go func() {
		var lastFiredDay string
		for {
			time.Sleep(30 * time.Second)

			if !cfg.Backup.AutoBackup {
				continue
			}

			backupTime := cfg.Backup.BackupTime
			if _, err := time.Parse("15:04", backupTime); err != nil {
				backupTime = "03:00"
			}

			now := time.Now()
			today := now.Format("2006-01-02")
			if lastFiredDay == today || now.Format("15:04") < backupTime {
				continue
			}

			lastFiredDay = today
			log.Printf("Scheduled database backup at %s", now.Format(time.RFC3339))
			bm := api.NewBackupManager(cfg, store, database, ledger)
			res := bm.RunBackup(cfg.Backup.AutoBackupUploadOSS)
			if res.Err != nil {
				log.Printf("scheduled backup failed: %v", res.Err)
				continue
			}
			if res.OSSErr != nil {
				log.Printf("scheduled backup oss upload failed: %v", res.OSSErr)
			}
		}
	}()
}
