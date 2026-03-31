import * as faceapi from 'face-api.js';

let modelsLoaded = false;

const MODEL_URL = '/models';
const MATCH_THRESHOLD = 0.45;
const ENROLLMENT_SAMPLES = 3;
/** Quantization bin size — coarser = more stable across sessions, less unique */
const QUANT_BIN = 0.05;

export interface FaceDescriptor {
  data: number[];
  capturedAt: number;
}

export interface FaceMap {
  canonical: number[];
  quantized: number[];
  hash: string;
  samples: number;
  createdAt: number;
}

// ──── Model Loading ────

export async function loadModels(): Promise<void> {
  if (modelsLoaded) return;
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  modelsLoaded = true;
}

export function areModelsLoaded(): boolean {
  return modelsLoaded;
}

// ──── Camera ────

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
  });
  video.srcObject = stream;
  await new Promise<void>((resolve) => {
    video.onloadedmetadata = () => { video.play(); resolve(); };
  });
  return stream;
}

export function stopCamera(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

// ──── Face Descriptor Capture ────

export async function captureFaceDescriptor(video: HTMLVideoElement): Promise<FaceDescriptor | null> {
  const detection = await faceapi
    .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 }))
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!detection) return null;

  return {
    data: Array.from(detection.descriptor),
    capturedAt: Date.now(),
  };
}

/**
 * Enroll a face: capture multiple samples, average into canonical descriptor,
 * then quantize for stable key derivation.
 */
export async function enrollFace(
  video: HTMLVideoElement,
  onProgress: (step: number, total: number, status: string) => void,
): Promise<FaceMap | null> {
  const descriptors: number[][] = [];
  let retries = 0;

  for (let i = 0; i < ENROLLMENT_SAMPLES; i++) {
    onProgress(i + 1, ENROLLMENT_SAMPLES, `Capturing sample ${i + 1} of ${ENROLLMENT_SAMPLES}...`);
    await sleep(800);

    const desc = await captureFaceDescriptor(video);
    if (!desc) {
      if (retries++ > 10) return null;
      onProgress(i + 1, ENROLLMENT_SAMPLES, 'No face detected. Look at the camera.');
      i--;
      await sleep(1000);
      continue;
    }
    descriptors.push(desc.data);
  }

  if (descriptors.length < ENROLLMENT_SAMPLES) return null;

  // Average descriptors
  const canonical = new Array(128).fill(0);
  for (const d of descriptors) {
    for (let i = 0; i < 128; i++) canonical[i] += d[i];
  }
  for (let i = 0; i < 128; i++) canonical[i] /= descriptors.length;

  const quantized = quantizeDescriptor(canonical);
  const hash = await hashDescriptor(quantized);

  return { canonical, quantized, hash, samples: descriptors.length, createdAt: Date.now() };
}

// ──── Liveness Detection (Movement) ────

/**
 * Liveness detection via face movement.
 *
 * Tracks the nose landmark across frames and confirms the user
 * moved their head (proving live person, not a static photo).
 * Much more reliable than blink/EAR detection.
 */
export async function detectLiveness(
  video: HTMLVideoElement,
  timeoutMs = 15000,
  onStatus?: (msg: string) => void,
): Promise<boolean> {
  const startTime = Date.now();
  let framesWithFace = 0;
  let framesWithoutFace = 0;
  const nosePositions: { x: number; y: number }[] = [];
  const MIN_MOVEMENT = 30; // pixels of nose travel required (higher = harder to spoof with photo)
  const MIN_DIRECTION_CHANGES = 2; // must reverse direction at least twice (rules out linear pan)

  onStatus?.('Face detected — slowly turn your head left and right...');

  while (Date.now() - startTime < timeoutMs) {
    const detection = await faceapi
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
      .withFaceLandmarks();

    if (detection) {
      framesWithFace++;
      const nose = detection.landmarks.positions[30];
      nosePositions.push({ x: nose.x, y: nose.y });
      if (nosePositions.length > 40) nosePositions.shift();

      if (nosePositions.length >= 5) {
        const xs = nosePositions.map((p) => p.x);
        const ys = nosePositions.map((p) => p.y);
        const totalRange = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));

        // Count direction changes in X axis (left-right reversals)
        let dirChanges = 0;
        for (let i = 2; i < nosePositions.length; i++) {
          const dx1 = nosePositions[i - 1].x - nosePositions[i - 2].x;
          const dx2 = nosePositions[i].x - nosePositions[i - 1].x;
          if ((dx1 > 1 && dx2 < -1) || (dx1 < -1 && dx2 > 1)) dirChanges++;
        }

        const movementPct = Math.min(50, Math.round((totalRange / MIN_MOVEMENT) * 50));
        const dirPct = Math.min(50, Math.round((dirChanges / MIN_DIRECTION_CHANGES) * 50));
        const progress = movementPct + dirPct;

        onStatus?.(`Liveness: ${progress}% — turn head left then right`);

        if (totalRange >= MIN_MOVEMENT && dirChanges >= MIN_DIRECTION_CHANGES) {
          onStatus?.('Liveness confirmed!');
          return true;
        }
      } else {
        onStatus?.(`Face detected (${framesWithFace}) — slowly move your head...`);
      }
    } else {
      framesWithoutFace++;
      if (framesWithoutFace % 8 === 0) {
        onStatus?.('No face detected — move closer, ensure good lighting.');
      }
    }
    await sleep(100);
  }

  onStatus?.(`Liveness failed (${framesWithFace} face frames). Try with better lighting.`);
  return false;
}

// ──── Quantization ────

/**
 * Quantize a 128-D descriptor into stable bins.
 * Each value is rounded to the nearest QUANT_BIN.
 * This ensures the same face produces the same quantized vector
 * across sessions (within tolerance).
 */
export function quantizeDescriptor(descriptor: number[]): number[] {
  return descriptor.map((v) => Math.round(v / QUANT_BIN) * QUANT_BIN);
}

// ──── Face-Derived Key ────

/**
 * Derive a stable AES encryption key from a quantized face descriptor.
 * Uses PBKDF2 with the quantized descriptor as the password
 * and a fixed salt derived from the descriptor itself.
 */
export async function deriveFaceKey(quantized: number[]): Promise<CryptoKey> {
  const descriptorStr = quantized.map((v) => v.toFixed(4)).join(',');
  const encoded = new TextEncoder().encode(descriptorStr);

  // Use first 16 bytes of SHA-256 of descriptor as salt (deterministic)
  const saltHash = await crypto.subtle.digest('SHA-256', encoded);
  const salt = new Uint8Array(saltHash).slice(0, 16);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoded, 'PBKDF2', false, ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt data with a face-derived AES-GCM key.
 */
export async function encryptWithFaceKey(data: string, faceKey: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    faceKey,
    encoded,
  );
  // Combine IV + ciphertext, encode as base64
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt data with a face-derived AES-GCM key.
 * Returns null if decryption fails (wrong face / corrupted data).
 */
export async function decryptWithFaceKey(encrypted: string, faceKey: CryptoKey): Promise<string | null> {
  try {
    const combined = new Uint8Array(atob(encrypted).split('').map((c) => c.charCodeAt(0)));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      faceKey,
      ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null; // Wrong face — decryption failed
  }
}

// ──── Comparison ────

export function compareFaces(a: number[], b: number[]): { distance: number; match: boolean } {
  let sum = 0;
  for (let i = 0; i < 128; i++) sum += (a[i] - b[i]) ** 2;
  const distance = Math.sqrt(sum);
  return { distance, match: distance < MATCH_THRESHOLD };
}

// ──── Hashing ────

export async function hashDescriptor(descriptor: number[]): Promise<string> {
  const str = descriptor.map((v) => v.toFixed(4)).join(',');
  const encoded = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ──── Helpers ────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { MATCH_THRESHOLD, ENROLLMENT_SAMPLES, QUANT_BIN };
