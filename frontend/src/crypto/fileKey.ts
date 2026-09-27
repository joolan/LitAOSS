import {
  getSessionPassword,
  getSessionSalt,
  getSessionEncryptedAccountKey,
  getCachedMasterBits,
  cacheMasterBits,
} from '../session';

// 重要: crypto.ts deriveMasterKey 用 salt||"account-key" 派生 AES-KW 主密钥(域分离)，
// 旧版文件名 / 旧 File Key 则用裸 salt 派生。两种派生都必须支持，否则 Account Key 解包失败。

function concatSalt(saltBytes: Uint8Array, domain: string): Uint8Array<ArrayBuffer> {
  const domainBytes = new TextEncoder().encode(domain);
  const out = new Uint8Array(saltBytes.length + domainBytes.length);
  out.set(saltBytes, 0);
  out.set(domainBytes, saltBytes.length);
  return out;
}

export async function deriveMasterBits(password: string, salt: string, domain = ''): Promise<ArrayBuffer> {
  const cacheKey = password + '|' + salt + '|' + domain;
  const cached = getCachedMasterBits(cacheKey);
  if (cached) return cached;

  const saltBytes = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
  const effectiveSalt = domain ? concatSalt(saltBytes, domain) : saltBytes;

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: effectiveSalt,
      iterations: 500000,
      hash: 'SHA-256',
    },
    passwordKey,
    256,
  );
  cacheMasterBits(cacheKey, bits);
  return bits;
}

function sessionMaterial(): { password: string; salt: string } {
  const password = getSessionPassword();
  const salt = getSessionSalt();
  if (!password || !salt) throw new Error('未解锁');
  return { password, salt };
}

async function getMasterKey(domain: string): Promise<CryptoKey> {
  const { password, salt } = sessionMaterial();
  const bits = await deriveMasterBits(password, salt, domain);
  return crypto.subtle.importKey('raw', bits, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
}

async function getMasterKeyCandidates(): Promise<CryptoKey[]> {
  return Promise.all([getMasterKey(''), getMasterKey('account-key')]);
}

export async function getAccountKey(): Promise<CryptoKey> {
  const wrappedAccountKey = getSessionEncryptedAccountKey();
  if (!wrappedAccountKey) throw new Error('未解锁');

  const masterKey = await getMasterKey('account-key');
  return crypto.subtle.unwrapKey(
    'raw',
    Uint8Array.from(atob(wrappedAccountKey), c => c.charCodeAt(0)),
    masterKey,
    'AES-KW',
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey'],
  );
}

export async function wrapFileKeyForStorage(fileKeyBase64: string): Promise<string> {
  const accountKey = await getAccountKey();
  const fileKey = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(fileKeyBase64), c => c.charCodeAt(0)),
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt'],
  );
  const wrapped = await crypto.subtle.wrapKey('raw', fileKey, accountKey, 'AES-KW');
  return btoa(String.fromCharCode(...new Uint8Array(wrapped)));
}

export async function unwrapFileKeyFromStorage(encryptedKeyBase64: string): Promise<ArrayBuffer> {
  const wrappedKey = Uint8Array.from(atob(encryptedKeyBase64), c => c.charCodeAt(0));

  try {
    const accountKey = await getAccountKey();
    const fileKey = await crypto.subtle.unwrapKey(
      'raw',
      wrappedKey,
      accountKey,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    return await crypto.subtle.exportKey('raw', fileKey);
  } catch {
    // 旧数据: File Key 曾直接用 Master Key 包装，两种派生都尝试
    let lastErr: unknown;
    for (const masterKey of await getMasterKeyCandidates()) {
      try {
        const fileKey = await crypto.subtle.unwrapKey(
          'raw',
          wrappedKey,
          masterKey,
          'AES-KW',
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt'],
        );
        return await crypto.subtle.exportKey('raw', fileKey);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('File Key 解包失败');
  }
}

// ---- 旧数据迁移: 判断/转换由旧 Master Key 保护的密钥材料 ----

export async function rewrapLegacyFileKey(encryptedKeyBase64: string): Promise<string | null> {
  const accountKey = await getAccountKey();
  const wrappedKey = Uint8Array.from(atob(encryptedKeyBase64), c => c.charCodeAt(0));

  try {
    await crypto.subtle.unwrapKey(
      'raw', wrappedKey, accountKey, 'AES-KW',
      { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    return null; // 已是 Account Key 包装
  } catch {
    // 旧版 Master Key 包装，继续迁移
  }

  for (const masterKey of await getMasterKeyCandidates()) {
    try {
      const fileKey = await crypto.subtle.unwrapKey(
        'raw', wrappedKey, masterKey, 'AES-KW',
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
      );
      const reWrapped = await crypto.subtle.wrapKey('raw', fileKey, accountKey, 'AES-KW');
      return btoa(String.fromCharCode(...new Uint8Array(reWrapped)));
    } catch {
      // 尝试下一种派生
    }
  }
  return null;
}

// ---- 文件名加密: 统一用 Account Key (改主密码不影响) ----

async function getAccountGCMKey(): Promise<CryptoKey> {
  const accountKey = await getAccountKey();
  const raw = await crypto.subtle.exportKey('raw', accountKey);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function getMasterGCMKeyCandidates(): Promise<CryptoKey[]> {
  const { password, salt } = sessionMaterial();
  const [plainBits, domainBits] = await Promise.all([
    deriveMasterBits(password, salt, ''),
    deriveMasterBits(password, salt, 'account-key'),
  ]);
  return Promise.all([
    crypto.subtle.importKey('raw', plainBits, { name: 'AES-GCM' }, false, ['decrypt', 'encrypt']),
    crypto.subtle.importKey('raw', domainBits, { name: 'AES-GCM' }, false, ['decrypt', 'encrypt']),
  ]);
}

async function gcmTryDecrypt(key: CryptoKey, encryptedB64: string): Promise<string | null> {
  try {
    const combined = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export async function encryptNameForStorage(name: string): Promise<string> {
  const key = await getAccountGCMKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(name),
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptNameForStorage(encryptedB64: string): Promise<string | null> {
  try {
    const viaAccount = await gcmTryDecrypt(await getAccountGCMKey(), encryptedB64);
    if (viaAccount !== null) return viaAccount;
  } catch {
    // 会话缺失等，继续尝试
  }
  try {
    for (const key of await getMasterGCMKeyCandidates()) {
      const viaMaster = await gcmTryDecrypt(key, encryptedB64);
      if (viaMaster !== null) return viaMaster;
    }
  } catch {
    // 未解锁
  }
  return null;
}

export async function isLegacyEncryptedName(encryptedB64: string): Promise<boolean> {
  try {
    const viaAccount = await gcmTryDecrypt(await getAccountGCMKey(), encryptedB64);
    if (viaAccount !== null) return false;
  } catch {
    // Account Key 不可用，继续检查旧 Master Key
  }
  try {
    for (const key of await getMasterGCMKeyCandidates()) {
      if ((await gcmTryDecrypt(key, encryptedB64)) !== null) return true;
    }
  } catch {
    // 未解锁
  }
  return false;
}
