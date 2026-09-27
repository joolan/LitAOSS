import { FileRecord } from './api/client';
import { decryptFileContent } from './preview';

// 明文缓存：仅为「拖出下载」在 mousedown → dragstart 的间隙即时取用。
// 小文件（≤ MAX_DATA_URL_BYTES）预取时转成 data:URL——dragstart 纯同步设置、
// 自包含、无 revoke 时序问题；较大文件（≤64MB）保留 blob URL（延迟释放）。
// 仅在用户按下鼠标时按需预取；不在悬停/展示时解密。

const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;
const MAX_ITEM_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_ITEMS = 3;

export interface PlainEntry {
  dataUrl?: string;
  blob?: Blob;
}

let entries: { key: string; entry: PlainEntry; size: number }[] = []; // 最旧在前
let totalBytes = 0;
let generation = 0;
const inflight = new Map<string, Promise<PlainEntry>>();

// 安全清理：进入登录/锁定/刷新等未解锁状态时清空内存明文
export function clearPlainCache(): void {
  generation++;
  entries = [];
  totalBytes = 0;
  inflight.clear();
}

// 拖出下载授权（本机持久化，仅询问一次）：
// unset = 未询问；'1' = 已同意（允许按住时预取解密）；'0' = 已拒绝（不产生任何 OSS 开销）
const DRAG_PREF_KEY = 'lit-aoss-drag-download';

export function dragOutPref(): 'unset' | 'on' | 'off' {
  try {
    const v = localStorage.getItem(DRAG_PREF_KEY);
    if (v === '1') return 'on';
    if (v === '0') return 'off';
  } catch {
    // localStorage 不可用时视为未询问
  }
  return 'unset';
}

export function setDragOutPref(enabled: boolean): void {
  try {
    localStorage.setItem(DRAG_PREF_KEY, enabled ? '1' : '0');
  } catch {
    // 忽略
  }
}

function plainKey(f: Pick<FileRecord, 'id' | 'updated_at'>): string {
  return `${f.id}:${f.updated_at}`;
}

export function canDragOut(file: FileRecord): boolean {
  return !file.is_directory && file.file_size <= MAX_ITEM_BYTES;
}

export function peekPlain(file: FileRecord): PlainEntry | undefined {
  const key = plainKey(file);
  const idx = entries.findIndex((e) => e.key === key);
  if (idx < 0) return undefined;
  const [hit] = entries.splice(idx, 1);
  entries.push(hit); // 变为最新
  return hit.entry;
}

function evict(): void {
  while (entries.length > MAX_ITEMS || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    totalBytes -= oldest.size;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function prefetchPlain(file: FileRecord): Promise<PlainEntry> | undefined {
  if (!canDragOut(file)) return undefined;
  const key = plainKey(file);
  const hit = peekPlain(file);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;

  const gen = generation;
  const p = (async () => {
    try {
      const content = await decryptFileContent(file);
      const blob = new Blob([content], {
        type: file.file_type || 'application/octet-stream',
      });
      if (gen !== generation || blob.size > MAX_ITEM_BYTES) {
        return { blob } as PlainEntry;
      }
      let entry: PlainEntry;
      let size = blob.size;
      if (blob.size <= MAX_DATA_URL_BYTES) {
        const dataUrl = await blobToDataUrl(blob);
        entry = { dataUrl };
        size = Math.round(dataUrl.length);
      } else {
        entry = { blob };
      }
      entries.push({ key, entry, size });
      totalBytes += size;
      evict();
      return entry;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}
