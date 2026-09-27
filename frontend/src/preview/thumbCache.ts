import { FileRecord } from '../api/client';

// 图片缩略图缓存（IndexedDB）：仅在预览成功后生成，网格视图只读缓存，
// 不为展示而解密图片；key 含 updated_at，文件更新版本后自动失效。

const DB_NAME = 'lit-aoss-thumbs';
const STORE = 'thumbs';
const THUMB_MAX = 160;

export function thumbKey(file: Pick<FileRecord, 'id' | 'updated_at'>): string {
  return `${file.id}:${file.updated_at}`;
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

export async function getThumb(key: string): Promise<Blob | undefined> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Blob | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function putThumb(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 缓存失败不影响功能
  }
}

// 安全清理：进入登录/锁定/刷新等未解锁状态时清空全部缩略图，避免解密数据残留
export async function clearThumbCache(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // 忽略
  }
}

export async function generateThumb(source: Blob): Promise<Blob | null> {
  try {
    const url = URL.createObjectURL(source);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('image decode failed'));
        el.src = url;
      });
      const scale = Math.min(1, THUMB_MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', 0.85),
      );
      if (blob) return blob;
      return await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}
