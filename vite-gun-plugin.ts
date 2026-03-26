import type { Plugin, ViteDevServer } from 'vite';
import { createServer as createHttpServer } from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Vite plugin: Real Gun relay with storage at /gun path.
 *
 * Creates a hidden internal HTTP server, attaches Gun to it (with disk storage),
 * then intercepts /gun WebSocket upgrades from Vite and forwards them to Gun.
 * Vite's HMR WebSocket is untouched (it uses /?token=xxx path).
 */
export function gunRelay(): Plugin {
  return {
    name: 'gun-relay',
    configureServer(server: ViteDevServer) {
      if (!server.httpServer) return;

      const Gun = require('gun');

      // Internal HTTP server for Gun (doesn't listen on any port)
      const internalServer = createHttpServer();

      // Attach Gun with storage — this is a REAL relay that stores and serves data
      Gun({ web: internalServer, file: 'relay-data' });

      // Intercept WebSocket upgrades for /gun and forward to Gun's internal server
      server.httpServer.on('upgrade', (req, socket, head) => {
        const url = req.url || '';
        if (url.startsWith('/gun')) {
          // Let Gun handle this WebSocket connection
          internalServer.emit('upgrade', req, socket, head);
        }
        // All other upgrade requests (Vite HMR) pass through untouched
      });

      // Forward HTTP requests to /gun to Gun's internal server
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/gun')) {
          internalServer.emit('request', req, res);
        } else {
          next();
        }
      });

      console.log('  Gun relay: real Gun instance with storage at /gun');
    },
  };
}
