// 目录列表快照缓存：按 parent_id 缓存「文件记录 + 已解密文件名 + 统计」，
// 返回上层目录时零请求、零解密开销。任何数据变更（上传/改名/删除/移动等）
// 都会触发静默强刷并回写缓存（loadFiles silent 分支），TTL 兜底跨端一致性。
// 缓存含明文文件名，组件卸载（锁定）时必须 invalidateListCache()。

import type { FileRecord } from './api/client';

export interface FolderStats {
  total_size: number;
  file_count: number;
  folder_count: number;
}

export interface FolderSnapshot {
  files: FileRecord[];
  decryptedNames: Map<string, string>;
  stats: FolderStats;
  at: number;
}

const TTL_MS = 60_000;
const snapshots = new Map<string, FolderSnapshot>();

const key = (parentId: string | null): string => parentId ?? '__root__';

export function getCachedSnapshot(parentId: string | null): FolderSnapshot | null {
  const k = key(parentId);
  const snap = snapshots.get(k);
  if (!snap) return null;
  if (Date.now() - snap.at > TTL_MS) {
    snapshots.delete(k);
    return null;
  }
  return snap;
}

export function putCachedSnapshot(
  parentId: string | null,
  snap: { files: FileRecord[]; decryptedNames: Map<string, string>; stats: FolderStats },
): void {
  snapshots.set(key(parentId), { ...snap, at: Date.now() });
}

export function invalidateListCache(): void {
  snapshots.clear();
}
