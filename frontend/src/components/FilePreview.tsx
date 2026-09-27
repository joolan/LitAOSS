import { useState, useEffect, type ComponentType } from 'react';
import { X, Download, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { FileRecord } from '../api/client';
import { resolvePreview, decryptFileContent, generateThumb, getThumb, putThumb, thumbKey, type PreviewRenderProps } from '../preview';

interface FilePreviewProps {
  file: FileRecord;
  fileName: string;
  onClose: () => void;
}

export default function FilePreview({ file, fileName, onClose }: FilePreviewProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [plaintext, setPlaintext] = useState<ArrayBuffer | null>(null);
  const [Viewer, setViewer] = useState<ComponentType<PreviewRenderProps> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(100);

  const preview = resolvePreview(fileName);

  useEffect(() => {
    loadContent();
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [file.id]);

  const loadContent = async () => {
    setLoading(true);
    setError('');

    if (!preview) {
      setError('不支持预览此文件类型');
      setLoading(false);
      return;
    }
    if (file.file_size > preview.maxSizeBytes) {
      const limitMb = Math.round(preview.maxSizeBytes / 1024 / 1024);
      setError(
        `文件太大（${(file.file_size / 1024 / 1024).toFixed(1)} MB），超过 ${limitMb}MB 不支持预览`,
      );
      setLoading(false);
      return;
    }

    try {
      const content = await decryptFileContent(file);

      if (preview.kind === 'image') {
        const blob = new Blob([content], { type: file.file_type || 'image/png' });
        setImageUrl(URL.createObjectURL(blob));
        // 预览成功后生成小缩略图缓存（供网格视图显示，失败不影响预览）
        generateThumb(blob)
          .then((thumb) => {
            if (thumb) putThumb(thumbKey(file), thumb);
          })
          .catch(() => {});
      } else if (preview.kind === 'text') {
        setTextContent(new TextDecoder().decode(content));
      } else {
        setPlaintext(content);
        if (preview.load) {
          const mod = await preview.load();
          setViewer(() => mod.default);
        }
      }
    } catch (err) {
      setError('解密失败: ' + (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async () => {
    try {
      const content = await decryptFileContent(file);
      const blob = new Blob([content], { type: file.file_type || 'application/octet-stream' });
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

  const showZoom = preview?.kind === 'text';

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div
        className="bg-gray-900 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-3 min-w-0">
            <h3 className="text-white font-medium truncate">{fileName}</h3>
            <span className="text-xs text-gray-500 flex-shrink-0">
              {(file.file_size / 1024).toFixed(1)} KB
            </span>
            {preview && preview.kind === 'document' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 flex-shrink-0">
                {preview.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {showZoom && (
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
            <div className="flex items-center justify-center h-64 text-red-400 text-center px-4">
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
          ) : textContent !== null ? (
            <pre
              className="text-sm text-gray-300 font-mono whitespace-pre-wrap break-words"
              style={{ fontSize: `${zoom}%` }}
            >
              {textContent}
            </pre>
          ) : Viewer && plaintext ? (
            <div className="h-[70vh]">
              <Viewer fileName={fileName} data={plaintext} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
