const RELOAD_LOG_KEY = 'neuronchain_pending_reload_log';
const FREEZE_KEY     = 'neuronchain_freeze_at';

// Set to true by writeReloadLog so the pagehide handler knows the unload was intentional.
let intentionalReload = false;
// Set to true when the user clicks Stop Node, cleared after 30s.
let nodeWasStopped = false;
let nodeStoppedTimer: ReturnType<typeof setTimeout> | null = null;

export function markNodeStopped(): void {
  nodeWasStopped = true;
  if (nodeStoppedTimer) clearTimeout(nodeStoppedTimer);
  nodeStoppedTimer = setTimeout(() => { nodeWasStopped = false; }, 30_000);
}

function deviceId(): string {
  return localStorage.getItem('neuronchain_device_id') ?? 'unknown';
}

function entry(reason: string): string {
  return `${new Date().toISOString()} | ${reason} | uptime ${Math.round(performance.now() / 1000)}s | device ${deviceId()}`;
}

function sendDirect(msg: string): void {
  fetch('/log-reload', { method: 'POST', body: msg }).catch(() => {});
}

// Write synchronously to localStorage before reloading so it survives the navigation.
export function writeReloadLog(reason: string): void {
  intentionalReload = true;
  try { localStorage.setItem(RELOAD_LOG_KEY, entry(reason)); } catch { /* ignore */ }
}

export function initReloadMonitor(): void {
  // ── Flush entry written before the last reload ──────────────────────────────
  const pending = localStorage.getItem(RELOAD_LOG_KEY);
  if (pending) {
    localStorage.removeItem(RELOAD_LOG_KEY);
    sendDirect(pending);
  }

  // ── Tab was discarded by the browser while backgrounded ─────────────────────
  // document.wasDiscarded is true when the browser reloaded a frozen/discarded tab.
  if ((document as any).wasDiscarded) {
    sendDirect(entry('tab discarded by browser while backgrounded'));
  }

  // ── Freeze entry that was never resumed (discarded after freeze) ─────────────
  const frozenRaw = localStorage.getItem(FREEZE_KEY);
  if (frozenRaw) {
    localStorage.removeItem(FREEZE_KEY);
    try {
      const { at, uptime, did } = JSON.parse(frozenRaw);
      sendDirect(`${new Date().toISOString()} | tab was frozen at ${at} (uptime ${uptime}s) then discarded | device ${did}`);
    } catch { /* ignore */ }
  }

  // ── Unexpected unload ────────────────────────────────────────────────────────
  // pagehide fires for reloads, closes, and navigations. If it fires without
  // intentionalReload being set, something outside our code triggered it.
  // e.persisted = true means the page went into bfcache (not a full unload).
  window.addEventListener('pagehide', (e) => {
    if (!intentionalReload) {
      const stopped = nodeWasStopped ? ', node was stopped recently' : '';
      writeReloadLog(`unexpected unload (bfcache=${e.persisted}${stopped})`);
    }
  });

  // ── Vite HMR full-reload (dev only) ─────────────────────────────────────────
  if ((import.meta as any).hot) {
    (import.meta as any).hot.on('vite:beforeFullReload', () => {
      writeReloadLog('vite HMR full-reload');
    });
  }

  // ── Service worker updated and claimed the tab mid-session ──────────────────
  // Only log if there was already a controller when the page loaded — that means
  // a NEW SW replaced the existing one while this tab was open.
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      sendDirect(entry('service worker updated and claimed tab mid-session'));
    });
  }

  // ── Page Lifecycle: freeze ───────────────────────────────────────────────────
  // Fires when the browser suspends the tab (background, low memory).
  // Persisted to localStorage so we can report it even if the tab is discarded.
  window.addEventListener('freeze', () => {
    try {
      localStorage.setItem(FREEZE_KEY, JSON.stringify({
        at: new Date().toISOString(),
        uptime: Math.round(performance.now() / 1000),
        did: deviceId(),
      }));
    } catch { /* ignore */ }
  });

  // ── Page Lifecycle: resume ───────────────────────────────────────────────────
  // Fires when the browser thaws a frozen tab. Report how long it was frozen.
  window.addEventListener('resume', () => {
    const raw = localStorage.getItem(FREEZE_KEY);
    if (!raw) return;
    localStorage.removeItem(FREEZE_KEY);
    try {
      const { at, uptime, did } = JSON.parse(raw);
      const frozenSecs = Math.round((Date.now() - new Date(at).getTime()) / 1000);
      sendDirect(`${new Date().toISOString()} | tab unfrozen after ${frozenSecs}s (frozen at ${at}, uptime ${uptime}s) | device ${did}`);
    } catch { /* ignore */ }
  });

  // ── Memory pressure (Chromium only) ─────────────────────────────────────────
  // Checked every minute. Logs when heap usage exceeds 80% of the JS heap limit —
  // a likely precursor to a renderer crash/reload.
  if ('memory' in performance) {
    setInterval(() => {
      const mem = (performance as any).memory;
      const usedMB  = Math.round(mem.usedJSHeapSize  / 1_048_576);
      const limitMB = Math.round(mem.jsHeapSizeLimit  / 1_048_576);
      const pct     = Math.round(usedMB / limitMB * 100);
      if (pct >= 80) {
        sendDirect(entry(`memory pressure: ${usedMB}MB / ${limitMB}MB (${pct}%)`));
      }
    }, 60_000);
  }
}
