package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
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
	}

	for _, q := range queries {
		if _, err := d.conn.Exec(q); err != nil {
			return fmt.Errorf("exec migration: %w", err)
		}
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
		passwordHash, salt,
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
	result, err := d.conn.Exec(
		"UPDATE auth SET password_hash = ?, encrypted_account_key = ? WHERE id = (SELECT MAX(id) FROM auth)",
		passwordHash, encKey,
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
	var count int
	err := d.conn.QueryRow(
		"SELECT COUNT(*) FROM auth WHERE password_hash = ?", authHash,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
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

func (d *Database) GetFailedLoginCount(since time.Duration) (int, error) {
	var count int
	err := d.conn.QueryRow(
		"SELECT COUNT(*) FROM login_attempts WHERE success = 0 AND created_at > datetime('now', ?)",
		sqliteSinceModifier(since),
	).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

func (d *Database) CreateFile(file *models.FileRecord) error {
	_, err := d.conn.Exec(
		`INSERT INTO files (id, name_encrypted, parent_id, is_directory, file_size, file_type,
		 oss_key, encrypted_file_key, iv, salt, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		file.ID, file.NameEncrypted, file.ParentID, file.IsDirectory,
		file.FileSize, file.FileType, file.OSSKey, file.EncryptedFileKey,
		file.IV, file.Salt, file.CreatedAt, file.UpdatedAt,
	)
	return err
}

func (d *Database) GetFiles(parentID *string) ([]models.FileRecord, error) {
	var rows *sql.Rows
	var err error

	if parentID == nil {
		rows, err = d.conn.Query(
			"SELECT id, name_encrypted, parent_id, is_directory, file_size, file_type, oss_key, encrypted_file_key, iv, salt, created_at, updated_at, deleted_at FROM files WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY is_directory DESC, name_encrypted ASC",
		)
	} else {
		rows, err = d.conn.Query(
			"SELECT id, name_encrypted, parent_id, is_directory, file_size, file_type, oss_key, encrypted_file_key, iv, salt, created_at, updated_at, deleted_at FROM files WHERE parent_id = ? AND deleted_at IS NULL ORDER BY is_directory DESC, name_encrypted ASC",
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
			&f.IV, &f.Salt, &f.CreatedAt, &f.UpdatedAt, &f.DeletedAt,
		); err != nil {
			return nil, err
		}
		files = append(files, f)
	}

	return files, nil
}

func (d *Database) GetFile(id string) (*models.FileRecord, error) {
	var f models.FileRecord
	err := d.conn.QueryRow(
		"SELECT id, name_encrypted, parent_id, is_directory, file_size, file_type, oss_key, encrypted_file_key, iv, salt, created_at, updated_at, deleted_at FROM files WHERE id = ? AND deleted_at IS NULL",
		id,
	).Scan(
		&f.ID, &f.NameEncrypted, &f.ParentID, &f.IsDirectory,
		&f.FileSize, &f.FileType, &f.OSSKey, &f.EncryptedFileKey,
		&f.IV, &f.Salt, &f.CreatedAt, &f.UpdatedAt, &f.DeletedAt,
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
func (d *Database) UpdateFileContent(id string, fileSize int64, fileType string, encKey, iv, salt []byte, ossKey string) error {
	now := time.Now()
	result, err := d.conn.Exec(
		"UPDATE files SET file_size = ?, file_type = ?, encrypted_file_key = ?, iv = ?, salt = ?, oss_key = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
		fileSize, fileType, encKey, iv, salt, ossKey, now, id,
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

func (d *Database) GetFileByOSSKey(ossKey string) (*models.FileRecord, error) {
	var f models.FileRecord
	err := d.conn.QueryRow(
		"SELECT id, name_encrypted, parent_id, is_directory, file_size, file_type, oss_key, encrypted_file_key, iv, salt, created_at, updated_at, deleted_at FROM files WHERE oss_key = ? AND deleted_at IS NULL",
		ossKey,
	).Scan(
		&f.ID, &f.NameEncrypted, &f.ParentID, &f.IsDirectory,
		&f.FileSize, &f.FileType, &f.OSSKey, &f.EncryptedFileKey,
		&f.IV, &f.Salt, &f.CreatedAt, &f.UpdatedAt, &f.DeletedAt,
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
	_, err := d.conn.Exec("DELETE FROM mfa")
	return err
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
