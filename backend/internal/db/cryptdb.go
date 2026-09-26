package db

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type EncryptedDB struct {
	*Database
	dbPath      string
	encPath     string
	passphrase  string
	initialized bool
}

func NewEncrypted(dbPath, passphrase string) (*EncryptedDB, error) {
	encPath := dbPath + ".enc"
	edb := &EncryptedDB{
		dbPath:     dbPath,
		encPath:    encPath,
		passphrase: passphrase,
	}

	// 必须在读取 .enc 之前: 应用 RestoreBackup 暂存的恢复快照，
	// 否则旧 .enc 会把恢复结果覆盖回去（恢复静默失效）
	if err := applyPendingRestore(dbPath, passphrase); err != nil {
		return nil, fmt.Errorf("apply pending restore: %w", err)
	}

	if passphrase == "" {
		db, err := New(dbPath)
		if err != nil {
			return nil, err
		}
		edb.Database = db
		edb.initialized = true
		return edb, nil
	}

	if err := edb.decryptOnStart(); err != nil {
		return nil, fmt.Errorf("decrypt database: %w", err)
	}

	db, err := New(dbPath)
	if err != nil {
		return nil, err
	}
	edb.Database = db
	edb.initialized = true

	return edb, nil
}

// applyPendingRestore 若存在 <db>.restore（恢复流程暂存的快照），则在启动时应用:
// 清掉旧主文件与 -wal/-shm 残留（防止旧日志重放到恢复后的库上）→ 写入恢复内容
// → 同步 .enc（防止下次启动又被旧 .enc 回退）→ 删除标记。操作幂等。
func applyPendingRestore(dbPath, passphrase string) error {
	staging := dbPath + ".restore"
	data, err := os.ReadFile(staging)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read restore staging: %w", err)
	}

	os.Remove(dbPath)
	os.Remove(dbPath + "-wal")
	os.Remove(dbPath + "-shm")

	if err := os.WriteFile(dbPath, data, 0600); err != nil {
		return fmt.Errorf("write restored db: %w", err)
	}

	if passphrase != "" {
		encData, err := encryptAES(data, passphrase)
		if err != nil {
			return fmt.Errorf("encrypt restored db: %w", err)
		}
		if err := os.WriteFile(dbPath+".enc", encData, 0600); err != nil {
			return fmt.Errorf("write restored encrypted db: %w", err)
		}
	}

	// 标记最后删除: 中途崩溃则下次启动重放（幂等）
	if err := os.Remove(staging); err != nil {
		return fmt.Errorf("remove restore staging: %w", err)
	}
	return nil
}

func (e *EncryptedDB) Close() error {
	if e.Database != nil {
		if err := e.Database.Close(); err != nil {
			return err
		}
	}

	if e.passphrase != "" && e.initialized {
		if err := e.encryptOnClose(); err != nil {
			return fmt.Errorf("encrypt database on close: %w", err)
		}
	}

	return nil
}

func (e *EncryptedDB) decryptOnStart() error {
	if _, err := os.Stat(e.encPath); os.IsNotExist(err) {
		return nil
	}

	encData, err := os.ReadFile(e.encPath)
	if err != nil {
		return fmt.Errorf("read encrypted db: %w", err)
	}

	plainData, err := decryptAES(encData, e.passphrase)
	if err != nil {
		return fmt.Errorf("decrypt db: %w", err)
	}

	dir := filepath.Dir(e.dbPath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create db dir: %w", err)
	}

	if err := os.WriteFile(e.dbPath, plainData, 0600); err != nil {
		return fmt.Errorf("write decrypted db: %w", err)
	}

	return nil
}

func (e *EncryptedDB) encryptOnClose() error {
	plainData, err := os.ReadFile(e.dbPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read db: %w", err)
	}

	encData, err := encryptAES(plainData, e.passphrase)
	if err != nil {
		return fmt.Errorf("encrypt db: %w", err)
	}

	if err := os.WriteFile(e.encPath, encData, 0600); err != nil {
		return fmt.Errorf("write encrypted db: %w", err)
	}

	os.Remove(e.dbPath)

	return nil
}

func encryptAES(plaintext []byte, passphrase string) ([]byte, error) {
	key := deriveDBKey(passphrase)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}

	ciphertext := aesGCM.Seal(nonce, nonce, plaintext, nil)
	return ciphertext, nil
}

func decryptAES(ciphertext []byte, passphrase string) ([]byte, error) {
	key := deriveDBKey(passphrase)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	nonceSize := aesGCM.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, err
	}

	return plaintext, nil
}

func deriveDBKey(passphrase string) []byte {
	h := sha256.Sum256([]byte("lit-aoss-db-key:" + passphrase))
	return h[:]
}
