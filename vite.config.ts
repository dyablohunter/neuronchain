import { defineConfig } from 'vite';
import { libp2pRelay } from './vite-libp2p-plugin';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [libp2pRelay()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    watch: {
      ignored: ['**/.relay-peer-id.json', '**/.relay-signing-key.json', '**/.relay-face-db.json'],
    },
    proxy: {
      // Proxy relay WebSocket through Vite so the tunnel URL (port 5173/443)
      // can reach the relay (port 9090).  Mobile browsers connect to:
      //   wss://tunnel-url/relay-ws  →  Vite proxy  →  ws://localhost:9090
      '/relay-ws': {
        target: 'ws://localhost:9090',
        ws: true,
        rewrite: (path) => path.replace(/^\/relay-ws/, '') || '/',
        // Disable proxy timeouts so the WebSocket is never torn down by Vite
        // for being idle — the libp2p ping keepalive handles NAT, not Vite.
        timeout: 0,
        proxyTimeout: 0,
      },
      '/smoke-hub': {
        target: 'ws://localhost:9092',
        ws: true,
      },
      '/log-reload': {
        target: 'http://localhost:9092',
      },
      '/face-verify': {
        target: 'http://localhost:9092',
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
    // Bake bootstrap relay multiaddresses into the build.
    // Format: JSON array of multiaddr strings with /p2p/<peerId> suffix, e.g.:
    //   __BOOTSTRAP_ADDRS__: JSON.stringify([
    //     '/dns4/relay1.example.com/tcp/443/wss/http-path/relay-ws/p2p/<peerId1>',
    //     '/dns4/relay2.example.com/tcp/443/wss/http-path/relay-ws/p2p/<peerId2>',
    //   ])
    // The localStorage key 'neuronchain_bootstrap' always takes priority over this list.
    __BOOTSTRAP_ADDRS__: JSON.stringify([
      '/dns4/neuronweb.org/tcp/443/wss/http-path/relay-ws/p2p/12D3KooWDqCwT9M8VFAZJ2qGDPuxYqdFpa5nAXJcyp7eXAQJYsf7',
      ...(process.env.BOOTSTRAP_ADDRS || '').split(',').filter(Boolean),
    ]),
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
