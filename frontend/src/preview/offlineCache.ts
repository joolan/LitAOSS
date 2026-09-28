import { FileRecord } from '../api/client';

// 离线预览缓存（IndexedDB）：预览下载成功后存一份 AES-GCM 密文副本，
// 断网时用 file record 自带的 encrypted_file_key / iv 解密缓存继续预览——
// 密钥不入库（file record 快照本身在会话内，wrap 材料随解锁态存在）。
// 生命周期与解锁态同步：锁定 / 登出 / 刷新 / 重新登录由 App 统一清空，
// 另以 TTL 兜底（过期条目在读取与统计时惰性删除）。

const DB_NAME = 'lit-aoss-offline';
const STORE = 'cache';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface OfflineEntry {
  stored_at: number;
  size: number;
  cipher: ArrayBuffer;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// key 含 updated_at：文件更新版本后旧缓存自动失效
export function offlineKey(file: Pick<FileRecord, 'id' | 'updated_at'>): string {
  return `${file.id}:${file.updated_at}`;
}

export async function getOfflineCipher(key: string): Promise<ArrayBuffer | undefined> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDB();
    const entry = await new Promise<OfflineEntry | undefined>((resolve, reject) => {
      const tx = db!.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as OfflineEntry | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!entry) return undefined;
    if (Date.now() - entry.stored_at > TTL_MS) {
      void deleteEntry(key);
      return undefined;
    }
    return entry.cipher;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export async function putOfflineCipher(key: string, cipher: ArrayBuffer): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE, 'readwrite');
      const entry: OfflineEntry = { stored_at: Date.now(), size: cipher.byteLength, cipher };
      tx.objectStore(STORE).put(entry, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 缓存失败不影响功能
  } finally {
    db?.close();
  }
}

function deleteEntry(key: string): Promise<void> {
  return openDB()
    .then(
      (db) =>
        new Promise<void>((resolve) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        })
        .finally(() => db.close()),
    )
    .catch(() => {});
}

// 统计未过期条目占用，顺带惰性删除过期条目（设置页展示用）
export async function offlineCacheUsage(): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  let db: IDBDatabase | undefined;
  try {
    db = await openDB();
    const expired: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const entry = cursor.value as OfflineEntry;
        if (Date.now() - entry.stored_at > TTL_MS) {
          expired.push(String(cursor.key));
        } else {
          count++;
          bytes += entry.size || 0;
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    if (expired.length > 0) {
      await new Promise<void>((resolve) => {
        const tx = db!.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        expired.forEach((k) => store.delete(k));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    }
  } catch {
    // 统计失败返回 0
  } finally {
    db?.close();
  }
  return { count, bytes };
}

// 安全清理：进入登录/锁定/刷新等未解锁状态时清空全部离线预览缓存
export async function clearOfflineCache(): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 忽略
  } finally {
    db?.close();
  }
}
