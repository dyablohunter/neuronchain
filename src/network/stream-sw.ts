import type { SmokeStore } from './smoke-store';
import type { KeyPair } from '../core/crypto';

let smokeStore: SmokeStore | null = null;

// Keys stay in the main thread — never sent to the Service Worker
const streamKeys = new Map<string, KeyPair | undefined>();

/**
 * Register the Service Worker and wire up the NC_CHUNK_REQUEST handler.
 * Safe to call before node.start() — the handler only runs when the user
 * actually plays a file (by which time the node will be running).
 */
export async function initStreamSW(store: SmokeStore): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    console.warn('[StreamSW] Service workers not supported — seekable video unavailable');
    return;
  }

  smokeStore = store;

  try {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    // On first install the SW activates and calls clients.claim(), but the
    // controller property on this page may not be set until controllerchange fires.
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      });
    }
  } catch (err) {
    console.error('[StreamSW] Registration failed:', err);
    return;
  }

  navigator.serviceWorker.addEventListener('message', async (event: MessageEvent) => {
    const data = event.data as {
      type?: string;
      metaCid?: string;
      start?: number;
      end?: number;
      port?: MessagePort;
    };
    if (data?.type !== 'NC_CHUNK_REQUEST') return;
    const { metaCid, start, end, port } = data;
    if (!metaCid || start === undefined || end === undefined || !port) return;

    try {
      if (!smokeStore) throw new Error('Store not initialised');
      const keys = streamKeys.get(metaCid);
      const bytes = await smokeStore.getChunkBytes(metaCid, start, end, keys);
      if (!bytes) throw new Error(`No data for ${metaCid} [${start}-${end}]`);
      port.postMessage({ bytes }, [bytes.buffer]);
    } catch (err) {
      port.postMessage({ error: String(err) });
    }
  });

  console.log('[StreamSW] Ready — seekable video/audio streaming enabled');
}

/**
 * Register a large file for range-request streaming through the Service Worker.
 * Returns the URL to use as <video>/<audio> src.
 * Keys never leave the main thread.
 */
export function registerStreamURL(
  metaCid: string,
  totalSize: number,
  mimeType: string,
  keys?: KeyPair,
): string {
  streamKeys.set(metaCid, keys);

  const controller = navigator.serviceWorker?.controller;
  if (controller) {
    controller.postMessage({ type: 'NC_REGISTER_STREAM', metaCid, totalSize, mimeType });
  } else {
    console.warn('[StreamSW] No active SW controller — reload the page if streaming fails');
  }

  return `/__nc_stream__/${metaCid}`;
}

/** Clean up when the media element is done. */
export function unregisterStreamURL(metaCid: string): void {
  streamKeys.delete(metaCid);
  navigator.serviceWorker?.controller?.postMessage({
    type: 'NC_UNREGISTER_STREAM',
    metaCid,
  });
}
