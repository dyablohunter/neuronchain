/**
 * Keep-alive system to prevent the browser tab from freezing/sleeping.
 *
 * Uses three strategies:
 * 1. Wake Lock API — prevents screen from turning off (mobile + desktop)
 * 2. Web Worker heartbeat — keeps JS execution alive even when tab is backgrounded
 * 3. Silent audio loop — prevents mobile browsers from suspending the tab
 */

let wakeLock: WakeLockSentinel | null = null;
let worker: Worker | null = null;
let audioCtx: AudioContext | null = null;
let silentSource: AudioBufferSourceNode | null = null;
let silentInterval: ReturnType<typeof setInterval> | null = null;
let onTick: (() => void) | null = null;

// ── Wake Lock API ──

async function requestWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await (navigator as Navigator & { wakeLock: { request: (type: string) => Promise<WakeLockSentinel> } }).wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    // Wake Lock not supported or denied — non-critical
  }
}

async function releaseWakeLock(): Promise<void> {
  if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
}

// ── Web Worker heartbeat ──

function startWorker(): void {
  const workerCode = `
    let interval = null;
    self.onmessage = function(e) {
      if (e.data === 'start') {
        interval = setInterval(() => self.postMessage('tick'), 1000);
      } else if (e.data === 'stop') {
        if (interval) clearInterval(interval);
        interval = null;
      }
    };
  `;
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  worker = new Worker(URL.createObjectURL(blob));
  worker.onmessage = () => {
    if (onTick) onTick();
  };
  worker.postMessage('start');
}

function stopWorker(): void {
  if (worker) {
    worker.postMessage('stop');
    worker.terminate();
    worker = null;
  }
}

// ── Silent audio (keeps mobile tabs alive) ──

function startSilentAudio(): void {
  try {
    audioCtx = new AudioContext();
    const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
    // Fill with silence
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = 0;

    function playSilence() {
      if (!audioCtx) return;
      silentSource = audioCtx.createBufferSource();
      silentSource.buffer = buffer;
      silentSource.connect(audioCtx.destination);
      silentSource.loop = true;
      silentSource.start();
    }

    playSilence();
  } catch {
    // AudioContext not available — non-critical
  }
}

function stopSilentAudio(): void {
  if (silentSource) {
    try { silentSource.stop(); } catch { /* already stopped */ }
    silentSource = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

// ── Visibility change handler ──
// Re-acquire Wake Lock when tab becomes visible again

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }
}

// ── Public API ──

export function startKeepAlive(tickCallback?: () => void): void {
  onTick = tickCallback || null;

  requestWakeLock();
  startWorker();
  startSilentAudio();

  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Fallback setInterval in case Worker gets throttled
  silentInterval = setInterval(() => {
    if (onTick) onTick();
  }, 5000);
}

export function stopKeepAlive(): void {
  releaseWakeLock();
  stopWorker();
  stopSilentAudio();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (silentInterval) {
    clearInterval(silentInterval);
    silentInterval = null;
  }
  onTick = null;
}

export function isKeepAliveActive(): boolean {
  return worker !== null || wakeLock !== null;
}
