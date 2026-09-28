import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Database, RefreshCw, Trash2 } from 'lucide-react';
import { clearOfflineCache, offlineCacheUsage } from '../preview';

function formatBytes(bytes: number): string {
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

// 离线预览缓存管理：占用统计 + 手动清除
export default function OfflineCacheSettings() {
  const [usage, setUsage] = useState({ count: 0, bytes: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUsage(await offlineCacheUsage());
      setError('');
    } catch {
      setError('统计缓存占用失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clearAll = async () => {
    setBusy(true);
    setSuccess('');
    setError('');
    try {
      await clearOfflineCache();
      await refresh();
      setSuccess('离线预览缓存已清除');
    } catch {
      setError('清除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-emerald-500/10 rounded-lg">
          <Database className="w-5 h-5 text-emerald-400" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-white">离线预览缓存</h3>
          <p className="text-xs text-gray-500">预览过的文件密文副本，断网时可继续查看</p>
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="mb-3 flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-300 text-sm">
          <Check className="w-4 h-4 flex-shrink-0" />
          {success}
        </div>
      )}

      <div className="bg-gray-800/60 border border-gray-800 rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-gray-400">当前占用</span>
          <button
            onClick={refresh}
            className="p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-gray-700"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="text-2xl font-semibold text-white">
          {loading ? '...' : formatBytes(usage.bytes)}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {loading ? '' : `${usage.count} 个文件`}
        </div>
      </div>

      <ul className="text-xs text-gray-500 space-y-1.5 mb-4">
        <li>· 有效期 7 天，超期自动删除</li>
        <li>· 锁定、登出、刷新或重新登录时自动清除</li>
        <li>· 仅缓存密文副本，解密仍需已解锁的会话密钥</li>
      </ul>

      <button
        onClick={clearAll}
        disabled={busy || (usage.count === 0 && !loading)}
        className="inline-flex items-center gap-2 px-4 py-2.5 bg-red-600/10 hover:bg-red-600/20 disabled:opacity-40 text-red-400 rounded-lg text-sm transition-colors"
      >
        <Trash2 className="w-4 h-4" />
        {busy ? '清除中...' : '清除缓存'}
      </button>
    </div>
  );
}
