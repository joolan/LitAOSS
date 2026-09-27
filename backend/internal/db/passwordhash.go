package db

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	argonTime    = 2
	argonMemory  = 32 * 1024 // KiB
	argonThreads = 1
	argonKeyLen  = 32
	argonSaltLen = 16
)

// hashAuthHash 用 argon2id 包裹客户端提交的 Auth Hash（服务端只存包裹后的值，
// 数据库被拖也无法直接重放登录）。输入是 PBKDF2-50万 的 256 位高熵凭据，
// 此处参数取中等强度即可。
func hashAuthHash(authHash string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	derived := argon2.IDKey([]byte(authHash), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(derived),
	), nil
}

// verifyAuthHash 校验提交的 Auth Hash；若库中仍是历史明文格式则做常数时间比较。
func verifyAuthHash(stored, authHash string) (bool, error) {
	if !strings.HasPrefix(stored, "$argon2id$") {
		return subtle.ConstantTimeCompare([]byte(stored), []byte(authHash)) == 1, nil
	}

	parts := strings.Split(stored, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, fmt.Errorf("malformed argon2 hash")
	}
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, fmt.Errorf("malformed argon2 params: %w", err)
	}
	if v, err := strconv.Atoi(strings.TrimPrefix(parts[2], "v=")); err != nil || v != argon2.Version {
		return false, fmt.Errorf("unsupported argon2 version")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, err
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, err
	}
	got := argon2.IDKey([]byte(authHash), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
