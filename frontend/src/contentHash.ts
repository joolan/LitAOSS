import { getSessionEncryptedAccountKey } from './session';
import { getAccountKey } from './crypto/fileKey';

// 内容寻址哈希：HMAC-SHA256，密钥 = HKDF(Account Key 原始字节, 固定盐,
// info="content-hash")。服务端仅存哈希值做相等比对，无密钥无法离线猜解
// （守住零知识口径）。
//
// 用 Account Key 而非主密码作 IKM：修改主密码只重新包装 Account Key
// （auth salt 不变），其原始字节不变，因此改密前后同内容同哈希，
// 查重持续有效；跨会话、跨设备同账号一致。

let cachedKey: CryptoKey | null = null;
let cachedKeyId: string | null = null;

async function getContentHashKey(): Promise<CryptoKey> {
  const wrappedId = getSessionEncryptedAccountKey();
  if (!wrappedId) {
    throw new Error('未解锁，无法计算内容哈希');
  }
  if (cachedKey && cachedKeyId === wrappedId) {
    return cachedKey;
  }
  const accountKey = await getAccountKey();
  const ikm = await crypto.subtle.exportKey('raw', accountKey);
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('lit-aoss|content-hash'),
      info: new TextEncoder().encode('content-hash'),
    },
    base,
    256,
  );
  const key = await crypto.subtle.importKey(
    'raw',
    bits,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKey = key;
  cachedKeyId = wrappedId;
  return key;
}

export async function contentHash(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const key = await getContentHashKey();
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const sig = await crypto.subtle.sign('HMAC', key, bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
