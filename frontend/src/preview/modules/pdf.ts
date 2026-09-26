import type { PreviewModule } from '../types';

const pdfModule: PreviewModule = {
  id: 'pdf',
  label: 'PDF 文档',
  extensions: ['pdf'],
  kind: 'document',
  maxSizeBytes: 100 * 1024 * 1024,
  load: () => import('../viewers/PdfViewer'),
};

export default pdfModule;
