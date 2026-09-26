import { useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import type { PreviewRenderProps } from '../types';

export default function DocxViewer({ data, fileName }: PreviewRenderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    setError('');
    setLoading(true);

    renderAsync(data.slice(0), el, undefined, {
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      ignoreLastRenderedPageBreak: false,
    })
      .then(() => {
        if (!cancelled) setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError('文档解析失败: ' + (err instanceof Error ? err.message : String(err)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      el.replaceChildren();
    };
  }, [data, fileName]);

  if (error) {
    return <div className="flex items-center justify-center h-64 text-red-400 text-sm">{error}</div>;
  }

  return (
    <div className="relative">
      {loading && (
        <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
          文档解析中...
        </div>
      )}
      <div ref={containerRef} />
    </div>
  );
}
