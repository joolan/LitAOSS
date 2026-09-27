import { api } from '../api/client';
import { encryptNameForStorage, decryptNameForStorage, wrapFileKeyForStorage } from '../crypto/fileKey';
import { contentHash } from '../contentHash';

export interface UploadHandle {
  promise: Promise<void>;
  abort: () => void;
}

export function encryptAndUploadFile(
  file: File,
  parentId: string | null,
  onProgress: (fraction: number) => void,
): UploadHandle {
  let xhr: XMLHttpRequest | null = null;
  let aborted = false;

  const abort = () => {
    aborted = true;
    if (xhr) xhr.abort();
  };

  const promise = (async () => {
    const arrayBuffer = await file.arrayBuffer();
    if (aborted) throw new Error('已取消');

    // 内容寻址查重：命中则跳过加密与 OSS 上传，复用既有密文对象建记录
    let hash = '';
    try {
      hash = await contentHash(arrayBuffer);
      const dup = await api.checkDedup(hash);
      if (dup.found && dup.file) {
        const nameEncrypted = await encryptNameForStorage(file.name);
        await api.createFileRecord({
          name_encrypted: nameEncrypted,
          parent_id: parentId || undefined,
          file_size: dup.file.file_size,
          file_type: dup.file.file_type || file.type,
          encrypted_file_key: dup.file.encrypted_file_key || '',
          iv: dup.file.iv || '',
          salt: dup.file.salt || '',
          oss_key: dup.file.oss_key,
          content_hash: hash,
        });
        onProgress(1);
        return;
      }
    } catch (err) {
      if (aborted) throw new Error('已取消');
      // 查重失败不阻断上传，走正常加密上传
      hash = hash || '';
    }
    if (aborted) throw new Error('已取消');

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const fileKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      fileKey,
      arrayBuffer,
    );

    const fileKeyRaw = await crypto.subtle.exportKey('raw', fileKey);
    const fileKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(fileKeyRaw)));
    const encryptedFileKey = await wrapFileKeyForStorage(fileKeyBase64);
    const nameEncrypted = await encryptNameForStorage(file.name);

    const ossKeyRes = await api.generateOSSKey();
    const presignRes = await api.getPresignUploadUrl(ossKeyRes.oss_key);
    if (aborted) throw new Error('已取消');

    await new Promise<void>((resolve, reject) => {
      const x = new XMLHttpRequest();
      xhr = x;
      x.upload.onprogress = (ev) => {
        if (ev.lengthComputable) onProgress(ev.loaded / ev.total);
      };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) resolve();
        else reject(new Error(`上传失败: HTTP ${x.status}`));
      };
      x.onerror = () => reject(new Error('网络错误'));
      x.onabort = () => reject(new Error('已取消'));
      x.open('PUT', presignRes.url);
      x.send(ciphertext);
    });
    if (aborted) throw new Error('已取消');

    await api.createFileRecord({
      name_encrypted: nameEncrypted,
      parent_id: parentId || undefined,
      file_size: ciphertext.byteLength,
      file_type: file.type,
      encrypted_file_key: encryptedFileKey,
      iv: Array.from(iv),
      salt: [],
      oss_key: ossKeyRes.oss_key,
      content_hash: hash,
    });
  })();

  return { promise, abort };
}

export class FolderChainResolver {
  private cache = new Map<string, string>();
  private rootParentId: string | null;

  constructor(rootParentId: string | null) {
    this.rootParentId = rootParentId;
  }

  async resolveDirPath(dirPath: string): Promise<string | null> {
    const segments = dirPath.split('/').filter(Boolean);
    let parentId = this.rootParentId;

    for (const name of segments) {
      const key = `${parentId ?? 'root'}\u0000${name}`;
      const cached = this.cache.get(key);
      if (cached) {
        parentId = cached;
        continue;
      }

      const res = await api.listFiles(parentId || undefined);
      let foundId: string | null = null;
      for (const f of res.files || []) {
        if (!f.is_directory) continue;
        const plain = await decryptNameForStorage(f.name_encrypted);
        if (plain === name) {
          foundId = f.id;
          break;
        }
      }
      if (!foundId) {
        const created = await api.createFolder(await encryptNameForStorage(name), parentId || undefined);
        foundId = created.id;
      }
      this.cache.set(key, foundId);
      parentId = foundId;
    }
    return parentId;
  }
}
