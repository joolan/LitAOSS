import type { PreviewModule } from '../types';

const docxModule: PreviewModule = {
  id: 'docx',
  label: 'Word 文档',
  extensions: ['docx'],
  kind: 'document',
  maxSizeBytes: 50 * 1024 * 1024,
  load: () => import('../viewers/DocxViewer'),
};

export default docxModule;
