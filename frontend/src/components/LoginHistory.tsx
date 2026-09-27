import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, History, RefreshCw, XCircle } from 'lucide-react';
import { api, LoginAttempt } from '../api/client';

export default function LoginHistory() {
  const [items, setItems] = useState<LoginAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getLoginHistory();
      setItems(res.attempts || []);
    } catch (err) {
      setError((err as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500">
          最近 50 条登录尝试；登录成功后失败记录自动清零（全局锁定）
        </p>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-lg transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
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
        <div className="text-center py-8 text-gray-500 text-sm">暂无登录记录</div>
      ) : (
        <ul className="divide-y divide-gray-800/60 rounded-lg border border-gray-800">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              {a.success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
              )}
              <span className={a.success ? 'text-emerald-400 w-12 flex-shrink-0' : 'text-red-400 w-12 flex-shrink-0'}>
                {a.success ? '成功' : '失败'}
              </span>
              <span className="text-gray-300 flex-1 min-w-0 truncate" title={a.ip_address}>
                {a.ip_address}
              </span>
              <span className="text-xs text-gray-500 flex-shrink-0">
                {new Date(a.created_at).toLocaleString('zh-CN')}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-start gap-2 mt-4 p-3 rounded-lg bg-gray-800/50 text-xs text-gray-500">
        <History className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>
          连续 5 次失败将全局锁定 15 分钟；IP 仅记录可信代理提交的 X-Forwarded-For（见 server.trusted_proxies）
        </span>
      </div>
    </div>
  );
}
