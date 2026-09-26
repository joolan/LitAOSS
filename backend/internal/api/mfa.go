package api

import (
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"time"

	"github.com/pquerna/otp/totp"
)

func GenerateTOTPSecret() (string, string, error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "LitAOSS",
		AccountName: "admin",
	})
	if err != nil {
		return "", "", fmt.Errorf("generate totp key: %w", err)
	}
	return key.Secret(), key.URL(), nil
}

func VerifyTOTP(secret, code string) bool {
	opts := totp.ValidateOpts{
		Period:    30,
		Skew:     1,
		Digits:   6,
		Algorithm: 0,
	}
	valid, _ := totp.ValidateCustom(code, secret, time.Now(), opts)
	return valid
}

func VerifyTOTPConstantTime(secret, code string) bool {
	return VerifyTOTP(secret, code)
}

func constantTimeCompare(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func GenerateRandomString(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}
