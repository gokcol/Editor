import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  clearScreen: false,
  server: {
    strictPort: true,
    port: 5178,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        boot: resolve(__dirname, '7txt-0.1.10.html'),
      },
    },
  },
});
