import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(packageRoot, 'src/ui');

export default defineConfig({
  root: uiRoot,
  base: '',
  plugins: [react()],
  build: {
    outDir: resolve(packageRoot, 'dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(uiRoot, 'index.html'),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
