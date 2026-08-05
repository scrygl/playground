/* SCRATCH — build config for the UI screenshot harness only. Deleted with it. */
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'esnext',
    outDir: 'dist-ui',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./uitest.html', import.meta.url)) },
  },
});
