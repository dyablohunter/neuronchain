import { NeuronNode } from './network/node';
import { validateUsername, generateAccountKeys, buildAccount, AccountWithKeys, Account } from './core/account';
import { NetworkType } from './core/dag-ledger';
import { KeyPair, signData } from './core/crypto';
import { startKeepAlive, stopKeepAlive } from './core/keepalive';
import { formatUNIT, parseUNIT, VERIFICATION_MINT_AMOUNT, AccountBlock } from './core/dag-block';
import { loadModels, startCamera, stopCamera, enrollFace, detectLiveness, deriveFaceKey, deriveFaceRawBits, encryptWithFaceKey, quantizeDescriptor } from './core/face-verify';
import { createEncryptedKeyBlob, recoverKeysWithFace, EncryptedKeyBlob, updateAttemptStateInBlob, verifyKeyBlobHash, deriveCombinedKey } from './core/face-store';
import { acquireTabLock } from './core/tab-lock';
import {
  derivePinRawBits, encryptWithPinKey, decryptWithPinKey,
  checkPinLockout, recordPinFailure, recordPinSuccess,
  getBackoffMs, generatePinSalt, LockoutNotice, lockoutPayload,
} from './core/pin-crypto';

// ──── Single-tab lock ────
if (!acquireTabLock()) {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0e17;color:#e2e8f0;font-family:system-ui;text-align:center;padding:24px;">
      <div>
        <div style="font-size:48px;margin-bottom:16px;">&#128683;</div>
        <h2 style="margin-bottom:8px;">NeuronChain is already running in another tab</h2>
        <p style="color:#94a3b8;font-size:14px;">Only one node per browser is allowed to prevent account farming.<br>Close the other tab first, then refresh this page.</p>
      </div>
    </div>`;
  throw new Error('Tab locked - another NeuronChain tab is active');
}

// ──── State ────
const savedNetwork = (localStorage.getItem('neuronchain_network') || 'testnet') as NetworkType;
let node = new NeuronNode(savedNetwork);
let localAccounts: AccountWithKeys[] = [];
let cameraStream: MediaStream | null = null;
let isRecovering = false;
let pendingGenerationReset = false;

const WALLET_KEY = 'neuronchain_wallet';

// ──── PIN Session Cache ────
// Holds the derived CryptoKey and raw PBKDF2 bits per account for 5 minutes.
// rawBits are needed for combined-key face+PIN operations (face update, PIN change).
const PIN_CACHE_TTL_MS = 5 * 60 * 1000;
const pinSessionCache = new Map<string, { key: CryptoKey; rawBits?: Uint8Array; expiry: number }>();

function getCachedPinKey(accountPub: string): CryptoKey | null {
  const entry = pinSessionCache.get(accountPub);
  if (!entry || entry.expiry < Date.now()) { pinSessionCache.delete(accountPub); return null; }
  return entry.key;
}

function getCachedPinRawBits(accountPub: string): Uint8Array | null {
  const entry = pinSessionCache.get(accountPub);
  if (!entry || entry.expiry < Date.now()) { pinSessionCache.delete(accountPub); return null; }
  return entry.rawBits ?? null;
}

function cachePinKey(accountPub: string, key: CryptoKey, rawBits?: Uint8Array): void {
  pinSessionCache.set(accountPub, { key, rawBits, expiry: Date.now() + PIN_CACHE_TTL_MS });
}

function clearPinCache(accountPub?: string): void {
  if (accountPub) pinSessionCache.delete(accountPub);
  else pinSessionCache.clear();
}

// ──── PIN Dialog ────

/**
 * Show a modal PIN input dialog and resolve with the entered 4-digit PIN, or null if cancelled.
 *
 * When `validate` is provided the modal stays open on failure: it calls validate(pin),
 * and if the result is not 'ok' or 'cancel' it treats the result as an error message,
 * shakes the card, turns the dots red, and lets the user try again without reopening.
 * Return 'ok' to accept, 'cancel' to dismiss (resolve null), or any string for an error.
 */
function promptPin(
  title = 'Enter your PIN',
  subtitle = '',
  validate?: (pin: string) => Promise<'ok' | 'cancel' | string>,
): Promise<string | null> {
  return new Promise(resolve => {
    // Inject shake keyframes once into the document
    if (!document.getElementById('nc-pin-shake')) {
      const s = document.createElement('style');
      s.id = 'nc-pin-shake';
      s.textContent = '@keyframes ncPinShake{0%,100%{transform:translateX(0)}15%{transform:translateX(-8px)}30%{transform:translateX(8px)}45%{transform:translateX(-6px)}60%{transform:translateX(6px)}75%{transform:translateX(-4px)}90%{transform:translateX(4px)}}';
      document.head.appendChild(s);
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:36px 32px 28px;width:320px;text-align:center;box-shadow:0 24px 48px rgba(0,0,0,0.5);';

    // Lock icon
    const icon = document.createElement('div');
    icon.style.cssText = 'font-size:32px;margin-bottom:12px;line-height:1;';
    icon.textContent = '🔐';

    const titleEl = document.createElement('h3');
    titleEl.style.cssText = 'margin:0 0 6px;color:var(--text);font-size:17px;font-weight:700;letter-spacing:-0.01em;';
    titleEl.textContent = title;

    const subtitleEl = document.createElement('p');
    subtitleEl.style.cssText = 'margin:0 0 20px;color:var(--text-muted);font-size:13px;min-height:18px;line-height:1.4;';
    subtitleEl.innerHTML = subtitle;

    // PIN dot indicators
    const dotsRow = document.createElement('div');
    dotsRow.style.cssText = 'display:flex;justify-content:center;gap:14px;margin-bottom:16px;';
    const dots: HTMLElement[] = [];
    for (let i = 0; i < 4; i++) {
      const dot = document.createElement('div');
      dot.style.cssText = 'width:14px;height:14px;border-radius:50%;border:2px solid var(--border);background:transparent;transition:background 0.15s,border-color 0.15s;';
      dots.push(dot);
      dotsRow.appendChild(dot);
    }

    const input = document.createElement('input');
    input.type = 'password';
    input.inputMode = 'numeric';
    input.maxLength = 4;
    input.pattern = '[0-9]{4}';
    input.autocomplete = 'off';
    input.style.cssText = 'position:absolute;opacity:0;pointer-events:none;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;margin-top:24px;';

    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'flex:1;padding:10px 0;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text-dim);font-size:14px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;';
    btnCancel.onmouseenter = () => { btnCancel.style.background = 'var(--surface2)'; };
    btnCancel.onmouseleave = () => { btnCancel.style.background = 'transparent'; };

    const btnOk = document.createElement('button');
    btnOk.textContent = 'Confirm';
    btnOk.style.cssText = 'flex:1;padding:10px 0;border-radius:10px;border:none;background:var(--primary);color:#fff;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;';
    btnOk.onmouseenter = () => { btnOk.style.background = 'var(--primary-hover)'; };
    btnOk.onmouseleave = () => { btnOk.style.background = 'var(--primary)'; };

    // Clicking anywhere on the card focuses the hidden input
    card.addEventListener('click', () => input.focus());

    const updateDots = () => {
      const len = input.value.length;
      dots.forEach((dot, i) => {
        if (i < len) {
          dot.style.background = 'var(--primary)';
          dot.style.borderColor = 'var(--primary)';
        } else {
          dot.style.background = 'transparent';
          dot.style.borderColor = 'var(--border)';
        }
      });
    };

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnOk);
    card.appendChild(icon);
    card.appendChild(titleEl);
    card.appendChild(subtitleEl);
    card.appendChild(dotsRow);
    card.appendChild(input);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Focus hidden input; slight delay so overlay is mounted
    setTimeout(() => input.focus(), 50);

    const finish = (value: string | null) => {
      document.body.removeChild(overlay);
      resolve(value);
    };

    const showError = (message: string) => {
      subtitleEl.innerHTML = `<span style="color:var(--danger)">${message}</span>`;
      dots.forEach(d => {
        d.style.opacity = '';
        d.style.background = 'var(--danger)';
        d.style.borderColor = 'var(--danger)';
      });
      // Restart animation even if already playing (force reflow trick)
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = 'ncPinShake 0.45s ease';
      card.addEventListener('animationend', () => {
        card.style.animation = '';
        input.value = '';
        updateDots();
        btnOk.disabled = false;
        btnCancel.disabled = false;
        setTimeout(() => input.focus(), 50);
      }, { once: true });
    };

    let validating = false;

    const tryConfirm = async () => {
      if (validating) return;
      const pin = input.value.trim();
      if (!/^\d{4}$/.test(pin)) {
        showError('Enter exactly 4 digits');
        return;
      }
      if (!validate) { finish(pin); return; }
      validating = true;
      btnOk.disabled = true;
      btnCancel.disabled = true;
      // Show immediate visual feedback while async validation (PBKDF2) runs
      subtitleEl.innerHTML = '<span style="color:var(--text-muted)"><span class="spinner"></span> Verifying…</span>';
      dots.forEach(d => { d.style.opacity = '0.45'; });
      const result = await validate(pin);
      if (result === 'ok') { finish(pin); return; }
      if (result === 'cancel') { finish(null); return; }
      validating = false;
      showError(result);
    };

    btnOk.addEventListener('click', tryConfirm);
    btnCancel.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryConfirm();
      if (e.key === 'Escape') finish(null);
    });
    input.addEventListener('input', () => {
      // Strip non-digits
      input.value = input.value.replace(/\D/g, '').slice(0, 4);
      updateDots();
      if (input.value.length === 4) setTimeout(tryConfirm, 80);
    });
  });
}

/**
 * Require PIN confirmation for a sensitive action.
 *
 * Checks lockout state, returns true if the user is authorised to proceed.
 * Returns false if the user cancels, is locked out, or fails the PIN check.
 * Legacy accounts (no PIN configured) return true immediately.
 *
 * The derived PIN key is cached in pinSessionCache for 5 minutes.
 */
async function requirePin(account: AccountWithKeys): Promise<boolean> {
  const acc = account as AccountWithKeys & { pinSalt?: string; pinVerifier?: string };
  const { pub } = acc;
  let pinSalt = acc.pinSalt;
  let pinVerifier = acc.pinVerifier;

  // If missing from the in-memory account (wallet created before PIN propagation was
  // fixed, or loaded without these fields), try to fetch them from the key blob in IDB.
  if (!pinSalt || !pinVerifier) {
    const blobData = await node.net.loadKeyBlob(pub)
      || await node.net.findKeyBlobByUsername(acc.username);
    if (blobData) {
      pinSalt = blobData.pinSalt ? String(blobData.pinSalt) : undefined;
      pinVerifier = blobData.pinVerifier ? String(blobData.pinVerifier) : undefined;
      if (pinSalt && pinVerifier) {
        // Patch the live account object and persist so this lookup only happens once
        Object.assign(acc, { pinSalt, pinVerifier });
        saveWallet();
      }
    }
  }

  // No PIN configured on this account - allow without PIN
  if (!pinSalt || !pinVerifier) return true;

  // Check session cache - PIN already verified recently
  if (getCachedPinKey(pub)) return true;

  // Check lockout
  const lockout = await checkPinLockout(pub);
  if (lockout.locked) {
    const remaining = Math.ceil(lockout.remainingMs / 1000);
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const msg = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    toast(`PIN locked - try again in ${msg}`, 'error');
    return false;
  }

  const saltBytes = Uint8Array.from(atob(pinSalt), c => c.charCodeAt(0));
  const storedVerifier = pinVerifier;

  const pin = await promptPin('Enter your PIN', '', async (enteredPin) => {
    // derivePinRawBits + importKey = one PBKDF2 call; produces identical key to derivePinKey
    const rawBits = await derivePinRawBits(enteredPin, saltBytes);
    const pinKey = await crypto.subtle.importKey('raw', rawBits as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    // Verify against stored verifier (fast - no full blob decryption needed)
    const result = await decryptWithPinKey(storedVerifier, pinKey);
    if (result === 'PINOK') {
      await recordPinSuccess(pub);
      cachePinKey(pub, pinKey, rawBits);
      return 'ok';
    }

    // Wrong PIN
    const state = await recordPinFailure(pub);
    const backoffMs = getBackoffMs(state.failedAttempts);

    // Publish decentralised lockout notice when backoff kicks in
    if (backoffMs > 0 && node.net.running) {
      const notice: LockoutNotice = {
        accountPub: pub,
        failedAttempts: state.failedAttempts,
        lockedUntil: state.lockedUntil,
        timestamp: Date.now(),
      };
      const keys = node.localKeys.get(pub);
      if (keys) notice.signature = await signData(lockoutPayload(notice), keys);
      node.net.publishLockout(notice);
    }

    if (state.lockedUntil > Date.now()) {
      const remaining = Math.ceil((state.lockedUntil - Date.now()) / 1000);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      toast(`Wrong PIN - locked for ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}`, 'error');
      return 'cancel';
    }

    return `Wrong PIN (attempt ${state.failedAttempts}) - try again`;
  });

  return pin !== null;
}

/** Prompt user to set a new 4-digit PIN, confirming entry twice. Returns the PIN string or null. */
async function promptSetPin(): Promise<string | null> {
  while (true) {
    const pin1 = await promptPin('Set a 4-digit PIN', 'This PIN will be required for sensitive actions');
    if (pin1 === null) return null;
    const pin2 = await promptPin('Confirm your PIN', 'Enter the same PIN again to confirm');
    if (pin2 === null) return null;
    if (pin1 === pin2) return pin1;
    toast('PINs do not match - try again', 'error');
  }
}

// ──── DOM Helpers ────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement>(sel: string) => document.querySelectorAll<T>(sel);

function toast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString();
const trunc = (s: string, n = 16) => s.length <= n ? s : s.slice(0, n) + '...';

// ──── Compact backup key encoding (Base58) ────
// Keys are stored as base64(JWK JSON). Each P-256 JWK private key contains
// three 32-byte fields: d (private scalar), x and y (public point).
// We pack all 6 × 32 = 192 bytes and Base58-encode them → ~263 chars.
// Public keys (pub, epub) are re-derived via Web Crypto on import.
// PQ keys are recoverable from the face+PIN blob independently.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let result = '';
  while (num > 0n) { result = BASE58_ALPHABET[Number(num % 58n)] + result; num /= 58n; }
  for (const b of bytes) { if (b !== 0) break; result = '1' + result; }
  return result;
}

function base58Decode(str: string): Uint8Array {
  let num = BigInt(0);
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid Base58 character');
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  for (const ch of str) { if (ch !== '1') break; bytes.unshift(0); }
  return new Uint8Array(bytes);
}

// base64url ↔ standard base64 helpers
const b64urlToB64 = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=');
const b64ToB64url = (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

function encodeBackupKey(keys: KeyPair): string {
  const pJwk = JSON.parse(atob(keys.priv))  as { d: string; x: string; y: string };
  const eJwk = JSON.parse(atob(keys.epriv)) as { d: string; x: string; y: string };
  const dec = (s: string) => Uint8Array.from(atob(b64urlToB64(s)), c => c.charCodeAt(0));
  const combined = new Uint8Array(192);
  let off = 0;
  for (const chunk of [pJwk.d, pJwk.x, pJwk.y, eJwk.d, eJwk.x, eJwk.y]) {
    combined.set(dec(chunk), off); off += 32;
  }
  return base58Encode(combined);
}

async function decodeBackupKey(code: string): Promise<Pick<KeyPair, 'pub' | 'priv' | 'epub' | 'epriv'> | null> {
  try {
    const bytes = base58Decode(code.trim());
    if (bytes.length !== 192) return null;
    const enc = (b: Uint8Array) => b64ToB64url(btoa(String.fromCharCode(...b)));
    const [d1, x1, y1, d2, x2, y2] = [0, 32, 64, 96, 128, 160].map((o) => enc(bytes.slice(o, o + 32)));

    const privJwk  = { crv: 'P-256', d: d1, ext: true, key_ops: ['sign'],   kty: 'EC', x: x1, y: y1 };
    const eprivJwk = { crv: 'P-256', d: d2, ext: true, key_ops: ['deriveKey'], kty: 'EC', x: x2, y: y2 };

    // Re-derive canonical public keys via Web Crypto (ensures pub matches on-chain format)
    const sigKey  = await crypto.subtle.importKey('jwk', privJwk,  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const encKey  = await crypto.subtle.importKey('jwk', eprivJwk, { name: 'ECDH',  namedCurve: 'P-256' }, true, ['deriveKey']);
    // exportKey for private key returns JWK with x,y,d - strip d to get public JWK
    const sigJwk  = await crypto.subtle.exportKey('jwk', sigKey)  as Record<string, unknown>;
    const encJwk  = await crypto.subtle.exportKey('jwk', encKey)  as Record<string, unknown>;
    const toPub   = (jwk: Record<string, unknown>, ops: string[]) => { const { d: _, ...pub } = jwk; return btoa(JSON.stringify({ ...pub, key_ops: ops })); };

    return {
      priv:  btoa(JSON.stringify({ ...sigJwk,  key_ops: ['sign'] })),
      epub:  toPub(encJwk, []),
      epriv: btoa(JSON.stringify({ ...encJwk,  key_ops: ['deriveKey'] })),
      pub:   toPub(sigJwk, ['verify']),
    };
  } catch { return null; }
}

/** Escape HTML to prevent XSS when inserting user-supplied data into innerHTML */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const cpBtn = (text: string) => `<button class="btn-copy" onclick="navigator.clipboard.writeText('${escHtml(text)}')" title="Copy">&#x2398;</button>`;
const copyBtn = (text: string, display?: string) => `${cpBtn(text)}<span class="hash truncate">${escHtml(display || trunc(text, 14))}</span>`;

const logBuffer: { html: string; level: string }[] = [];
let unreadLogCount = 0;

function makeLogEntry(msg: string, level: string): HTMLElement {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerHTML = `<span class="time">[${fmtTime(Date.now())}]</span><span class="msg">${escHtml(msg)}</span>`;
  return entry;
}

function addLog(msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
  const entry = makeLogEntry(msg, level);
  const html = entry.outerHTML;

  // Keep buffer bounded
  logBuffer.push({ html, level });
  if (logBuffer.length > 500) logBuffer.shift();

  // Write to Node-tab console (may not exist yet during early init)
  const log = document.querySelector('#nodeLog');
  if (log) { log.appendChild(entry.cloneNode(true)); log.scrollTop = log.scrollHeight; }

  // Write to mobile panel if open, otherwise increment badge
  const panel = document.getElementById('mobileLogPanel');
  const scroller = document.getElementById('mobileLogScroller');
  if (panel?.classList.contains('open') && scroller) {
    scroller.appendChild(entry);
    scroller.scrollTop = scroller.scrollHeight;
  } else {
    unreadLogCount++;
    const badge = document.getElementById('logFabBadge');
    if (badge) {
      badge.textContent = unreadLogCount > 99 ? '99+' : String(unreadLogCount);
      badge.style.display = 'flex';
    }
  }
}

// Intercept all console.* calls so every module's logs appear in the custom console.
// Originals are preserved so browser devtools still work normally.
{
  const _log   = console.log.bind(console);
  const _info  = console.info.bind(console);
  const _warn  = console.warn.bind(console);
  const _error = console.error.bind(console);

  const fmt = (args: unknown[]) => args.map(a =>
    typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
  ).join(' ');

  console.log   = (...a: unknown[]) => { _log(...a);   addLog(fmt(a), 'info'); };
  console.info  = (...a: unknown[]) => { _info(...a);  addLog(fmt(a), 'info'); };
  console.warn  = (...a: unknown[]) => { _warn(...a);  addLog(fmt(a), 'warn'); };
  console.error = (...a: unknown[]) => { _error(...a); addLog(fmt(a), 'error'); };
}

// Wire up log FAB and panel after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const fab = document.getElementById('logFab');
  const panel = document.getElementById('mobileLogPanel');
  const scroller = document.getElementById('mobileLogScroller');
  const closeBtn = document.getElementById('mobileLogClose');
  const copyBtn = document.getElementById('mobileLogCopy');
  const clearBtn = document.getElementById('mobileLogClear');
  const badge = document.getElementById('logFabBadge');
  if (!fab || !panel || !scroller || !closeBtn || !copyBtn || !clearBtn || !badge) return;

  const openPanel = () => {
    // Populate from buffer (replace scroller contents)
    scroller.innerHTML = logBuffer.map(e => e.html).join('');
    panel.classList.add('open');
    scroller.scrollTop = scroller.scrollHeight;
    // Reset badge
    unreadLogCount = 0;
    badge.style.display = 'none';
  };

  const closePanel = () => panel.classList.remove('open');

  fab.addEventListener('click', () => {
    if (panel.classList.contains('open')) closePanel(); else openPanel();
  });
  closeBtn.addEventListener('click', closePanel);

  clearBtn.addEventListener('click', () => {
    logBuffer.length = 0;
    scroller.innerHTML = '';
    unreadLogCount = 0;
    badge.style.display = 'none';
    // Also clear the Node-tab console
    const nodeLog = document.querySelector('#nodeLog');
    if (nodeLog) nodeLog.innerHTML = '';
  });

  copyBtn.addEventListener('click', async () => {
    const text = logBuffer.map(e => {
      const tmp = document.createElement('div');
      tmp.innerHTML = e.html;
      return tmp.textContent ?? '';
    }).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const orig = copyBtn.innerHTML;
      copyBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="var(--success)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,8 6,12 14,4"/></svg>';
      setTimeout(() => { copyBtn.innerHTML = orig; }, 1200);
    } catch { /* clipboard denied */ }
  });

  // P6: start loading face models as soon as the user begins typing a username,
  // so models are ready by the time they click Create Account.
  const newUsernameInput = document.getElementById('newUsername');
  if (newUsernameInput) {
    newUsernameInput.addEventListener('input', () => { loadModels().catch(() => {}); }, { once: true });
  }
});

function resolveNamePlain(pub: string): string {
  if (!pub) return '-';
  for (const a of localAccounts) if (a.pub === pub) return a.username;
  for (const [, acc] of node.ledger.accounts) if (acc.pub === pub) return acc.username;
  return trunc(pub);
}

function resolveName(pub: string): string {
  if (!pub) return '-';
  const name = resolveNamePlain(pub);
  return `<a class="account-link" style="cursor:pointer;color:var(--primary);text-decoration:underline;" data-pub="${escHtml(pub)}">${escHtml(name)}</a>`;
}

function showAccountDetail(pub: string) {
  const detail = $('#explorerDetail');
  const acc = node.ledger.getAccountByPub ? node.ledger.getAccountByPub(pub) : undefined;
  const username = acc?.username ?? trunc(pub);
  const balance = node.ledger.getAccountBalance(pub);
  const chain = node.ledger.getAccountChain(pub);
  const provider = node.ledger.storageProviders.get(pub);

  // Token balances
  const tokenRows: string[] = [];
  for (const [contractId, contract] of node.ledger.contracts) {
    const state = contract.state as Record<string, unknown>;
    if (state.balances && typeof state.balances === 'object' && state.symbol) {
      const balances = state.balances as Record<string, number>;
      const bal = (balances[pub] ?? 0) + (username ? (balances[username] ?? 0) : 0);
      if (bal <= 0) continue;
      tokenRows.push(`<tr><td><a class="explorer-contract-link" style="cursor:pointer;color:var(--primary);text-decoration:underline;" data-contract-id="${escHtml(contractId)}">${escHtml(contract.name)}</a></td><td>${escHtml(String(state.symbol))}</td><td>${bal.toLocaleString()}</td></tr>`);
    }
  }

  // NFTs owned
  const nftRows: string[] = [];
  for (const [contractId, contract] of node.ledger.contracts) {
    const state = contract.state as Record<string, unknown>;
    if (!state.tokens || typeof state.tokens !== 'object') continue;
    const tokens = state.tokens as Record<string, { owner: string; metadata?: unknown; cid?: string }>;
    for (const [tokenId, token] of Object.entries(tokens)) {
      if (token.owner !== pub) continue;
      const meta = typeof token.metadata === 'string' ? token.metadata : JSON.stringify(token.metadata ?? '');
      nftRows.push(`<tr><td>#${escHtml(tokenId)}</td><td><a class="explorer-contract-link" style="cursor:pointer;color:var(--primary);text-decoration:underline;" data-contract-id="${escHtml(contractId)}">${escHtml(contract.name)}</a></td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(meta)}">${escHtml(meta)}</td><td>${token.cid ? escHtml(trunc(token.cid, 16)) : '-'}</td></tr>`);
    }
  }

  // Contracts deployed
  const contractRows: string[] = [];
  for (const [contractId, contract] of node.ledger.contracts) {
    if (contract.owner !== pub) continue;
    contractRows.push(`<tr><td><a class="explorer-contract-link" style="cursor:pointer;color:var(--primary);text-decoration:underline;" data-contract-id="${escHtml(contractId)}">${escHtml(contract.name)}</a></td><td><span class="hash truncate">${escHtml(trunc(contractId, 16))}</span></td><td>${fmtTime(contract.deployedAt)}</td></tr>`);
  }

  // Storage
  const storageHtml = provider ? `
    <div class="card" style="margin-top:0;">
      <div class="card-title">Storage Provider</div>
      <div class="stats-grid">
        <div class="stat-item"><div class="stat-label">Capacity</div><div class="stat-value">${provider.capacityGB} GB</div></div>
        <div class="stat-item"><div class="stat-label">Score</div><div class="stat-value">${provider.score.toFixed(2)}</div></div>
        <div class="stat-item"><div class="stat-label">Uptime</div><div class="stat-value">${(provider.heartbeatsLast24h / 6 * 100).toFixed(0)}%</div></div>
        <div class="stat-item"><div class="stat-label">Rate</div><div class="stat-value">${formatUNIT(provider.earningRate)} UNIT/day</div></div>
        <div class="stat-item"><div class="stat-label">Total Earned</div><div class="stat-value">${formatUNIT(provider.totalEarned)} UNIT</div></div>
        <div class="stat-item"><div class="stat-label">Avg Latency</div><div class="stat-value">${provider.avgLatencyMs > 0 ? provider.avgLatencyMs + ' ms' : '-'}</div></div>
      </div>
    </div>` : '';

  // Block history
  const blockRows = chain.map(b => {
    const status = node.ledger.getBlockStatus(b.hash);
    const statusColor = status === 'confirmed' ? 'var(--success)' : status === 'rejected' ? 'var(--danger)' : 'var(--warning)';
    const typeClass = b.type === 'send' ? 'badge-transfer' : b.type === 'receive' ? 'badge-create' : b.type === 'deploy' ? 'badge-deploy' : 'badge-call';
    let detail2 = '-';
    if (b.type === 'send') detail2 = `→ ${resolveName(b.recipient || '')} ${formatUNIT(b.amount || 0)} UNIT`;
    else if (b.type === 'receive') detail2 = `← ${resolveName(b.sendFrom || '')} +${formatUNIT(b.receiveAmount || 0)} UNIT`;
    else if (b.type === 'open') detail2 = `+${formatUNIT(VERIFICATION_MINT_AMOUNT)} UNIT (genesis)`;
    else if (b.type === 'deploy' && b.contractData) { try { const d = JSON.parse(b.contractData) as { name?: string }; detail2 = escHtml(d.name || 'contract'); } catch { /**/ } }
    else if (b.type === 'call' && b.contractData) { try { const d = JSON.parse(b.contractData) as { contractId: string; method: string }; const c = node.ledger.contracts.get(d.contractId); detail2 = `${escHtml(c?.name ?? trunc(d.contractId))}.${escHtml(d.method)}()`; } catch { /**/ } }
    else if (b.type === 'storage-reward' && b.contractData) { try { const d = JSON.parse(b.contractData) as { amount: number }; detail2 = `+${formatUNIT(d.amount)} UNIT`; } catch { /**/ } }
    else if (b.type === 'storage-register' && b.contractData) { try { const d = JSON.parse(b.contractData) as { capacityGB: number }; detail2 = `${d.capacityGB} GB`; } catch { /**/ } }
    return `<tr>
      <td>${copyBtn(b.hash)}</td>
      <td><span class="badge ${typeClass}">${b.type}</span></td>
      <td>${fmtTime(b.timestamp)}</td>
      <td>${detail2}</td>
      <td style="color:${statusColor}">${status}</td>
    </tr>`;
  }).join('');

  detail.innerHTML = `
    <div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>${escHtml(username)}</span>
        <span style="font-size:12px;color:var(--text-muted);">${escHtml(trunc(pub, 24))}</span>
      </div>
      <div class="stats-grid" style="margin-bottom:0;">
        <div class="stat-item"><div class="stat-label">Public Key</div><div class="stat-value small">${cpBtn(pub)}${escHtml(trunc(pub, 24))}</div></div>
        <div class="stat-item"><div class="stat-label">UNIT Balance</div><div class="stat-value">${formatUNIT(balance)} UNIT</div></div>
        <div class="stat-item"><div class="stat-label">Blocks</div><div class="stat-value">${chain.length}</div></div>
        ${acc ? `<div class="stat-item"><div class="stat-label">Generation</div><div class="stat-value">${(acc as unknown as Record<string, unknown>).generation ?? 0}</div></div>` : ''}
      </div>
    </div>

    ${tokenRows.length > 0 ? `<div class="card" style="margin-top:0;">
      <div class="card-title">Token Balances</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Contract</th><th>Symbol</th><th>Balance</th></tr></thead>
        <tbody>${tokenRows.join('')}</tbody>
      </table></div>
    </div>` : ''}

    ${nftRows.length > 0 ? `<div class="card" style="margin-top:0;">
      <div class="card-title">NFTs Owned</div>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Collection</th><th>Metadata</th><th>CID</th></tr></thead>
        <tbody>${nftRows.join('')}</tbody>
      </table></div>
    </div>` : ''}

    ${contractRows.length > 0 ? `<div class="card" style="margin-top:0;">
      <div class="card-title">Contracts Deployed</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>ID</th><th>Deployed</th></tr></thead>
        <tbody>${contractRows.join('')}</tbody>
      </table></div>
    </div>` : ''}

    ${storageHtml}

    <div class="card" style="margin-top:0;">
      <div class="card-title">Block History (${chain.length})</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Hash</th><th>Type</th><th>Time</th><th>Detail</th><th>Status</th></tr></thead>
        <tbody>${blockRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No blocks.</td></tr>'}</tbody>
      </table></div>
    </div>`;

  // Switch to explorer tab and scroll to detail
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  $('#tab-explorer').classList.add('active');
  document.querySelector('.tab-btn[data-tab="explorer"]')?.classList.add('active');
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ──── Wallet (localStorage - encrypted with session key) ────
const SESSION_KEY_NAME = 'neuronchain_session_key';

async function getOrCreateSessionKey(): Promise<CryptoKey> {
  // Use localStorage so the key survives page reloads (including location.reload()).
  // sessionStorage is cleared by mobile browsers (especially iOS Safari) on reload,
  // which broke wallet decryption and silently wiped all accounts after any reload.
  const fromLocal = localStorage.getItem(SESSION_KEY_NAME);
  if (fromLocal) {
    const raw = Uint8Array.from(atob(fromLocal), c => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  }
  // Migrate from sessionStorage if still available (same browser session, first upgrade)
  const fromSession = sessionStorage.getItem(SESSION_KEY_NAME);
  if (fromSession) {
    localStorage.setItem(SESSION_KEY_NAME, fromSession);
    sessionStorage.removeItem(SESSION_KEY_NAME);
    const raw = Uint8Array.from(atob(fromSession), c => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const exported = await crypto.subtle.exportKey('raw', key);
  localStorage.setItem(SESSION_KEY_NAME, btoa(String.fromCharCode(...new Uint8Array(exported))));
  return key;
}

async function saveWallet() {
  const data = JSON.stringify(
    localAccounts.map((a) => {
      const acc = a as AccountWithKeys & { pinSalt?: string; pinVerifier?: string; linkedAnchor?: string; pqPub?: string; pqKemPub?: string; encryptedFaceDescriptor?: string };
      return {
        username: a.username, pub: a.pub, keys: a.keys, createdAt: a.createdAt, faceMapHash: a.faceMapHash,
        pinSalt: acc.pinSalt, pinVerifier: acc.pinVerifier, linkedAnchor: acc.linkedAnchor,
        pqPub: acc.pqPub, pqKemPub: acc.pqKemPub, encryptedFaceDescriptor: acc.encryptedFaceDescriptor,
      };
    })
  );
  try {
    const key = await getOrCreateSessionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(data);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    localStorage.setItem(WALLET_KEY, btoa(String.fromCharCode(...combined)));
  } catch {
    // Fallback: store as-is if Web Crypto unavailable (shouldn't happen)
    localStorage.setItem(WALLET_KEY, data);
  }
}

async function loadWallet() {
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    if (!raw) return;
    let parsed: string;
    try {
      // Try decrypting with session key
      const key = await getOrCreateSessionKey();
      const combined = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      parsed = new TextDecoder().decode(decrypted);
    } catch {
      // Fallback: try parsing as plain JSON (migration from unencrypted format)
      parsed = raw;
    }
    localAccounts = (JSON.parse(parsed) as { username: string; pub: string; keys: KeyPair; createdAt: number; faceMapHash: string; pinSalt?: string; pinVerifier?: string; linkedAnchor?: string; pqPub?: string; pqKemPub?: string; encryptedFaceDescriptor?: string }[])
      .map((d) => Object.assign({ username: d.username, pub: d.pub, keys: d.keys, balance: 0, nonce: 0, createdAt: d.createdAt, faceMapHash: d.faceMapHash || '' }, {
        pinSalt: d.pinSalt, pinVerifier: d.pinVerifier, linkedAnchor: d.linkedAnchor,
        pqPub: d.pqPub, pqKemPub: d.pqKemPub, encryptedFaceDescriptor: d.encryptedFaceDescriptor,
      }));
  } catch { /* corrupt */ }
}

function registerLocalKeys() {
  for (const acc of localAccounts) {
    node.addLocalKey(acc.pub, acc.keys);
    const a = acc as AccountWithKeys & { pinSalt?: string; pinVerifier?: string; linkedAnchor?: string; pqPub?: string; pqKemPub?: string; encryptedFaceDescriptor?: string };
    node.ledger.registerAccount(buildAccount(acc.username, acc.pub, acc.faceMapHash, {
      pinSalt: a.pinSalt, pinVerifier: a.pinVerifier, linkedAnchor: a.linkedAnchor,
      pqPub: a.pqPub, pqKemPub: a.pqKemPub, encryptedFaceDescriptor: a.encryptedFaceDescriptor,
    }));
  }
}

function showCameraModal() {
  $('#cameraModal').classList.add('active');
  $('#cameraOverlay').textContent = '';
  $('#cameraStatus').innerHTML = '<span class="spinner"></span> Initializing...';
}

function hideCameraModal() {
  $('#cameraModal').classList.remove('active');
  if (cameraStream) { stopCamera(cameraStream); cameraStream = null; }
  $('#cameraOverlay').textContent = '';
  $('#cameraStatus').textContent = '';
}

function setCameraStatus(html: string) {
  $('#cameraStatus').innerHTML = html;
}

// Close modal via X button
$('#cameraModalClose').addEventListener('click', () => {
  hideCameraModal();
  restoreCreateBtn();
  $('#createStatus').innerHTML = '<span style="color:var(--text-muted)">Cancelled.</span>';
  $('#btnRecoverFace').removeAttribute('disabled');
});

// ──── Tabs ────
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if ((btn as HTMLButtonElement).disabled) return;
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const tabId = btn.getAttribute('data-tab')!;
    $(`#tab-${tabId}`).classList.add('active');
    localStorage.setItem('neuronchain_tab', tabId);
    if (['explorer', 'account', 'transfer', 'contracts'].includes(tabId)) {
      node.requestResync();
    }
    refreshTab();
  });
});

function setNodeDependentTabs(enabled: boolean) {
  const tabs = ['transfer', 'contracts', 'storage'];
  tabs.forEach((t) => {
    const btn = document.querySelector(`.tab-btn[data-tab="${t}"]`) as HTMLButtonElement;
    if (btn) btn.disabled = !enabled;
  });
}

function activeTab(): string {
  return document.querySelector('.tab-btn.active')?.getAttribute('data-tab') || 'node';
}

function refreshTab() {
  switch (activeTab()) {
    case 'chain': refreshChain(); break;
    case 'node': refreshNode(); break;
    case 'account': refreshAccount(); break;
    case 'transfer': refreshTransfer(); break;
    case 'explorer': refreshExplorer(); break;
    case 'contracts': refreshContracts(); break;
    case 'storage': refreshStorage(); break;
  }
}

// ──── Tab renders ────

function refreshChain() {
  const s = node.ledger.getStats();
  const ns = node.getStats();
  const chainBytes = node.ledger.estimateBlockchainSizeBytes();
  const chainSize = chainBytes >= 1_073_741_824
    ? `${(chainBytes / 1_073_741_824).toFixed(2)} GB`
    : `${(chainBytes / 1_048_576).toFixed(2)} MB`;
  $('#chainStats').innerHTML = `
    <div class="stat-item"><div class="stat-label">Network</div><div class="stat-value">${s.network}</div></div>
    <div class="stat-item"><div class="stat-label">Peers</div><div class="stat-value">${ns.peerCount}</div></div>
    <div class="stat-item"><div class="stat-label">Chain Size</div><div class="stat-value">${chainSize}</div></div>
    <div class="stat-item"><div class="stat-label">Accounts</div><div class="stat-value">${s.totalAccounts}</div></div>
    <div class="stat-item"><div class="stat-label">Total Blocks</div><div class="stat-value">${s.totalBlocks}</div></div>
    <div class="stat-item"><div class="stat-label">Confirmed</div><div class="stat-value">${s.confirmedBlocks}</div></div>
    <div class="stat-item"><div class="stat-label">Pending</div><div class="stat-value">${s.pendingBlocks}</div></div>
    <div class="stat-item"><div class="stat-label">TPS</div><div class="stat-value">${s.tps}</div></div>
    <div class="stat-item"><div class="stat-label">Currency</div><div class="stat-value small">UNIT</div></div>
    <div class="stat-item"><div class="stat-label">Type</div><div class="stat-value small">Block-Lattice DAG</div></div>
  `;

  const blocks = node.ledger.getAllBlocks().slice(0, 15);
  $('#recentBlocks').innerHTML = blocks.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No blocks yet</td></tr>'
    : blocks.map((b) => {
        const status = node.ledger.getBlockStatus(b.hash);
        const statusColor = status === 'confirmed' ? 'var(--success)' : status === 'rejected' ? 'var(--danger)' : status === 'conflict' ? 'var(--danger)' : 'var(--warning)';
        return `<tr>
          <td>${copyBtn(b.hash)}</td>
          <td><span class="badge badge-${b.type === 'send' ? 'transfer' : b.type === 'receive' ? 'create' : b.type === 'deploy' ? 'deploy' : b.type === 'call' ? 'call' : 'verify'}">${b.type}</span></td>
          <td>${resolveName(b.accountPub)}</td>
          <td>${
            b.type === 'send' ? '-' + formatUNIT(b.amount || 0) :
            b.type === 'receive' ? '+' + formatUNIT(b.receiveAmount || 0) :
            b.type === 'open' ? '+' + formatUNIT(VERIFICATION_MINT_AMOUNT) :
            b.type === 'storage-register' && b.contractData ? (() => { try { return (JSON.parse(b.contractData) as { capacityGB: number }).capacityGB + ' GB'; } catch { return '-'; } })() :
            b.type === 'storage-deregister' && b.contractData ? (() => { try { return `-${(JSON.parse(b.contractData) as { capacityGB: number }).capacityGB} GB`; } catch { return '0 GB'; } })() :
            '-'
          }</td>
          <td style="color:${statusColor}">${status}</td>
        </tr>`;
      }).join('');
}

function refreshNode() {
  const s = node.getStats();
  const uptime = s.uptime > 0 ? `${Math.floor(s.uptime / 1000)}s` : '-';
  $('#nodeStats').innerHTML = `
    <div class="stat-item"><div class="stat-label">Status</div><div class="stat-value small" style="color:${s.status === 'stopped' ? 'var(--danger)' : s.status === 'validating' ? 'var(--success)' : 'var(--accent)'}">${s.status.toUpperCase()}</div></div>
    <div class="stat-item"><div class="stat-label">Uptime</div><div class="stat-value">${uptime}</div></div>
    <div class="stat-item"><div class="stat-label">Synapses</div><div class="stat-value">${s.synapses}</div></div>
    <div class="stat-item"><div class="stat-label">Peer ID</div><div class="stat-value small">${trunc(s.peerId, 16)}</div></div>
    <div class="stat-item"><div class="stat-label">Network</div><div class="stat-value small">${s.network}</div></div>
  `;
  refreshRelays();
}

function refreshRelays() {
  const relays = node.getKnownRelays();
  const connected = new Set(
    (node.net.libp2p?.getConnections?.() ?? []).map((c: { remotePeer: { toString(): string } }) => c.remotePeer.toString())
  );
  const sel = document.getElementById('relayAccountSelect') as HTMLSelectElement | null;
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = localAccounts.length === 0
      ? '<option value="">No accounts</option>'
      : localAccounts.map(a => `<option value="${escHtml(a.pub)}">${escHtml(a.username)}</option>`).join('');
    if (prev) sel.value = prev;
  }
  const list = document.getElementById('knownRelaysList');
  if (!list) return;
  if (relays.length === 0) {
    list.innerHTML = '<p style="font-size:12px;color:var(--text-dim);margin:0;">No community relays known yet.</p>';
    return;
  }
  list.innerHTML = `<table style="width:100%;font-size:12px;border-collapse:collapse;">
    <thead><tr style="color:var(--text-dim);text-align:left;">
      <th style="padding:4px 8px;">Status</th>
      <th style="padding:4px 8px;">Address</th>
      <th style="padding:4px 8px;">Last seen</th>
      <th style="padding:4px 8px;">Failures</th>
      <th style="padding:4px 8px;"></th>
    </tr></thead>
    <tbody>${relays.map(r => {
      const live = connected.has(r.peerId);
      const ago = Math.floor((Date.now() - r.lastSeen) / 1000);
      const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.floor(ago / 60)}m ago` : `${Math.floor(ago / 3600)}h ago`;
      return `<tr>
        <td style="padding:4px 8px;"><span style="color:${live ? 'var(--success)' : 'var(--danger)'}">&#9679;</span> ${live ? 'Live' : 'Offline'}</td>
        <td style="padding:4px 8px;font-family:monospace;color:var(--text-dim);" title="${escHtml(r.addr)}">${escHtml(trunc(r.addr, 40))}</td>
        <td style="padding:4px 8px;">${agoStr}</td>
        <td style="padding:4px 8px;">${r.failCount}</td>
        <td style="padding:4px 8px;"><button class="btn btn-outline" style="padding:2px 8px;font-size:11px;" data-remove-relay="${escHtml(r.addr)}">Remove</button></td>
      </tr>`;
    }).join('')}</tbody></table>`;
  list.querySelectorAll('[data-remove-relay]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const addr = btn.getAttribute('data-remove-relay')!;
      await node.net.markRelayFailed(addr);
      await node.net.markRelayFailed(addr);
      await node.net.markRelayFailed(addr);
      refreshRelays();
    });
  });
}

function refreshAccount() {
  const tbody = $('#myAccounts');
  tbody.innerHTML = localAccounts.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:var(--text-muted)">No accounts yet. Create one with FaceID above.</td></tr>'
    : localAccounts.map((acc) => {
        const bal = node.ledger.getAccountBalance(acc.pub);
        return `<tr>
          <td>${escHtml(acc.username)}</td>
          <td><span class="hash truncate">${escHtml(trunc(acc.pub, 20))}</span></td>
          <td>${formatUNIT(bal)} UNIT</td>
          <td>
            <button class="btn btn-outline" onclick="navigator.clipboard.writeText('${escHtml(acc.username)}')">Copy</button>
            <button class="btn btn-delete-account" data-pub="${escHtml(acc.pub)}" style="background:var(--danger);color:#fff;margin-left:6px;">Delete</button>
          </td>
        </tr>`;
      }).join('');

  tbody.querySelectorAll('.btn-delete-account').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pub = btn.getAttribute('data-pub')!;
      const acc = localAccounts.find((a) => a.pub === pub);
      if (!acc) return;
      if (!confirm(`Delete account "${acc.username}"? This removes it from your local wallet. You can recover it later with FaceID or key pair.`)) return;
      localAccounts = localAccounts.filter((a) => a.pub !== pub);
      node.localKeys.delete(pub);
      clearPinCache(pub);
      saveWallet();
      refreshAccount();
      refreshTransfer();
      refreshContracts();
      toast(`Account "${acc.username}" removed`, 'info');
    });
  });

  // Show/populate the Update PIN/Face card if any local account has a PIN set
  const secCard = $('#updateSecurityCard');
  const pinAccounts = localAccounts.filter(a => (a as AccountWithKeys & { pinSalt?: string }).pinSalt);
  if (pinAccounts.length > 0) {
    secCard.style.display = '';
    const sel = $<HTMLSelectElement>('#updateSecurityAccount');
    sel.innerHTML = pinAccounts.map(a => `<option value="${escHtml(a.pub)}">${escHtml(a.username)}</option>`).join('');
  } else {
    secCard.style.display = 'none';
  }
}

function refreshTransfer() {
  const select = $<HTMLSelectElement>('#txFrom');
  const currentValue = select.value;
  const newOptions = localAccounts.map((a) =>
    `<option value="${escHtml(a.pub)}">${escHtml(a.username)} (${formatUNIT(node.ledger.getAccountBalance(a.pub))} UNIT)</option>`
  ).join('');
  if (select.innerHTML !== newOptions) {
    select.innerHTML = newOptions;
    if (currentValue && localAccounts.some((a) => a.pub === currentValue)) {
      select.value = currentValue;
    }
  }

  refreshTxAssets();

  // Auto-claim any unclaimed receives
  autoClaimPending();

  const el = $('#unclaimedReceives');
  el.innerHTML = '';
}

function refreshTxAssets() {
  const fromPub = $<HTMLSelectElement>('#txFrom').value;
  const fromUsername = localAccounts.find(a => a.pub === fromPub)?.username ?? '';
  const assetSelect = $<HTMLSelectElement>('#txAsset');
  const prevAsset = assetSelect.value;

  const options: string[] = [
    `<option value="__unit__">UNIT - ${formatUNIT(node.ledger.getAccountBalance(fromPub))} available</option>`,
  ];

  for (const [contractId, contract] of node.ledger.contracts) {
    const state = contract.state as Record<string, unknown>;
    if (state.balances && typeof state.balances === 'object' && state.symbol) {
      const balances = state.balances as Record<string, number>;
      // Check by pub key (correct) or username (legacy - pre-fix transfers)
      const bal = (balances[fromPub] ?? 0) + (fromUsername ? (balances[fromUsername] ?? 0) : 0);
      if (bal <= 0) continue;
      const sym = escHtml(String(state.symbol));
      options.push(`<option value="${escHtml(contractId)}">${escHtml(contract.name)} (${sym}) - ${bal.toLocaleString()} available</option>`);
    }
  }

  assetSelect.innerHTML = options.join('');
  if (prevAsset && Array.from(assetSelect.options).some(o => o.value === prevAsset)) {
    assetSelect.value = prevAsset;
  }

  // Update amount label/placeholder
  const isUnit = assetSelect.value === '__unit__';
  ($('#txAmountLabel') as HTMLElement).textContent = isUnit ? 'Amount (UNIT)' : 'Amount (tokens)';
  $<HTMLInputElement>('#txAmount').placeholder = isUnit ? '0.001' : '1';

  // NFT table
  refreshNFTTransferList();
}

function refreshNFTTransferList() {
  const localPubs = new Set(localAccounts.map(a => a.pub));
  const rows: string[] = [];

  for (const [contractId, contract] of node.ledger.contracts) {
    const state = contract.state as Record<string, unknown>;
    if (!state.tokens || typeof state.tokens !== 'object') continue;
    const tokens = state.tokens as Record<string, { owner: string; metadata?: unknown; cid?: string }>;
    for (const [tokenId, token] of Object.entries(tokens)) {
      if (!localPubs.has(token.owner)) continue;
      const ownerAcc = localAccounts.find(a => a.pub === token.owner)!;
      const meta = typeof token.metadata === 'string' ? token.metadata : JSON.stringify(token.metadata ?? '');
      const cidStr = token.cid ? escHtml(token.cid) : '-';
      rows.push(`<tr>
        <td>#${escHtml(tokenId)}</td>
        <td title="${escHtml(contractId)}">${escHtml(contract.name)}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(meta)}">${escHtml(meta)}</td>
        <td><span class="hash truncate" title="${cidStr}">${cidStr !== '-' ? trunc(cidStr, 16) : '-'}</span></td>
        <td>${escHtml(ownerAcc.username)}</td>
        <td><button class="btn btn-outline btn-nft-xfer"
          data-contract="${escHtml(contractId)}"
          data-token="${escHtml(tokenId)}"
          data-from="${escHtml(ownerAcc.pub)}">Transfer</button></td>
      </tr>`);
    }
  }

  const card = $('#nftTransferCard') as HTMLElement;
  const tbody = $('#nftTransferList');
  if (rows.length > 0) {
    tbody.innerHTML = rows.join('');
    card.style.display = '';
    tbody.querySelectorAll('.btn-nft-xfer').forEach(btn => {
      btn.addEventListener('click', async () => {
        const contractId = btn.getAttribute('data-contract')!;
        const tokenId = parseInt(btn.getAttribute('data-token')!, 10);
        const fromPub = btn.getAttribute('data-from')!;
        const acc = localAccounts.find(a => a.pub === fromPub);
        if (!acc) return;
        const to = prompt(`Transfer NFT #${tokenId} - enter recipient username or public key:`);
        if (!to) return;
        const toPub = node.ledger.resolveToPublicKey(to) ?? to;
        const result = await node.ledger.createCall(fromPub, contractId, 'transfer', [tokenId, toPub], acc.keys);
        if (!result.block) { toast(`Error: ${result.error}`, 'error'); return; }
        const submit = await node.submitBlock(result.block);
        if (submit.success) { toast(`NFT #${tokenId} transferred`, 'success'); refreshTransfer(); }
        else { toast(`Error: ${submit.error}`, 'error'); }
      });
    });
  } else {
    card.style.display = 'none';
  }
}

let autoClaimRunning = false;
async function autoClaimPending(): Promise<void> {
  if (autoClaimRunning) return;
  autoClaimRunning = true;
  try {
    for (const acc of localAccounts) {
      const unclaimed = node.ledger.getUnclaimedForAccount(acc.pub);
      for (const u of unclaimed) {
        const result = await node.ledger.createReceive(acc.pub, u.sendBlockHash, acc.keys);
        if (result.block) {
          await node.submitBlock(result.block);
          addLog(`Auto-claimed ${formatUNIT(result.block.receiveAmount || 0)} UNIT from ${resolveNamePlain(u.fromPub)}`, 'success');
        }
      }
    }
  } finally {
    autoClaimRunning = false;
  }
}

const EXPLORER_PAGE_SIZE = 20;
let explorerDisplayCount = EXPLORER_PAGE_SIZE;
let nodeStartedAt = 0;
let lastKnownBlockCount = 0;
let blockCountStableSince = 0;

function renderExplorerRow(b: AccountBlock): string {
  const status = node.ledger.getBlockStatus(b.hash);
  const statusColor = status === 'confirmed' ? 'var(--success)' : status === 'rejected' ? 'var(--danger)' : status === 'conflict' ? 'var(--danger)' : 'var(--warning)';
  const typeClass = b.type === 'send' ? 'badge-transfer' : b.type === 'receive' ? 'badge-create' : b.type === 'deploy' ? 'badge-deploy' : 'badge-call';

  let counterparty = '-';
  let name = '-';
  let amount = '-';

  if (b.type === 'send') {
    counterparty = resolveName(b.recipient || '');
    amount = formatUNIT(b.amount || 0);
  } else if (b.type === 'receive') {
    counterparty = resolveName(b.sendFrom || '');
    amount = formatUNIT(b.receiveAmount || 0);
  } else if (b.type === 'open') {
    amount = formatUNIT(VERIFICATION_MINT_AMOUNT);
  } else if (b.type === 'deploy' && b.contractData) {
    try {
      const d = JSON.parse(b.contractData) as { name?: string };
      const cname = escHtml(d.name || 'Unnamed');
      name = `<a class="explorer-contract-link" style="cursor:pointer;color:var(--primary);text-decoration:underline;" data-contract-id="${escHtml(b.hash)}">${cname}</a>`;
    } catch { /* skip */ }
  } else if (b.type === 'call' && b.contractData) {
    try {
      const d = JSON.parse(b.contractData) as { contractId: string; method: string; args: unknown[] };
      const contract = node.ledger.contracts.get(d.contractId);
      counterparty = `<a class="hash truncate explorer-contract-link" style="cursor:pointer;color:var(--primary);text-decoration:underline;" title="${escHtml(d.contractId)}" data-contract-id="${escHtml(d.contractId)}">${escHtml(trunc(d.contractId, 14))}</a>`;
      name = contract ? `${escHtml(contract.name)}.${escHtml(d.method)}()` : escHtml(d.method + '()');
      // For transfer calls show amount from args: transfer(to, amount) or transfer(tokenId, to)
      if (d.method === 'transfer' && Array.isArray(d.args)) {
        const hasSymbol = contract && (contract.state as Record<string, unknown>).symbol;
        if (hasSymbol) {
          // Token: transfer(to, amount)
          const sym = String((contract!.state as Record<string, unknown>).symbol ?? '');
          amount = `${d.args[1]} ${escHtml(sym)}`;
        } else if (contract && (contract.state as Record<string, unknown>).tokens) {
          // NFT: transfer(tokenId, to)
          amount = `NFT #${d.args[0]}`;
        }
      } else if (d.method === 'mint' && Array.isArray(d.args)) {
        amount = `NFT mint`;
      } else if (d.method === 'init') {
        amount = `init`;
      }
    } catch { /* skip */ }
  } else if (b.type === 'storage-reward' && b.contractData) {
    try {
      const d = JSON.parse(b.contractData) as { amount: number };
      amount = formatUNIT(d.amount);
      name = 'storage reward';
    } catch { /* skip */ }
  } else if (b.type === 'storage-register' && b.contractData) {
    try {
      const d = JSON.parse(b.contractData) as { capacityGB: number };
      amount = `${d.capacityGB} GB`;
    } catch { /* skip */ }
  } else if (b.type === 'storage-deregister' && b.contractData) {
    try { amount = `-${(JSON.parse(b.contractData) as { capacityGB: number }).capacityGB} GB`; } catch { amount = '0 GB'; }
  }

  return `<tr>
    <td>${copyBtn(b.hash)}</td>
    <td><span class="badge ${typeClass}">${b.type}</span></td>
    <td>${cpBtn(b.accountPub)}${resolveName(b.accountPub)}</td>
    <td>${counterparty}</td>
    <td>${name}</td>
    <td>${amount}</td>
    <td style="color:${statusColor}">${status}</td>
  </tr>`;
}

function refreshExplorer() {
  const allBlocks = node.ledger.getAllBlocks();
  const blocks = allBlocks.slice(0, explorerDisplayCount);
  const tbody = $('#explorerTxs');
  const loadMoreEl = $('#explorerLoadMore');
  const syncEl = $('#explorerSyncStatus');

  // Sync status indicator
  const stats = node.ledger.getStats();
  const nodeStats = node.getStats();
  const isRunning = nodeStats.status !== 'stopped';
  const confirmed = stats.confirmedBlocks;
  const total = stats.totalBlocks;
  const accounts = stats.totalAccounts;
  const pending = total - confirmed;

  // Track when block count stabilizes (no new blocks for 10s = synced)
  if (total !== lastKnownBlockCount) {
    lastKnownBlockCount = total;
    blockCountStableSince = Date.now();
  }
  const stableFor = Date.now() - blockCountStableSince;
  const recentlyStarted = Date.now() - nodeStartedAt < 15000;
  const isSyncing = recentlyStarted || stableFor < 10000;

  if (!isRunning) {
    syncEl.innerHTML = '<span style="color:var(--danger)">Node offline - start node to sync</span>';
  } else if (total === 0 && isSyncing) {
    syncEl.innerHTML = '<span class="spinner"></span> Connecting to relay and syncing...';
  } else if (isSyncing) {
    syncEl.innerHTML = `<span class="spinner"></span> Syncing - ${total} blocks &middot; ${accounts} accounts &middot; ${pending > 0 ? pending + ' pending' : 'confirming...'}`;
  } else {
    syncEl.innerHTML = `<span style="color:var(--success)">&#10003;</span> Synced - ${total} blocks &middot; ${accounts} accounts &middot; ${nodeStats.synapses} synapses`;
  }

  if (blocks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No blocks yet.</td></tr>';
    loadMoreEl.style.display = 'none';
    return;
  }

  tbody.innerHTML = blocks.map(renderExplorerRow).join('');

  if (allBlocks.length > explorerDisplayCount) {
    loadMoreEl.style.display = 'block';
    loadMoreEl.textContent = `Load more (${explorerDisplayCount} of ${allBlocks.length})`;
  } else {
    loadMoreEl.style.display = 'none';
  }
}

function refreshContracts() {
  const contractAcctHtml = localAccounts.map((a) => `<option value="${escHtml(a.username)}">${escHtml(a.username)}</option>`).join('');
  ['#contractFrom', '#callFrom'].forEach((sel) => {
    const el = $<HTMLSelectElement>(sel);
    if (el.innerHTML !== contractAcctHtml) {
      const prev = el.value;
      el.innerHTML = contractAcctHtml;
      if (prev && Array.from(el.options).some(o => o.value === prev)) el.value = prev;
    }
  });
  const tbody = $('#contractsList');
  const contracts = Array.from(node.ledger.contracts.entries());
  tbody.innerHTML = contracts.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No contracts yet.</td></tr>'
    : contracts.map(([id, c]) => `<tr>
        <td><span class="hash truncate">${escHtml(trunc(id, 14))}</span></td><td>${escHtml(c.name)}</td><td>${resolveName(c.owner)}</td>
        <td>${fmtTime(c.deployedAt)}</td><td><button class="btn btn-outline" onclick="document.getElementById('callContractId').value='${escHtml(id)}'">Call</button></td>
      </tr>`).join('');
}

// ──── Network ────
$('#btnTestnet').addEventListener('click', () => switchNet('testnet'));
$('#btnMainnet').addEventListener('click', () => switchNet('mainnet'));
async function switchNet(network: NetworkType) {
  await node.switchNetwork(network);
  $('#networkBadge').textContent = network.toUpperCase();
  $('#networkBadge').className = `network-badge ${network}`;
  $('#btnTestnet').className = `btn ${network === 'testnet' ? 'btn-primary' : 'btn-outline'}`;
  $('#btnMainnet').className = `btn ${network === 'mainnet' ? 'btn-primary' : 'btn-outline'}`;
  localStorage.setItem('neuronchain_network', network);
  toast(`Switched to ${network}`, 'info');
  refreshTab();
}

// ──── Reset ────
$('#btnResetChain').addEventListener('click', () => {
  if (node.ledger.network !== 'testnet') { toast('Reset only on testnet', 'error'); return; }
  $('#resetDialog').classList.add('active');
});
$('#btnResetCancel').addEventListener('click', () => $('#resetDialog').classList.remove('active'));
$('#btnResetConfirm').addEventListener('click', async () => {
  $('#resetDialog').classList.remove('active');
  await node.net.clearAll();
  node.ledger.reset();
  localAccounts = [];
  node.localKeys.clear();
  localStorage.removeItem(WALLET_KEY);
  localStorage.removeItem('neuronchain_tab');
  localStorage.removeItem('neuronchain_facemaps');
  // Reload page to fully clear in-memory state
  toast('Testnet reset - reloading...', 'success');
  setTimeout(() => location.reload(), 500);
});

// ──── Node Control ────
$('#btnStartNode').addEventListener('click', async () => {
  const btn = $('#btnStartNode');
  const origText = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Starting...';
  btn.setAttribute('disabled', '');

  await node.start();
  registerLocalKeys();
  for (const acc of localAccounts) {
    if (!node.ledger.getAccountHead(acc.pub)) {
      const block = await node.ledger.openAccount(acc.pub, acc.faceMapHash, acc.keys);
      await node.submitBlock(block);
    }
  }
  // Publish all local data to the network (accounts + blocks created before node started)
  node.publishLocalData();

  btn.innerHTML = origText;
  $('#btnStopNode').removeAttribute('disabled');
  $('#statusDot').classList.add('active');
  setNodeDependentTabs(true);
  startKeepAlive(() => refreshTab());
  wireNodeEvents();
  startRefreshInterval();
  nodeStartedAt = Date.now();
  lastKnownBlockCount = 0;
  blockCountStableSince = 0;
  addLog('Node started', 'success');
  toast('Node started', 'success');
  refreshTab();
});

$('#btnStopNode').addEventListener('click', async () => {
  const btn = $('#btnStopNode');
  const origText = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Stopping...';
  btn.setAttribute('disabled', '');

  await node.stop();

  btn.innerHTML = origText;
  $('#btnStartNode').removeAttribute('disabled');
  $('#statusDot').classList.remove('active');
  setNodeDependentTabs(false);
  stopKeepAlive();
  stopRefreshInterval();
  unwireNodeEvents();
  addLog('Node stopped', 'warn');
  refreshNode();
});

$('#btnAnnounceRelay').addEventListener('click', async () => {
  const btn = $('#btnAnnounceRelay') as HTMLButtonElement;
  const addrInput = $('#relayAddrInput') as HTMLInputElement;
  const sel = $('#relayAccountSelect') as HTMLSelectElement;
  const addr = addrInput.value.trim();
  const pub = sel.value;
  if (!addr) { toast('Enter a relay multiaddr', 'error'); return; }
  if (!addr.includes('/p2p/')) { toast('Address must include /p2p/<peerId> suffix', 'error'); return; }
  if (!pub) { toast('Select an account to sign with', 'error'); return; }
  const acc = localAccounts.find(a => a.pub === pub);
  if (!acc) { toast('Account not found', 'error'); return; }
  if (node.getStats().status === 'stopped') { toast('Start the node first', 'error'); return; }
  const origText = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span>';
  btn.setAttribute('disabled', '');
  try {
    await node.announceRelay(addr, acc.keys);
    addrInput.value = '';
    toast('Relay announced to the network', 'success');
    refreshRelays();
  } catch (e: unknown) {
    toast((e as Error).message || 'Failed to announce relay', 'error');
  } finally {
    btn.innerHTML = origText;
    btn.removeAttribute('disabled');
  }
});

node.net.on('relays:updated', () => { if (document.getElementById('tab-node')?.classList.contains('active')) refreshRelays(); });


// ══════════════════════════════════════════════════════════
// ──── Account Creation (FaceID mandatory) ────
// ══════════════════════════════════════════════════════════

$('#btnCreateAccount').addEventListener('click', async () => {
  const username = $<HTMLInputElement>('#newUsername').value.trim().toLowerCase();
  const v = validateUsername(username);
  if (!v.valid) { toast(v.error!, 'error'); return; }
  if (node.ledger.getAccountByUsername(username)) { toast('Username taken', 'error'); return; }
  if (localAccounts.find((a) => a.username === username)) { toast('Username taken', 'error'); return; }

  const statusEl = $('#createStatus');
  const overlay = $('#cameraOverlay');
  const video = $<HTMLVideoElement>('#faceVideo');

  $('#btnCreateAccount').setAttribute('disabled', '');
    showCameraModal();

  try {
    setCameraStatus('<span class="spinner"></span> Loading face recognition models...');
    await loadModels();

    setCameraStatus('<span class="spinner"></span> Starting camera...');
    cameraStream = await startCamera(video);

    // Step 1: Liveness
    setCameraStatus('<span class="spinner"></span> Step 1/2: Slowly turn your head left and right');
    const isLive = await detectLiveness(video, 15000, (msg: string) => {
      overlay.textContent = msg;
    });
    if (!isLive) {
      addLog('FaceID: Liveness FAILED - not enough movement detected', 'error');
      toast('Liveness failed - try moving your head more', 'error');
      statusEl.innerHTML = '<span style="color:var(--danger)">Liveness failed. Try again with more head movement.</span>';
      hideCameraModal(); restoreCreateBtn(); return;
    }
    // Step 2: Face enrollment
    setCameraStatus('<span class="spinner"></span> Step 2/2: Hold still - capturing face map');
    const faceMap = await enrollFace(video, (step, total, status) => {
      overlay.textContent = `[${step}/${total}] ${status}`;
      setCameraStatus(`<span class="spinner"></span> Step 2/2: Sample ${step}/${total}`);
    });
    hideCameraModal();

    if (!faceMap) {
      addLog('FaceID: Face enrollment FAILED - could not capture enough samples', 'error');
      toast('Face enrollment failed', 'error');
      statusEl.innerHTML = '<span style="color:var(--danger)">Face enrollment failed. Try again with better lighting.</span>';
      restoreCreateBtn(); return;
    }

    // Step 3: PIN setup
    statusEl.innerHTML = '<span style="color:var(--accent)">Face enrolled. Now set your account PIN...</span>';
    const pin = await promptSetPin();
    if (!pin) {
      statusEl.innerHTML = '<span style="color:var(--danger)">PIN setup cancelled. Account not created.</span>';
      restoreCreateBtn(); return;
    }

    statusEl.innerHTML = '<span style="color:var(--accent)"><span class="spinner"></span> Generating keys and encrypting with face + PIN...</span>';

    // Generate ECDSA + PQ key pair
    const keys = await generateAccountKeys();

    const keyBlob = await createEncryptedKeyBlob(keys, username, faceMap.canonical, faceMap.hash, pin);

    // Encrypt face descriptor with PIN key for local privacy
    const pinSalt = keyBlob.pinSalt!;
    const saltBytes = Uint8Array.from(atob(pinSalt), c => c.charCodeAt(0));
    const pinRawBits = await derivePinRawBits(pin, saltBytes);
    const pinKey = await crypto.subtle.importKey('raw', pinRawBits as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const encryptedFaceDescriptor = await encryptWithPinKey(JSON.stringify(faceMap.canonical), pinKey);

    // Register account
    statusEl.innerHTML = '<span style="color:var(--accent)"><span class="spinner"></span> Creating account on-chain...</span>';
    const account = buildAccount(username, keys.pub, faceMap.hash, {
      encryptedFaceDescriptor,
      pinSalt,
      pinVerifier: keyBlob.pinVerifier,
      linkedAnchor: keyBlob.linkedAnchor,
      pqPub: keys.pqPub,
      pqKemPub: keys.pqKemPub,
    });
    node.ledger.registerAccount(account);

    // Create open block (mints 1M UNIT)
    const openBlock = await node.ledger.openAccount(keys.pub, faceMap.hash, keys);

    // Submit through node (publishes to libp2p network, triggers auto-vote)
    await node.submitBlock(openBlock);
    const accPayload = `account:${keys.pub}:${username}:${account.createdAt}:${faceMap.hash}`;
    const accSig = await signData(accPayload, keys);
    node.net.saveAccount(keys.pub, {
      username, pub: keys.pub, balance: 1000000, nonce: 0,
      createdAt: account.createdAt, faceMapHash: faceMap.hash,
      encryptedFaceDescriptor, pinSalt, pinVerifier: keyBlob.pinVerifier,
      linkedAnchor: keyBlob.linkedAnchor, pqPub: keys.pqPub, pqKemPub: keys.pqKemPub,
      _sig: accSig,
    });
    await node.net.saveKeyBlob(keys.pub, keyBlob as unknown as Record<string, unknown>);

    // Cache PIN for this session (rawBits needed for combined-key face update later)
    cachePinKey(keys.pub, pinKey, pinRawBits);

    // Store locally
    const fullAcc: AccountWithKeys = { ...account, keys, balance: 1000000 };
    localAccounts.push(fullAcc);
    node.addLocalKey(keys.pub, keys);
    saveWallet();

    const backupCode = encodeBackupKey(keys);
    statusEl.innerHTML = `<div style="margin-top:12px;">
      <span style="color:var(--success);font-weight:600;">Account created! +${formatUNIT(VERIFICATION_MINT_AMOUNT)} UNIT minted.</span><br>
      <div class="stat-item" style="margin-top:8px;"><div class="stat-label">Username</div><div class="stat-value small" style="user-select:all;">${escHtml(username)}</div></div>
      <div class="stat-item" style="margin-top:4px;"><div class="stat-label">Public Key</div><input readonly class="form-input" style="font-size:11px;font-family:monospace;user-select:all;" value="${escHtml(keys.pub)}" onclick="this.select()"/></div>
      <div class="stat-item" style="margin-top:4px;"><div class="stat-label">Face Map Hash</div><input readonly class="form-input" style="font-size:11px;font-family:monospace;user-select:all;" value="${escHtml(faceMap.hash)}" onclick="this.select()"/></div>
      <div class="secret-box" style="margin-top:12px;">
        <div class="warn-text">&#9888; BACKUP KEY - save this secret key as a secondary recovery method.</div>
        <input readonly class="form-input secret-value" style="font-size:12px;font-family:monospace;user-select:all;letter-spacing:1px;" value="${escHtml(backupCode)}" onclick="this.select()"/>
        <p style="color:var(--text-muted);font-size:11px;margin-top:6px;">Contains your two private keys encoded as Base58. Import via "Recover with Key Pair" on any device.</p>
      </div>
      <p style="font-size:12px;margin-top:10px;line-height:1.7;">Primary recovery: <span style="display:inline-flex;align-items:center;gap:4px;background:rgba(99,102,241,0.15);color:var(--primary-hover);border:1px solid rgba(99,102,241,0.3);border-radius:6px;padding:1px 8px;font-size:11px;font-weight:600;">&#x1F4F7; Face</span> + <span style="display:inline-flex;align-items:center;gap:4px;background:rgba(34,211,238,0.12);color:var(--accent);border:1px solid rgba(34,211,238,0.3);border-radius:6px;padding:1px 8px;font-size:11px;font-weight:600;">&#x1F511; PIN</span> on any device.</p>
      <p style="font-size:12px;margin-top:4px;line-height:1.7;">Backup: <span style="display:inline-flex;align-items:center;gap:4px;background:rgba(16,185,129,0.12);color:var(--success);border:1px solid rgba(16,185,129,0.3);border-radius:6px;padding:1px 8px;font-size:11px;font-weight:600;">&#x1F4CB; Secret Key</span> - paste in the recovery field.</p>
    </div>`;

    toast(`${username} created - ${formatUNIT(VERIFICATION_MINT_AMOUNT)} UNIT`, 'success');
    addLog(`Account created: ${username} (+1M UNIT, face-locked)`, 'success');
    refreshAccount(); refreshTransfer(); refreshContracts();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLog(`Account creation failed: ${msg}`, 'error');
    statusEl.innerHTML = `<span style="color:var(--danger)">${msg}</span>`;
    toast(`Error: ${msg}`, 'error');
    hideCameraModal();
  }
  restoreCreateBtn();
});

function restoreCreateBtn() {
  $('#btnCreateAccount').removeAttribute('disabled');
  $('#btnCancelCreate').style.display = 'none';
}

$('#btnCancelCreate').addEventListener('click', () => {
  hideCameraModal();
  $('#createStatus').innerHTML = '';
  restoreCreateBtn();
});

// ══════════════════════════════════════════════════════════
// ──── Account Recovery by Face ────
// ══════════════════════════════════════════════════════════

function finishRecovery(): void {
  isRecovering = false;
  if (pendingGenerationReset) {
    pendingGenerationReset = false;
    toast('Network reset received - reloading...', 'info');
    setTimeout(() => location.reload(), 800);
  }
}

$('#btnRecoverFace').addEventListener('click', async () => {
  const username = $<HTMLInputElement>('#recoverUsername').value.trim().toLowerCase();
  if (!username) { toast('Enter your username', 'error'); return; }

  const statusEl = $('#recoverStatus');
  const video = $<HTMLVideoElement>('#faceVideo');

  isRecovering = true;
  $('#btnRecoverFace').setAttribute('disabled', '');
  showCameraModal();

  try {
    setCameraStatus('<span class="spinner"></span> Loading models...');
    await loadModels();

    // Fetch encrypted key blob from libp2p network / IndexedDB
    setCameraStatus('<span class="spinner"></span> Fetching encrypted keys from chain...');
    const blobData = await node.net.findKeyBlobByUsername(username);
    if (!blobData) {
      toast('No key blob found for this username on the chain', 'error');
      hideCameraModal();
      statusEl.innerHTML = '<span style="color:var(--danger)">Account not found on chain. Start node first.</span>';
      finishRecovery(); $('#btnRecoverFace').removeAttribute('disabled');
      return;
    }
    const blob: EncryptedKeyBlob = {
      encryptedKeys: String(blobData.encryptedKeys),
      faceMapHash: String(blobData.faceMapHash),
      username: String(blobData.username),
      pub: String(blobData.pub),
      createdAt: Number(blobData.createdAt),
      linkedAnchor: blobData.linkedAnchor ? String(blobData.linkedAnchor) : undefined,
      pinSalt: blobData.pinSalt ? String(blobData.pinSalt) : undefined,
      pinVersion: typeof blobData.pinVersion === 'number' ? blobData.pinVersion : 0,
      pinAttemptState: blobData.pinAttemptState ? String(blobData.pinAttemptState) : undefined,
      pinVerifier: blobData.pinVerifier ? String(blobData.pinVerifier) : undefined,
      encryptedCanonical: blobData.encryptedCanonical ? String(blobData.encryptedCanonical) : undefined,
    };

    // Verify linked anchor against on-chain account data (prevents relay from serving fake blobs)
    const onChainAccount = await node.net.loadAccount(blob.pub);
    if (onChainAccount && onChainAccount.linkedAnchor && blob.linkedAnchor) {
      const hashValid = await verifyKeyBlobHash(blob, String(onChainAccount.linkedAnchor));
      if (!hashValid) {
        toast('Key blob integrity check failed - blob may be tampered', 'error');
        hideCameraModal();
        statusEl.innerHTML = '<span style="color:var(--danger)">Key blob integrity check failed. The relay may have served a tampered blob.</span>';
        finishRecovery(); $('#btnRecoverFace').removeAttribute('disabled');
        return;
      }
    }

    // If PIN-protected, ask for PIN before camera (needed for decryption)
    let pin: string | undefined;
    if (blob.pinVersion && blob.pinVersion >= 1) {
      hideCameraModal();
      const enteredPin = await promptPin('Enter your account PIN', 'Required to recover your keys');
      if (!enteredPin) {
        statusEl.innerHTML = '<span style="color:var(--danger)">PIN entry cancelled.</span>';
        finishRecovery(); $('#btnRecoverFace').removeAttribute('disabled');
        return;
      }
      pin = enteredPin;
      showCameraModal();
    }

    setCameraStatus('<span class="spinner"></span> Starting camera...');
    cameraStream = await startCamera(video);

    // Use the same multi-sample enrollment as account creation so the quantized
    // descriptor matches exactly (single-frame capture can differ enough to break
    // the derived AES key).
    const faceMap = await enrollFace(video, (step, total, status) => {
      setCameraStatus(`<span class="spinner"></span> ${status} (${step}/${total})`);
    });
    hideCameraModal();

    if (!faceMap) { toast('No face detected', 'error'); statusEl.innerHTML = '<span style="color:var(--danger)">No face detected. Try again with better lighting.</span>'; finishRecovery(); $('#btnRecoverFace').removeAttribute('disabled'); return; }

    statusEl.innerHTML = '<span style="color:var(--accent)"><span class="spinner"></span> Decrypting keys with face + PIN...</span>';

    const recoveryResult = await recoverKeysWithFace(blob, faceMap.canonical, pin);

    if (!recoveryResult) {
      const msg = (blob.pinVersion && blob.pinVersion >= 1)
        ? 'Face or PIN did not match. Decryption failed.'
        : 'Face did not match. Decryption failed. Try again with better lighting.';
      if (blob.pinVersion && blob.pinVersion >= 1 && pin) {
        const state = await recordPinFailure(blob.pub);
        const backoffMs = getBackoffMs(state.failedAttempts);
        if (backoffMs > 0 && node.net.running) {
          const notice: LockoutNotice = { accountPub: blob.pub, failedAttempts: state.failedAttempts, lockedUntil: state.lockedUntil, timestamp: Date.now() };
          const keys = node.localKeys.get(blob.pub);
          if (keys) notice.signature = await signData(lockoutPayload(notice), keys);
          node.net.publishLockout(notice);
        }
        // Update attempt state in blob and re-save
        if (recoveryResult === null) { /* face key unknown, skip blob update */ }
      }
      statusEl.innerHTML = `<span style="color:var(--danger)">${msg}</span>`;
      toast('Recovery failed', 'error');
      finishRecovery(); $('#btnRecoverFace').removeAttribute('disabled');
      return;
    }

    const { keys, faceKey } = recoveryResult;

    // Reset attempt counter on successful recovery
    await recordPinSuccess(blob.pub);
    const updatedBlob = await updateAttemptStateInBlob(blob, faceKey, { failedAttempts: 0, lockedUntil: 0 });
    await node.net.saveKeyBlob(keys.pub, updatedBlob as unknown as Record<string, unknown>);

    // Cache PIN key + raw bits for this session (raw bits needed for combined-key face update)
    if (pin && blob.pinSalt) {
      const saltBytes = Uint8Array.from(atob(blob.pinSalt), c => c.charCodeAt(0));
      const pinRawBits = await derivePinRawBits(pin, saltBytes);
      const pinKey = await crypto.subtle.importKey('raw', pinRawBits as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      cachePinKey(keys.pub, pinKey, pinRawBits);
    }

    // Recovery successful!
    const account = buildAccount(username, keys.pub, blob.faceMapHash, {
      pinSalt: blob.pinSalt,
      pinVerifier: blob.pinVerifier,
      linkedAnchor: blob.linkedAnchor,
    });
    node.ledger.registerAccount(account);
    const fullAcc: AccountWithKeys = { ...account, keys, balance: 0 };
    if (!localAccounts.find((a) => a.pub === keys.pub)) {
      localAccounts.push(fullAcc);
      node.addLocalKey(keys.pub, keys);
      saveWallet();
    }

    statusEl.innerHTML = `<div style="margin-top:8px;"><span style="color:var(--success);font-weight:600;">Account recovered: ${username}</span></div>`;
    toast(`Recovered: ${username}`, 'success');
    addLog(`Account recovered via face + PIN: ${username}`, 'success');
    refreshAccount(); refreshTransfer(); refreshContracts();

    // P6: prompt legacy face-only accounts to upgrade to PIN protection
    if (!blob.pinVersion || blob.pinVersion < 1) {
      const upgrade = confirm('This account uses legacy face-only security.\n\nAdd a PIN for stronger protection? (Recommended)');
      if (upgrade) {
        const newPin = await promptSetPin();
        if (newPin) {
          try {
            const newBlob = await createEncryptedKeyBlob(keys, username, faceMap.canonical, blob.faceMapHash, newPin);
            await node.net.saveKeyBlob(keys.pub, newBlob as unknown as Record<string, unknown>);
            const saltBytes = Uint8Array.from(atob(newBlob.pinSalt!), c => c.charCodeAt(0));
            const newRawBits = await derivePinRawBits(newPin, saltBytes);
            const newPinKey = await crypto.subtle.importKey('raw', newRawBits as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            cachePinKey(keys.pub, newPinKey, newRawBits);
            toast('PIN added - account upgraded to face + PIN security', 'success');
          } catch {
            toast('PIN setup failed - account still accessible via face', 'error');
          }
        }
      }
    }
  } catch (err) {
    toast(`Recovery error: ${err}`, 'error');
    hideCameraModal();
  }
  finishRecovery();
  $('#btnRecoverFace').removeAttribute('disabled');
});

// ──── Key Pair Recovery (backup method) ────

$('#btnToggleKeyRecover').addEventListener('click', () => {
  const section = $('#keyRecoverSection');
  section.style.display = section.style.display === 'none' ? 'block' : 'none';
});

$('#btnRecoverKeys').addEventListener('click', async () => {
  const username = $<HTMLInputElement>('#recoverUsername').value.trim().toLowerCase();
  const keysRaw = $<HTMLTextAreaElement>('#recoverKeyPair').value.trim();
  if (!username || !keysRaw) { toast('Enter username and backup code', 'error'); return; }

  let keys: KeyPair;
  try {
    // Accept both the compact Base58 backup code and the legacy full JSON format
    const isBase58 = /^[1-9A-HJ-NP-Za-km-z]+$/.test(keysRaw) && !keysRaw.startsWith('{');
    if (isBase58) {
      const decoded = await decodeBackupKey(keysRaw);
      if (!decoded) { toast('Invalid backup code', 'error'); return; }
      keys = decoded as KeyPair;
    } else {
      keys = JSON.parse(keysRaw) as KeyPair;
    }
    if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) { toast('Invalid key format', 'error'); return; }

    const existing = node.ledger.getAccountByUsername(username);
    if (existing && existing.pub !== keys.pub) { toast('Key does not match this username', 'error'); return; }

    // Fetch the key blob to reliably get pinSalt/pinVerifier - don't rely on sync timing
    const blobData = await node.net.findKeyBlobByUsername(username);
    const blobPinSalt = blobData?.pinSalt ? String(blobData.pinSalt) : (existing as Account & { pinSalt?: string } | undefined)?.pinSalt;
    const blobPinVerifier = blobData?.pinVerifier ? String(blobData.pinVerifier) : (existing as Account & { pinVerifier?: string } | undefined)?.pinVerifier;

    const account = buildAccount(username, keys.pub, existing?.faceMapHash || blobData?.faceMapHash as string || '', {
      pinSalt: blobPinSalt,
      pinVerifier: blobPinVerifier,
      linkedAnchor: blobData?.linkedAnchor ? String(blobData.linkedAnchor) : existing?.linkedAnchor,
      pqPub: existing?.pqPub,
      pqKemPub: existing?.pqKemPub,
    });
    if (!existing) node.ledger.registerAccount(account);

    if (!localAccounts.find((a) => a.pub === keys.pub)) {
      const fullAcc: AccountWithKeys = { ...account, keys, balance: existing?.balance || 0 };
      localAccounts.push(fullAcc);
      node.addLocalKey(keys.pub, keys);
      saveWallet();
    }

    $('#recoverStatus').innerHTML = `<span style="color:var(--success);">Recovered: ${username}</span>`;
    toast(`Recovered: ${username}`, 'success');
    addLog(`Account recovered via backup code: ${username}`, 'success');
    refreshAccount(); refreshTransfer(); refreshContracts();
  } catch { toast('Invalid backup code or JSON', 'error'); }
});

// ──── Update PIN ────
$('#btnUpdatePin').addEventListener('click', async () => {
  const pub = $<HTMLSelectElement>('#updateSecurityAccount').value;
  const acc = localAccounts.find(a => a.pub === pub) as (AccountWithKeys & { pinSalt?: string; pinVerifier?: string; linkedAnchor?: string; pqPub?: string; pqKemPub?: string }) | undefined;
  if (!acc || !acc.pinSalt || !acc.pinVerifier) { toast('Account not found or no PIN set', 'error'); return; }
  const statusEl = $('#updateSecurityStatus');

  // Verify current PIN first
  if (!await requirePin(acc)) { statusEl.innerHTML = '<span style="color:var(--danger)">PIN verification cancelled or failed.</span>'; return; }

  // Prompt new PIN
  const newPin = await promptSetPin();
  if (!newPin) { statusEl.innerHTML = '<span style="color:var(--text-muted)">Cancelled.</span>'; return; }

  try {
    // Fetch the current encrypted blob from the network.
    statusEl.innerHTML = '<span class="spinner"></span> Fetching current blob...';
    const blobRaw = await node.net.findKeyBlobByUsername(acc.username);
    if (!blobRaw) { toast('Could not fetch key blob from network', 'error'); statusEl.innerHTML = ''; return; }

    const blob: EncryptedKeyBlob = {
      encryptedKeys: String(blobRaw.encryptedKeys), faceMapHash: String(blobRaw.faceMapHash),
      username: String(blobRaw.username), pub: String(blobRaw.pub), createdAt: Number(blobRaw.createdAt),
      linkedAnchor: blobRaw.linkedAnchor ? String(blobRaw.linkedAnchor) : undefined,
      pinSalt: blobRaw.pinSalt ? String(blobRaw.pinSalt) : undefined,
      pinVersion: typeof blobRaw.pinVersion === 'number' ? blobRaw.pinVersion : 0,
      pinAttemptState: blobRaw.pinAttemptState ? String(blobRaw.pinAttemptState) : undefined,
      pinVerifier: blobRaw.pinVerifier ? String(blobRaw.pinVerifier) : undefined,
      encryptedCanonical: blobRaw.encryptedCanonical ? String(blobRaw.encryptedCanonical) : undefined,
    };
    if (!blob.pinVersion || blob.pinVersion < 1) { toast('Legacy account - no PIN to update', 'error'); statusEl.innerHTML = ''; return; }

    // Derive new PIN key (rawBits used for combined key on v2 blobs)
    const newSaltBytes = generatePinSalt();
    const newPinSalt = btoa(String.fromCharCode(...newSaltBytes));
    const newPinRawBits = await derivePinRawBits(newPin, newSaltBytes);
    const newPinKey = await crypto.subtle.importKey('raw', newPinRawBits as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    const oldPinKey = getCachedPinKey(pub);
    if (!oldPinKey) { toast('Session expired - please retry', 'error'); statusEl.innerHTML = ''; return; }

    let newEncryptedKeys: string;
    let newPinVersion: number;

    if (blob.pinVersion === 2) {
      // Combined-key blob: recover face bytes from stored canonical, form new combined key
      if (!blob.encryptedCanonical) {
        toast('Security data missing - use Update Face first to repair it, then change your PIN', 'error');
        statusEl.innerHTML = '<span style="color:var(--danger)">Security data missing. Go to <strong>Update Face</strong> to repair, then retry PIN change.</span>';
        return;
      }
      const canonicalJson = await decryptWithPinKey(blob.encryptedCanonical, oldPinKey);
      if (!canonicalJson) {
        toast('Security data is out of sync - please use Update Face first to repair it, then change your PIN', 'error');
        statusEl.innerHTML = '<span style="color:var(--danger)">Security data out of sync. Go to <strong>Update Face</strong> to repair, then retry PIN change.</span>';
        return;
      }
      const storedQuantized = quantizeDescriptor(JSON.parse(canonicalJson) as number[]);
      const faceBytes = await deriveFaceRawBits(storedQuantized, pub);
      const newSharedKey = await deriveCombinedKey(faceBytes, newPinRawBits);
      // Re-encrypt directly from in-memory keys - identity already proved by requirePin
      newEncryptedKeys = await encryptWithPinKey(JSON.stringify(acc.keys), newSharedKey);
      newPinVersion = 2;
    } else {
      // v1 two-layer blob: strip PIN outer layer and re-wrap with new PIN key
      const innerCiphertext = await decryptWithPinKey(blob.encryptedKeys, oldPinKey);
      if (!innerCiphertext) {
        toast('Security data is out of sync - please use Update Face first to repair it, then change your PIN', 'error');
        statusEl.innerHTML = '<span style="color:var(--danger)">Security data out of sync. Go to <strong>Update Face</strong> to repair, then retry PIN change.</span>';
        return;
      }
      newEncryptedKeys = await encryptWithPinKey(innerCiphertext, newPinKey);
      newPinVersion = 1;
    }

    const newPinVerifier = await encryptWithPinKey('PINOK', newPinKey);

    // Re-encrypt face descriptor with new PIN key if present
    let newEncryptedFaceDescriptor: string | undefined;
    if (acc.encryptedFaceDescriptor) {
      const oldDesc = await decryptWithPinKey(acc.encryptedFaceDescriptor, oldPinKey);
      if (oldDesc) newEncryptedFaceDescriptor = await encryptWithPinKey(oldDesc, newPinKey);
    }

    // Re-encrypt encryptedCanonical with new PIN key
    let newEncryptedCanonical: string | undefined;
    if (blob.encryptedCanonical) {
      const oldCanonical = await decryptWithPinKey(blob.encryptedCanonical, oldPinKey);
      if (oldCanonical) newEncryptedCanonical = await encryptWithPinKey(oldCanonical, newPinKey);
    }

    // Compute new linkedAnchor
    const newAnchorInput = `${newEncryptedKeys}:${blob.faceMapHash}:${acc.pub}`;
    const anchorBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(newAnchorInput));
    const newLinkedAnchor = Array.from(new Uint8Array(anchorBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    // Publish update block
    const updateResult = await node.ledger.createUpdate(acc.pub, acc.keys, {
      newLinkedAnchor, newPQPub: acc.pqPub, newPQKemPub: acc.pqKemPub,
    });
    if ('error' in updateResult && updateResult.error) { toast(`Update failed: ${updateResult.error}`, 'error'); statusEl.innerHTML = ''; return; }
    const sub = await node.submitBlock(updateResult.block!);
    if (!sub.success) { toast(`Update block failed: ${sub.error}`, 'error'); statusEl.innerHTML = ''; return; }

    // Publish the full updated blob to the P2P network
    const updatedBlob: EncryptedKeyBlob = {
      ...blob,
      updatedAt: Date.now(),
      encryptedKeys: newEncryptedKeys,
      pinSalt: newPinSalt,
      pinVersion: newPinVersion,
      pinVerifier: newPinVerifier,
      linkedAnchor: newLinkedAnchor,
      encryptedCanonical: newEncryptedCanonical ?? blob.encryptedCanonical,
    };
    await node.net.saveKeyBlob(acc.pub, updatedBlob as unknown as Record<string, unknown>);

    // Update local account
    Object.assign(acc, { pinSalt: newPinSalt, pinVerifier: newPinVerifier, linkedAnchor: newLinkedAnchor, encryptedFaceDescriptor: newEncryptedFaceDescriptor, encryptedCanonical: newEncryptedCanonical });
    cachePinKey(pub, newPinKey, newPinRawBits);
    saveWallet();
    statusEl.innerHTML = '<span style="color:var(--success)">PIN updated successfully.</span>';
    toast('PIN updated', 'success');
    addLog(`PIN updated for ${acc.username}`, 'success');
    refreshAccount();
  } catch (e) {
    toast('PIN update failed', 'error');
    statusEl.innerHTML = `<span style="color:var(--danger)">Error: ${String(e)}</span>`;
  }
});

// ──── Update Face ────
$('#btnUpdateFace').addEventListener('click', async () => {
  const pub = $<HTMLSelectElement>('#updateSecurityAccount').value;
  const acc = localAccounts.find(a => a.pub === pub) as (AccountWithKeys & { pinSalt?: string; pinVerifier?: string; linkedAnchor?: string; pqPub?: string; pqKemPub?: string; encryptedFaceDescriptor?: string }) | undefined;
  if (!acc) { toast('Account not found', 'error'); return; }
  const statusEl = $('#updateSecurityStatus');

  // Verify current face+PIN first
  if (!await requirePin(acc)) { statusEl.innerHTML = '<span style="color:var(--danger)">Authentication cancelled or failed.</span>'; return; }

  const pinKey = getCachedPinKey(pub);

  // Fetch the blob NOW before starting camera so we can detect a missing PIN key
  // early instead of wasting the user's time on a full face scan.
  statusEl.innerHTML = '<span class="spinner"></span> Fetching key blob...';
  const blobRawPre = await node.net.findKeyBlobByUsername(acc.username);
  if (!blobRawPre) { toast('Could not fetch key blob', 'error'); statusEl.innerHTML = ''; return; }
  const blobPre: EncryptedKeyBlob = {
    encryptedKeys: String(blobRawPre.encryptedKeys), faceMapHash: String(blobRawPre.faceMapHash),
    username: String(blobRawPre.username), pub: String(blobRawPre.pub), createdAt: Number(blobRawPre.createdAt),
    linkedAnchor: blobRawPre.linkedAnchor ? String(blobRawPre.linkedAnchor) : undefined,
    pinSalt: blobRawPre.pinSalt ? String(blobRawPre.pinSalt) : undefined,
    pinVersion: typeof blobRawPre.pinVersion === 'number' ? blobRawPre.pinVersion : 0,
    pinAttemptState: blobRawPre.pinAttemptState ? String(blobRawPre.pinAttemptState) : undefined,
    pinVerifier: blobRawPre.pinVerifier ? String(blobRawPre.pinVerifier) : undefined,
    encryptedCanonical: blobRawPre.encryptedCanonical ? String(blobRawPre.encryptedCanonical) : undefined,
  };

  // If the blob requires a PIN but we don't have the key cached, requirePin returned via
  // an early path (no pinSalt/pinVerifier on the in-memory account at the time it ran).
  // Abort here so the user isn't stuck re-doing the face scan only to hit "Session expired".
  if ((blobPre.pinVersion === 1 || blobPre.pinVersion === 2) && !pinKey) {
    toast('Session expired - please close and re-open Security Settings to authenticate again', 'error');
    statusEl.innerHTML = '';
    return;
  }

  // Re-enroll face
  statusEl.innerHTML = '<span class="spinner"></span> Starting camera for face re-enrollment...';
  const video = $<HTMLVideoElement>('#faceVideo');
  showCameraModal();

  let faceMap: Awaited<ReturnType<typeof enrollFace>> | null = null;
  try {
    setCameraStatus('<span class="spinner"></span> Loading face recognition models...');
    await loadModels();
    setCameraStatus('<span class="spinner"></span> Starting camera...');
    cameraStream = await startCamera(video);
    setCameraStatus('<span class="spinner"></span> Step 1/2: Slowly turn your head left and right');
    const isLive = await detectLiveness(video, 15000, (msg: string) => { $('#cameraOverlay').textContent = msg; });
    if (!isLive) {
      hideCameraModal();
      statusEl.innerHTML = '<span style="color:var(--danger)">Liveness failed. Try again with more head movement.</span>';
      return;
    }
    setCameraStatus('<span class="spinner"></span> Step 2/2: Hold still - capturing face map');
    faceMap = await enrollFace(video, (step, total) => {
      setCameraStatus(`<span class="spinner"></span> Step 2/2: Sample ${step}/${total}`);
    });
  } catch {
    hideCameraModal();
    statusEl.innerHTML = '<span style="color:var(--danger)">Camera error. Try again.</span>';
    return;
  }
  hideCameraModal();

  if (!faceMap || !faceMap.canonical) {
    statusEl.innerHTML = '<span style="color:var(--danger)">Face enrollment failed. Try again.</span>';
    return;
  }

  try {
    const newQuantized = quantizeDescriptor(faceMap.canonical);
    const newFaceKey = await deriveFaceKey(newQuantized, pub);  // for pinAttemptState

    // Reuse blob fetched before camera (already validated above)
    const blob: EncryptedKeyBlob = blobPre;

    // Use the in-memory keys directly - identity was already proved by requirePin + liveness.
    const keysJson: string = JSON.stringify(acc.keys);

    // Build new encryptedKeys using combined key (pinVersion=2) or face-only (no PIN)
    let newEncryptedKeys: string;
    let newPinVersion: number;
    if (pinKey) {
      const pinRawBits = getCachedPinRawBits(pub);
      if (!pinRawBits) {
        hideCameraModal();
        toast('Session expired - please close and re-open Security Settings to authenticate again', 'error');
        statusEl.innerHTML = '';
        return;
      }
      const newFaceBytes = await deriveFaceRawBits(newQuantized, pub);
      const newSharedKey = await deriveCombinedKey(newFaceBytes, pinRawBits);
      newEncryptedKeys = await encryptWithPinKey(keysJson, newSharedKey);
      newPinVersion = 2;
    } else {
      newEncryptedKeys = await encryptWithFaceKey(keysJson, newFaceKey);
      newPinVersion = 0;
    }

    // Update encryptedCanonical with new canonical descriptor (still encrypted with PIN key for deterministic recovery)
    const newEncryptedCanonical = pinKey
      ? await encryptWithPinKey(JSON.stringify(faceMap.canonical), pinKey)
      : undefined;

    // Compute new faceMapHash
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(newQuantized)));
    const newFaceMapHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    // Compute new linkedAnchor
    const anchorInput = `${newEncryptedKeys}:${newFaceMapHash}:${acc.pub}`;
    const anchorBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(anchorInput));
    const newLinkedAnchor = Array.from(new Uint8Array(anchorBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    // Build and save updated blob.
    // Use acc.pinSalt (authoritative in-memory value) - the blob fetched from IDB may have a
    // stale pinSalt from before a previous PIN change that didn't publish an updated blob.
    const newPinVerifier = pinKey ? await encryptWithPinKey('PINOK', pinKey) : blob.pinVerifier;
    const newBlob: EncryptedKeyBlob = {
      ...blob,
      pinSalt: acc.pinSalt ?? blob.pinSalt,
      pinVersion: newPinVersion,
      updatedAt: Date.now(),
      encryptedKeys: newEncryptedKeys,
      faceMapHash: newFaceMapHash,
      linkedAnchor: newLinkedAnchor,
      encryptedCanonical: newEncryptedCanonical ?? blob.encryptedCanonical,
      pinVerifier: newPinVerifier,
      pinAttemptState: await encryptWithFaceKey(JSON.stringify({ failedAttempts: 0, lockedUntil: 0 }), newFaceKey),
    };
    await node.net.saveKeyBlob(acc.pub, newBlob as unknown as Record<string, unknown>);

    // Publish update block
    const updateResult = await node.ledger.createUpdate(acc.pub, acc.keys, {
      newFaceMapHash, newLinkedAnchor, newPQPub: acc.pqPub, newPQKemPub: acc.pqKemPub,
    });
    if ('error' in updateResult && updateResult.error) { toast(`Update failed: ${updateResult.error}`, 'error'); statusEl.innerHTML = ''; return; }
    const sub = await node.submitBlock(updateResult.block!);
    if (!sub.success) { toast(`Update block failed: ${sub.error}`, 'error'); statusEl.innerHTML = ''; return; }

    // Update local account
    Object.assign(acc, { faceMapHash: newFaceMapHash, linkedAnchor: newLinkedAnchor, encryptedFaceDescriptor: newEncryptedCanonical });
    saveWallet();
    statusEl.innerHTML = '<span style="color:var(--success)">Face updated successfully.</span>';
    toast('Face updated', 'success');
    addLog(`Face updated for ${acc.username}`, 'success');
    refreshAccount();
  } catch (e) {
    toast('Face update failed', 'error');
    statusEl.innerHTML = `<span style="color:var(--danger)">Error: ${String(e)}</span>`;
  }
});

// ──── Transfer ────
$<HTMLSelectElement>('#txFrom').addEventListener('change', refreshTxAssets);
$<HTMLSelectElement>('#txAsset').addEventListener('change', () => {
  const isUnit = $<HTMLSelectElement>('#txAsset').value === '__unit__';
  ($('#txAmountLabel') as HTMLElement).textContent = isUnit ? 'Amount (UNIT)' : 'Amount (tokens)';
  $<HTMLInputElement>('#txAmount').placeholder = isUnit ? '0.001' : '1';
});

$('#btnSendTx').addEventListener('click', async () => {
  const fromPub = $<HTMLSelectElement>('#txFrom').value;
  const assetId = $<HTMLSelectElement>('#txAsset').value;
  const to = $<HTMLInputElement>('#txTo').value.trim();
  const amountInput = $<HTMLInputElement>('#txAmount').value;
  if (!fromPub || !to || !amountInput) { toast('Fill all fields', 'error'); return; }

  const sender = localAccounts.find((a) => a.pub === fromPub);
  if (!sender) { toast('Sender not found', 'error'); return; }

  // PIN required for all transfers
  if (!await requirePin(sender)) return;

  if (assetId === '__unit__') {
    const amount = parseUNIT(amountInput);
    if (amount <= 0) { toast('Invalid amount', 'error'); return; }
    const result = await node.ledger.createSend(sender.pub, to.toLowerCase(), amount, sender.keys);
    if (result.error) { toast(result.error, 'error'); return; }
    const sub = await node.submitBlock(result.block!);
    if (sub.success) {
      toast(`Sent ${formatUNIT(amount)} UNIT to ${to}`, 'success');
      addLog(`Send: ${formatUNIT(amount)} UNIT to ${to}`, 'success');
      $<HTMLInputElement>('#txAmount').value = '';
      $<HTMLInputElement>('#txTo').value = '';
      refreshTab();
    } else { toast(`Failed: ${sub.error}`, 'error'); }
  } else {
    // Token transfer via contract call
    const amount = parseInt(amountInput, 10);
    if (!amount || amount <= 0) { toast('Invalid amount', 'error'); return; }
    const contract = node.ledger.contracts.get(assetId);
    if (!contract) { toast('Contract not found', 'error'); return; }
    const sym = String((contract.state as Record<string, unknown>).symbol ?? '');
    // Always pass pub key so balances are keyed consistently
    const toPub = node.ledger.resolveToPublicKey(to) ?? to;
    const result = await node.ledger.createCall(sender.pub, assetId, 'transfer', [toPub, amount], sender.keys);
    if (!result.block) { toast(`Error: ${result.error}`, 'error'); return; }
    const sub = await node.submitBlock(result.block);
    if (sub.success) {
      toast(`Sent ${amount} ${sym} to ${to}`, 'success');
      addLog(`Token transfer: ${amount} ${sym} to ${to}`, 'success');
      $<HTMLInputElement>('#txAmount').value = '';
      $<HTMLInputElement>('#txTo').value = '';
      refreshTab();
    } else { toast(`Failed: ${sub.error}`, 'error'); }
  }
});

// ──── Explorer ────
$('#explorerLoadMore').addEventListener('click', () => {
  explorerDisplayCount += EXPLORER_PAGE_SIZE;
  refreshExplorer();
});

function showContractDetail(contractId: string) {
  const contract = node.ledger.contracts.get(contractId);
  const detail = $('#explorerDetail');
  if (!contract) {
    detail.innerHTML = '<div class="card" style="color:var(--text-muted);text-align:center;">Contract not found.</div>';
    detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const state = JSON.stringify(contract.state, null, 2);
  detail.innerHTML = `<div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
      <span>${escHtml(contract.name)}</span>
      <span class="badge badge-deploy">contract</span>
    </div>
    <div class="stats-grid" style="margin-bottom:16px;">
      <div class="stat-item"><div class="stat-label">Contract ID</div><div class="stat-value small">${cpBtn(contractId)}${escHtml(trunc(contractId, 28))}</div></div>
      <div class="stat-item"><div class="stat-label">Owner</div><div class="stat-value small">${resolveName(contract.owner)}</div></div>
      <div class="stat-item"><div class="stat-label">Deployed</div><div class="stat-value small">${fmtTime(contract.deployedAt)}</div></div>
    </div>
    <div style="margin-bottom:12px;">
      <div class="stat-label" style="margin-bottom:6px;">State</div>
      <pre style="background:var(--surface2);padding:12px;border-radius:var(--radius);font-family:var(--mono);font-size:12px;overflow-x:auto;max-height:200px;overflow-y:auto;">${escHtml(state)}</pre>
    </div>
    <div>
      <div class="stat-label" style="margin-bottom:6px;">Contract Code</div>
      <pre style="background:var(--surface2);padding:12px;border-radius:var(--radius);font-family:var(--mono);font-size:12px;overflow-x:auto;max-height:360px;overflow-y:auto;">${escHtml(contract.code)}</pre>
    </div>
  </div>`;
  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Global click delegation for account and contract links (rendered anywhere via innerHTML)
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const contractLink = target.closest('.explorer-contract-link') as HTMLElement | null;
  if (contractLink) { showContractDetail(contractLink.dataset.contractId!); return; }
  const accountLink = target.closest('.account-link') as HTMLElement | null;
  if (accountLink) { showAccountDetail(accountLink.dataset.pub!); return; }
});

$('#btnExplorerSearch').addEventListener('click', () => {
  const query = $<HTMLInputElement>('#explorerSearch').value.trim().toLowerCase();
  if (!query) return;
  const detail = $('#explorerDetail');

  const block = node.ledger.getBlock(query);
  if (block) {
    const status = node.ledger.getBlockStatus(block.hash);
    const tally = node.ledger.votes.getTally(block.hash);
    detail.innerHTML = `<div class="card"><div class="card-title">Block Detail</div><div class="stats-grid">
      <div class="stat-item"><div class="stat-label">Hash</div><div class="stat-value small">${cpBtn(block.hash)}${block.hash}</div></div>
      <div class="stat-item"><div class="stat-label">Type</div><div class="stat-value small">${block.type}</div></div>
      <div class="stat-item"><div class="stat-label">Account</div><div class="stat-value small">${cpBtn(block.accountPub)}${resolveName(block.accountPub)}</div></div>
      <div class="stat-item"><div class="stat-label">Balance</div><div class="stat-value">${formatUNIT(block.balance)} UNIT</div></div>
      <div class="stat-item"><div class="stat-label">Status</div><div class="stat-value small">${status}</div></div>
      <div class="stat-item"><div class="stat-label">Approve Stake</div><div class="stat-value">${tally?.approveStake ?? 0}</div></div>
      <div class="stat-item"><div class="stat-label">Voters</div><div class="stat-value">${tally?.voterCount ?? 0}</div></div>
      <div class="stat-item"><div class="stat-label">Time</div><div class="stat-value small">${fmtTime(block.timestamp)}</div></div>
    </div></div>`;
    return;
  }

  const acc = node.ledger.getAccountByUsername(query);
  if (acc) { showAccountDetail(acc.pub); return; }

  // Try pub key directly
  if (node.ledger.getAccountChain(query).length > 0) { showAccountDetail(query); return; }

  if (node.ledger.contracts.has(query)) { showContractDetail(query); return; }

  detail.innerHTML = '<div class="card" style="color:var(--text-muted);text-align:center;">No results found.</div>';
});

// ──── Contracts ────
$('#btnDeployContract').addEventListener('click', async () => {
  const from = $<HTMLSelectElement>('#contractFrom').value;
  const name = $<HTMLInputElement>('#contractName').value.trim();
  const code = $<HTMLTextAreaElement>('#contractCode').value.trim();
  const initArgsStr = $<HTMLInputElement>('#contractInitArgs').value.trim();
  if (!from || !code) { toast('Fill required fields', 'error'); return; }
  const sender = localAccounts.find((a) => a.username === from);
  if (!sender) { toast('Account not found', 'error'); return; }

  if (!await requirePin(sender)) return;

  const deployResult = await node.ledger.createDeploy(sender.pub, name || 'Unnamed', code, sender.keys);
  if (deployResult.error) { toast(deployResult.error, 'error'); return; }
  const sub = await node.submitBlock(deployResult.block!);
  if (!sub.success) { toast(`Deploy failed: ${sub.error}`, 'error'); return; }

  const contractId = deployResult.block!.hash;

  if (initArgsStr) {
    let initArgs: unknown[];
    try { initArgs = JSON.parse(initArgsStr); } catch { toast('Deployed, but constructor args are invalid JSON - call init() manually', 'error'); refreshContracts(); return; }
    if (!Array.isArray(initArgs)) { toast('Deployed, but constructor args must be a JSON array - call init() manually', 'error'); refreshContracts(); return; }
    const callResult = await node.ledger.createCall(sender.pub, contractId, 'init', initArgs, sender.keys);
    if (callResult.error) { toast(`Deployed but init() failed: ${callResult.error}`, 'error'); refreshContracts(); return; }
    const callSub = await node.submitBlock(callResult.block!);
    if (callSub.success) { toast('Contract deployed and initialised', 'success'); }
    else { toast(`Deployed but init() failed: ${callSub.error}`, 'error'); }
  } else {
    toast('Contract deployed', 'success');
  }

  refreshContracts();
  refreshTransfer();
});

$('#btnCallContract').addEventListener('click', async () => {
  const contractId = $<HTMLInputElement>('#callContractId').value.trim();
  const method = $<HTMLInputElement>('#callMethod').value.trim();
  const from = $<HTMLSelectElement>('#callFrom').value;
  const argsStr = $<HTMLInputElement>('#callArgs').value.trim();
  if (!contractId || !method || !from) { toast('Fill all fields', 'error'); return; }
  const sender = localAccounts.find((a) => a.username === from);
  if (!sender) { toast('Account not found', 'error'); return; }
  let args: unknown[];
  try { args = JSON.parse(argsStr || '[]'); } catch { toast('Invalid JSON', 'error'); return; }
  const result = await node.ledger.createCall(sender.pub, contractId, method, args, sender.keys);
  if (result.error) { toast(result.error, 'error'); return; }
  const sub = await node.submitBlock(result.block!);
  if (sub.success) { toast(`Called "${method}"`, 'success'); }
  else { toast(`Failed: ${sub.error}`, 'error'); }
});

// ──── Node Events ────
let nodeEventsWired = false;
// Debounce for high-frequency events (block:received, account:synced) so they
// don't cause continuous DOM mutations that interfere with native select pickers on mobile.
let _refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedRefreshTab() {
  if (_refreshDebounceTimer) return; // already queued
  _refreshDebounceTimer = setTimeout(() => {
    _refreshDebounceTimer = null;
    refreshTab();
  }, 800);
}

function wireNodeEvents() {
  if (nodeEventsWired) return;
  nodeEventsWired = true;
  node.on('block:confirmed', (b: unknown) => {
    const block = b as { type: string; accountPub: string };
    addLog(`Confirmed: ${block.type} by ${resolveNamePlain(block.accountPub)}`, 'success');
    debouncedRefreshTab();
  });
  node.on('block:conflict', (b: unknown) => {
    const block = b as { hash: string; type: string; accountPub: string };
    addLog(`CONFLICT: fork detected for ${block.type} by ${resolveNamePlain(block.accountPub)} - voting started`, 'warn');
    debouncedRefreshTab();
  });
  node.on('block:rejected', (b: unknown) => {
    const block = b as { hash: string };
    addLog(`Rejected: ${trunc(block.hash)}`, 'error');
    debouncedRefreshTab();
  });
  node.on('peer:connected', () => { refreshNode(); });
  node.on('peer:disconnected', () => { refreshNode(); });
  node.on('auto:received', (data: unknown) => {
    const d = data as { from: string; amount: number };
    addLog(`Auto-received: +${formatUNIT(d.amount)} UNIT`, 'success');
    refreshTab();
  });
  node.on('inbox:signal', (data: unknown) => {
    const sig = data as { sender: string; amount: number };
    addLog(`Inbox: incoming ${formatUNIT(sig.amount)} UNIT from ${resolveNamePlain(sig.sender)}`, 'info');
  });
  node.on('contract:deployed', (data: unknown) => {
    addLog(`Contract: ${(data as { name: string }).name}`, 'success');
    refreshContracts();
  });
  node.on('contract:executed', () => {
    refreshTransfer();
  });
  node.on('contract:error', (data: unknown) => {
    addLog(`Contract error: ${(data as { error: string }).error}`, 'error');
  });
  node.on('account:synced', () => {
    debouncedRefreshTab();
  });
  node.on('block:received', () => {
    debouncedRefreshTab();
  });
  node.on('resync', (data: unknown) => {
    const d = data as { newAccounts: number; newBlocks: number };
    if (d.newAccounts > 0 || d.newBlocks > 0) {
      addLog(`Resync: +${d.newAccounts} accounts, +${d.newBlocks} blocks`, 'info');
      refreshTab();
    }
  });
  node.on('generation:reset', () => {
    // Another peer broadcast a higher generation - reload to clear all in-memory state.
    // If recovery is in progress, defer the reload until it finishes so the user
    // doesn't lose their face scan mid-flow.
    localAccounts = [];
    localStorage.removeItem(WALLET_KEY);
    if (isRecovering) {
      pendingGenerationReset = true;
      toast('Network generation updated - will reload after recovery', 'info');
      return;
    }
    toast('Network reset received - reloading...', 'info');
    setTimeout(() => location.reload(), 800);
  });
  node.net.on('peer:connected', (url: unknown) => {
    addLog(`Relay connected: ${url}`, 'success');
  });
  node.net.on('peer:disconnected', (url: unknown) => {
    addLog(`Relay disconnected: ${url}`, 'warn');
  });
}

function unwireNodeEvents() {
  if (!nodeEventsWired) return;
  nodeEventsWired = false;
  node.removeAllListeners();
  node.net.removeAllListeners();
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;

function startRefreshInterval() {
  stopRefreshInterval();
  refreshInterval = setInterval(() => {
    refreshTab();
    // Always keep explorer current in the background so it's ready when switched to
    if (activeTab() !== 'explorer') refreshExplorer();
  }, 5000);
}

function stopRefreshInterval() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// ──── Storage tab ────

interface ContentRecord {
  cid: string;
  /** Inner content CID (the actual data block, separate from the meta envelope) */
  contentCid?: string;
  name: string;
  contentType: string;
  mimeType: string;
  sizeBytes: number;
  timestamp: number;
  ownerPub: string;
  encrypted: boolean;
}

const CONTENT_LIBRARY_KEY = 'neuronchain_content_library';

function loadContentLibrary(): ContentRecord[] {
  try {
    const raw = localStorage.getItem(CONTENT_LIBRARY_KEY);
    return raw ? JSON.parse(raw) as ContentRecord[] : [];
  } catch { return []; }
}

function saveContentLibrary(records: ContentRecord[]): void {
  try { localStorage.setItem(CONTENT_LIBRARY_KEY, JSON.stringify(records)); } catch {}
}

function addToContentLibrary(record: ContentRecord): void {
  const records = loadContentLibrary();
  if (!records.find(r => r.cid === record.cid)) {
    records.unshift(record);
    if (records.length > 200) records.pop();
    saveContentLibrary(records);
  }
}

function removeFromContentLibrary(cid: string): void {
  saveContentLibrary(loadContentLibrary().filter(r => r.cid !== cid));
}

(window as unknown as Record<string, unknown>)['removeFromLibraryAndRefresh'] = async (cid: string) => {
  const record = loadContentLibrary().find(r => r.cid === cid);
  removeFromContentLibrary(cid);
  refreshStorage();

  if (node.store.isStarted() && record) {
    const cids = [cid, ...(record.contentCid ? [record.contentCid] : [])];
    const keys = node.localKeys.get(record.ownerPub);
    if (keys) {
      await node.deleteContent(cids, record.ownerPub, keys).catch(() => {});
    } else {
      // Keys not loaded (e.g. wallet locked) - delete locally only
      for (const c of cids) await node.store.deleteBlock(c).catch(() => {});
    }
  }
};

(window as unknown as Record<string, unknown>)['fillRetrieveCid'] = (cid: string) => {
  const el = $<HTMLInputElement>('#retrieveCid');
  el.value = cid;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

(window as unknown as Record<string, unknown>)['distributeFromLibrary'] = async (cid: string) => {
  const record = loadContentLibrary().find(r => r.cid === cid);
  if (!record) { toast('Record not found in library', 'error'); return; }
  if (!node.store.isStarted()) { toast('Node not started', 'error'); return; }
  const acc = localAccounts.find(a => a.pub === record.ownerPub);
  if (!acc) { toast('Owner account not loaded in wallet', 'error'); return; }
  toast('Distributing…', 'info');
  const cids = [cid, ...(record.contentCid ? [record.contentCid] : [])];
  const result = await node.distributeContent(cids, record.ownerPub, acc.keys);
  if (result.error) toast(`Distribution: ${result.error}`, 'error');
  else toast(`Distributed to ${result.providers.length} provider(s)`, 'success');
  refreshStorage();
};

(window as unknown as Record<string, unknown>)['openReplaceModal'] = (cid: string) => {
  const record = loadContentLibrary().find(r => r.cid === cid);
  if (!record) { toast('Record not found in library', 'error'); return; }
  const modal = $('#replaceContentModal');
  ($('#replaceContentName') as HTMLElement).textContent = record.name || cid.slice(0, 16) + '…';
  ($('#replaceVisibilityLabel') as HTMLElement).textContent = record.encrypted ? 'Private' : 'Public';
  ($('#replaceContentFile') as HTMLInputElement).value = '';
  const status = $('#replaceContentStatus') as HTMLElement;
  status.style.display = 'none';
  status.textContent = '';
  modal.dataset.cid = cid;
  modal.classList.add('active');
};

$('#btnReplaceCancel')?.addEventListener('click', () => {
  $('#replaceContentModal').classList.remove('active');
});

$('#btnReplaceConfirm')?.addEventListener('click', async () => {
  const modal = $('#replaceContentModal');
  const cid = modal.dataset.cid ?? '';
  const record = loadContentLibrary().find(r => r.cid === cid);
  if (!record) { toast('Record not found', 'error'); return; }

  const file = $<HTMLInputElement>('#replaceContentFile').files?.[0];
  if (!file) { toast('Select a replacement file', 'error'); return; }

  const acc = localAccounts.find(a => a.pub === record.ownerPub);
  if (!acc) { toast('Wallet not loaded for owner account', 'error'); return; }
  if (!node.store.isStarted()) { toast('Node not started', 'error'); return; }

  const statusEl = $('#replaceContentStatus') as HTMLElement;
  statusEl.textContent = 'Storing new content…';
  statusEl.style.display = 'block';
  const confirmBtn = $<HTMLButtonElement>('#btnReplaceConfirm');
  confirmBtn.disabled = true;

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const mimeType = file.type || record.mimeType || 'application/octet-stream';
    const name = record.name;

    const storeResult = record.encrypted
      ? await node.store.storeWithMeta(data, { mimeType, name }, acc.keys)
      : await node.store.storeWithMetaPublic(data, { mimeType, name });

    const newCid = storeResult.cid;
    const newContentCid = (storeResult.meta as { contentCid?: string }).contentCid;

    const oldCids = [cid, ...(record.contentCid ? [record.contentCid] : [])];
    const newCids = [newCid, ...(newContentCid ? [newContentCid] : [])];

    statusEl.textContent = 'Broadcasting replace request…';
    const result = await node.replaceContent(oldCids, newCids, record.ownerPub, acc.keys);
    if (result.error) addLog(`Replace: ${result.error}`, 'warn');
    else addLog(`Content replaced, distributed to ${result.providers.length} provider(s)`, 'success');

    // Update library record
    removeFromContentLibrary(cid);
    addToContentLibrary({ ...record, cid: newCid, contentCid: newContentCid, sizeBytes: data.length, mimeType, timestamp: Date.now() });

    toast('Content replaced successfully', 'success');
    modal.classList.remove('active');
    refreshStorage();
  } catch (err) {
    statusEl.textContent = `Error: ${err}`;
    toast(`Replace failed: ${err}`, 'error');
  } finally {
    confirmBtn.disabled = false;
  }
});

function setStorageTypeFields(type: string): void {
  document.querySelectorAll<HTMLElement>('.storage-type-fields').forEach(el => { el.style.display = 'none'; });
  const active = document.getElementById(`storageFields-${type}`);
  if (active) active.style.display = 'block';
}

function refreshStorage() {
  const options = localAccounts.map(a => `<option value="${escHtml(a.pub)}">${escHtml(a.username)}</option>`).join('');
  const noAcct = '<option value="">No accounts</option>';
  const newHtml = options || noAcct;

  // Populate account selectors - preserve selection and skip if unchanged (prevents mobile picker flicker)
  for (const id of ['#storageProviderAccount', '#storageContentFrom', '#retrieveContentFrom'] as const) {
    const sel = $<HTMLSelectElement>(id);
    if (sel.innerHTML !== newHtml) {
      const prev = sel.value;
      sel.innerHTML = newHtml;
      if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
    }
  }

  // Determine if any local account is already a provider
  const servingAccount = localAccounts.find(a => node.storage.isServing(a.pub));
  const serveForm = $('#serveStorageForm');
  const statsDiv = $('#myStorageStats');
  const stopArea = $('#stopServingArea');

  if (servingAccount) {
    serveForm.style.display = 'none';
    statsDiv.style.display = 'block';
    stopArea.style.display = 'block';
    // Populate my stats row
    const p = node.ledger.storageProviders.get(servingAccount.pub);
    if (p) {
      const uptime = `${node.storage.getUptimePct(p.pub)}%`;
      const latency = p.avgLatencyMs > 0 ? `${p.avgLatencyMs.toFixed(0)}ms` : '-';
      const lastReward = p.lastRewardEpoch > 0
        ? `${Math.round((Date.now() - p.lastRewardEpoch * 24 * 60 * 60 * 1000) / 3_600_000)}h ago`
        : 'Never';
      $('#myProviderStatsRow').innerHTML = `<tr>
        <td>${p.capacityGB.toLocaleString()} GB</td>
        <td>${uptime} (${p.heartbeatsLast24h}/6 heartbeats)</td>
        <td>${latency}</td>
        <td><strong>${p.score.toFixed(3)}</strong></td>
        <td>${formatUNIT(p.earningRate)}</td>
        <td>${formatUNIT(p.totalEarned)}</td>
        <td>${lastReward}</td>
      </tr>`;
    }
  } else {
    serveForm.style.display = 'block';
    statsDiv.style.display = 'none';
    stopArea.style.display = 'none';
  }

  // Render storage network stat bar
  const statBar = $('#storageNetworkStatBar') as HTMLElement | null;
  const providers = node.ledger.getStorageProviders();
  if (statBar) {
    const ACTIVE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const active = providers.filter(p => p.lastHeartbeat > now - ACTIVE_MS);
    const totalCapGB = providers.reduce((s, p) => s + p.capacityGB, 0);
    const storedBytes = active.reduce((s, p) => s + p.lastActualStoredBytes, 0);
    const freeGB = Math.max(0, totalCapGB - storedBytes / 1_073_741_824);
    const avgUptime = active.length
      ? active.reduce((s, p) => s + (p.heartbeatsLast24h / 6), 0) / active.length
      : 0;
    const avgScore = active.length
      ? active.reduce((s, p) => s + p.score, 0) / active.length
      : 0;
    const totalEarned = providers.reduce((s, p) => s + p.totalEarned, 0);
    const fmtGB = (gb: number) => gb >= 1024 ? `${(gb / 1024).toFixed(2)} TB` : `${gb.toFixed(1)} GB`;
    const chip = (label: string, value: string, color = 'var(--accent)') =>
      `<div style="background:var(--surface2);border-radius:8px;padding:8px 14px;min-width:110px;text-align:center;">
        <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;letter-spacing:.5px;text-transform:uppercase;">${label}</div>
        <div style="font-size:15px;font-weight:700;color:${color};">${value}</div>
      </div>`;
    statBar.innerHTML = [
      chip('Providers', `${active.length} / ${providers.length}`, active.length > 0 ? 'var(--success)' : 'var(--danger)'),
      chip('Total Capacity', fmtGB(totalCapGB)),
      chip('Free Space', fmtGB(freeGB), freeGB > 1 ? 'var(--success)' : 'var(--warning)'),
      chip('Avg Uptime', `${Math.round(avgUptime * 100)}%`, avgUptime >= 0.8 ? 'var(--success)' : avgUptime >= 0.4 ? 'var(--warning)' : 'var(--danger)'),
      chip('Avg Score', avgScore.toFixed(3), avgScore >= 0.8 ? 'var(--success)' : avgScore >= 0.4 ? 'var(--warning)' : 'var(--danger)'),
      chip('Total Earned', formatUNIT(totalEarned)),
    ].join('');
  }

  // Render storage network table
  const providersList = $('#storageProvidersList');
  if (providers.length === 0) {
    providersList.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">No storage providers registered yet</td></tr>';
  } else {
    const myPubs = new Set(localAccounts.map(a => a.pub));
    providersList.innerHTML = providers.map(p => {
      const isMine = myPubs.has(p.pub);
      const uptime = `${Math.round((p.heartbeatsLast24h / 6) * 100)}%`;
      const latency = p.avgLatencyMs > 0 ? `${p.avgLatencyMs.toFixed(0)}ms` : '-';
      const spotCheck = `${Math.round(p.spotCheckPassRate * 100)}%`;
      const scoreColor = p.score >= 0.8 ? 'var(--success)' : p.score >= 0.4 ? 'var(--warning)' : 'var(--danger)';
      return `<tr${isMine ? ' style="background:rgba(34,211,238,0.04);"' : ''}>
        <td>${copyBtn(p.pub)}${isMine ? ' <span style="color:var(--accent);font-size:11px;">(you)</span>' : ''}</td>
        <td>${p.capacityGB.toLocaleString()} GB</td>
        <td>${uptime}</td>
        <td>${latency}</td>
        <td>${spotCheck}</td>
        <td><strong style="color:${scoreColor}">${p.score.toFixed(3)}</strong></td>
        <td>${formatUNIT(p.earningRate)}</td>
        <td>${formatUNIT(p.totalEarned)}</td>
      </tr>`;
    }).join('');
  }

  // Render content library
  const libraryList = $('#contentLibraryList');
  const records = loadContentLibrary();
  const trackedCids = node.storage.getTrackedCids();
  const typeIcons: Record<string, string> = {
    image: '🖼️', video: '🎬', audio: '🎵', html: '🌐', css: '🎨',
    js: '⚙️', json: '📋', other: '📁',
  };
  if (records.length === 0) {
    libraryList.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">No content stored yet</td></tr>';
  } else {
    libraryList.innerHTML = records.map(r => {
      const date = new Date(r.timestamp).toLocaleDateString();
      const sizeStr = r.sizeBytes > 1024 * 1024
        ? `${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB`
        : r.sizeBytes > 1024 ? `${(r.sizeBytes / 1024).toFixed(1)} KB` : `${r.sizeBytes} B`;
      const icon = typeIcons[r.contentType] || '📄';
      const visCell = r.encrypted
        ? `<span style="color:var(--warning);font-size:11px;font-weight:600;">Private</span>`
        : `<span style="color:var(--accent);font-size:11px;font-weight:600;">Public</span>`;
      const tracked = trackedCids.get(r.cid);
      const providerCount = tracked ? tracked.confirmedProviders.size : 0;
      const providerCell = providerCount > 0
        ? `<span style="color:var(--success);font-size:11px;font-weight:600;">${providerCount}</span>`
        : `<span style="color:var(--text-muted);font-size:11px;">Local only</span>`;
      return `<tr>
        <td>${escHtml(r.name)}</td>
        <td>${icon} ${escHtml(r.contentType)}</td>
        <td>${visCell}</td>
        <td>${sizeStr}</td>
        <td>${date}</td>
        <td>${copyBtn(r.cid)}</td>
        <td>${providerCell}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-outline" style="font-size:11px;padding:2px 8px;"
            onclick="fillRetrieveCid('${escHtml(r.cid)}')">Use CID</button>
          <button class="btn btn-outline" style="font-size:11px;padding:2px 8px;"
            onclick="distributeFromLibrary('${escHtml(r.cid)}')">Distribute</button>
          <button class="btn btn-outline" style="font-size:11px;padding:2px 8px;color:var(--accent);border-color:var(--accent);"
            onclick="openReplaceModal('${escHtml(r.cid)}')">Replace</button>
          <button class="btn btn-outline" style="font-size:11px;padding:2px 8px;color:var(--danger);border-color:var(--danger);"
            onclick="removeFromLibraryAndRefresh('${escHtml(r.cid)}')">Remove</button>
        </td>
      </tr>`;
    }).join('');
  }
}

// Content type field switching
$('#storageContentType')?.addEventListener('change', () => {
  setStorageTypeFields($<HTMLSelectElement>('#storageContentType').value);
});
setStorageTypeFields($<HTMLSelectElement>('#storageContentType').value);

// Visibility badge
function updateVisibilityBadge(): void {
  const vis = $<HTMLSelectElement>('#storageVisibility').value;
  const badge = $('#visibilityBadge');
  if (!badge) return;
  if (vis === 'private') {
    badge.style.cssText = 'padding:10px 14px;border-radius:var(--radius);border:1px solid rgba(245,158,11,0.4);font-size:12px;font-weight:600;text-align:center;background:rgba(245,158,11,0.08);color:var(--warning);';
    badge.textContent = 'Private - AES-256-GCM';
  } else {
    badge.style.cssText = 'padding:10px 14px;border-radius:var(--radius);border:1px solid rgba(34,211,238,0.3);font-size:12px;font-weight:600;text-align:center;background:rgba(34,211,238,0.07);color:var(--accent);';
    badge.textContent = 'Public - unencrypted';
  }
}
$('#storageVisibility')?.addEventListener('change', updateVisibilityBadge);
updateVisibilityBadge();

// Media preview handlers
$('#imageFile')?.addEventListener('change', () => {
  const file = $<HTMLInputElement>('#imageFile').files?.[0];
  const preview = $('#imagePreview');
  const previewEl = $<HTMLImageElement>('#imagePreviewEl');
  if (file) {
    previewEl.src = URL.createObjectURL(file);
    preview.style.display = 'block';
    $('#imagePreviewInfo').textContent = `${file.name} - ${(file.size / 1024).toFixed(1)} KB - ${file.type || 'unknown'}`;
  } else { preview.style.display = 'none'; }
});

$('#videoFile')?.addEventListener('change', () => {
  const file = $<HTMLInputElement>('#videoFile').files?.[0];
  const preview = $('#videoPreview');
  if (file) {
    $<HTMLVideoElement>('#videoPreviewEl').src = URL.createObjectURL(file);
    preview.style.display = 'block';
    $('#videoPreviewInfo').textContent = `${file.name} - ${(file.size / 1024 / 1024).toFixed(2)} MB - ${file.type || 'unknown'}`;
  } else { preview.style.display = 'none'; }
});

$('#audioFile')?.addEventListener('change', () => {
  const file = $<HTMLInputElement>('#audioFile').files?.[0];
  const preview = $('#audioPreview');
  if (file) {
    $<HTMLAudioElement>('#audioPreviewEl').src = URL.createObjectURL(file);
    preview.style.display = 'block';
    $('#audioPreviewInfo').textContent = `${file.name} - ${(file.size / 1024).toFixed(1)} KB - ${file.type || 'unknown'}`;
  } else { preview.style.display = 'none'; }
});

$('#otherFile')?.addEventListener('change', () => {
  const file = $<HTMLInputElement>('#otherFile').files?.[0];
  $('#otherFileInfo').textContent = file
    ? `${file.name} - ${(file.size / 1024).toFixed(1)} KB - ${file.type || 'unknown type'}`
    : '';
});

// JSON validate
$('#btnValidateJson')?.addEventListener('click', () => {
  const content = $<HTMLTextAreaElement>('#jsonContent').value.trim();
  const result = $('#jsonValidationResult');
  try {
    JSON.parse(content);
    result.innerHTML = '<span style="color:var(--success)">Valid JSON</span>';
  } catch (err) {
    result.innerHTML = `<span style="color:var(--danger)">${escHtml(String(err))}</span>`;
  }
});

$('#btnServeStorage')?.addEventListener('click', async () => {
  const pub = $<HTMLSelectElement>('#storageProviderAccount').value;
  const capacityGB = parseFloat($<HTMLInputElement>('#storageCapacityGB').value);

  if (!pub) { toast('Select an account', 'error'); return; }
  if (!capacityGB || capacityGB <= 0) { toast('Enter a valid capacity in GB', 'error'); return; }

  const acc = localAccounts.find(a => a.pub === pub);
  if (!acc) { toast('Account not found', 'error'); return; }
  if (!node.store.isStarted()) { toast('Start the node first', 'error'); return; }

  const result = await node.registerStorage(pub, capacityGB, acc.keys);
  if (result.success) {
    toast(`Registered as storage provider: ${capacityGB} GB`, 'success');
    refreshStorage();
  } else {
    toast(`Error: ${result.error}`, 'error');
  }
});

$('#btnAdjustCapacity')?.addEventListener('click', async () => {
  const servingAcc = localAccounts.find(a => node.storage.isServing(a.pub));
  if (!servingAcc) { toast('Not currently serving storage', 'error'); return; }

  const newGB = parseInt($<HTMLInputElement>('#adjustCapacityGB').value, 10);
  if (!newGB || newGB <= 0) { toast('Enter a valid capacity in GB', 'error'); return; }

  const result = await node.registerStorage(servingAcc.pub, newGB, servingAcc.keys);
  if (result.success) { toast(`Capacity updated to ${newGB} GB`, 'success'); refreshStorage(); }
  else { toast(`Error: ${result.error}`, 'error'); }
});

$('#btnStopServing')?.addEventListener('click', async () => {
  const servingAcc = localAccounts.find(a => node.storage.isServing(a.pub));
  if (!servingAcc) { toast('Not currently serving storage', 'error'); return; }

  const result = await node.deregisterStorage(servingAcc.pub, servingAcc.keys);
  if (result.success) { toast('Deregistered from storage network', 'info'); refreshStorage(); }
  else { toast(`Error: ${result.error}`, 'error'); }
});

$('#btnManualHeartbeat')?.addEventListener('click', async () => {
  const servingAcc = localAccounts.find(a => node.storage.isServing(a.pub));
  if (!servingAcc) { toast('Not currently serving storage', 'error'); return; }

  const result = await node.storage.broadcastHeartbeat(servingAcc.pub, servingAcc.keys);
  if (result.success) { toast('Heartbeat sent', 'success'); refreshStorage(); }
  else { toast(`${result.error}`, 'error'); }
});

$('#btnClaimReward')?.addEventListener('click', async () => {
  const servingAcc = localAccounts.find(a => node.storage.isServing(a.pub));
  if (!servingAcc) { toast('Not currently serving storage', 'error'); return; }

  await node.storage.issueRewardsIfEligible();
  toast('Reward check complete - see balance if minted', 'info');
  refreshStorage();
});

$('#btnRefreshProviders')?.addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('#btnRefreshProviders');
  const orig = btn.textContent;
  btn.textContent = 'Refreshing…';
  btn.disabled = true;
  // Re-publish our full local chain so peers respond with theirs.
  // This is the only reliable way to pull storage-register / heartbeat blocks
  // that were published before we joined the GossipSub mesh.
  await node.broadcastLocalState();
  // Give peers time to receive our broadcast and reply with their blocks.
  await new Promise(r => setTimeout(r, 3000));
  refreshStorage();
  btn.textContent = orig;
  btn.disabled = false;
});

$('#btnStoreContent')?.addEventListener('click', async () => {
  const pub = $<HTMLSelectElement>('#storageContentFrom').value;
  const acc = localAccounts.find(a => a.pub === pub);
  if (!acc) { toast('Select an account', 'error'); return; }
  if (!node.store.isStarted()) { toast('Node not started', 'error'); return; }

  const contentType = $<HTMLSelectElement>('#storageContentType').value;
  const contentName = $<HTMLInputElement>('#storageContentName').value.trim() || contentType;

  let data: Uint8Array;
  let mimeType: string;

  switch (contentType) {
    case 'image': {
      const file = $<HTMLInputElement>('#imageFile').files?.[0];
      if (!file) { toast('Select an image file', 'error'); return; }
      const caption = $<HTMLInputElement>('#imageCaption').value.trim();
      data = new Uint8Array(await file.arrayBuffer());
      mimeType = file.type || 'image/jpeg';
      if (caption && !contentName) $<HTMLInputElement>('#storageContentName').value = caption;
      break;
    }
    case 'video': {
      const file = $<HTMLInputElement>('#videoFile').files?.[0];
      if (!file) { toast('Select a video file', 'error'); return; }
      data = new Uint8Array(await file.arrayBuffer());
      mimeType = file.type || 'video/mp4';
      break;
    }
    case 'audio': {
      const file = $<HTMLInputElement>('#audioFile').files?.[0];
      if (!file) { toast('Select an audio file', 'error'); return; }
      data = new Uint8Array(await file.arrayBuffer());
      mimeType = file.type || 'audio/mpeg';
      break;
    }
    case 'html': {
      const content = $<HTMLTextAreaElement>('#htmlContent').value.trim();
      if (!content) { toast('Enter HTML content', 'error'); return; }
      data = new TextEncoder().encode(content);
      mimeType = 'text/html';
      break;
    }
    case 'css': {
      const content = $<HTMLTextAreaElement>('#cssContent').value.trim();
      if (!content) { toast('Enter CSS content', 'error'); return; }
      data = new TextEncoder().encode(content);
      mimeType = 'text/css';
      break;
    }
    case 'js': {
      const content = $<HTMLTextAreaElement>('#jsContent').value.trim();
      if (!content) { toast('Enter JavaScript content', 'error'); return; }
      data = new TextEncoder().encode(content);
      mimeType = 'application/javascript';
      break;
    }
    case 'json': {
      const content = $<HTMLTextAreaElement>('#jsonContent').value.trim();
      if (!content) { toast('Enter JSON content', 'error'); return; }
      try { JSON.parse(content); } catch { toast('Invalid JSON - fix errors before storing', 'error'); return; }
      data = new TextEncoder().encode(content);
      mimeType = 'application/json';
      break;
    }
    case 'other': {
      const file = $<HTMLInputElement>('#otherFile').files?.[0];
      if (!file) { toast('Select a file', 'error'); return; }
      data = new Uint8Array(await file.arrayBuffer());
      mimeType = file.type || 'application/octet-stream';
      break;
    }
    default: { toast('Unknown content type', 'error'); return; }
  }

  try {
    const finalName = $<HTMLInputElement>('#storageContentName').value.trim() || contentType;
    const visibility = $<HTMLSelectElement>('#storageVisibility').value;
    const isEncrypted = visibility === 'private';

    // D6: warn if the network lacks enough free capacity for 2-node redundancy
    const feasibility = node.ledger.checkPublishFeasibility(data.length);
    if (!feasibility.feasible) {
      addLog(feasibility.warning!, 'warn');
      toast(feasibility.warning!, 'info');
    }

    const storeResult = isEncrypted
      ? await node.store.storeWithMeta(data, { mimeType, name: finalName }, acc.keys)
      : await node.store.storeWithMetaPublic(data, { mimeType, name: finalName });

    const { cid } = storeResult;
    const contentCid = (storeResult.meta as { contentCid?: string }).contentCid;
    const visLabel = isEncrypted ? 'private' : 'public';

    // Distribute to network providers. Pass both the meta CID and the inner content
    // CID so providers pin both blobs (they are separate UnixFS blocks).
    const cidsToDistribute = contentCid ? [cid, contentCid] : [cid];
    const distResult = await node.distributeContent(cidsToDistribute, pub, acc.keys);
    const distInfo = distResult.error
      ? `<span style="color:var(--warning);font-size:11px;">⚠ ${escHtml(distResult.error)}</span>`
      : `<span style="color:var(--success);font-size:11px;">✓ Sent to ${distResult.providers.length} provider(s)</span>`;
    if (distResult.error) addLog(`Storage distribution: ${distResult.error}`, 'warn');
    else addLog(`Content distributed to ${distResult.providers.length} provider(s)`, 'success');

    const resultEl = $('#storageCidResult');
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<strong>Stored!</strong> (${visLabel})&nbsp; CID: <span>${escHtml(cid)}</span> ${cpBtn(cid)}<br>${distInfo}`;

    addToContentLibrary({ cid, contentCid, name: finalName, contentType, mimeType, sizeBytes: data.length, timestamp: Date.now(), ownerPub: pub, encrypted: isEncrypted });
    toast(`Content stored (${visLabel})`, 'success');
    refreshStorage();
  } catch (err) {
    toast(`Error: ${err}`, 'error');
  }
});

// Retrieve content by CID
$('#btnRetrieveContent')?.addEventListener('click', async () => {
  const cid = $<HTMLInputElement>('#retrieveCid').value.trim();
  if (!cid) { toast('Enter a CID', 'error'); return; }

  const pub = $<HTMLSelectElement>('#retrieveContentFrom').value;
  const acc = localAccounts.find(a => a.pub === pub);
  if (!node.store.isStarted()) { toast('Node not started', 'error'); return; }

  const resultEl = $('#retrieveResult');
  resultEl.style.display = 'block';

  // Check library to know if content is encrypted
  const knownRecord = loadContentLibrary().find(r => r.cid === cid);
  const hint = knownRecord ? (knownRecord.encrypted ? 'encrypted' : 'public') : 'auto';
  resultEl.innerHTML = `<span class="spinner"></span> Retrieving${hint !== 'auto' ? ` (${hint})` : ''}...`;

  // Encrypted content requires the owner's keys; public content does not
  if (hint === 'encrypted' && !acc) { toast('Select the owner account to decrypt', 'error'); return; }

  let result: Awaited<ReturnType<typeof node.store.retrieveAuto>> = undefined;
  let lastErr: unknown;

  try {
    result = hint === 'public'
      ? await node.store.retrieveAuto(cid)
      : await node.store.retrieveAuto(cid, acc?.keys);
  } catch (err) {
    lastErr = err;
  }

  try {
    if (!result) {
      const errMsg = lastErr instanceof Error ? escHtml(lastErr.message) : '';
      resultEl.innerHTML = `<span style="color:var(--danger)">Content not found. Ensure the uploader's node is running and online. ${errMsg}</span>`;
      return;
    }

    const { data, meta, wasEncrypted } = result;
    const visLabel = wasEncrypted ? 'private / encrypted' : 'public / unencrypted';
    const mime = meta.mimeType || 'application/octet-stream';
    const sizeBytes = data.length;
    const sizeStr = sizeBytes > 1024 * 1024
      ? `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`
      : sizeBytes > 1024 ? `${(sizeBytes / 1024).toFixed(1)} KB` : `${sizeBytes} B`;

    let preview = '';

    const dataBuf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (mime.startsWith('image/')) {
      const url = URL.createObjectURL(new Blob([dataBuf], { type: mime }));
      preview = `<img src="${url}" alt="${escHtml(meta.name || '')}" style="max-width:100%;max-height:300px;border-radius:var(--radius);display:block;margin-bottom:8px;" />`;
    } else if (mime.startsWith('video/')) {
      const url = URL.createObjectURL(new Blob([dataBuf], { type: mime }));
      preview = `<video src="${url}" controls muted style="max-width:100%;max-height:300px;border-radius:var(--radius);display:block;margin-bottom:8px;"></video>`;
    } else if (mime.startsWith('audio/')) {
      const url = URL.createObjectURL(new Blob([dataBuf], { type: mime }));
      preview = `<audio src="${url}" controls style="width:100%;margin-bottom:8px;"></audio>`;
    } else if (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript') || mime.includes('neuron')) {
      let text = new TextDecoder().decode(data);
      if (mime.includes('json') || mime.includes('neuron')) {
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
      }
      const displayText = text.length > 5000 ? text.slice(0, 5000) + '\n\n[...truncated]' : text;
      preview = `<pre style="background:var(--surface2);padding:12px;border-radius:var(--radius);overflow:auto;max-height:340px;font-size:12px;font-family:var(--mono);white-space:pre-wrap;word-break:break-word;">${escHtml(displayText)}</pre>`;
    } else {
      preview = `<div style="color:var(--text-dim);font-size:13px;margin-bottom:8px;">Binary content - use the download button to save.</div>`;
    }

    const downloadUrl = URL.createObjectURL(new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: mime }));
    const ext = mime.includes('json') || mime.includes('neuron') ? '.json' : mime.includes('html') ? '.html' : mime.includes('css') ? '.css' : mime.includes('javascript') ? '.js' : '';
    const filename = escHtml((meta.name || cid.slice(0, 12)) + ext);

    resultEl.innerHTML = `
      ${preview}
      <div style="font-size:12px;color:var(--text-muted);margin-top:10px;margin-bottom:8px;line-height:1.8;">
        Visibility: <strong style="color:${wasEncrypted ? 'var(--warning)' : 'var(--accent)'}">${visLabel}</strong>
        &nbsp;|&nbsp; MIME: ${escHtml(mime)} &nbsp;|&nbsp; Size: ${sizeStr}${meta.name ? ` &nbsp;|&nbsp; Name: ${escHtml(meta.name)}` : ''}
      </div>
      <a href="${downloadUrl}" download="${filename}" class="btn btn-outline" style="font-size:12px;padding:6px 14px;text-decoration:none;">Download</a>
    `;
  } catch (err) {
    resultEl.innerHTML = `<span style="color:var(--danger)">Error: ${escHtml(String(err))}</span>`;
  }
});

// Clear content library
$('#btnClearLibrary')?.addEventListener('click', () => {
  saveContentLibrary([]);
  refreshStorage();
  toast('Content library cleared', 'info');
});

// ──── Contract template buttons ────

const TOKEN_TEMPLATE_NAME = 'SimpleToken';
const TOKEN_TEMPLATE_CODE = `// Simple fungible token (ERC-20 style)
// Deploy with: init("MyToken", "MTK", 1000000)
function init(name, symbol, totalSupply) {
  if (state.initialized) return { error: 'already initialized' };
  state.name = name;
  state.symbol = symbol;
  state.totalSupply = totalSupply;
  state.balances = {};
  state.balances[caller] = totalSupply;
  state.initialized = true;
  return { name, symbol, totalSupply };
}
function transfer(to, amount) {
  if (!state.balances[caller] || state.balances[caller] < amount)
    return { error: 'insufficient balance' };
  state.balances[caller] -= amount;
  state.balances[to] = (state.balances[to] || 0) + amount;
  return { success: true, from: caller, to, amount };
}
function balanceOf(address) {
  return { address, balance: state.balances[address] || 0 };
}
function getInfo() {
  return { name: state.name, symbol: state.symbol, totalSupply: state.totalSupply };
}`;

const NFT_TEMPLATE_NAME = 'NFTCollection';
const NFT_TEMPLATE_CODE = `// NFT Collection (ERC-721 style)
// Deploy with:  init("My Collection", "MNFT")
// Mint with:    mint("My artwork title", "<content-cid>")
// Transfer with: transfer(1, "recipient_pub_key")
function init(name, symbol) {
  if (state.initialized) return { error: 'already initialized' };
  state.name = name;
  state.symbol = symbol;
  state.tokens = {};
  state.nextId = 1;
  state.initialized = true;
  return { name, symbol };
}
function mint(metadata, cid) {
  const id = state.nextId++;
  state.tokens[id] = {
    owner: caller,
    metadata,
    cid,      // content CID (image, video, etc.)
    mintedAt: Date.now()
  };
  return { tokenId: id, owner: caller, cid };
}
function transfer(tokenId, to) {
  const token = state.tokens[tokenId];
  if (!token) return { error: 'token not found' };
  if (token.owner !== caller) return { error: 'not the owner' };
  const prev = token.owner;
  token.owner = to;
  return { success: true, tokenId, from: prev, to };
}
function ownerOf(tokenId) {
  const t = state.tokens[tokenId];
  return t ? { tokenId, owner: t.owner } : { error: 'not found' };
}
function tokenInfo(tokenId) {
  return state.tokens[tokenId] || { error: 'not found' };
}
function myTokens() {
  return Object.entries(state.tokens)
    .filter(([, t]) => t.owner === caller)
    .map(([id, t]) => ({ tokenId: Number(id), ...t }));
}
function totalSupply() {
  return { total: Object.keys(state.tokens).length };
}`;

$('#btnLoadTokenExample')?.addEventListener('click', () => {
  $<HTMLInputElement>('#contractName').value = TOKEN_TEMPLATE_NAME;
  $<HTMLTextAreaElement>('#contractCode').value = TOKEN_TEMPLATE_CODE;
  toast('Token template loaded', 'info');
});

$('#btnLoadNFTExample')?.addEventListener('click', () => {
  $<HTMLInputElement>('#contractName').value = NFT_TEMPLATE_NAME;
  $<HTMLTextAreaElement>('#contractCode').value = NFT_TEMPLATE_CODE;
  toast('NFT template loaded', 'info');
});

// ──── Boot ────
(async () => {
  await loadWallet();

  // Restore saved network UI
  if (savedNetwork !== 'testnet') {
    $('#networkBadge').textContent = savedNetwork.toUpperCase();
    $('#networkBadge').className = `network-badge ${savedNetwork}`;
    $('#btnTestnet').className = 'btn btn-outline';
    $('#btnMainnet').className = 'btn btn-primary';
  }

  // Restore saved tab (skip disabled tabs)
  const savedTab = localStorage.getItem('neuronchain_tab');
  const disabledTabs = ['transfer', 'contracts'];
  if (savedTab && !disabledTabs.includes(savedTab)) {
    const tabBtn = document.querySelector(`.tab-btn[data-tab="${savedTab}"]`) as HTMLButtonElement;
    if (tabBtn && !tabBtn.disabled) {
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      $$('.tab-panel').forEach((p) => p.classList.remove('active'));
      tabBtn.classList.add('active');
      $(`#tab-${savedTab}`).classList.add('active');
    }
  }

  refreshTab();
  addLog('NeuronChain initialized (Block-Lattice DAG, Face-Locked Keys)', 'info');
  addLog(`Network: ${savedNetwork} | Loaded ${localAccounts.length} account(s)`, 'info');
})();
