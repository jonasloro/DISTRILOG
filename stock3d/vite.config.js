import { defineConfig } from 'vite';
export default defineConfig({
  base: '/static/stock3d/',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', cssCodeSplit: true },
  server: { port: 5173, strictPort: true },
});
