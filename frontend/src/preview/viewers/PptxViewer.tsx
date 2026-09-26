import { useEffect, useRef, useState } from 'react';
import { PptxViewer as PptxLib, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer';
import type { PreviewRenderProps } from '../types';

export default function PptxViewer({ data, fileName }: PreviewRenderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PptxLib | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const el = containerRef.current;
    if (!scrollEl || !el) return;
    let cancelled = false;

    (async () => {
      try {
        const viewer = await PptxLib.open(data.slice(0), el, {
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          lazySlides: true,
          lazyMedia: true,
          scrollContainer: scrollEl,
          listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
          pdfjs: {
            moduleUrl: new URL('pdfjs-dist/build/pdf.min.mjs', import.meta.url).toString(),
            workerUrl: new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString(),
          },
        });
        if (cancelled) {
          viewer.destroy();
        } else {
          viewerRef.current = viewer;
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError('演示文稿解析失败: ' + (err instanceof Error ? err.message : String(err)));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
      el.replaceChildren();
    };
  }, [data, fileName]);

  if (error) {
    return <div className="flex items-center justify-center h-64 text-red-400 text-sm">{error}</div>;
  }

  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      {loading && (
        <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
          演示文稿解析中...
        </div>
      )}
      <div ref={containerRef} />
    </div>
  );
}
