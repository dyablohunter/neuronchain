import type { Plugin, ViteDevServer } from 'vite';
import { createServer as createHttpServer } from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Vite plugin: Gun relay with internal sharding.
 *
 * Single Gun instance at /gun — data is sharded internally using
 * Gun's graph structure (shard/N/... paths within the same Gun DB).
 * This avoids multiple WebSocket connections which break through tunnels.
 */
export function gunRelay(): Plugin {
  return {
    name: 'gun-relay',
    configureServer(server: ViteDevServer) {
      if (!server.httpServer) return;

      const Gun = require('gun');
      const internalServer = createHttpServer();
      Gun({ web: internalServer, file: '.relay-data' });

      server.httpServer.on('upgrade', (req, socket, head) => {
        const url = req.url || '';
        if (url.startsWith('/gun')) {
          internalServer.emit('upgrade', req, socket, head);
        }
      });

      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/gun')) {
          internalServer.emit('request', req, res);
        } else {
          next();
        }
      });

      console.log('  Gun relay: single instance with internal sharding at /gun');
    },
  };
}
