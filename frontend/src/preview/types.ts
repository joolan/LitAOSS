import type { ComponentType } from 'react';

export type PreviewKind = 'image' | 'text' | 'document';

export interface PreviewRenderProps {
  fileName: string;
  data: ArrayBuffer;
}

export interface PreviewModule {
  id: string;
  label: string;
  extensions: string[];
  kind: PreviewKind;
  maxSizeBytes: number;
  /** kind 为 document 时必填；动态导入，保证查看器代码按需分包 */
  load?: () => Promise<{ default: ComponentType<PreviewRenderProps> }>;
}
