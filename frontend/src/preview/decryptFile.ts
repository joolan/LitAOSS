import { api, FileRecord, fromBase64Bytes } from '../api/client';
import { unwrapFileKeyFromStorage } from '../crypto/fileKey';

/** 通过预签名 URL 下载密文并在本地解密，返回明文字节 */
export async function decryptFileContent(file: FileRecord): Promise<ArrayBuffer> {
  const presignRes = await api.getPresignDownloadUrl(file.oss_key);
  const response = await fetch(presignRes.url);
  const ciphertext = await response.arrayBuffer();

  const fileKeyRaw = await unwrapFileKeyFromStorage(file.encrypted_file_key || '');
  const fileKey = await crypto.subtle.importKey(
    'raw',
    fileKeyRaw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );

  const iv = new Uint8Array(fromBase64Bytes(file.iv));
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    fileKey,
    ciphertext,
  );
}
