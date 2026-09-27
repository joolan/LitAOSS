import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ChevronRight, Folder, Home, Move, X } from 'lucide-react';
import { api } from '../api/client';
import { getSessionPassword } from '../session';
import { decryptNameForStorage } from '../crypto/fileKey';

interface FolderPickerProps {
  onPick: (parentId: string | null) => void;
  onClose: () => void;
}

interface FolderEntry {
  id: string;
  name: string;
}

export default function FolderPicker({ onPick, onClose }: FolderPickerProps) {
  const [path, setPath] = useState<{ id: string | null; name: string }[]>([
    { id: null, name: '根目录' },
  ]);
  const [dirs, setDirs] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const current = path[path.length - 1];

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.listFiles(current.id || undefined);
      const list = (res.files || []).filter((f) => f.is_directory);
      const entries = await Promise.all(
        list.map(async (f) => {
          let name = '(无法解密)';
          if (getSessionPassword()) {
            try {
              name = (await decryptNameForStorage(f.name_encrypted)) ?? '(无法解密)';
            } catch {
              name = '(无法解密)';
            }
          } else {
            name = '(未解锁)';
          }
          return { id: f.id, name };
        }),
      );
      setDirs(entries);
    } catch (err) {
      setError((err as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [current.id]);

  useEffect(() => {
    load();
  }, [load]);

  const enterFolder = (dir: FolderEntry) => {
    setPath((prev) => [...prev, { id: dir.id, name: dir.name }]);
  };

  const jumpTo = (index: number) => {
    setPath((prev) => prev.slice(0, index + 1));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Move className="w-5 h-5 text-emerald-400" />
            <h3 className="text-lg font-semibold text-white">移动到</h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-1 overflow-x-auto text-sm">
          {path.map((p, i) => (
            <span key={p.id || 'root'} className="flex items-center gap-1 flex-shrink-0 last:shrink last:min-w-0">
              {i > 0 && <ChevronRight className="w-3 h-3 text-gray-600 flex-shrink-0" />}
              <button
                onClick={() => jumpTo(i)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors whitespace-nowrap overflow-hidden text-ellipsis max-w-[140px] ${
                  i === path.length - 1
                    ? 'text-white bg-gray-800'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {i === 0 && <Home className="w-3.5 h-3.5" />}
                {p.name}
              </button>
            </span>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3 min-h-[200px]">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
          {loading ? (
            <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>
          ) : dirs.length === 0 ? (
            <div className="text-center py-8 text-gray-500 text-sm">此位置下没有子文件夹</div>
          ) : (
            <ul className="space-y-1">
              {dirs.map((d) => (
                <li key={d.id}>
                  <button
                    onClick={() => enterFolder(d)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-200 hover:bg-gray-800 transition-colors text-left"
                  >
                    <Folder className="w-4 h-4 text-amber-400 flex-shrink-0" />
                    <span className="truncate flex-1">{d.name}</span>
                    <ChevronRight className="w-4 h-4 text-gray-600 flex-shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onPick(current.id)}
            disabled={loading}
            className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 text-white rounded-lg font-medium transition-colors"
          >
            移动到这里
          </button>
        </div>
      </div>
    </div>
  );
}
