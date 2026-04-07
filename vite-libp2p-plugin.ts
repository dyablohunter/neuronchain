/**
 * Vite plugin: starts the libp2p relay server (relay-server.js) as a
 * child process alongside the Vite dev server, then stops it on close.
 *
 * In production, run relay-server.js separately:
 *   node relay-server.js
 */

import type { Plugin, ViteDevServer } from 'vite';
import { spawn, ChildProcess } from 'child_process';
import { createServer } from 'http';
import { join } from 'path';

export function libp2pRelay(): Plugin {
  let relayProcess: ChildProcess | null = null;

  return {
    name: 'libp2p-relay',

    configureServer(server: ViteDevServer) {
      const relayPath = join(process.cwd(), 'relay-server.js');

      relayProcess = spawn(process.execPath, [relayPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: '9090' },
      });

      relayProcess.stdout?.on('data', (d: Buffer) => {
        process.stdout.write(`\x1b[36m[relay]\x1b[0m ${d.toString()}`);
      });
      relayProcess.stderr?.on('data', (d: Buffer) => {
        process.stderr.write(`\x1b[31m[relay]\x1b[0m ${d.toString()}`);
      });
      relayProcess.on('exit', (code) => {
        if (code !== 0) console.warn(`[libp2p-relay] Relay exited with code ${code}`);
        relayProcess = null;
      });

      // Proxy /relay-info to the relay's info HTTP endpoint (port 9092)
      server.middlewares.use('/relay-info', (_req, res) => {
        const proxyReq = createServer().listen(); // dummy — use http.get instead
        proxyReq.close();
        import('http').then(({ get }) => {
          get('http://localhost:9092/relay-info', (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(res);
          }).on('error', () => {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Relay not ready yet' }));
          });
        });
      });

      console.log('  libp2p relay: starting on port 9090');
    },

    closeServer() {
      if (relayProcess) {
        relayProcess.kill('SIGTERM');
        relayProcess = null;
      }
    },
  };
}
