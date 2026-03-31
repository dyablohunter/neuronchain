import type { Plugin, ViteDevServer } from 'vite';
import { createServer as createHttpServer } from 'http';
import { createRequire } from 'module';
import { installGunMiddleware } from './gun-middleware';

const require = createRequire(import.meta.url);

/**
 * Vite plugin: Gun relay with server-side validation.
 *
 * Single Gun relay instance with middleware that:
 * - Verifies ECDSA signatures on blocks, accounts, and votes
 * - Rejects null writes to protected paths (prevents malicious deletion)
 * - Rate limits per connection (60 burst, 20/s sustained)
 *
 * Data is sharded by path within the Gun graph (synapse-0..3 + global).
 */
export function gunRelay(): Plugin {
  return {
    name: 'gun-relay',
    configureServer(server: ViteDevServer) {
      if (!server.httpServer) return;

      const Gun = require('gun');
      const internalServer = createHttpServer();
      const gunInstance = Gun({ web: internalServer, file: '.relay-data' });

      // Install server-side validation middleware
      const { stats } = installGunMiddleware(gunInstance);

      server.httpServer.on('upgrade', (req, socket, head) => {
        const url = req.url || '';
        if (url.startsWith('/gun')) {
          internalServer.emit('upgrade', req, socket, head);
        }
      });

      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/gun')) {
          internalServer.emit('request', req, res);
        } else if (req.url === '/gun-stats') {
          // Expose middleware stats at /gun-stats for monitoring
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stats));
        } else {
          next();
        }
      });

      console.log('  Gun relay: single instance at /gun (sharded by path internally)');
      console.log('  Middleware: signature validation + rate limiting enabled');
      console.log('  Stats endpoint: /gun-stats');
    },
  };
}
