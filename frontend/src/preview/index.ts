import { registerPreview } from './registry';
import { imageModule, textModule } from './builtin';
import pdfModule from './modules/pdf';
import docxModule from './modules/docx';
import xlsxModule from './modules/xlsx';

registerPreview(imageModule);
registerPreview(textModule);
registerPreview(pdfModule);
registerPreview(docxModule);
registerPreview(xlsxModule);

export { resolvePreview, registerPreview, PREVIEW_MAX_SIZE } from './registry';
export { decryptFileContent } from './decryptFile';
export type { PreviewModule, PreviewRenderProps, PreviewKind } from './types';
