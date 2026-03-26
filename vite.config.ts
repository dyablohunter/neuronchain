import { defineConfig } from 'vite';
import { gunRelay } from './vite-gun-plugin';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [gunRelay()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  optimizeDeps: {
    rolldownOptions: {
      target: 'esnext',
    },
  },
});
