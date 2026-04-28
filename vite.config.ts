import { defineConfig } from 'vite';
import { libp2pRelay } from './vite-libp2p-plugin';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [libp2pRelay()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      // Proxy relay WebSocket through Vite so the tunnel URL (port 5173/443)
      // can reach the relay (port 9090).  Mobile browsers connect to:
      //   wss://tunnel-url/relay-ws  →  Vite proxy  →  ws://localhost:9090
      '/relay-ws': {
        target: 'ws://localhost:9090',
        ws: true,
        rewrite: (path) => path.replace(/^\/relay-ws/, '') || '/',
      },
      '/smoke-hub': {
        target: 'ws://localhost:9092',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // Node.js Buffer polyfill for libp2p dependencies
      buffer: 'buffer/',
    },
  },
  optimizeDeps: {
    include: [
      '@tensorflow/tfjs',
      '@vladmandic/face-api',
      'libp2p',
      '@libp2p/websockets',
      '@libp2p/webrtc',
      '@libp2p/circuit-relay-v2',
      '@chainsafe/libp2p-gossipsub',
      '@libp2p/kad-dht',
      '@chainsafe/libp2p-noise',
      '@libp2p/yamux',
      '@libp2p/identify',
      '@libp2p/ping',
      '@libp2p/bootstrap',
      '@sinclair/smoke',
      'idb',
      'multiformats',
      '@multiformats/multiaddr-matcher',
      '@multiformats/multiaddr',
      '@libp2p/peer-id',
      '@libp2p/utils',
      'buffer',
    ],
  },
});
