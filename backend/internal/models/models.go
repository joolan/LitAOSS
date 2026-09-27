package models

import "time"

type AuthRecord struct {
	ID            int64     `json:"id"`
	PasswordHash  string    `json:"password_hash"`
	Salt          string    `json:"salt"`
	EncAccountKey []byte    `json:"encrypted_account_key"`
	CreatedAt     time.Time `json:"created_at"`
}

type AuthState struct {
	ID            int64     `json:"id"`
	PasswordHash  string    `json:"password_hash"`
	Salt          string    `json:"salt"`
	CreatedAt     time.Time `json:"created_at"`
}

type FileRecord struct {
	ID              string     `json:"id"`
	NameEncrypted   string     `json:"name_encrypted"`
	ParentID        *string    `json:"parent_id"`
	IsDirectory     bool       `json:"is_directory"`
	FileSize        int64      `json:"file_size"`
	FileType        string     `json:"file_type"`
	OSSKey          string     `json:"oss_key"`
	EncryptedFileKey []byte   `json:"encrypted_file_key"`
	IV              []byte     `json:"iv"`
	Salt            []byte     `json:"salt"`
	ContentHash     string     `json:"content_hash"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	DeletedAt       *time.Time `json:"deleted_at"`
}

type LoginAttempt struct {
	ID        int64     `json:"id"`
	IPAddress string    `json:"ip_address"`
	Success   bool      `json:"success"`
	CreatedAt time.Time `json:"created_at"`
}

type LoginRequest struct {
	AuthHash string `json:"auth_hash" binding:"required"`
	Salt     string `json:"salt" binding:"required"`
}

type LoginResponse struct {
	OK                 bool   `json:"ok"`
	EncryptedAccountKey []byte `json:"encrypted_account_key,omitempty"`
	Salt               string `json:"salt,omitempty"`
	SessionToken       string `json:"session_token,omitempty"`
	MFARequired        bool   `json:"mfa_required,omitempty"`
	Version            string `json:"version,omitempty"` // 仅凭证验证通过时返回
	Error              string `json:"error,omitempty"`
}

type SetupRequest struct {
	PasswordHash       string `json:"password_hash" binding:"required"`
	Salt               string `json:"salt" binding:"required"`
	EncryptedAccountKey []byte `json:"encrypted_account_key" binding:"required"`
}

type SetupResponse struct {
	OK  bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type FileListResponse struct {
	Files []FileRecord `json:"files"`
}

type FileUploadRequest struct {
	NameEncrypted    string `json:"name_encrypted" binding:"required"`
	ParentID         string `json:"parent_id"`
	FileSize         int64  `json:"file_size" binding:"required"`
	FileType         string `json:"file_type"`
	EncryptedFileKey []byte `json:"encrypted_file_key" binding:"required"`
	IV               []byte `json:"iv" binding:"required"`
	Salt             []byte `json:"salt" binding:"required"`
	OSSKey           string `json:"oss_key" binding:"required"`
	ContentHash      string `json:"content_hash"`
}

type PresignRequest struct {
	OSSKey  string `json:"oss_key" binding:"required"`
	Expires int    `json:"expires"`
}

type PresignResponse struct {
	URL string `json:"url"`
}

type FileDeleteRequest struct {
	ID string `json:"id" binding:"required"`
}

type MessageResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type MFARecord struct {
	ID        int64     `json:"id"`
	Secret    string    `json:"secret"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
}

type MFASetupResponse struct {
	OK       bool   `json:"ok"`
	Secret   string `json:"secret,omitempty"`
	URI      string `json:"uri,omitempty"`
	Error    string `json:"error,omitempty"`
}

type MFAStatusResponse struct {
	OK               bool `json:"ok"`
	Enabled          bool `json:"enabled"`
	RecoveryTotal    int  `json:"recovery_total"`
	RecoveryRemaining int `json:"recovery_remaining"`
}

type TOTPVerifyRequest struct {
	Code         string `json:"code" binding:"required"`
	PasswordHash string `json:"password_hash,omitempty"`
}
