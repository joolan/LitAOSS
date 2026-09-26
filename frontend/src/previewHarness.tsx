import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import XlsxViewer from './preview/viewers/XlsxViewer';
import DocxViewer from './preview/viewers/DocxViewer';
import PdfViewer from './preview/viewers/PdfViewer';

async function fetchBuf(path: string): Promise<ArrayBuffer> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

interface Samples {
  xlsx?: ArrayBuffer;
  docx?: ArrayBuffer;
  pdf?: ArrayBuffer;
}

export default function PreviewHarness() {
  const [samples, setSamples] = useState<Samples>({});
  const [status, setStatus] = useState('loading');
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const collected: string[] = [];
    const onError = (e: ErrorEvent) => collected.push('window.error: ' + e.message);
    window.addEventListener('error', onError);
    (async () => {
      try {
        const [xlsx, docx, pdf] = await Promise.all([
          fetchBuf('/src/preview/samples/test.xlsx'),
          fetchBuf('/src/preview/samples/test.docx'),
          fetchBuf('/src/preview/samples/test.pdf'),
        ]);
        setSamples({ xlsx, docx, pdf });
        setStatus('ready');
      } catch (e) {
        setStatus('failed: ' + (e as Error).message);
      } finally {
        setTimeout(() => setErrors(collected), 0);
      }
    })();
    return () => window.removeEventListener('error', onError);
  }, []);

  return (
    <div>
      <h1>
        LitAOSS 预览自检
        <span id="status">{status}</span>
      </h1>
      <div id="errors">{errors.join('\n')}</div>
      <div className="panel" id="panel-xlsx">
        <h2>XLSX</h2>
        {samples.xlsx && <XlsxViewer fileName="test.xlsx" data={samples.xlsx} />}
      </div>
      <div className="panel" id="panel-docx">
        <h2>DOCX</h2>
        {samples.docx && <DocxViewer fileName="test.docx" data={samples.docx} />}
      </div>
      <div className="panel" id="panel-pdf" style={{ height: '70vh' }}>
        <h2>PDF</h2>
        {samples.pdf && <PdfViewer fileName="test.pdf" data={samples.pdf} />}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<PreviewHarness />);
