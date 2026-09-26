import type { PreviewModule } from '../types';

const pptxModule: PreviewModule = {
  id: 'pptx',
  label: 'PPT 演示文稿',
  extensions: ['pptx'],
  kind: 'document',
  maxSizeBytes: 50 * 1024 * 1024,
  load: () => import('../viewers/PptxViewer'),
};

export default pptxModule;
