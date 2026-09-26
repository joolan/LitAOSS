import type { PreviewModule } from './types';

const modules: PreviewModule[] = [];

export const PREVIEW_MAX_SIZE = 200 * 1024 * 1024;

export function registerPreview(module: PreviewModule): void {
  const idx = modules.findIndex((m) => m.id === module.id);
  if (idx >= 0) {
    modules[idx] = module;
  } else {
    modules.push(module);
  }
}

function fileExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() || '';
}

export function resolvePreview(fileName: string): PreviewModule | undefined {
  const ext = fileExtension(fileName);
  if (!ext) return undefined;
  return modules.find((m) => m.extensions.includes(ext));
}
