import { NeuronNode } from './network/node';
import { validateUsername, generateAccountKeys, buildAccount, AccountWithKeys } from './core/account';
import { NetworkType } from './core/dag-ledger';
import { KeyPair, signData } from './core/crypto';
import { startKeepAlive, stopKeepAlive } from './core/keepalive';
import { formatUNIT, parseUNIT, VERIFICATION_MINT_AMOUNT, AccountBlock } from './core/dag-block';
import { loadModels, startCamera, stopCamera, enrollFace, detectLiveness, captureFaceDescriptor } from './core/face-verify';
import { createEncryptedKeyBlob, recoverKeysWithFace, EncryptedKeyBlob } from './core/face-store';
import { acquireTabLock } from './core/tab-lock';

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
  throw new Error('Tab locked — another NeuronChain tab is active');
}

// ──── State ────
const savedNetwork = (localStorage.getItem('neuronchain_network') || 'testnet') as NetworkType;
let node = new NeuronNode(savedNetwork);
let localAccounts: AccountWithKeys[] = [];
let cameraStream: MediaStream | null = null;

const WALLET_KEY = 'neuronchain_wallet';

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

/** Escape HTML to prevent XSS when inserting user-supplied data into innerHTML */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const cpBtn = (text: string) => `<button class="btn-copy" onclick="navigator.clipboard.writeText('${escHtml(text)}')" title="Copy">&#x2398;</button>`;
const copyBtn = (text: string, display?: string) => `${cpBtn(text)}<span class="hash truncate">${escHtml(display || trunc(text, 14))}</span>`;

function addLog(msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
  const log = $('#nodeLog');
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerHTML = `<span class="time">[${fmtTime(Date.now())}]</span><span class="msg">${escHtml(msg)}</span>`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function resolveNamePlain(pub: string): string {
  if (!pub) return '—';
  for (const a of localAccounts) if (a.pub === pub) return a.username;
  for (const [, acc] of node.ledger.accounts) if (acc.pub === pub) return acc.username;
  return trunc(pub);
}

function resolveName(pub: string): string {
  if (!pub) return '—';
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
      nftRows.push(`<tr><td>#${escHtml(tokenId)}</td><td><a class="explorer-contract-link" style="cursor:pointer;color:var(--primary);text-decoration:underline;" data-contract-id="${escHtml(contractId)}">${escHtml(contract.name)}</a></td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(meta)}">${escHtml(meta)}</td><td>${token.cid ? escHtml(trunc(token.cid, 16)) : '—'}</td></tr>`);
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
        <div class="stat-item"><div class="stat-label">Avg Latency</div><div class="stat-value">${provider.avgLatencyMs > 0 ? provider.avgLatencyMs + ' ms' : '—'}</div></div>
      </div>
    </div>` : '';

  // Block history
  const blockRows = chain.map(b => {
    const status = node.ledger.getBlockStatus(b.hash);
    const statusColor = status === 'confirmed' ? 'var(--success)' : status === 'rejected' ? 'var(--danger)' : 'var(--warning)';
    const typeClass = b.type === 'send' ? 'badge-transfer' : b.type === 'receive' ? 'badge-create' : b.type === 'deploy' ? 'badge-deploy' : 'badge-call';
    let detail2 = '—';
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
        ${acc ? `<div class="stat-item"><div class="stat-label">Generation</div><div class="stat-value">${acc.generation ?? 0}</div></div>` : ''}
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

// ──── Wallet (localStorage — encrypted with session key) ────
const SESSION_KEY_NAME = 'neuronchain_session_key';

async function getOrCreateSessionKey(): Promise<CryptoKey> {
  const existing = sessionStorage.getItem(SESSION_KEY_NAME);
  if (existing) {
    const raw = Uint8Array.from(atob(existing), c => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const exported = await crypto.subtle.exportKey('raw', key);
  sessionStorage.setItem(SESSION_KEY_NAME, btoa(String.fromCharCode(...new Uint8Array(exported))));
  return key;
}

async function saveWallet() {
  const data = JSON.stringify(
    localAccounts.map((a) => ({ username: a.username, pub: a.pub, keys: a.keys, createdAt: a.createdAt, faceMapHash: a.faceMapHash }))
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
    localAccounts = (JSON.parse(parsed) as { username: string; pub: string; keys: KeyPair; createdAt: number; faceMapHash: string }[])
      .map((d) => ({ username: d.username, pub: d.pub, keys: d.keys, balance: 0, nonce: 0, createdAt: d.createdAt, faceMapHash: d.faceMapHash || '' }));
  } catch { /* corrupt */ }
}

function registerLocalKeys() {
  for (const acc of localAccounts) {
    node.addLocalKey(acc.pub, acc.keys);
    node.ledger.registerAccount(buildAccount(acc.username, acc.pub, acc.faceMapHash));
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
  $('#chainStats').innerHTML = `
    <div class="stat-item"><div class="stat-label">Network</div><div class="stat-value">${s.network}</div></div>
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
          <td>${b.type === 'send' ? '-' + formatUNIT(b.amount || 0) : b.type === 'receive' ? '+' + formatUNIT(b.receiveAmount || 0) : b.type === 'open' ? '+' + formatUNIT(VERIFICATION_MINT_AMOUNT) : '-'}</td>
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
    <div class="stat-item"><div class="stat-label">Peers</div><div class="stat-value">${s.peerCount}</div></div>
    <div class="stat-item"><div class="stat-label">Synapses</div><div class="stat-value">${s.synapses}</div></div>
    <div class="stat-item"><div class="stat-label">Peer ID</div><div class="stat-value small">${trunc(s.peerId, 16)}</div></div>
    <div class="stat-item"><div class="stat-label">Network</div><div class="stat-value small">${s.network}</div></div>
  `;
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
      saveWallet();
      refreshAccount();
      refreshTransfer();
      refreshContracts();
      toast(`Account "${acc.username}" removed`, 'info');
    });
  });
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
    `<option value="__unit__">UNIT — ${formatUNIT(node.ledger.getAccountBalance(fromPub))} available</option>`,
  ];

  for (const [contractId, contract] of node.ledger.contracts) {
    const state = contract.state as Record<string, unknown>;
    if (state.balances && typeof state.balances === 'object' && state.symbol) {
      const balances = state.balances as Record<string, number>;
      // Check by pub key (correct) or username (legacy — pre-fix transfers)
      const bal = (balances[fromPub] ?? 0) + (fromUsername ? (balances[fromUsername] ?? 0) : 0);
      if (bal <= 0) continue;
      const sym = escHtml(String(state.symbol));
      options.push(`<option value="${escHtml(contractId)}">${escHtml(contract.name)} (${sym}) — ${bal.toLocaleString()} available</option>`);
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
      const cidStr = token.cid ? escHtml(token.cid) : '—';
      rows.push(`<tr>
        <td>#${escHtml(tokenId)}</td>
        <td title="${escHtml(contractId)}">${escHtml(contract.name)}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(meta)}">${escHtml(meta)}</td>
        <td><span class="hash truncate" title="${cidStr}">${cidStr !== '—' ? trunc(cidStr, 16) : '—'}</span></td>
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
        const to = prompt(`Transfer NFT #${tokenId} — enter recipient username or public key:`);
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
      name = `${d.capacityGB} GB`;
    } catch { /* skip */ }
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
    syncEl.innerHTML = '<span style="color:var(--danger)">Node offline — start node to sync</span>';
  } else if (total === 0 && isSyncing) {
    syncEl.innerHTML = '<span class="spinner"></span> Connecting to relay and syncing...';
  } else if (isSyncing) {
    syncEl.innerHTML = `<span class="spinner"></span> Syncing — ${total} blocks &middot; ${accounts} accounts &middot; ${pending > 0 ? pending + ' pending' : 'confirming...'}`;
  } else {
    syncEl.innerHTML = `<span style="color:var(--success)">&#10003;</span> Synced — ${total} blocks &middot; ${accounts} accounts &middot; ${nodeStats.synapses} synapses`;
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
  ['#contractFrom', '#callFrom'].forEach((sel) => {
    $(sel).innerHTML = localAccounts.map((a) => `<option value="${escHtml(a.username)}">${escHtml(a.username)}</option>`).join('');
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
  toast('Testnet reset — reloading...', 'success');
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
      addLog('FaceID: Liveness FAILED — not enough movement detected', 'error');
      toast('Liveness failed — try moving your head more', 'error');
      statusEl.innerHTML = '<span style="color:var(--danger)">Liveness failed. Try again with more head movement.</span>';
      hideCameraModal(); restoreCreateBtn(); return;
    }
    // Step 2: Face enrollment
    setCameraStatus('<span class="spinner"></span> Step 2/2: Hold still — capturing face map');
    const faceMap = await enrollFace(video, (step, total, status) => {
      overlay.textContent = `[${step}/${total}] ${status}`;
      setCameraStatus(`<span class="spinner"></span> Step 2/2: Sample ${step}/${total}`);
    });
    hideCameraModal();

    if (!faceMap) {
      addLog('FaceID: Face enrollment FAILED — could not capture enough samples', 'error');
      toast('Face enrollment failed', 'error');
      statusEl.innerHTML = '<span style="color:var(--danger)">Face enrollment failed. Try again with better lighting.</span>';
      restoreCreateBtn(); return;
    }
    statusEl.innerHTML = '<span style="color:var(--accent)"><span class="spinner"></span> Generating keys and encrypting with face...</span>';

    // Generate ECDSA key pair
    const keys = await generateAccountKeys();

    // Encrypt keys with face-derived AES key
    const keyBlob = await createEncryptedKeyBlob(keys, username, faceMap.quantized, faceMap.hash);

    // Register account
    statusEl.innerHTML = '<span style="color:var(--accent)"><span class="spinner"></span> Creating account on-chain...</span>';
    const account = buildAccount(username, keys.pub, faceMap.hash, faceMap.canonical);
    node.ledger.registerAccount(account);

    // Create open block (mints 1M UNIT)
    const openBlock = await node.ledger.openAccount(keys.pub, faceMap.hash, keys, faceMap.canonical);

    // Submit through node (publishes to libp2p network, triggers auto-vote)
    await node.submitBlock(openBlock);
    const accPayload = `account:${keys.pub}:${username}:${account.createdAt}:${faceMap.hash}`;
    const accSig = await signData(accPayload, keys);
    node.net.saveAccount(keys.pub, { username, pub: keys.pub, balance: 1000000, nonce: 0, createdAt: account.createdAt, faceMapHash: faceMap.hash, faceDescriptor: JSON.stringify(faceMap.canonical), keyBlobHash: keyBlob.blobHash || '', _sig: accSig });
    node.net.saveKeyBlob(keys.pub, keyBlob as unknown as Record<string, unknown>);

    // Store locally
    const fullAcc: AccountWithKeys = { ...account, keys, balance: 1000000 };
    localAccounts.push(fullAcc);
    node.addLocalKey(keys.pub, keys);
    saveWallet();

    const keysJson = JSON.stringify(keys, null, 2);
    statusEl.innerHTML = `<div style="margin-top:12px;">
      <span style="color:var(--success);font-weight:600;">Account created! +${formatUNIT(VERIFICATION_MINT_AMOUNT)} UNIT minted.</span><br>
      <div class="stat-item" style="margin-top:8px;"><div class="stat-label">Username</div><div class="stat-value small" style="user-select:all;">${username}</div></div>
      <div class="stat-item" style="margin-top:4px;"><div class="stat-label">Public Key</div><div class="stat-value small" style="user-select:all;">${trunc(keys.pub, 40)}</div></div>
      <div class="stat-item" style="margin-top:4px;"><div class="stat-label">Face Map Hash</div><div class="stat-value small" style="user-select:all;">${trunc(faceMap.hash, 24)}</div></div>
      <div class="secret-box" style="margin-top:12px;">
        <div class="warn-text">&#9888; BACKUP KEY PAIR — save this as a secondary recovery method.</div>
        <pre class="secret-value" style="white-space:pre-wrap;font-size:11px;">${keysJson}</pre>
      </div>
      <p style="color:var(--accent);font-size:12px;margin-top:8px;">Primary recovery: scan your face on any device. Backup: paste this key pair.</p>
    </div>`;

    toast(`${username} created — ${formatUNIT(VERIFICATION_MINT_AMOUNT)} UNIT`, 'success');
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

$('#btnRecoverFace').addEventListener('click', async () => {
  const username = $<HTMLInputElement>('#recoverUsername').value.trim().toLowerCase();
  if (!username) { toast('Enter your username', 'error'); return; }

  const statusEl = $('#recoverStatus');
  const video = $<HTMLVideoElement>('#faceVideo');

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
      $('#btnRecoverFace').removeAttribute('disabled');
      statusEl.innerHTML = '<span style="color:var(--danger)">Account not found on chain. Start node first.</span>';
      return;
    }
    const blob: EncryptedKeyBlob = {
      encryptedKeys: String(blobData.encryptedKeys),
      faceMapHash: String(blobData.faceMapHash),
      username: String(blobData.username),
      pub: String(blobData.pub),
      createdAt: Number(blobData.createdAt),
      blobHash: blobData.blobHash ? String(blobData.blobHash) : undefined,
    };

    // Verify key blob hash against on-chain account data (prevents relay from serving fake blobs)
    const onChainAccount = await node.net.loadAccount(blob.pub);
    if (onChainAccount && onChainAccount.keyBlobHash && blob.blobHash) {
      const { verifyKeyBlobHash } = await import('./core/face-store');
      const hashValid = await verifyKeyBlobHash(blob, String(onChainAccount.keyBlobHash));
      if (!hashValid) {
        toast('Key blob hash mismatch — blob may be tampered', 'error');
        hideCameraModal();
        $('#btnRecoverFace').removeAttribute('disabled');
        statusEl.innerHTML = '<span style="color:var(--danger)">Key blob integrity check failed. The relay may have served a tampered blob.</span>';
        return;
      }
    }

    setCameraStatus('<span class="spinner"></span> Starting camera...');
    cameraStream = await startCamera(video);

    setCameraStatus('<span class="spinner"></span> Look at the camera — capturing face...');
    await new Promise((r) => setTimeout(r, 1500));

    const desc = await captureFaceDescriptor(video);
    hideCameraModal();

    if (!desc) { toast('No face detected', 'error'); statusEl.innerHTML = '<span style="color:var(--danger)">No face detected. Try again.</span>'; $('#btnRecoverFace').removeAttribute('disabled'); return; }

    statusEl.innerHTML = '<span style="color:var(--accent)"><span class="spinner"></span> Decrypting keys with face...</span>';

    const keys = await recoverKeysWithFace(blob, desc.data);

    if (!keys) {
      statusEl.innerHTML = '<span style="color:var(--danger)">Face did not match. Decryption failed. Try again with better lighting.</span>';
      toast('Face mismatch — recovery failed', 'error');
      $('#btnRecoverFace').removeAttribute('disabled');
      return;
    }

    // Recovery successful!
    const account = buildAccount(username, keys.pub, blob.faceMapHash);
    node.ledger.registerAccount(account);
    const fullAcc: AccountWithKeys = { ...account, keys, balance: 0 };
    if (!localAccounts.find((a) => a.pub === keys.pub)) {
      localAccounts.push(fullAcc);
      node.addLocalKey(keys.pub, keys);
      saveWallet();
    }

    statusEl.innerHTML = `<div style="margin-top:8px;"><span style="color:var(--success);font-weight:600;">Account recovered: ${username}</span></div>`;
    toast(`Recovered: ${username}`, 'success');
    addLog(`Account recovered via face: ${username}`, 'success');
    refreshAccount(); refreshTransfer(); refreshContracts();
  } catch (err) {
    toast(`Recovery error: ${err}`, 'error');
    hideCameraModal();
  }
  $('#btnRecoverFace').removeAttribute('disabled');
});

// ──── Key Pair Recovery (backup method) ────

$('#btnToggleKeyRecover').addEventListener('click', () => {
  const section = $('#keyRecoverSection');
  section.style.display = section.style.display === 'none' ? 'block' : 'none';
});

$('#btnRecoverKeys').addEventListener('click', () => {
  const username = $<HTMLInputElement>('#recoverUsername').value.trim().toLowerCase();
  const keysRaw = $<HTMLTextAreaElement>('#recoverKeyPair').value.trim();
  if (!username || !keysRaw) { toast('Enter username and key pair', 'error'); return; }

  try {
    const keys = JSON.parse(keysRaw) as KeyPair;
    if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) { toast('Invalid key format — needs pub, priv, epub, epriv', 'error'); return; }

    const existing = node.ledger.getAccountByUsername(username);
    if (existing && existing.pub !== keys.pub) { toast('Key does not match this username', 'error'); return; }

    const account = buildAccount(username, keys.pub, existing?.faceMapHash || '');
    if (!existing) node.ledger.registerAccount(account);

    if (!localAccounts.find((a) => a.pub === keys.pub)) {
      const fullAcc: AccountWithKeys = { ...account, keys, balance: existing?.balance || 0 };
      localAccounts.push(fullAcc);
      node.addLocalKey(keys.pub, keys);
      saveWallet();
    }

    $('#recoverStatus').innerHTML = `<span style="color:var(--success);">Recovered: ${username}</span>`;
    toast(`Recovered: ${username}`, 'success');
    addLog(`Account recovered via key pair: ${username}`, 'success');
    refreshAccount(); refreshTransfer(); refreshContracts();
  } catch { toast('Invalid JSON', 'error'); }
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

  const deployResult = await node.ledger.createDeploy(sender.pub, name || 'Unnamed', code, sender.keys);
  if (deployResult.error) { toast(deployResult.error, 'error'); return; }
  const sub = await node.submitBlock(deployResult.block!);
  if (!sub.success) { toast(`Deploy failed: ${sub.error}`, 'error'); return; }

  const contractId = deployResult.block!.hash;

  if (initArgsStr) {
    let initArgs: unknown[];
    try { initArgs = JSON.parse(initArgsStr); } catch { toast('Deployed, but constructor args are invalid JSON — call init() manually', 'error'); refreshContracts(); return; }
    if (!Array.isArray(initArgs)) { toast('Deployed, but constructor args must be a JSON array — call init() manually', 'error'); refreshContracts(); return; }
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
function wireNodeEvents() {
  if (nodeEventsWired) return;
  nodeEventsWired = true;
  node.on('block:confirmed', (b: unknown) => {
    const block = b as { type: string; accountPub: string };
    addLog(`Confirmed: ${block.type} by ${resolveNamePlain(block.accountPub)}`, 'success');
    refreshTab();
  });
  node.on('block:conflict', (b: unknown) => {
    const block = b as { hash: string; type: string; accountPub: string };
    addLog(`CONFLICT: fork detected for ${block.type} by ${resolveNamePlain(block.accountPub)} — voting started`, 'warn');
    refreshTab();
  });
  node.on('block:rejected', (b: unknown) => {
    const block = b as { hash: string };
    addLog(`Rejected: ${trunc(block.hash)}`, 'error');
    refreshTab();
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
    refreshTab();
  });
  node.on('block:received', () => {
    refreshTab();
  });
  node.on('resync', (data: unknown) => {
    const d = data as { newAccounts: number; newBlocks: number };
    if (d.newAccounts > 0 || d.newBlocks > 0) {
      addLog(`Resync: +${d.newAccounts} accounts, +${d.newBlocks} blocks`, 'info');
      refreshTab();
    }
  });
  node.on('generation:reset', () => {
    // Another peer broadcast a higher generation reset — reload to clear all in-memory state
    localAccounts = [];
    localStorage.removeItem(WALLET_KEY);
    toast('Network reset received — reloading...', 'warn');
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
  refreshInterval = setInterval(() => refreshTab(), 5000);
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

(window as unknown as Record<string, unknown>)['removeFromLibraryAndRefresh'] = (cid: string) => {
  removeFromContentLibrary(cid);
  refreshStorage();
};

(window as unknown as Record<string, unknown>)['fillRetrieveCid'] = (cid: string) => {
  const el = $<HTMLInputElement>('#retrieveCid');
  el.value = cid;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

function setStorageTypeFields(type: string): void {
  document.querySelectorAll<HTMLElement>('.storage-type-fields').forEach(el => { el.style.display = 'none'; });
  const active = document.getElementById(`storageFields-${type}`);
  if (active) active.style.display = 'block';
}

function refreshStorage() {
  const options = localAccounts.map(a => `<option value="${escHtml(a.pub)}">${escHtml(a.username)}</option>`).join('');
  const noAcct = '<option value="">No accounts</option>';

  // Populate account selectors
  $<HTMLSelectElement>('#storageProviderAccount').innerHTML = options || noAcct;
  $<HTMLSelectElement>('#storageContentFrom').innerHTML = options || noAcct;
  $<HTMLSelectElement>('#retrieveContentFrom').innerHTML = options || noAcct;

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
      const latency = p.avgLatencyMs > 0 ? `${p.avgLatencyMs.toFixed(0)}ms` : '—';
      const lastReward = p.lastRewardEpoch > 0
        ? `${Math.round((Date.now() - p.lastRewardEpoch * 24 * 60 * 60 * 1000) / 3_600_000)}h ago`
        : 'Never';
      $('#myProviderStatsRow').innerHTML = `<tr>
        <td>${p.capacityGB.toLocaleString()} GB</td>
        <td>${uptime} (${p.heartbeatsLast24h}/6 heartbeats)</td>
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

  // Render storage network table
  const providersList = $('#storageProvidersList');
  const providers = node.ledger.getStorageProviders();
  if (providers.length === 0) {
    providersList.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">No storage providers registered yet</td></tr>';
  } else {
    const myPubs = new Set(localAccounts.map(a => a.pub));
    providersList.innerHTML = providers.map(p => {
      const isMine = myPubs.has(p.pub);
      const uptime = `${Math.round((p.heartbeatsLast24h / 6) * 100)}%`;
      const latency = p.avgLatencyMs > 0 ? `${p.avgLatencyMs.toFixed(0)}ms` : '—';
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
  const typeIcons: Record<string, string> = {
    image: '🖼️', video: '🎬', audio: '🎵', html: '🌐', css: '🎨',
    js: '⚙️', json: '📋', other: '📁',
  };
  if (records.length === 0) {
    libraryList.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No content stored yet</td></tr>';
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
      return `<tr>
        <td>${escHtml(r.name)}</td>
        <td>${icon} ${escHtml(r.contentType)}</td>
        <td>${visCell}</td>
        <td>${sizeStr}</td>
        <td>${date}</td>
        <td>${copyBtn(r.cid)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-outline" style="font-size:11px;padding:2px 8px;"
            onclick="fillRetrieveCid('${escHtml(r.cid)}')">Use CID</button>
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
setStorageTypeFields('json');

// Visibility badge
function updateVisibilityBadge(): void {
  const vis = $<HTMLSelectElement>('#storageVisibility').value;
  const badge = $('#visibilityBadge');
  if (!badge) return;
  if (vis === 'private') {
    badge.style.cssText = 'padding:10px 14px;border-radius:var(--radius);border:1px solid rgba(245,158,11,0.4);font-size:12px;font-weight:600;text-align:center;background:rgba(245,158,11,0.08);color:var(--warning);';
    badge.textContent = 'Private — AES-256-GCM';
  } else {
    badge.style.cssText = 'padding:10px 14px;border-radius:var(--radius);border:1px solid rgba(34,211,238,0.3);font-size:12px;font-weight:600;text-align:center;background:rgba(34,211,238,0.07);color:var(--accent);';
    badge.textContent = 'Public — unencrypted';
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
    $('#imagePreviewInfo').textContent = `${file.name} — ${(file.size / 1024).toFixed(1)} KB — ${file.type || 'unknown'}`;
  } else { preview.style.display = 'none'; }
});

$('#videoFile')?.addEventListener('change', () => {
  const file = $<HTMLInputElement>('#videoFile').files?.[0];
  const preview = $('#videoPreview');
  if (file) {
    $<HTMLVideoElement>('#videoPreviewEl').src = URL.createObjectURL(file);
    preview.style.display = 'block';
    $('#videoPreviewInfo').textContent = `${file.name} — ${(file.size / 1024 / 1024).toFixed(2)} MB — ${file.type || 'unknown'}`;
  } else { preview.style.display = 'none'; }
});

$('#audioFile')?.addEventListener('change', () => {
  const file = $<HTMLInputElement>('#audioFile').files?.[0];
  const preview = $('#audioPreview');
  if (file) {
    $<HTMLAudioElement>('#audioPreviewEl').src = URL.createObjectURL(file);
    preview.style.display = 'block';
    $('#audioPreviewInfo').textContent = `${file.name} — ${(file.size / 1024).toFixed(1)} KB — ${file.type || 'unknown'}`;
  } else { preview.style.display = 'none'; }
});

$('#otherFile')?.addEventListener('change', () => {
  const file = $<HTMLInputElement>('#otherFile').files?.[0];
  $('#otherFileInfo').textContent = file
    ? `${file.name} — ${(file.size / 1024).toFixed(1)} KB — ${file.type || 'unknown type'}`
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
  if (!node.helia.isStarted()) { toast('Start the node first', 'error'); return; }

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
  toast('Reward check complete — see balance if minted', 'info');
  refreshStorage();
});

$('#btnRefreshProviders')?.addEventListener('click', () => refreshStorage());

$('#btnStoreContent')?.addEventListener('click', async () => {
  const pub = $<HTMLSelectElement>('#storageContentFrom').value;
  const acc = localAccounts.find(a => a.pub === pub);
  if (!acc) { toast('Select an account', 'error'); return; }
  if (!node.helia.isStarted()) { toast('Node not started', 'error'); return; }

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
      try { JSON.parse(content); } catch { toast('Invalid JSON — fix errors before storing', 'error'); return; }
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

    const storeResult = isEncrypted
      ? await node.helia.storeWithMeta(data, { mimeType, name: finalName }, acc.keys)
      : await node.helia.storeWithMetaPublic(data, { mimeType, name: finalName });

    const { cid } = storeResult;
    const visLabel = isEncrypted ? 'private' : 'public';

    const resultEl = $('#storageCidResult');
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<strong>Stored!</strong> (${visLabel})&nbsp; CID: <span>${escHtml(cid)}</span> ${cpBtn(cid)}`;

    addToContentLibrary({ cid, name: finalName, contentType, mimeType, sizeBytes: data.length, timestamp: Date.now(), ownerPub: pub, encrypted: isEncrypted });
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
  if (!acc) { toast('Select an account', 'error'); return; }
  if (!node.helia.isStarted()) { toast('Node not started', 'error'); return; }

  const resultEl = $('#retrieveResult');
  resultEl.style.display = 'block';

  // Check library to know if content is encrypted
  const knownRecord = loadContentLibrary().find(r => r.cid === cid);
  const hint = knownRecord ? (knownRecord.encrypted ? 'encrypted' : 'public') : 'auto';
  resultEl.innerHTML = `<span class="spinner"></span> Retrieving${hint !== 'auto' ? ` (${hint})` : ''}...`;

  try {
    // If we know it's public, skip the encrypted attempt to avoid spurious errors
    const result = hint === 'public'
      ? await node.helia.retrieveAuto(cid)
      : await node.helia.retrieveAuto(cid, acc.keys);

    if (!result) {
      resultEl.innerHTML = '<span style="color:var(--danger)">Content not found or decryption failed. Ensure the node is running and you are using the correct account key.</span>';
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

    if (mime.startsWith('image/')) {
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      preview = `<img src="${url}" alt="${escHtml(meta.name || '')}" style="max-width:100%;max-height:300px;border-radius:var(--radius);display:block;margin-bottom:8px;" />`;
    } else if (mime.startsWith('video/')) {
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      preview = `<video src="${url}" controls muted style="max-width:100%;max-height:300px;border-radius:var(--radius);display:block;margin-bottom:8px;"></video>`;
    } else if (mime.startsWith('audio/')) {
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      preview = `<audio src="${url}" controls style="width:100%;margin-bottom:8px;"></audio>`;
    } else if (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript') || mime.includes('neuron')) {
      let text = new TextDecoder().decode(data);
      if (mime.includes('json') || mime.includes('neuron')) {
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
      }
      const displayText = text.length > 5000 ? text.slice(0, 5000) + '\n\n[...truncated]' : text;
      preview = `<pre style="background:var(--surface2);padding:12px;border-radius:var(--radius);overflow:auto;max-height:340px;font-size:12px;font-family:var(--mono);white-space:pre-wrap;word-break:break-word;">${escHtml(displayText)}</pre>`;
    } else {
      preview = `<div style="color:var(--text-dim);font-size:13px;margin-bottom:8px;">Binary content — use the download button to save.</div>`;
    }

    const downloadUrl = URL.createObjectURL(new Blob([data], { type: mime }));
    const ext = mime.includes('json') || mime.includes('neuron') ? '.json' : mime.includes('html') ? '.html' : mime.includes('css') ? '.css' : mime.includes('javascript') ? '.js' : '';
    const filename = escHtml((meta.name || cid.slice(0, 12)) + ext);

    resultEl.innerHTML = `
      ${preview}
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;line-height:1.8;">
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
// Mint with:    mint("My artwork title", "<helia-cid>")
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
    cid,      // Helia/IPFS content CID (image, video, etc.)
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
