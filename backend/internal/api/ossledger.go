package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"lit-aoss/internal/db"
)

// OSSBackupLedgerEntry 与 /api/backup/list 的 oss_backups 元素同构。
type OSSBackupLedgerEntry struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	OSSKey     string    `json:"oss_key"`
	MD5        string    `json:"md5"`
	FileSize   int64     `json:"file_size"`
	UploadedAt time.Time `json:"uploaded_at"`
}

// OSSBackupLedger OSS 备份上传台账，持久化为 data/backups/oss-ledger.json。
//
// 不放数据库的两个原因:
//  1. 上传后台账写入本身会改变数据库内容 → 下一次备份 md5 必然变化 → MD5 跳过永远失效；
//  2. 台账是 OSS 侧状态（哪些对象已上传、允许恢复哪些 key），恢复旧数据库快照时
//     不应把它回滚——否则较新的 OSS 对象会从恢复白名单中消失。
type OSSBackupLedger struct {
	path    string
	mu      sync.Mutex
	entries []OSSBackupLedgerEntry // 按 ID 升序
	seq     int64
}

// NewOSSBackupLedger 加载台账文件；文件不存在时从旧版数据库 oss_backups 表一次性导入。
func NewOSSBackupLedger(backupDir string, database *db.Database) *OSSBackupLedger {
	l := &OSSBackupLedger{
		path:    filepath.Join(backupDir, "oss-ledger.json"),
		entries: []OSSBackupLedgerEntry{},
	}

	data, err := os.ReadFile(l.path)
	if err == nil {
		var entries []OSSBackupLedgerEntry
		if json.Unmarshal(data, &entries) == nil && entries != nil {
			l.entries = entries
			for _, e := range entries {
				if e.ID > l.seq {
					l.seq = e.ID
				}
			}
			return l
		}
	}

	// 一次性迁移: 旧实现把台账写在数据库 oss_backups 表里
	if database != nil {
		if legacy, err := database.ListOSSBackups(); err == nil {
			for _, b := range legacy {
				l.entries = append(l.entries, OSSBackupLedgerEntry{
					ID: b.ID, Name: b.Name, OSSKey: b.OSSKey,
					MD5: b.MD5, FileSize: b.FileSize, UploadedAt: b.UploadedAt,
				})
				if b.ID > l.seq {
					l.seq = b.ID
				}
			}
			if len(l.entries) > 0 {
				l.saveLocked()
			}
		}
	}

	return l
}

// Append 记录一次成功上传；写盘失败则回滚该条，保持内存与磁盘一致。
func (l *OSSBackupLedger) Append(name, ossKey, md5 string, fileSize int64) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.seq++
	l.entries = append(l.entries, OSSBackupLedgerEntry{
		ID:         l.seq,
		Name:       name,
		OSSKey:     ossKey,
		MD5:        md5,
		FileSize:   fileSize,
		UploadedAt: time.Now().UTC(),
	})
	if err := l.saveLocked(); err != nil {
		l.entries = l.entries[:len(l.entries)-1]
		l.seq--
		return err
	}
	return nil
}

// Latest 最近一次成功上传，无记录返回 nil。
func (l *OSSBackupLedger) Latest() *OSSBackupLedgerEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.entries) == 0 {
		return nil
	}
	e := l.entries[len(l.entries)-1]
	return &e
}

// List 全部记录，新→旧。
func (l *OSSBackupLedger) List() []OSSBackupLedgerEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]OSSBackupLedgerEntry, 0, len(l.entries))
	for i := len(l.entries) - 1; i >= 0; i-- {
		out = append(out, l.entries[i])
	}
	return out
}

// GetByKey 按 oss_key 查（恢复白名单校验），无记录返回 nil。
func (l *OSSBackupLedger) GetByKey(ossKey string) *OSSBackupLedgerEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := len(l.entries) - 1; i >= 0; i-- {
		if l.entries[i].OSSKey == ossKey {
			e := l.entries[i]
			return &e
		}
	}
	return nil
}

// saveLocked 原子写盘（tmp + rename），调用方需持锁。
func (l *OSSBackupLedger) saveLocked() error {
	if err := os.MkdirAll(filepath.Dir(l.path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(l.entries, "", "  ")
	if err != nil {
		return err
	}
	tmp := l.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, l.path)
}
