import { useState, useEffect, useCallback } from 'react';
import { X, Save, AlertCircle, Check, History, RotateCcw } from 'lucide-react';
import { FileRecord, FileVersion, fromBase64Bytes } from '../api/client';
import { unwrapFileKeyFromStorage, wrapFileKeyForStorage } from '../crypto/fileKey';
import { getPreviewMode } from '../crypto/crypto';

interface TextEditorProps {
  file: FileRecord;
  fileName: string;
  onClose: () => void;
}

export default function TextEditor({ file, fileName, onClose }: TextEditorProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);

  useEffect(() => {
    loadContent();
  }, [file.id]);

  const loadContent = async () => {
    setLoading(true);
    setError('');
    try {
      const { api: apiClient } = await import('../api/client');
      const presignRes = await apiClient.getPresignDownloadUrl(file.oss_key);
      const response = await fetch(presignRes.url);
      const ciphertext = await response.arrayBuffer();

      const fileKeyRaw = await unwrapFileKeyFromStorage(file.encrypted_file_key || '');
      const fileKey = await crypto.subtle.importKey(
        'raw',
        fileKeyRaw,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );

      const iv = fromBase64Bytes(file.iv);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        fileKey,
        ciphertext,
      );

      const text = new TextDecoder().decode(plaintext);
      setContent(text);
      setOriginalContent(text);
    } catch (err) {
      setError('解密失败: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (): Promise<boolean> => {
    if (content === originalContent) return true;
    setSaving(true);
    setError('');
    setSaved(false);

    try {
      const plaintext = new TextEncoder().encode(content);

      const fileKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
      );

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, tagLength: 128 },
        fileKey,
        plaintext,
      );

      const fileKeyRaw = await crypto.subtle.exportKey('raw', fileKey);
      const fileKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(fileKeyRaw)));

      const encryptedFileKey = await wrapFileKeyForStorage(fileKeyBase64);

      const { api: apiClient } = await import('../api/client');

      // Save current version before overwriting
      await apiClient.getFileVersions(file.id).catch(() => ({ versions: [] })).then(async (res) => {
        const versionCount = res.versions?.length || 0;
        if (versionCount > 0 || file.oss_key) {
          await apiClient.createFileVersion(file.id, {
            oss_key: file.oss_key,
            encrypted_file_key: file.encrypted_file_key || '',
            iv: file.iv || '',
            salt: file.salt || '',
            file_size: file.file_size,
          }).catch(() => {});
        }
      });

      const ossKeyRes = await apiClient.generateOSSKey();
      const ossKey = ossKeyRes.oss_key;

      const presignRes = await apiClient.getPresignUploadUrl(ossKey);
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`upload failed: ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('network error'));
        xhr.open('PUT', presignRes.url);
        xhr.send(ciphertext);
      });

      await apiClient.updateFileContent(file.id, {
        file_size: ciphertext.byteLength,
        file_type: file.file_type,
        encrypted_file_key: encryptedFileKey,
        iv: Array.from(iv),
        salt: [],
        oss_key: ossKey,
      });

      setOriginalContent(content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    } catch (err) {
      setError('保存失败: ' + (err as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const requestClose = () => {
    if (hasChanges) setCloseConfirm(true);
    else onClose();
  };

  const handleSaveAndClose = async () => {
    const ok = await handleSave();
    if (ok) onClose();
    else setCloseConfirm(false);
  };

  const loadVersions = async () => {
    setLoadingVersions(true);
    try {
      const { api: apiClient } = await import('../api/client');
      const res = await apiClient.getFileVersions(file.id);
      setVersions(res.versions || []);
    } catch {
      setVersions([]);
    } finally {
      setLoadingVersions(false);
    }
  };

  const handleShowVersions = () => {
    setShowVersions(!showVersions);
    if (!showVersions) loadVersions();
  };

  const handleRestoreVersion = async (version: FileVersion) => {
    try {
      const { api: apiClient } = await import('../api/client');
      const presignRes = await apiClient.getPresignDownloadUrl(version.oss_key);
      const response = await fetch(presignRes.url);
      const ciphertext = await response.arrayBuffer();

      const fileKeyRaw = await unwrapFileKeyFromStorage(version.encrypted_file_key || '');
      const fileKey = await crypto.subtle.importKey(
        'raw', fileKeyRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
      );

      const iv = fromBase64Bytes(version.iv);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: 128 }, fileKey, ciphertext,
      );

      setContent(new TextDecoder().decode(plaintext));
      setShowVersions(false);
    } catch (err) {
      setError('恢复版本失败: ' + (err as Error).message);
    }
  };

  const hasChanges = content !== originalContent;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div
        className="bg-gray-900 rounded-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-white font-medium truncate">{fileName}</h3>
            {hasChanges && (
              <span className="text-xs text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded">
                未保存
              </span>
            )}
            {saved && (
              <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded flex items-center gap-1">
                <Check className="w-3 h-3" /> 已保存
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleShowVersions}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
              title="版本历史"
            >
              <History className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-sm transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? '保存中...' : '保存'}
            </button>
            <button
              onClick={requestClose}
              className="p-1.5 hover:bg-gray-700 rounded transition-colors"
              title="关闭"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-3 flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        <div className="flex-1 overflow-hidden p-4">
          {showVersions ? (
            <div className="h-full overflow-auto">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-medium text-white">版本历史</h4>
                <button onClick={() => setShowVersions(false)} className="text-xs text-gray-400 hover:text-white">关闭</button>
              </div>
              {loadingVersions ? (
                <div className="text-center py-8 text-gray-400 text-sm">加载中...</div>
              ) : versions.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">暂无历史版本</div>
              ) : (
                <div className="space-y-2">
                  {versions.map((v) => (
                    <div key={v.id} className="flex items-center justify-between p-3 bg-gray-800 rounded-lg">
                      <div>
                        <span className="text-xs text-emerald-400">v{v.version}</span>
                        <span className="text-xs text-gray-500 ml-2">
                          {new Date(v.created_at).toLocaleString('zh-CN')}
                        </span>
                        <span className="text-xs text-gray-600 ml-2">
                          {(v.file_size / 1024).toFixed(1)} KB
                        </span>
                      </div>
                      <button
                        onClick={() => handleRestoreVersion(v)}
                        className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" /> 恢复
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center h-full text-gray-400">
              解密中...
            </div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-full bg-gray-950 text-gray-300 font-mono text-sm p-4 rounded-xl border border-gray-800 focus:outline-none focus:border-emerald-500 resize-none"
              placeholder="输入内容..."
              spellCheck={false}
            />
          )}
        </div>

        <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-500 flex items-center justify-between">
          <span>Ctrl+S 保存</span>
          <span>{content.length} 字符 · {content.split('\n').length} 行</span>
        </div>
      </div>

      {closeConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <AlertCircle className="w-5 h-5 text-amber-400" />
              </div>
              <h3 className="text-lg font-semibold text-white">未保存的修改</h3>
            </div>
            <p className="text-gray-400 text-sm mb-5">内容已修改且尚未保存，如何处理？</p>
            <div className="flex flex-col gap-2">
              <button
                onClick={handleSaveAndClose}
                disabled={saving}
                className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                {saving ? '保存中...' : '保存并关闭'}
              </button>
              <button
                onClick={onClose}
                className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-white rounded-lg font-medium transition-colors"
              >
                放弃修改并关闭
              </button>
              <button
                onClick={() => setCloseConfirm(false)}
                className="w-full py-2 bg-transparent hover:bg-gray-800 text-gray-400 rounded-lg text-sm transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
