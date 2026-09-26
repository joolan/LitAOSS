import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Loader2, RotateCcw, Upload, X, XCircle,
} from 'lucide-react';
import { PendingUpload, QueueItem } from '../upload/types';
import { encryptAndUploadFile, FolderChainResolver, UploadHandle } from '../upload/uploadQueue';

interface UploadQueueDialogProps {
  items: PendingUpload[];
  targetFolderId: string | null;
  targetLabel: string;
  onClose: () => void;
  onUploaded: () => void;
}

const OVERSIZE_LIMIT = 200 * 1024 * 1024;

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function UploadQueueDialog({
  items, targetFolderId, targetLabel, onClose, onUploaded,
}: UploadQueueDialogProps) {
  const [queue, setQueue] = useState<QueueItem[]>(() =>
    items.map((it) => ({ ...it, status: 'pending' as const, progress: 0 })),
  );
  const [phase, setPhase] = useState<'pending' | 'uploading' | 'summary'>('pending');
  const cancelRef = useRef(false);
  const handleRef = useRef<UploadHandle | null>(null);

  const totalSize = queue.reduce((s, q) => s + q.size, 0);
  const oversizeCount = queue.filter((q) => q.size > OVERSIZE_LIMIT).length;

  const counts = useMemo(() => {
    let done = 0, failed = 0, pending = 0, uploading = 0;
    for (const q of queue) {
      if (q.status === 'done') done++;
      else if (q.status === 'error') failed++;
      else if (q.status === 'uploading') uploading++;
      else pending++;
    }
    return { done, failed, pending, uploading };
  }, [queue]);

  const overall = queue.length
    ? Math.round(
        (queue.reduce(
          (acc, q) => acc + (q.status === 'done' ? 1 : q.status === 'uploading' ? q.progress / 100 : 0),
          0,
        ) /
          queue.length) *
          100,
      )
    : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'uploading') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  const removeItem = (id: string) => {
    if (phase !== 'pending') return;
    setQueue((q) => q.filter((x) => x.id !== id));
  };

  const startUpload = async () => {
    if (phase === 'uploading') return;
    if (!queue.some((q) => q.status === 'pending')) return;

    if (oversizeCount > 0) {
      const ok = window.confirm(
        `队列中有 ${oversizeCount} 个超过 200MB 的大文件，` +
          '浏览器内加密容易因内存不足而上传失败。\n\n是否仍要继续上传？',
      );
      if (!ok) return;
    }

    cancelRef.current = false;
    setPhase('uploading');
    const resolver = new FolderChainResolver(targetFolderId);
    const snapshot = queue;

    for (let i = 0; i < snapshot.length; i++) {
      if (cancelRef.current) break;
      const item = snapshot[i];
      if (item.status !== 'pending') continue;

      setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: 'uploading', progress: 0 } : x)));
      try {
        const slash = item.path.lastIndexOf('/');
        const dirPath = slash > 0 ? item.path.slice(0, slash) : '';
        const parentId = dirPath ? await resolver.resolveDirPath(dirPath) : targetFolderId;
        if (cancelRef.current) {
          setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: 'pending', progress: 0 } : x)));
          break;
        }

        const handle = encryptAndUploadFile(item.file, parentId, (frac) => {
          setQueue((q) => q.map((x, j) => (j === i ? { ...x, progress: Math.round(frac * 100) } : x)));
        });
        handleRef.current = handle;
        await handle.promise;
        handleRef.current = null;

        if (cancelRef.current) {
          setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: 'pending', progress: 0 } : x)));
          break;
        }
        setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: 'done', progress: 100 } : x)));
      } catch (err) {
        const msg = (err as Error).message || '上传失败';
        if (cancelRef.current && msg === '已取消') {
          setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: 'pending', progress: 0 } : x)));
          break;
        }
        setQueue((q) =>
          q.map((x, j) => (j === i ? { ...x, status: 'error', progress: 0, error: msg } : x)),
        );
      }
    }

    setPhase('summary');
    onUploaded();
  };

  const cancelUpload = () => {
    cancelRef.current = true;
    handleRef.current?.abort();
  };

  const retryFailed = () => {
    setQueue((q) =>
      q.map((x) => (x.status === 'error' ? { ...x, status: 'pending', progress: 0, error: undefined } : x)),
    );
    setPhase('pending');
  };

  const statusIcon = (item: QueueItem) => {
    if (item.status === 'uploading') {
      return <Loader2 className="w-4 h-4 text-emerald-400 animate-spin flex-shrink-0" />;
    }
    if (item.status === 'done') {
      return <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />;
    }
    if (item.status === 'error') {
      return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
    }
    return <span className="w-4 h-4 flex-shrink-0 text-gray-600 text-xs leading-4 text-center">•</span>;
  };

  const renderPath = (path: string) => {
    const slash = path.lastIndexOf('/');
    if (slash < 0) return <span className="break-all">{path}</span>;
    return (
      <span className="break-all">
        <span className="text-gray-500">{path.slice(0, slash + 1)}</span>
        {path.slice(slash + 1)}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-gray-900 border border-gray-800 rounded-xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-start justify-between gap-4 p-4 border-b border-gray-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Upload className="w-4 h-4 text-emerald-400" />
              <h2 className="text-base font-semibold">上传队列</h2>
              <span className="text-xs text-gray-400">
                {queue.length} 个文件 · {formatSize(totalSize)}
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1 truncate" title={targetLabel}>
              上传到: <span className="text-gray-400">{targetLabel}</span>
            </p>
          </div>
          <button
            onClick={() => phase !== 'uploading' && onClose()}
            disabled={phase === 'uploading'}
            className="p-1 text-gray-500 hover:text-white transition-colors disabled:opacity-30 flex-shrink-0"
            title={phase === 'uploading' ? '上传中，请先取消' : '关闭'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {phase === 'pending' && oversizeCount > 0 && (
          <div className="mx-4 mt-3 flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-400 text-xs">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              队列中有 {oversizeCount} 个超过 200MB 的大文件，浏览器内加密可能因内存不足而失败
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {queue.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">队列为空</div>
          ) : (
            <ul className="divide-y divide-gray-800/60">
              {queue.map((item, i) => (
                <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="w-6 text-gray-600 text-xs flex-shrink-0 text-right">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm">{renderPath(item.path)}</div>
                    {item.status === 'error' && item.error && (
                      <div className="text-xs text-red-400 mt-0.5">{item.error}</div>
                    )}
                    {item.status === 'uploading' && (
                      <div className="w-full bg-gray-800 rounded-full h-1 mt-1.5">
                        <div
                          className="bg-emerald-500 h-1 rounded-full transition-all"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-gray-500 flex-shrink-0 w-20 text-right">
                    {formatSize(item.size)}
                  </span>
                  <div className="flex-shrink-0 w-16 flex items-center justify-end gap-2">
                    {statusIcon(item)}
                    {phase === 'pending' && (
                      <button
                        onClick={() => removeItem(item.id)}
                        className="text-gray-600 hover:text-red-400 transition-colors"
                        title="移除"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {phase === 'pending' && (
          <div className="p-4 border-t border-gray-800 flex items-center justify-between gap-3">
            <button
              onClick={() => setQueue((q) => q.filter((x) => x.status !== 'pending'))}
              disabled={!queue.some((q) => q.status === 'pending')}
              className="text-sm text-gray-500 hover:text-white transition-colors disabled:opacity-30"
            >
              清空待上传
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-sm"
              >
                取消
              </button>
              <button
                onClick={startUpload}
                disabled={!queue.some((q) => q.status === 'pending')}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                确认上传
              </button>
            </div>
          </div>
        )}

        {phase === 'uploading' && (
          <div className="p-4 border-t border-gray-800">
            <div className="flex items-center justify-between text-sm text-emerald-400 mb-2">
              <span>
                加密上传中... {counts.done + counts.failed}/{queue.length}
              </span>
              <span>{overall}%</span>
            </div>
            <div className="w-full bg-gray-800 rounded-full h-2 mb-3">
              <div
                className="bg-emerald-500 h-2 rounded-full transition-all"
                style={{ width: `${overall}%` }}
              />
            </div>
            <div className="flex justify-end">
              <button
                onClick={cancelUpload}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-sm"
              >
                取消上传
              </button>
            </div>
          </div>
        )}

        {phase === 'summary' && (
          <div className="p-4 border-t border-gray-800">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm mb-3">
              <span className="text-emerald-400">成功 {counts.done}</span>
              {counts.failed > 0 && <span className="text-red-400">失败 {counts.failed}</span>}
              {counts.pending > 0 && <span className="text-gray-400">未上传 {counts.pending}</span>}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {counts.pending > 0 && (
                <button
                  onClick={() => setPhase('pending')}
                  className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-sm"
                >
                  继续上传
                </button>
              )}
              {counts.failed > 0 && (
                <button
                  onClick={retryFailed}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-sm"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  重试失败项
                </button>
              )}
              <button
                onClick={onClose}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors text-sm"
              >
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
