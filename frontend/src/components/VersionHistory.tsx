import { useState, useEffect } from 'react';
import { X, RotateCcw, Download, History, AlertCircle, Eye } from 'lucide-react';
import { api, FileRecord, FileVersion } from '../api/client';
import { unwrapFileKeyFromStorage } from '../crypto/fileKey';
import { getPreviewMode, PREVIEW_MAX_SIZE } from '../crypto/crypto';

interface VersionHistoryProps {
  file: FileRecord;
  fileName: string;
  onClose: () => void;
  onChanged?: () => void;
}

export default function VersionHistory({ file, fileName, onClose, onChanged }: VersionHistoryProps) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [previewV, setPreviewV] = useState<FileVersion | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);
    };
  }, [previewImageUrl]);

  const closePreview = () => {
    setPreviewV(null);
    setPreviewText(null);
    setPreviewError('');
    if (previewImageUrl) {
      URL.revokeObjectURL(previewImageUrl);
      setPreviewImageUrl(null);
    }
  };

  const loadVersions = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getFileVersions(file.id);
      setVersions(res.versions || []);
    } catch (err: any) {
      setError(err.message || '加载历史版本失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadVersions();
  }, [file.id]);

  const decryptBytes = async (ciphertext: ArrayBuffer, v: FileVersion): Promise<ArrayBuffer> => {
    const fileKeyRaw = await unwrapFileKeyFromStorage(v.encrypted_file_key || '');
    const fileKey = await crypto.subtle.importKey('raw', fileKeyRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const ivBytes = Uint8Array.from(atob(v.iv || ''), c => c.charCodeAt(0));
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes, tagLength: 128 }, fileKey, ciphertext);
  };

  const handleDownloadVersion = async (v: FileVersion) => {
    setBusy(true);
    setError('');
    try {
      const presignRes = await api.getPresignDownloadUrl(v.oss_key);
      const response = await fetch(presignRes.url);
      const ciphertext = await response.arrayBuffer();
      const plaintext = await decryptBytes(ciphertext, v);

      const blob = new Blob([plaintext], { type: file.file_type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}.v${v.version}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError('下载版本失败: ' + (err.message || err));
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async (v: FileVersion) => {
    setPreviewV(v);
    setPreviewLoading(true);
    setPreviewError('');
    setPreviewText(null);
    if (previewImageUrl) {
      URL.revokeObjectURL(previewImageUrl);
      setPreviewImageUrl(null);
    }
    if (v.file_size > PREVIEW_MAX_SIZE) {
      setPreviewLoading(false);
      setPreviewError(`文件太大（${formatSize(v.file_size)}），超过 200MB 不支持预览`);
      return;
    }
    try {
      const presignRes = await api.getPresignDownloadUrl(v.oss_key);
      const response = await fetch(presignRes.url);
      const ciphertext = await response.arrayBuffer();
      const plaintext = await decryptBytes(ciphertext, v);

      if (getPreviewMode(fileName) === 'image') {
        const blob = new Blob([plaintext], { type: file.file_type || 'image/png' });
        setPreviewImageUrl(URL.createObjectURL(blob));
      } else {
        setPreviewText(new TextDecoder().decode(plaintext));
      }
    } catch (err: any) {
      setPreviewError('预览失败: ' + (err.message || err));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleRestore = async (v: FileVersion) => {
    if (!confirm(`恢复到版本 ${v.version}？当前内容会先保存为历史版本`)) return;
    setBusy(true);
    setError('');
    setActionMsg('');
    try {
      await api.createFileVersion(file.id, {
        oss_key: file.oss_key,
        encrypted_file_key: file.encrypted_file_key || '',
        iv: file.iv || '',
        salt: file.salt || '',
        file_size: file.file_size,
      }).catch(() => {});

      await api.updateFileContent(file.id, {
        file_size: v.file_size,
        file_type: file.file_type,
        encrypted_file_key: v.encrypted_file_key || '',
        iv: (v.iv || '') as any,
        salt: (v.salt || '') as any,
        oss_key: v.oss_key,
      });

      setActionMsg(`已恢复到版本 ${v.version}`);
      await loadVersions();
      onChanged?.();
    } catch (err: any) {
      setError('恢复失败: ' + (err.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
      <div className="bg-gray-900 rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <History className="w-5 h-5 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">历史版本</h2>
            <span className="hidden sm:block text-sm text-gray-400 truncate max-w-[200px]">{fileName}</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg">&times;</button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-2">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}
          {actionMsg && (
            <div className="p-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">{actionMsg}</div>
          )}

          {loading ? (
            <div className="text-center text-gray-400 py-8">加载中...</div>
          ) : versions.length === 0 ? (
            <div className="text-center text-gray-500 py-8">暂无历史版本</div>
          ) : (
            versions.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center justify-between gap-2 p-3 bg-gray-800 rounded-lg">
                <div>
                  <div className="text-white text-sm font-medium">版本 {v.version}</div>
                  <div className="text-xs text-gray-400">
                    {new Date(v.created_at).toLocaleString()} · {formatSize(v.file_size)}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(getPreviewMode(fileName) === 'image' || getPreviewMode(fileName) === 'text') && (
                    <button
                      onClick={() => handlePreview(v)}
                      disabled={busy || previewLoading}
                      className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded disabled:opacity-50 flex items-center gap-1"
                    >
                      <Eye className="w-3.5 h-3.5" /> 预览
                    </button>
                  )}
                  <button
                    onClick={() => handleDownloadVersion(v)}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded disabled:opacity-50 flex items-center gap-1"
                  >
                    <Download className="w-3.5 h-3.5" /> 下载
                  </button>
                  <button
                    onClick={() => handleRestore(v)}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded disabled:opacity-50 flex items-center gap-1"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> 恢复
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {previewV && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4">
          <div
            className="bg-gray-900 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
              <div className="flex items-center gap-3 min-w-0">
                <Eye className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                <h3 className="text-white font-medium truncate">{fileName}</h3>
                <span className="text-xs text-emerald-400 flex-shrink-0">版本 {previewV.version}</span>
                <span className="text-xs text-gray-500 flex-shrink-0">{formatSize(previewV.file_size)}</span>
              </div>
              <button onClick={closePreview} className="text-gray-400 hover:text-white text-lg flex-shrink-0 ml-4">
                &times;
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {previewLoading ? (
                <div className="flex items-center justify-center h-64 text-gray-400">解密中...</div>
              ) : previewError ? (
                <div className="flex items-center justify-center h-64 text-red-400 text-sm">{previewError}</div>
              ) : previewImageUrl ? (
                <div className="flex items-center justify-center">
                  <img src={previewImageUrl} alt={fileName} className="max-w-full max-h-[70vh] object-contain rounded" />
                </div>
              ) : previewText !== null ? (
                <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap break-words">{previewText}</pre>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
