import type { PreviewModule } from './types';
import { PREVIEW_MAX_SIZE } from './registry';

const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif'];

const textExts = [
  'txt', 'json', 'xml', 'csv', 'log', 'md', 'yaml', 'yml', 'toml', 'ini', 'conf',
  'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'rb', 'rs',
  'sh', 'bash', 'zsh', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte',
  'env', 'gitignore', 'dockerignore', 'makefile', 'cmake', 'gradle', 'properties',
  'proto', 'graphql', 'tf', 'hcl', 'nginx', 'apache',
];

export const imageModule: PreviewModule = {
  id: 'image',
  label: '图片',
  extensions: imageExts,
  kind: 'image',
  maxSizeBytes: PREVIEW_MAX_SIZE,
};

export const textModule: PreviewModule = {
  id: 'text',
  label: '文本',
  extensions: textExts,
  kind: 'text',
  maxSizeBytes: PREVIEW_MAX_SIZE,
};
