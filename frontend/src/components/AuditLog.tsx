import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, RefreshCw, ScrollText } from 'lucide-react';
import { api, AuditEntry, AuditAction } from '../api/client';
import { decryptNameForStorage } from '../crypto/fileKey';

const ACTION_LABELS: Record<AuditAction, string> = {
  upload: '上传',
  download: '下载',
  delete: '删除',
  rename: '改名',
  move: '移动',
  edit: '编辑',
  change_password: '改密',
  create_folder: '新建文件夹',
  restore: '恢复',
  purge_trash: '清空回收站',
};

const ACTION_STYLES: Record<AuditAction, string> = {
  upload: 'bg-sky-500/15 text-sky-300',
  download: 'bg-emerald-500/15 text-emerald-300',
  delete: 'bg-red-500/15 text-red-300',
  rename: 'bg-amber-500/15 text-amber-300',
  move: 'bg-violet-500/15 text-violet-300',
  edit: 'bg-indigo-500/15 text-indigo-300',
  change_password: 'bg-fuchsia-500/15 text-fuchsia-300',
  create_folder: 'bg-teal-500/15 text-teal-300',
  restore: 'bg-emerald-500/15 text-emerald-300',
  purge_trash: 'bg-orange-500/15 text-orange-300',
};

// 这些动作的 target_name 是文件/目录密文名，需要会话内解密
const NAME_ACTIONS = new Set<AuditAction>([
  'upload', 'download', 'delete', 'rename', 'move', 'edit', 'create_folder', 'restore',
]);

const PAGE_SIZE = 50;

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function decryptSafe(enc: string): Promise<string> {
  try {
    const name = await decryptNameForStorage(enc);
    return name || '(无法解密)';
  } catch {
    return '(无法解密)';
  }
}

export default function AuditLog() {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // key 规则：`<id>:name` = 目标名，`<id>:old` = 旧名/目标目录（detail 列）
  const [decrypted, setDecrypted] = useState<Map<string, string>>(new Map());

  const load = useCallback(async (p: number, a: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.listAudit({
        page: p,
        page_size: PAGE_SIZE,
        action: a || undefined,
      });
      setItems(res.items);
      setTotal(res.total);

      const jobs: Promise<void>[] = [];
      const next = new Map<string, string>();
      const put = async (key: string, enc: string) => {
        next.set(key, await decryptSafe(enc));
      };
      for (const it of res.items) {
        if (NAME_ACTIONS.has(it.action) && it.target_name) {
          jobs.push(put(`${it.id}:name`, it.target_name));
        }
        if ((it.action === 'rename' || it.action === 'move') && it.detail) {
          jobs.push(put(`${it.id}:old`, it.detail));
        }
      }
      await Promise.all(jobs);
      setDecrypted(next);
    } catch (err) {
      setError((err as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page, action);
  }, [page, action, load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const renderDetail = (it: AuditEntry) => {
    const name = it.target_name ? decrypted.get(`${it.id}:name`) || '...' : '';
    switch (it.action) {
      case 'change_password':
        return <span className="text-gray-300">主密码与账户密钥已更新（全部会话已注销）</span>;
      case 'rename':
        return (
          <span className="text-gray-300">
            {decrypted.get(`${it.id}:old`) || '?'} → <span className="text-white">{name}</span>
          </span>
        );
      case 'move':
        return (
          <span className="text-gray-300">
            {name} → <span className="text-white">{it.detail ? decrypted.get(`${it.id}:old`) || '...' : '根目录'}</span>
          </span>
        );
      case 'upload':
        return (
          <span className="text-gray-300">
            {name} <span className="text-gray-500">· {formatSize(Number(it.detail) || 0)}</span>
          </span>
        );
      case 'delete':
        return (
          <span className="text-gray-300">
            {name} <span className="text-gray-500">· {it.detail}</span>
          </span>
        );
      default:
        return <span className="text-gray-300">{name}</span>;
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <p className="text-xs text-gray-500">共 {total} 条记录，每页 {PAGE_SIZE} 条</p>
        <div className="flex items-center gap-2">
          <select
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
            className="px-2 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-300 focus:outline-none focus:border-emerald-500"
          >
            <option value="">全部动作</option>
            {(Object.keys(ACTION_LABELS) as AuditAction[]).map((a) => (
              <option key={a} value={a}>{ACTION_LABELS[a]}</option>
            ))}
          </select>
          <button
            onClick={() => load(page, action)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-8 text-gray-500 text-sm">暂无审计记录</div>
      ) : (
        <ul className="divide-y divide-gray-800/60 rounded-lg border border-gray-800">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span
                className={`px-2 py-0.5 rounded text-xs flex-shrink-0 ${
                  ACTION_STYLES[it.action] || 'bg-gray-700 text-gray-300'
                }`}
              >
                {ACTION_LABELS[it.action] || it.action}
              </span>
              <span className="flex-1 min-w-0 truncate" title={it.ip_address}>
                {renderDetail(it)}
              </span>
              <span className="text-xs text-gray-500 flex-shrink-0 hidden sm:block" title={it.ip_address}>
                {it.ip_address}
              </span>
              <span className="text-xs text-gray-500 flex-shrink-0">
                {new Date(it.created_at).toLocaleString('zh-CN')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded-lg transition-colors"
          >
            上一页
          </button>
          <span className="text-gray-400 text-xs">
            第 {page} / {totalPages} 页
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 rounded-lg transition-colors"
          >
            下一页
          </button>
        </div>
      )}

      <div className="flex items-start gap-2 mt-4 p-3 rounded-lg bg-gray-800/50 text-xs text-gray-500">
        <ScrollText className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>
          文件名以密文存储、仅在本页会话内解密展示（零知识）；预览与编辑器打开不计入「下载」计量，只有主动下载/拖出记录。
        </span>
      </div>
    </div>
  );
}
