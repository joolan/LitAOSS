import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, FileText, Folder, RotateCcw, Shield, Trash2, X } from 'lucide-react';
import { api, TrashItem } from '../api/client';
import { decryptNameForStorage } from '../crypto/fileKey';
import { invalidateFolderSnapshot } from '../fileListCache';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_DAYS = 3;

interface TrashDialogProps {
  onClose: () => void;
  onChanged: () => void;
}

// 回收站：查看/恢复已删除项；清空需输入「清空」确认，与删除同受 MFA 二次验证保护
export default function TrashDialog({ onClose, onChanged }: TrashDialogProps) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [retention, setRetention] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busyId, setBusyId] = useState('');

  // 清空确认：输入框内容必须等于「清空」
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [purgeBusy, setPurgeBusy] = useState(false);
  // MFA：清空请求被 403 mfa_required 拦下后展示验证码输入
  const [mfaPending, setMfaPending] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError('');
      const res = await api.listTrash();
      setItems(res.items);
      setRetention(res.retention_days);
      const m = new Map<string, string>();
      for (const it of res.items) {
        try {
          m.set(it.id, (await decryptNameForStorage(it.name_encrypted)) || '(无法解密)');
        } catch {
          m.set(it.id, '(无法解密)');
        }
      }
      setNames(m);
    } catch (err: any) {
      setError('加载回收站失败: ' + (err?.message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRestore = async (it: TrashItem) => {
    setBusyId(it.id);
    setInfo('');
    setError('');
    try {
      const res = await api.restoreFile(it.id);
      // 恢复目标目录（后端返回实际位置，原目录已删则为根）缓存失效，
      // 否则进入该目录时看到恢复前的旧列表
      invalidateFolderSnapshot(res.parent_id);
      setInfo(`已恢复「${names.get(it.id) || it.id}」`);
      await refresh();
      onChanged();
    } catch (err: any) {
      setError('恢复失败: ' + (err?.message || err));
    } finally {
      setBusyId('');
    }
  };

  const doPurge = async () => {
    setPurgeBusy(true);
    setError('');
    try {
      const res = await api.purgeTrash();
      setConfirming(false);
      setConfirmText('');
      setMfaPending(false);
      setMfaCode('');
      setInfo(`已清空 ${res.purged} 项`);
      await refresh();
      onChanged();
    } catch (err: any) {
      if (err?.body?.mfa_required) {
        setMfaPending(true);
        setMfaCode('');
        setMfaError('');
      } else {
        setError('清空失败: ' + (err?.message || err));
        setConfirming(false);
      }
    } finally {
      setPurgeBusy(false);
    }
  };

  const confirmPurgeMFA = async () => {
    if (!/^\d{6}$/.test(mfaCode)) {
      setMfaError('请输入 6 位验证码');
      return;
    }
    setMfaBusy(true);
    setMfaError('');
    try {
      await api.verifyDeleteMFA(mfaCode);
      await doPurge();
    } catch (err: any) {
      setMfaError(err?.message || '验证失败');
    } finally {
      setMfaBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-5 pb-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-red-500/10 rounded-lg">
              <Trash2 className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">回收站</h3>
              <p className="text-xs text-gray-500">
                {retention > 0
                  ? `删除后保留 ${retention} 天，超期自动清理`
                  : '已删除内容不会自动清理'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white rounded-lg hover:bg-gray-800"
            title="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mx-5 mb-2 flex items-center gap-2 p-2.5 rounded-lg bg-red-500/10 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}
        {info && (
          <div className="mx-5 mb-2 flex items-center gap-2 p-2.5 rounded-lg bg-emerald-500/10 text-emerald-300 text-sm">
            {info}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 pb-2">
          {loading ? (
            <div className="py-10 text-center text-gray-500 text-sm">加载中...</div>
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-gray-500 text-sm">回收站是空的</div>
          ) : (
            <ul className="space-y-2">
              {items.map((it) => {
                const deletedAt = new Date(it.deleted_at);
                const daysLeft =
                  retention > 0 ? Math.ceil(retention - (Date.now() - deletedAt.getTime()) / DAY_MS) : null;
                const urgent = daysLeft !== null && daysLeft <= WARN_DAYS;
                return (
                  <li
                    key={it.id}
                    className="flex items-center gap-3 p-3 bg-gray-800/60 rounded-lg border border-gray-800"
                  >
                    <div className="p-1.5 bg-gray-900 rounded">
                      {it.is_directory ? (
                        <Folder className="w-4 h-4 text-amber-400" />
                      ) : (
                        <FileText className="w-4 h-4 text-sky-400" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white truncate">
                        {names.get(it.id) || '...'}
                      </div>
                      <div className="text-xs text-gray-500">
                        {deletedAt.toLocaleString('zh-CN')}
                        {it.is_directory ? ' · 目录' : ` · ${formatSize(it.file_size)}`}
                        {daysLeft !== null && (
                          <span className={urgent ? 'text-red-400 font-medium' : ''}>
                            {' · '}
                            {daysLeft <= 0 ? '即将清理' : `${daysLeft} 天后清理`}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRestore(it)}
                      disabled={busyId === it.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white rounded-lg transition-colors"
                      title="恢复到原位置（原目录已删除则恢复到根目录）"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      {busyId === it.id ? '恢复中...' : '恢复'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="p-5 pt-3 border-t border-gray-800">
          {mfaPending ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <Shield className="w-4 h-4 text-emerald-400" />
                清空回收站前请输入 TOTP 验证码（同一会话仅首次删除/清空需要验证）。
              </div>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={mfaCode}
                autoFocus
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmPurgeMFA();
                }}
                placeholder="6 位验证码"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-center tracking-widest placeholder-gray-500 focus:outline-none focus:border-emerald-500"
              />
              {mfaError && (
                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-red-500/10 text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {mfaError}
                </div>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setMfaPending(false);
                    setMfaCode('');
                    setConfirming(false);
                  }}
                  className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={confirmPurgeMFA}
                  disabled={mfaBusy}
                  className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
                >
                  {mfaBusy ? '验证中...' : '验证并清空'}
                </button>
              </div>
            </div>
          ) : confirming ? (
            <div className="space-y-3">
              <div className="text-sm text-gray-400">
                清空将<b className="text-red-400">立即物理删除</b>全部 {items.length} 项且不可恢复。
                请输入 <b className="text-white">清空</b> 确认。
              </div>
              <input
                type="text"
                value={confirmText}
                autoFocus
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="输入：清空"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setConfirming(false);
                    setConfirmText('');
                  }}
                  className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={doPurge}
                  disabled={purgeBusy || confirmText !== '清空' || items.length === 0}
                  className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg font-medium transition-colors"
                >
                  {purgeBusy ? '清空中...' : '清空回收站'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setConfirming(true);
                  setConfirmText('');
                }}
                disabled={items.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 text-sm bg-red-600/10 hover:bg-red-600/20 disabled:opacity-40 text-red-400 rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                清空回收站
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
