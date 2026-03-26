/**
 * Single-tab lock.
 *
 * Prevents multiple NeuronChain tabs in the same browser.
 * This stops users from opening multiple tabs to create
 * multiple accounts and farm UNIT.
 *
 * Uses BroadcastChannel to detect other tabs and localStorage
 * as a persistent heartbeat.
 */

const LOCK_KEY = 'neuronchain_tab_lock';
const HEARTBEAT_MS = 2000;
const STALE_MS = 5000;

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let tabId: string = '';

function generateTabId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Try to acquire the tab lock.
 * Returns true if this tab is allowed to run, false if another tab is already active.
 */
export function acquireTabLock(): boolean {
  tabId = generateTabId();

  // Check if another tab holds the lock
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (raw) {
      const lock = JSON.parse(raw) as { id: string; ts: number };
      if (lock.id !== tabId && Date.now() - lock.ts < STALE_MS) {
        // Another tab is active and not stale
        return false;
      }
    }
  } catch { /* corrupt lock data */ }

  // Acquire the lock
  writeLock();

  // Heartbeat to keep the lock alive
  heartbeatInterval = setInterval(() => {
    writeLock();
  }, HEARTBEAT_MS);

  // Release on unload
  window.addEventListener('beforeunload', releaseTabLock);

  return true;
}

function writeLock(): void {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify({ id: tabId, ts: Date.now() }));
  } catch { /* localStorage full or unavailable */ }
}

/**
 * Release the tab lock (on tab close or manual release).
 */
export function releaseTabLock(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (raw) {
      const lock = JSON.parse(raw) as { id: string };
      // Only remove if we own it
      if (lock.id === tabId) {
        localStorage.removeItem(LOCK_KEY);
      }
    }
  } catch { /* ignore */ }
}
