import { useMemo, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCw } from 'lucide-react';
import type { PreviewRenderProps } from '../types';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const pdfOptions = {
  cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

export default function PdfViewer({ data }: PreviewRenderProps) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState('');

  const file = useMemo(() => data, [data]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-center gap-2 py-2 border-b border-gray-800 bg-gray-900 text-sm text-gray-300 sticky top-0 z-10">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1}
          className="p-1.5 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors"
          title="上一页"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="w-28 text-center text-xs">
          第 {page} / {numPages || '—'} 页
        </span>
        <button
          onClick={() => setPage((p) => Math.min(numPages, p + 1))}
          disabled={page >= numPages}
          className="p-1.5 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors"
          title="下一页"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-gray-700 mx-1" />
        <button
          onClick={() => setScale((s) => Math.max(MIN_SCALE, s - 0.2))}
          disabled={scale <= MIN_SCALE}
          className="p-1.5 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors"
          title="缩小"
        >
          <Minus className="w-4 h-4" />
        </button>
        <span className="w-14 text-center text-xs">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale((s) => Math.min(MAX_SCALE, s + 0.2))}
          disabled={scale >= MAX_SCALE}
          className="p-1.5 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent rounded transition-colors"
          title="放大"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          onClick={() => setScale(1.2)}
          className="p-1.5 hover:bg-gray-700 rounded transition-colors"
          title="重置缩放"
        >
          <RotateCw className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 flex justify-center items-start">
        {error ? (
          <div className="flex items-center justify-center h-64 text-red-400 text-sm">
            {error}
          </div>
        ) : (
          <Document
            file={file}
            options={pdfOptions}
            loading={
              <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
                PDF 解析中...
              </div>
            }
            error={
              <div className="flex items-center justify-center h-64 text-red-400 text-sm">
                PDF 加载失败
              </div>
            }
            onLoadSuccess={(doc) => {
              setNumPages(doc.numPages);
              setPage(1);
              setError('');
            }}
            onLoadError={(err) => setError('PDF 加载失败: ' + err.message)}
            onSourceError={(err) => setError('PDF 读取失败: ' + err.message)}
          >
            <Page
              pageNumber={page}
              scale={scale}
              renderAnnotationLayer
              renderTextLayer
            />
          </Document>
        )}
      </div>
    </div>
  );
}
