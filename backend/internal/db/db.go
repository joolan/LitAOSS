package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"lit-aoss/internal/models"

	_ "modernc.org/sqlite"
)

type Database struct {
	conn *sql.DB
}

func New(dbPath string) (*Database, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}

	conn, err := sql.Open("sqlite", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("ping db: %w", err)
	}

	db := &Database{conn: conn}
	if err := db.migrate(); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}

	// Cleanup old attempt records on startup
	db.CleanupOldAttempts(7 * 24 * time.Hour)

	return db, nil
}

func (d *Database) Close() error {
	return d.conn.Close()
}

// BackupTo 生成运行中数据库的一致性快照（VACUUM INTO），包含 WAL 中尚未
// checkpoint 的已提交数据。不能用文件拷贝代替：journal_mode=WAL 下主 .db
// 文件只有 checkpoint 后才更新，直接拷贝会得到旧快照且内容不随写入变化。
func (d *Database) BackupTo(destPath string) error {
	// VACUUM INTO 要求目标不存在；同秒重复备份等场景直接覆盖
	if err := os.Remove(destPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove existing backup: %w", err)
	}
	if _, err := d.conn.Exec("VACUUM INTO ?", destPath); err != nil {
		return fmt.Errorf("vacuum into: %w", err)
	}
	return nil
}

func (d *Database) migrate() error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS auth (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			password_hash TEXT NOT NULL,
			salt TEXT NOT NULL,
			encrypted_account_key BLOB,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS files (
			id TEXT PRIMARY KEY,
			name_encrypted TEXT NOT NULL,
			parent_id TEXT,
			is_directory INTEGER DEFAULT 0,
			file_size INTEGER DEFAULT 0,
			file_type TEXT DEFAULT '',
			oss_key TEXT NOT NULL,
			encrypted_file_key BLOB,
			iv BLOB,
			salt BLOB,
			content_hash TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			deleted_at DATETIME,
			FOREIGN KEY (parent_id) REFERENCES files(id)
		)`,
		`CREATE TABLE IF NOT EXISTS file_versions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			file_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			oss_key TEXT NOT NULL,
			encrypted_file_key BLOB,
			iv BLOB,
			salt BLOB,
			file_size INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (file_id) REFERENCES files(id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions(file_id)`,
		`CREATE TABLE IF NOT EXISTS deleted_objects (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			file_id TEXT NOT NULL,
			name_encrypted TEXT NOT NULL DEFAULT '',
			oss_key TEXT NOT NULL,
			file_size INTEGER NOT NULL DEFAULT 0,
			file_type TEXT NOT NULL DEFAULT '',
			is_version INTEGER NOT NULL DEFAULT 0,
			reason TEXT NOT NULL,
			deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_deleted_objects_at ON deleted_objects(deleted_at)`,
		`CREATE INDEX IF NOT EXISTS idx_deleted_objects_key ON deleted_objects(oss_key)`,
		`CREATE TABLE IF NOT EXISTS login_attempts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ip_address TEXT NOT NULL,
			success INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id)`,
		`CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at)`,
		`CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address, created_at)`,
		`CREATE TABLE IF NOT EXISTS mfa (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			secret TEXT NOT NULL,
			enabled INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS totp_attempts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_token TEXT NOT NULL,
			success INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_totp_attempts_session ON totp_attempts(session_token, created_at)`,
		`CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			code_hash TEXT NOT NULL,
			used_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_hash ON mfa_recovery_codes(code_hash)`,
		`CREATE TABLE IF NOT EXISTS audit_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			action TEXT NOT NULL,
			target_type TEXT NOT NULL DEFAULT '',
			target_id TEXT NOT NULL DEFAULT '',
			target_name TEXT NOT NULL DEFAULT '',
			detail TEXT NOT NULL DEFAULT '',
			ip_address TEXT NOT NULL DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at)`,
	}

	for _, q := range queries {
		if _, err := d.conn.Exec(q); err != nil {
			return fmt.Errorf("exec migration: %w", err)
		}
	}

	// 既有库补列：content_hash（新库建表时已含）
	var hasHashCol int
	if err := d.conn.QueryRow(
		`SELECT COUNT(*) FROM pragma_table_info('files') WHERE name = 'content_hash'`,
	).Scan(&hasHashCol); err == nil && hasHashCol == 0 {
		if _, err := d.conn.Exec(`ALTER TABLE files ADD COLUMN content_hash TEXT`); err != nil {
			return fmt.Errorf("alter files add content_hash: %w", err)
		}
	}
	// 历史行 content_hash 为 NULL（ALTER 补列所致），统一归一为空串，
	// 避免 Scan(NULL → string) 报错导致文件列表 500；读路径另有 IFNULL 兜底
	if _, err := d.conn.Exec(`UPDATE files SET content_hash = '' WHERE content_hash IS NULL`); err != nil {
		return fmt.Errorf("backfill files content_hash: %w", err)
	}
	if _, err := d.conn.Exec(
		`CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash)`,
	); err != nil {
		return fmt.Errorf("create content_hash index: %w", err)
	}

	return nil
}

func (d *Database) GetAuthState() (*models.AuthState, error) {
	var state models.AuthState
	err := d.conn.QueryRow(
		"SELECT id, password_hash, salt, created_at FROM auth ORDER BY id DESC LIMIT 1",
	).Scan(&state.ID, &state.PasswordHash, &state.Salt, &state.CreatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &state, nil
}

func (d *Database) SetupAuth(passwordHash, salt string) error {
	encHash, err := hashAuthHash(passwordHash)
	if err != nil {
		return err
	}
	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec("DELETE FROM auth")
	if err != nil {
		return err
	}
	_, err = tx.Exec(
		"INSERT INTO auth (password_hash, salt) VALUES (?, ?)",
		encHash, salt,
	)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (d *Database) UpdateEncryptedAccountKey(encKey []byte) error {
	result, err := d.conn.Exec(
		"UPDATE auth SET encrypted_account_key = ? WHERE id = (SELECT MAX(id) FROM auth)",
		encKey,
	)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("no auth record found")
	}
	return nil
}

func (d *Database) UpdatePassword(passwordHash string, encKey []byte) error {
	encHash, err := hashAuthHash(passwordHash)
	if err != nil {
		return err
	}
	result, err := d.conn.Exec(
		"UPDATE auth SET password_hash = ?, encrypted_account_key = ? WHERE id = (SELECT MAX(id) FROM auth)",
		encHash, encKey,
	)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("no auth record found")
	}
	return nil
}

func (d *Database) GetEncryptedAccountKey() ([]byte, error) {
	var key []byte
	err := d.conn.QueryRow(
		"SELECT encrypted_account_key FROM auth ORDER BY id DESC LIMIT 1",
	).Scan(&key)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return key, nil
}

func (d *Database) GetAuthSalt() (string, error) {
	var salt string
	err := d.conn.QueryRow(
		"SELECT salt FROM auth ORDER BY id DESC LIMIT 1",
	).Scan(&salt)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", nil
		}
		return "", err
	}
	return salt, nil
}

func (d *Database) VerifyPassword(authHash string) (bool, error) {
	var stored string
	err := d.conn.QueryRow(
		"SELECT password_hash FROM auth ORDER BY id DESC LIMIT 1",
	).Scan(&stored)
	if err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, err
	}

	match, err := verifyAuthHash(stored, authHash)
	if err != nil || !match {
		return match, err
	}

	// 历史明文凭据校验成功后自动升级为 argon2id 包裹存储
	if !strings.HasPrefix(stored, "$argon2id$") {
		if enc, herr := hashAuthHash(authHash); herr == nil {
			_, _ = d.conn.Exec(
				"UPDATE auth SET password_hash = ? WHERE id = (SELECT MAX(id) FROM auth)",
				enc,
			)
		}
	}
	return true, nil
}

func (d *Database) IsSetupComplete() (bool, error) {
	var count int
	err := d.conn.QueryRow("SELECT COUNT(*) FROM auth").Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (d *Database) RecordLoginAttempt(ip string, success bool) error {
	_, err := d.conn.Exec(
		"INSERT INTO login_attempts (ip_address, success) VALUES (?, ?)",
		ip, success,
	)
	return err
}

// GetFailedLoginCount 窗口内、且 id 晚于最近一次成功登录的失败次数。
// 「成功后的旧失败不计数」等价于历史上的物理清零约定，但不再删除历史行——
// 登录日志完整保留密码错误/MFA 错误记录供审计，锁定语义保持不变。
// 用自增 id 比较顺序（而非 created_at），同秒插入的记录也不失准。
func (d *Database) GetFailedLoginCount(since time.Duration) (int, error) {
	var count int
	err := d.conn.QueryRow(
		`SELECT COUNT(*) FROM login_attempts
		 WHERE success = 0
		   AND created_at > datetime('now', ?)
		   AND id > COALESCE(
		         (SELECT MAX(id) FROM login_attempts WHERE success = 1), 0)`,
		sqliteSinceModifier(since),
	).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// GetFailedLoginCountByIP 指定 IP 窗口内、且 id 晚于该 IP 最近一次成功登录的失败次数
// （登录失败告警阈值判定；口径与 GetFailedLoginCount 一致）
func (d *Database) GetFailedLoginCountByIP(ip string, since time.Duration) (int, error) {
	var count int
	err := d.conn.QueryRow(
		`SELECT COUNT(*) FROM login_attempts
		 WHERE success = 0
		   AND ip_address = ?
		   AND created_at > datetime('now', ?)
		   AND id > COALESCE(
		         (SELECT MAX(id) FROM login_attempts WHERE success = 1 AND ip_address = ?), 0)`,
		ip, sqliteSinceModifier(since), ip,
	).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// GetLoginHistory 按时间倒序返回最近 limit 条登录尝试。
// 含密码错误与 MFA 验证失败记录（成功登录不再物理删除历史失败行，
// 锁定计数改由「晚于最近一次成功的失败」计算，见 GetFailedLoginCount）。
func (d *Database) GetLoginHistory(limit int) ([]models.LoginAttempt, error) {
	rows, err := d.conn.Query(
		"SELECT id, ip_address, success, created_at FROM login_attempts ORDER BY id DESC LIMIT ?",
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]models.LoginAttempt, 0)
	for rows.Next() {
		var a models.LoginAttempt
		var success int
		var created string
		if err := rows.Scan(&a.ID, &a.IPAddress, &success, &created); err != nil {
			return nil, err
		}
		a.Success = success != 0
		if t, err := time.Parse("2006-01-02 15:04:05", created); err == nil {
			a.CreatedAt = t
		} else if t, err := time.Parse(time.RFC3339, created); err == nil {
			a.CreatedAt = t
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// RecordAudit 写入一条操作审计（调用方失败仅记日志，不影响业务）
func (d *Database) RecordAudit(action, targetType, targetID, targetName, detail, ip string) error {
	_, err := d.conn.Exec(
		`INSERT INTO audit_log (action, target_type, target_id, target_name, detail, ip_address)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		action, targetType, targetID, targetName, detail, ip,
	)
	return err
}

// ListAudit 分页查询操作审计（按 id 倒序）；action 为空表示不过滤
func (d *Database) ListAudit(page, pageSize int, action string) ([]models.AuditEntry, int, error) {
	if page < 1 {
		page = 1
	}
	// 上限防 (page-1)*pageSize 溢出与无意义深翻页
	if page > 1_000_000 {
		page = 1_000_000
	}
	if pageSize < 1 || pageSize > 200 {
		pageSize = 50
	}

	where := ""
	args := []any{}
	if action != "" {
		where = "WHERE action = ?"
		args = append(args, action)
	}

	var total int
	if err := d.conn.QueryRow("SELECT COUNT(*) FROM audit_log "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	rows, err := d.conn.Query(
		`SELECT id, action, target_type, target_id, target_name, detail, ip_address, created_at
		 FROM audit_log `+where+` ORDER BY id DESC LIMIT ? OFFSET ?`,
		append(args, pageSize, (page-1)*pageSize)...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := make([]models.AuditEntry, 0)
	for rows.Next() {
		var a models.AuditEntry
		var created string
		if err := rows.Scan(&a.ID, &a.Action, &a.TargetType, &a.TargetID,
			&a.TargetName, &a.Detail, &a.IPAddress, &created); err != nil {
			return nil, 0, err
		}
		if t, err := time.Parse("2006-01-02 15:04:05", created); err == nil {
			a.CreatedAt = t
		} else if t, err := time.Parse(time.RFC3339, created); err == nil {
			a.CreatedAt = t
		}
		out = append(out, a)
	}
	return out, total, rows.Err()
}

// PurgeAuditOlderThan 清理超过保留期的操作审计，返回删除行数；days<=0 表示永不清理
func (d *Database) PurgeAuditOlderThan(days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	res, err := d.conn.Exec(
		"DELETE FROM audit_log WHERE created_at < datetime('now', ?)",
		fmt.Sprintf("-%d days", days),
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// FindFileNameByOSSKey 下载审计反查：对象键可能是主对象或历史版本对象，
// 两者都查以保证文件名（密文）可回填到审计记录
func (d *Database) FindFileNameByOSSKey(ossKey string) (string, string, error) {
	var fileID, name string
	err := d.conn.QueryRow(
		`SELECT id, name_encrypted FROM files WHERE oss_key = ?
		 UNION ALL
		 SELECT v.file_id, f.name_encrypted FROM file_versions v
		 JOIN files f ON f.id = v.file_id WHERE v.oss_key = ?
		 LIMIT 1`,
		ossKey, ossKey,
	).Scan(&fileID, &name)
	return fileID, name, err
}

func (d *Database) CreateFile(file *models.FileRecord) error {
	_, err := d.conn.Exec(
		`INSERT INTO files (id, name_encrypted, parent_id, is_directory, file_size, file_type,
		 oss_key, encrypted_file_key, iv, salt, content_hash, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		file.ID, file.NameEncrypted, file.ParentID, file.IsDirectory,
		file.FileSize, file.FileType, file.OSSKey, file.EncryptedFileKey,
		file.IV, file.Salt, file.ContentHash, file.CreatedAt, file.UpdatedAt,
	)
	return err
}

func (d *Database) GetFiles(parentID *string) ([]models.FileRecord, error) {
	var rows *sql.Rows
	var err error

	if parentID == nil {
		rows, err = d.conn.Query(
			"SELECT id, name_encrypted, parent_id, is_directory, file_size, file_type, oss_key, encrypted_file_key, iv, salt, IFNULL(content_hash, '') AS content_hash, created_at, updated_at, deleted_at FROM files WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY is_directory DESC, name_encrypted ASC",
		)
	} else {
		rows, err = d.conn.Query(
			"SELECT id, name_encrypted, parent_id, is_directory, file_size, file_type, oss_key, encrypted_file_key, iv, salt, IFNULL(content_hash, '') AS content_hash, created_at, updated_at, deleted_at FROM files WHERE parent_id = ? AND deleted_at IS NULL ORDER BY is_directory DESC, name_encrypted ASC",
			*parentID,
		)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []models.FileRecord
	for rows.Next() {
		var f models.FileRecord
		if err := rows.Scan(
			&f.ID, &f.NameEncrypted, &f.ParentID, &f.IsDirectory,
			&f.FileSize, &f.FileType, &f.OSSKey, &f.EncryptedFileKey,
			&f.IV, &f.Salt, &f.ContentHash, &f.CreatedAt, &f.UpdatedAt, &f.DeletedAt,
		); err != nil {
			return nil, err
		}
		files = append(files, f)
	}

	return files, nil
}

// FileStatRow 统计聚合用的精简文件行（不含密钥字段）
type FileStatRow struct {
	ID            string
	ParentID      *string
	IsDirectory   bool
	FileSize      int64
	FileType      string
	NameEncrypted string
}

// GetFileStatRows 返回全部未删除文件/目录的精简行，供全库统计聚合
func (d *Database) GetFileStatRows() ([]FileStatRow, error) {
	rows, err := d.conn.Query(
		`SELECT id, parent_id, is_directory, file_size, IFNULL(file_type, ''), name_encrypted
		 FROM files WHERE deleted_at IS NULL`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]FileStatRow, 0)
	for rows.Next() {
		var r FileStatRow
		if err := rows.Scan(&r.ID, &r.ParentID, &r.IsDirectory, &r.FileSize, &r.FileType, &r.NameEncrypted); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// LoginDayCount 某日成功登录次数
type LoginDayCount struct {
	Day   string `json:"day"`
	Count int    `json:"count"`
}

// GetLoginSuccessDaily 返回最近 days 天每天的成功登录次数（按日期分组）。
// created_at 兼容 'YYYY-MM-DD HH:MM:SS' 与 RFC3339 两种格式，
// 两者前 10 位均为日期，substr + 字符串比较均成立。
func (d *Database) GetLoginSuccessDaily(days int) ([]LoginDayCount, error) {
	rows, err := d.conn.Query(
		`SELECT substr(created_at, 1, 10) AS day, COUNT(*)
		 FROM login_attempts
		 WHERE success = 1 AND created_at >= date('now', ?)
		 GROUP BY day ORDER BY day ASC`,
		fmt.Sprintf("-%d days", days-1),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]LoginDayCount, 0)
	for rows.Next() {
		var lc LoginDayCount
		if err := rows.Scan(&lc.Day, &lc.Count); err != nil {
			return nil, err
		}
		out = append(out, lc)
	}
	return out, rows.Err()
}

func (d *Database) GetFile(id string) (*models.FileRecord, error) {
	var f models.FileRecord
	err := d.conn.QueryRow(
		"SELECT id, name_encrypted, parent_id, is_directory, file_size, file_type, oss_key, encrypted_file_key, iv, salt, IFNULL(content_hash, '') AS content_hash, created_at, updated_at, deleted_at FROM files WHERE id = ? AND deleted_at IS NULL",
		id,
	).Scan(
		&f.ID, &f.NameEncrypted, &f.ParentID, &f.IsDirectory,
		&f.FileSize, &f.FileType, &f.OSSKey, &f.EncryptedFileKey,
		&f.IV, &f.Salt, &f.ContentHash, &f.CreatedAt, &f.UpdatedAt, &f.DeletedAt,
	)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (d *Database) SoftDeleteFile(id string) error {
	now := time.Now()
	_, err := d.conn.Exec(
		"UPDATE files SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
		now, id,
	)
	return err
}

// ---- 回收站 ----

type TrashItem struct {
	ID            string    `json:"id"`
	NameEncrypted string    `json:"name_encrypted"`
	IsDirectory   bool      `json:"is_directory"`
	FileSize      int64     `json:"file_size"`
	ParentID      *string   `json:"parent_id"`
	DeletedAt     time.Time `json:"deleted_at"`
}

// ListTrash 回收站列表：只列显式软删的行；被删文件夹的子项（未单独标记）不重复出现
func (d *Database) ListTrash() ([]TrashItem, error) {
	rows, err := d.conn.Query(
		`SELECT id, name_encrypted, is_directory, file_size, parent_id, deleted_at
		 FROM files WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]TrashItem, 0)
	for rows.Next() {
		var t TrashItem
		if err := rows.Scan(&t.ID, &t.NameEncrypted, &t.IsDirectory, &t.FileSize,
			&t.ParentID, &t.DeletedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ObjectRefCount oss_key 被 files（任意状态）或 file_versions 引用的总行数。
// 软删行也算引用——行未物理删除前对象随时可能随恢复重新在用，不可登记清理。
func (d *Database) ObjectRefCount(ossKey string) (int, error) {
	var n int
	err := d.conn.QueryRow(
		`SELECT (SELECT COUNT(*) FROM files WHERE oss_key = ?)
		      + (SELECT COUNT(*) FROM file_versions WHERE oss_key = ?)`,
		ossKey, ossKey,
	).Scan(&n)
	return n, err
}

// RestoreFile 恢复软删行：原父目录仍存在且未删除则回原位，否则回根目录。
// 返回实际恢复到的 parent_id（nil = 根目录）。行不存在或未删除返回 sql.ErrNoRows。
func (d *Database) RestoreFile(id string) (*string, error) {
	var oldParent *string
	var delAt any
	err := d.conn.QueryRow(
		"SELECT parent_id, deleted_at FROM files WHERE id = ? AND deleted_at IS NOT NULL",
		id,
	).Scan(&oldParent, &delAt)
	if err != nil {
		return nil, err
	}

	target := oldParent
	if oldParent != nil {
		var parentDel any
		if err := d.conn.QueryRow("SELECT deleted_at FROM files WHERE id = ?", *oldParent).Scan(&parentDel); err != nil || parentDel != nil {
			// 原目录已不存在或同样在回收站 → 恢复到根目录
			target = nil
		}
	}

	res, err := d.conn.Exec(
		"UPDATE files SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL", id,
	)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, sql.ErrNoRows
	}
	// 撤下历史遗留（登记时机迁移前的旧数据）的台账条目：对象重新在用，
	// 不可再被按台账清理。尽力而为，失败不影响恢复本身。
	_, _ = d.conn.Exec("DELETE FROM deleted_objects WHERE file_id = ?", id)
	return target, nil
}

// purgeTrash 物理删除全部软删行及其后代（子项未标记 deleted_at 但随父消失）。
// files 行形成树且禁止建环（MoveFile 防环），递归 CTE 不会无限展开。
// 同步删除这些行的历史版本记录（file_versions），避免留下孤儿行。
// 不触碰 OSS 对象：同内容寻址复用同一 oss_key 的其他存活文件不受影响。
// 台账登记时机 = 物理清理（而非软删）：软删/回收站期间对象仍需支撑恢复与
// 历史版本回溯，一律不登记；purge 后逐对象检查剩余引用（files 任意状态 +
// file_versions），仍被引用（如去重复用的兄弟文件）的对象不登记，绝无误删引导。
func (d *Database) purgeTrash(extraCond string, args ...any) (int64, error) {
	cte := `WITH RECURSIVE trash_tree(id) AS (
		SELECT id FROM files WHERE deleted_at IS NOT NULL` + extraCond + `
		UNION ALL
		SELECT f.id FROM files f JOIN trash_tree t ON f.parent_id = t.id
	)`

	// 1. 收集本批待删对象（主对象 + 历史版本对象），供删除后登记台账
	type fileMeta struct {
		name, ftype string
	}
	var metas = map[string]fileMeta{}
	type ledgerObj struct {
		fileID, name, ossKey, ftype string
		size                        int64
		isVersion                   bool
	}
	var ledger []ledgerObj

	rows, err := d.conn.Query(
		cte+` SELECT id, name_encrypted, oss_key, file_type, file_size FROM files WHERE id IN (SELECT id FROM trash_tree)`,
		args...,
	)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var id, name, ossKey, ftype string
		var size int64
		if err := rows.Scan(&id, &name, &ossKey, &ftype, &size); err != nil {
			rows.Close()
			return 0, err
		}
		metas[id] = fileMeta{name, ftype}
		if ossKey != "" {
			ledger = append(ledger, ledgerObj{id, name, ossKey, ftype, size, false})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	vrows, err := d.conn.Query(
		cte+` SELECT file_id, oss_key, file_size FROM file_versions WHERE file_id IN (SELECT id FROM trash_tree)`,
		args...,
	)
	if err != nil {
		return 0, err
	}
	for vrows.Next() {
		var fileID, ossKey string
		var size int64
		if err := vrows.Scan(&fileID, &ossKey, &size); err != nil {
			vrows.Close()
			return 0, err
		}
		if ossKey == "" {
			continue
		}
		m := metas[fileID]
		ledger = append(ledger, ledgerObj{fileID, m.name, ossKey, m.ftype, size, true})
	}
	if err := vrows.Err(); err != nil {
		vrows.Close()
		return 0, err
	}
	vrows.Close()

	// 2. 物理删除版本行与主行（原有逻辑）
	if _, err := d.conn.Exec(
		cte+` DELETE FROM file_versions WHERE file_id IN (SELECT id FROM trash_tree)`,
		args...,
	); err != nil {
		return 0, err
	}
	res, err := d.conn.Exec(
		cte+` DELETE FROM files WHERE id IN (SELECT id FROM trash_tree)`,
		args...,
	)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}

	// 3. 行已删：无剩余引用的对象登记台账（同 oss_key 去重，登记一次即可）
	seen := map[string]bool{}
	for _, o := range ledger {
		if seen[o.ossKey] {
			continue
		}
		seen[o.ossKey] = true
		ref, err := d.ObjectRefCount(o.ossKey)
		if err != nil || ref > 0 {
			continue // 仍被存活文件/版本引用（去重复用），不可按台账清理
		}
		if err := d.RecordDeletedObject(o.fileID, o.name, o.ossKey, o.ftype, "回收站物理清理", o.size, o.isVersion); err != nil {
			continue // 登记失败不阻塞清理（对象本来就不物理删除）
		}
	}
	return n, nil
}

// PurgeExpiredTrash 清理超过保留期的软删行（含后代）；days<=0 = 永不自动清理
func (d *Database) PurgeExpiredTrash(days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	return d.purgeTrash(" AND deleted_at < datetime('now', ?)", fmt.Sprintf("-%d days", days))
}

// PurgeAllTrash 清空回收站：立即物理删除全部软删行及后代
func (d *Database) PurgeAllTrash() (int64, error) {
	return d.purgeTrash("")
}

// PurgeDeletedObjectsOlderThan 清理超过保留期的删除台账；days<=0 = 永不清理
func (d *Database) PurgeDeletedObjectsOlderThan(days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	res, err := d.conn.Exec(
		"DELETE FROM deleted_objects WHERE deleted_at < datetime('now', ?)",
		fmt.Sprintf("-%d days", days),
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

type DeletedObject struct {
	ID            int64     `json:"id"`
	FileID        string    `json:"file_id"`
	NameEncrypted string    `json:"name_encrypted"`
	OSSKey        string    `json:"oss_key"`
	FileSize      int64     `json:"file_size"`
	FileType      string    `json:"file_type"`
	IsVersion     bool      `json:"is_version"`
	Reason        string    `json:"reason"`
	DeletedAt     time.Time `json:"deleted_at"`
}

// RecordDeletedObject 软删除台账: 对象保留在 OSS 上不再物理删除，仅登记
func (d *Database) RecordDeletedObject(fileID, nameEncrypted, ossKey, fileType, reason string, fileSize int64, isVersion bool) error {
	isVer := 0
	if isVersion {
		isVer = 1
	}
	_, err := d.conn.Exec(
		`INSERT INTO deleted_objects (file_id, name_encrypted, oss_key, file_size, file_type, is_version, reason)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		fileID, nameEncrypted, ossKey, fileSize, fileType, isVer, reason,
	)
	return err
}

func (d *Database) ListDeletedObjects() ([]DeletedObject, error) {
	rows, err := d.conn.Query(
		`SELECT id, file_id, name_encrypted, oss_key, file_size, file_type, is_version, reason, deleted_at
		 FROM deleted_objects ORDER BY deleted_at DESC, id DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var objects []DeletedObject
	for rows.Next() {
		var o DeletedObject
		var isVer int64
		if err := rows.Scan(&o.ID, &o.FileID, &o.NameEncrypted, &o.OSSKey, &o.FileSize, &o.FileType, &isVer, &o.Reason, &o.DeletedAt); err != nil {
			return nil, err
		}
		o.IsVersion = isVer != 0
		objects = append(objects, o)
	}
	return objects, nil
}

// OSSBackup 旧版数据库台账（oss_backups 表）的一行，仅供新台账文件的一次性导入。
type OSSBackup struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	OSSKey     string    `json:"oss_key"`
	MD5        string    `json:"md5"`
	FileSize   int64     `json:"file_size"`
	UploadedAt time.Time `json:"uploaded_at"`
}

// ListOSSBackups 读旧版数据库台账（新装库无此表时返回错误，由调用方忽略）。
func (d *Database) ListOSSBackups() ([]OSSBackup, error) {
	rows, err := d.conn.Query(
		`SELECT id, name, oss_key, md5, file_size, uploaded_at FROM oss_backups ORDER BY id DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var backups []OSSBackup
	for rows.Next() {
		var b OSSBackup
		if err := rows.Scan(&b.ID, &b.Name, &b.OSSKey, &b.MD5, &b.FileSize, &b.UploadedAt); err != nil {
			return nil, err
		}
		backups = append(backups, b)
	}
	return backups, nil
}

func (d *Database) UpdateFile(id string, nameEncrypted string) error {
	now := time.Now()
	_, err := d.conn.Exec(
		"UPDATE files SET name_encrypted = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
		nameEncrypted, now, id,
	)
	return err
}

func (d *Database) UpdateFileParent(id string, parentID *string) error {
	now := time.Now()
	_, err := d.conn.Exec(
		"UPDATE files SET parent_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
		parentID, now, id,
	)
	return err
}
func (d *Database) UpdateFileContent(id string, fileSize int64, fileType string, encKey, iv, salt []byte, ossKey string, contentHash string) error {
	now := time.Now()
	// content_hash 恒为字符串（清空传 ''，不再写 NULL——NULL 会破坏 Scan）
	result, err := d.conn.Exec(
		"UPDATE files SET file_size = ?, file_type = ?, encrypted_file_key = ?, iv = ?, salt = ?, oss_key = ?, content_hash = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
		fileSize, fileType, encKey, iv, salt, ossKey, contentHash, now, id,
	)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("file not found")
	}
	return nil
}

// FindFileByContentHash 内容寻址查重：返回任意内容哈希相同的有效文件
// （仅文件、已排除软删除与无对象记录），供上传去重复用同一 OSS 对象。
func (d *Database) FindFileByContentHash(contentHash string) (*models.FileRecord, error) {
	if contentHash == "" {
		return nil, sql.ErrNoRows
	}
	var f models.FileRecord
	err := d.conn.QueryRow(
		"SELECT id, name_encrypted, parent_id, is_directory, file_size, file_type, oss_key, encrypted_file_key, iv, salt, IFNULL(content_hash, '') AS content_hash, created_at, updated_at, deleted_at FROM files WHERE content_hash = ? AND deleted_at IS NULL AND is_directory = 0 AND oss_key != '' LIMIT 1",
		contentHash,
	).Scan(
		&f.ID, &f.NameEncrypted, &f.ParentID, &f.IsDirectory,
		&f.FileSize, &f.FileType, &f.OSSKey, &f.EncryptedFileKey,
		&f.IV, &f.Salt, &f.ContentHash, &f.CreatedAt, &f.UpdatedAt, &f.DeletedAt,
	)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (d *Database) GetFileByOSSKey(ossKey string) (*models.FileRecord, error) {
	var f models.FileRecord
	err := d.conn.QueryRow(
		"SELECT id, name_encrypted, parent_id, is_directory, file_size, file_type, oss_key, encrypted_file_key, iv, salt, IFNULL(content_hash, '') AS content_hash, created_at, updated_at, deleted_at FROM files WHERE oss_key = ? AND deleted_at IS NULL",
		ossKey,
	).Scan(
		&f.ID, &f.NameEncrypted, &f.ParentID, &f.IsDirectory,
		&f.FileSize, &f.FileType, &f.OSSKey, &f.EncryptedFileKey,
		&f.IV, &f.Salt, &f.ContentHash, &f.CreatedAt, &f.UpdatedAt, &f.DeletedAt,
	)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (d *Database) GetMFA() (*models.MFARecord, error) {
	var m models.MFARecord
	var enabled int
	err := d.conn.QueryRow(
		"SELECT id, secret, enabled, created_at FROM mfa ORDER BY id DESC LIMIT 1",
	).Scan(&m.ID, &m.Secret, &enabled, &m.CreatedAt)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	m.Enabled = enabled == 1
	return &m, nil
}

func (d *Database) SetupMFA(secret string) error {
	_, err := d.conn.Exec("DELETE FROM mfa")
	if err != nil {
		return err
	}
	_, err = d.conn.Exec(
		"INSERT INTO mfa (secret, enabled) VALUES (?, 0)",
		secret,
	)
	return err
}

func (d *Database) EnableMFA() error {
	_, err := d.conn.Exec("UPDATE mfa SET enabled = 1 WHERE id = (SELECT MAX(id) FROM mfa)")
	return err
}

func (d *Database) DisableMFA() error {
	if _, err := d.conn.Exec("DELETE FROM mfa"); err != nil {
		return err
	}
	// 恢复码随 MFA 一起失效
	_, err := d.conn.Exec("DELETE FROM mfa_recovery_codes")
	return err
}

// ReplaceRecoveryCodes 原子替换全部恢复码哈希（重新生成即令旧码全部失效）
func (d *Database) ReplaceRecoveryCodes(hashes []string) error {
	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM mfa_recovery_codes"); err != nil {
		return err
	}
	for _, h := range hashes {
		if _, err := tx.Exec("INSERT INTO mfa_recovery_codes (code_hash) VALUES (?)", h); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ConsumeRecoveryCode 一次性消费：命中未使用的码即标记已用（原子），返回是否命中。
// 已使用过的码再次提交返回 false，防止重放。
func (d *Database) ConsumeRecoveryCode(hash string) (bool, error) {
	res, err := d.conn.Exec(
		"UPDATE mfa_recovery_codes SET used_at = datetime('now') WHERE code_hash = ? AND used_at IS NULL",
		hash,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// CountRecoveryCodes 恢复码统计（总数 / 剩余未使用）
func (d *Database) CountRecoveryCodes() (total int, remaining int, err error) {
	err = d.conn.QueryRow(
		"SELECT COUNT(*), IFNULL(SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END), 0) FROM mfa_recovery_codes",
	).Scan(&total, &remaining)
	return
}

func (d *Database) RecordTOTPAttempt(success bool) error {
	_, err := d.conn.Exec(
		"INSERT INTO totp_attempts (session_token, success) VALUES (?, ?)",
		"_global", success,
	)
	return err
}

func (d *Database) GetFailedTOTPCount(since time.Duration) (int, error) {
	var count int
	err := d.conn.QueryRow(
		"SELECT COUNT(*) FROM totp_attempts WHERE session_token = '_global' AND success = 0 AND created_at > datetime('now', ?)",
		sqliteSinceModifier(since),
	).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

func (d *Database) RecordVerificationAttempt(success bool) error {
	_, err := d.conn.Exec(
		"INSERT INTO login_attempts (ip_address, success) VALUES (?, ?)",
		"_global", success,
	)
	return err
}

func (d *Database) GetFailedVerificationCount(since time.Duration) (int, error) {
	var count int
	err := d.conn.QueryRow(
		"SELECT COUNT(*) FROM login_attempts WHERE ip_address = '_global' AND success = 0 AND created_at > datetime('now', ?)",
		sqliteSinceModifier(since),
	).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

func (d *Database) CleanupOldAttempts(olderThan time.Duration) error {
	modifier := sqliteSinceModifier(olderThan)
	_, err := d.conn.Exec("DELETE FROM login_attempts WHERE created_at < datetime('now', ?)", modifier)
	if err != nil {
		return err
	}
	_, err = d.conn.Exec("DELETE FROM totp_attempts WHERE created_at < datetime('now', ?)", modifier)
	return err
}

func sqliteSinceModifier(d time.Duration) string {
	return fmt.Sprintf("-%d minutes", int64(d.Minutes()))
}

type FileVersion struct {
	ID               int64     `json:"id"`
	FileID           string    `json:"file_id"`
	Version          int       `json:"version"`
	OSSKey           string    `json:"oss_key"`
	EncryptedFileKey []byte    `json:"encrypted_file_key"`
	IV               []byte    `json:"iv"`
	Salt             []byte    `json:"salt"`
	FileSize         int64     `json:"file_size"`
	CreatedAt        time.Time `json:"created_at"`
}

func (d *Database) CreateFileVersion(fileID, ossKey string, encKey []byte, iv, salt []byte, fileSize int64) error {
	var maxVersion int
	d.conn.QueryRow("SELECT COALESCE(MAX(version), 0) FROM file_versions WHERE file_id = ?", fileID).Scan(&maxVersion)
	newVersion := maxVersion + 1

	_, err := d.conn.Exec(
		`INSERT INTO file_versions (file_id, version, oss_key, encrypted_file_key, iv, salt, file_size)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		fileID, newVersion, ossKey, encKey, iv, salt, fileSize,
	)
	return err
}

func (d *Database) GetFileVersions(fileID string) ([]FileVersion, error) {
	rows, err := d.conn.Query(
		`SELECT id, file_id, version, oss_key, encrypted_file_key, iv, salt, file_size, created_at
		 FROM file_versions WHERE file_id = ? ORDER BY version DESC`,
		fileID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var versions []FileVersion
	for rows.Next() {
		var v FileVersion
		if err := rows.Scan(&v.ID, &v.FileID, &v.Version, &v.OSSKey, &v.EncryptedFileKey, &v.IV, &v.Salt, &v.FileSize, &v.CreatedAt); err != nil {
			return nil, err
		}
		versions = append(versions, v)
	}
	return versions, nil
}
