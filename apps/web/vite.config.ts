import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      '/api': { target: process.env.API_TARGET ?? 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: (process.env.API_TARGET ?? 'http://localhost:8787').replace('http', 'ws'), ws: true },
    },
  },
});
