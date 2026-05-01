'use strict';

const STREAM_PREFIX = '/__nc_stream__/';

// metaCid → { totalSize: number, mimeType: string, clientId: string }
const registry = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('message', event => {
  const { type, metaCid, totalSize, mimeType } = event.data ?? {};
  if (type === 'NC_REGISTER_STREAM' && metaCid) {
    registry.set(metaCid, { totalSize, mimeType, clientId: event.source.id });
  } else if (type === 'NC_UNREGISTER_STREAM' && metaCid) {
    registry.delete(metaCid);
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(STREAM_PREFIX)) return;

  const metaCid = url.pathname.slice(STREAM_PREFIX.length);
  const info = registry.get(metaCid);
  if (!info) return;

  event.respondWith(handleStreamRequest(event.request, metaCid, info));
});

async function handleStreamRequest(request, metaCid, info) {
  const { totalSize, mimeType, clientId } = info;
  const rangeHeader = request.headers.get('Range');

  let start = 0;
  let end = totalSize - 1;
  let status = 200;

  if (rangeHeader) {
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (m) {
      start = parseInt(m[1], 10);
      end = m[2] ? Math.min(parseInt(m[2], 10), totalSize - 1) : totalSize - 1;
      status = 206;
    }
  }

  const client = await self.clients.get(clientId);
  if (!client) {
    return new Response('Stream client unavailable', { status: 503 });
  }

  const { port1, port2 } = new MessageChannel();

  const bytesPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port1.onmessage = null;
      reject(new Error('Chunk request timed out after 30s'));
    }, 30_000);
    port1.onmessage = event => {
      clearTimeout(timer);
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.bytes);
    };
  });

  client.postMessage(
    { type: 'NC_CHUNK_REQUEST', metaCid, start, end, port: port2 },
    [port2],
  );

  try {
    const bytes = await bytesPromise;
    const length = end - start + 1;
    const headers = new Headers({
      'Content-Type': mimeType,
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (status === 206) {
      headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    }
    return new Response(bytes, { status, headers });
  } catch (err) {
    return new Response(err.message, { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }
}
