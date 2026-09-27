package api

import "testing"

// 恢复码规范化：大小写/横线/空格不影响哈希，生成格式稳定
func TestRecoveryCodeNormalizeAndHash(t *testing.T) {
	base := hashRecoveryCode("ABCD-EFGH-JKLM-NPQR-STUV")
	for _, variant := range []string{
		"abcd-efgh-jklm-npqr-stuv",
		"ABCDEFGHJKLMNPQRSTUV",
		"abcd efgh jklm npqr stuv",
		" ABCD-EFGH-JKLM-NPQR-STUV ",
	} {
		if h := hashRecoveryCode(variant); h != base {
			t.Fatalf("variant %q hashed differently: %s != %s", variant, h, base)
		}
	}
	if hashRecoveryCode("ABCD-EFGH-JKLM-NPQR-STUW") == base {
		t.Fatal("different code must hash differently")
	}
}

func TestGenerateRecoveryCodeFormat(t *testing.T) {
	plain, hash, err := generateRecoveryCode()
	if err != nil {
		t.Fatal(err)
	}
	// 12 字节 = 20 个 base32 字符 → 4-4-4-4-4 分组
	if len(plain) != 24 || hash == "" {
		t.Fatalf("plain=%q (len %d) hash=%q", plain, len(plain), hash)
	}
	for i, ch := range plain {
		if (i+1)%5 == 0 {
			if ch != '-' {
				t.Fatalf("position %d expected '-', got %q in %q", i, ch, plain)
			}
			continue
		}
		if !((ch >= 'A' && ch <= 'Z') || (ch >= '2' && ch <= '7')) {
			t.Fatalf("invalid base32 char %q in %q", ch, plain)
		}
	}
	plain2, _, _ := generateRecoveryCode()
	if plain2 == plain {
		t.Fatal("two generated codes must differ")
	}
}
