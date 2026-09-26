let password: string | null = null;
let salt: string | null = null;
let encryptedAccountKey: string | null = null;
let masterBitsCache: { key: string; bits: ArrayBuffer } | null = null;

export function setUnlockMaterial(p: string, s: string, encKey: string): void {
  password = p;
  salt = s;
  encryptedAccountKey = encKey;
}

export function getSessionPassword(): string | null {
  return password;
}

export function getSessionSalt(): string | null {
  return salt;
}

export function getSessionEncryptedAccountKey(): string | null {
  return encryptedAccountKey;
}

export function getCachedMasterBits(cacheKey: string): ArrayBuffer | null {
  if (masterBitsCache && masterBitsCache.key === cacheKey) return masterBitsCache.bits;
  return null;
}

export function cacheMasterBits(cacheKey: string, bits: ArrayBuffer): void {
  masterBitsCache = { key: cacheKey, bits };
}

export function clearUnlockMaterial(): void {
  password = null;
  salt = null;
  encryptedAccountKey = null;
  masterBitsCache = null;
}
