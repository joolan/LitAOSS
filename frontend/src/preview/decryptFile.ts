import { api, FileRecord, fromBase64Bytes } from '../api/client';
import { unwrapFileKeyFromStorage } from '../crypto/fileKey';
import { getOfflineCipher, offlineKey, putOfflineCipher } from './offlineCache';

/** 通过预签名 URL 下载密文并在本地解密，返回明文字节。
 * purpose='download'（拖出下载）时后端记入下载审计；预览不传、不计量。
 * 预览下载成功后密文副本入离线缓存；网络不可用时回退缓存密文（断网可预览） */
export async function decryptFileContent(file: FileRecord, purpose = ''): Promise<ArrayBuffer> {
  let ciphertext: ArrayBuffer;
  try {
    const presignRes = await api.getPresignDownloadUrl(file.oss_key, 3600, purpose);
    const response = await fetch(presignRes.url);
    if (!response.ok) {
      throw new Error(`download failed: ${response.status}`);
    }
    ciphertext = await response.arrayBuffer();
    if (purpose === '') {
      void putOfflineCipher(offlineKey(file), ciphertext);
    }
  } catch (err) {
    // 仅预览路径回退离线缓存；下载路径（带审计）失败照常抛出
    if (purpose !== '') {
      throw err;
    }
    const cached = await getOfflineCipher(offlineKey(file));
    if (!cached) {
      throw err;
    }
    ciphertext = cached;
  }

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
