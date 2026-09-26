import path from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, normalizePath } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const require = createRequire(import.meta.url)
const pdfjsDistPath = path.dirname(require.resolve('pdfjs-dist/package.json'))
const cMapsDir = normalizePath(path.join(pdfjsDistPath, 'cmaps'))
const standardFontsDir = normalizePath(path.join(pdfjsDistPath, 'standard_fonts'))

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: cMapsDir,
          dest: '',
        },
        {
          src: standardFontsDir,
          dest: '',
        },
      ],
    }),
  ],
  // PptxViewer 含 ECharts，按需分包 ~1.1MB（gz ~360KB），仅打开 pptx 时加载
  build: {
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8780',
        changeOrigin: true,
      },
    },
  },
})
