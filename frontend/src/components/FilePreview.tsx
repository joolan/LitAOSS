import { useState, useEffect } from 'react';
import { X, Download, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { FileRecord, fromBase64Bytes } from '../api/client';
import { unwrapFileKeyFromStorage } from '../crypto/fileKey';
import { getPreviewMode, PREVIEW_MAX_SIZE } from '../crypto/crypto';

interface FilePreviewProps {
  file: FileRecord;
  fileName: string;
  onClose: () => void;
}

export default function FilePreview({ file, fileName, onClose }: FilePreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(100);

  useEffect(() => {
    loadContent();
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [file.id]);

  const loadContent = async () => {
    setLoading(true);
    setError('');

    const mode = getPreviewMode(fileName);
    if (mode === 'unsupported') {
      setError('不支持预览此文件类型');
      setLoading(false);
      return;
    }
    if (file.file_size > PREVIEW_MAX_SIZE) {
      setError(`文件太大（${(file.file_size / 1024 / 1024).toFixed(1)} MB），超过 200MB 不支持预览`);
      setLoading(false);
      return;
    }

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

      if (mode === 'image') {
        const blob = new Blob([plaintext], { type: file.file_type || 'image/png' });
        setImageUrl(URL.createObjectURL(blob));
      } else {
        const text = new TextDecoder().decode(plaintext);
        setContent(text);
      }
    } catch (err) {
      setError('解密失败: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
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

      const blob = new Blob([plaintext], { type: file.file_type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('下载失败');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-white font-medium truncate">{fileName}</h3>
            <span className="text-xs text-gray-500 flex-shrink-0">
              {(file.file_size / 1024).toFixed(1)} KB
            </span>
          </div>
          <div className="flex items-center gap-2">
            {getPreviewMode(fileName) === 'text' && (
              <>
                <button
                  onClick={() => setZoom(Math.max(50, zoom - 10))}
                  className="p-1.5 hover:bg-gray-700 rounded transition-colors"
                >
                  <ZoomOut className="w-4 h-4 text-gray-400" />
                </button>
                <span className="text-xs text-gray-400 w-10 text-center">{zoom}%</span>
                <button
                  onClick={() => setZoom(Math.min(200, zoom + 10))}
                  className="p-1.5 hover:bg-gray-700 rounded transition-colors"
                >
                  <ZoomIn className="w-4 h-4 text-gray-400" />
                </button>
                <button
                  onClick={() => setZoom(100)}
                  className="p-1.5 hover:bg-gray-700 rounded transition-colors"
                >
                  <RotateCcw className="w-4 h-4 text-gray-400" />
                </button>
              </>
            )}
            <button
              onClick={handleDownload}
              className="p-1.5 hover:bg-gray-700 rounded transition-colors"
              title="下载"
            >
              <Download className="w-4 h-4 text-gray-400" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 hover:bg-gray-700 rounded transition-colors"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-64 text-gray-400">
              解密中...
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-64 text-red-400">
              {error}
            </div>
          ) : imageUrl ? (
            <div className="flex items-center justify-center">
              <img
                src={imageUrl}
                alt={fileName}
                className="max-w-full max-h-[70vh] object-contain rounded"
                style={{ transform: `scale(${zoom / 100})` }}
              />
            </div>
          ) : content !== null ? (
            <pre
              className="text-sm text-gray-300 font-mono whitespace-pre-wrap break-words"
              style={{ fontSize: `${zoom}%` }}
            >
              {content}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
