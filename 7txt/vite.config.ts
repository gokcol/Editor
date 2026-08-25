import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    strictPort: true,
    port: 5178,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
