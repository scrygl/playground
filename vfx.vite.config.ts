// SCRATCH — builds only the VFX harness page. Delete with vfxtest.html.
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'esnext',
    outDir: 'dist-vfx',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      input: { index: resolve(fileURLToPath(new URL('.', import.meta.url)), 'vfxtest.html') },
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
});
