import type { PreviewModule } from '../types';

const xlsxModule: PreviewModule = {
  id: 'xlsx',
  label: 'Excel 表格',
  extensions: ['xlsx', 'xlsm', 'xls'],
  kind: 'document',
  maxSizeBytes: 50 * 1024 * 1024,
  load: () => import('../viewers/XlsxViewer'),
};

export default xlsxModule;
