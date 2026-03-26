import { NeuronNode } from './network/node';
import { validateUsername, generateAccountKeys, buildAccount, AccountWithKeys } from './core/account';
import { NetworkType } from './core/dag-ledger';
import { KeyPair } from './core/crypto';
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
const cpBtn = (text: string) => `<button class="btn-copy" onclick="navigator.clipboard.writeText('${text}')" title="Copy">&#x2398;</button>`;
const copyBtn = (text: string, display?: string) => `${cpBtn(text)}<span class="hash truncate">${display || trunc(text, 14)}</span>`;

function addLog(msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
  const log = $('#nodeLog');
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerHTML = `<span class="time">[${fmtTime(Date.now())}]</span><span class="msg">${msg}</span>`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function resolveName(pub: string): string {
  for (const a of localAccounts) if (a.pub === pub) return a.username;
  for (const [, acc] of node.ledger.accounts) if (acc.pub === pub) return acc.username;
  return trunc(pub);
}

// ──── Wallet (localStorage — keys for active session only) ────
function saveWallet() {
  localStorage.setItem(WALLET_KEY, JSON.stringify(
    localAccounts.map((a) => ({ username: a.username, pub: a.pub, keys: a.keys, createdAt: a.createdAt, faceMapHash: a.faceMapHash }))
  ));
}
function loadWallet() {
  try {
    const raw = localStorage.getItem(WALLET_KEY);
    if (!raw) return;
    localAccounts = (JSON.parse(raw) as { username: string; pub: string; keys: KeyPair; createdAt: number; faceMapHash: string }[])
      .map((d) => ({ username: d.username, pub: d.pub, keys: d.keys, balance: 0, nonce: 0, createdAt: d.createdAt, faceMapHash: d.faceMapHash || '' }));
  } catch { /* corrupt */ }
}

function registerLocalKeys() {
  for (const acc of localAccounts) {
    node.localKeys.set(acc.pub, acc.keys);
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
    refreshTab();
  });
});

function setNodeDependentTabs(enabled: boolean) {
  const tabs = ['transfer', 'contracts'];
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
    <div class="stat-item"><div class="stat-label">Shards</div><div class="stat-value">${s.shards}</div></div>
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
        const unclaimed = node.ledger.getUnclaimedForAccount(acc.pub);
        const unclaimedStr = unclaimed.length > 0 ? ` <span style="color:var(--success)">(+${unclaimed.length} pending)</span>` : '';
        return `<tr>
          <td>${acc.username}</td>
          <td><span class="hash truncate">${trunc(acc.pub, 20)}</span></td>
          <td>${formatUNIT(bal)} UNIT${unclaimedStr}</td>
          <td><button class="btn btn-outline" onclick="navigator.clipboard.writeText('${acc.username}')">Copy</button></td>
        </tr>`;
      }).join('');
}

function refreshTransfer() {
  $<HTMLSelectElement>('#txFrom').innerHTML =
    localAccounts.map((a) => `<option value="${a.username}">${a.username} (${formatUNIT(node.ledger.getAccountBalance(a.pub))} UNIT)</option>`).join('');

  const unclaimed: { sendBlockHash: string; fromPub: string; amount: number; forUsername: string }[] = [];
  for (const acc of localAccounts) {
    for (const u of node.ledger.getUnclaimedForAccount(acc.pub)) {
      unclaimed.push({ ...u, forUsername: acc.username });
    }
  }

  const el = $('#unclaimedReceives');
  if (unclaimed.length === 0) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No pending receives.</p>';
  } else {
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>From</th><th>To</th><th>Amount</th><th>Action</th></tr></thead>
      <tbody>${unclaimed.map((u) => `<tr>
        <td>${resolveName(u.fromPub)}</td><td>${u.forUsername}</td><td>${formatUNIT(u.amount)} UNIT</td>
        <td><button class="btn btn-success btn-claim" data-hash="${u.sendBlockHash}" data-pub="${node.ledger.resolveToPublicKey(u.forUsername) || ''}">Claim</button></td>
      </tr>`).join('')}</tbody></table></div>`;

    el.querySelectorAll('.btn-claim').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const hash = btn.getAttribute('data-hash')!;
        const pub = btn.getAttribute('data-pub')!;
        const acc = localAccounts.find((a) => a.pub === pub);
        if (!acc) return;
        const result = await node.ledger.createReceive(pub, hash, acc.keys);
        if (result.block) {
          await node.submitBlock(result.block);
          toast(`Claimed ${formatUNIT(result.block.receiveAmount || 0)} UNIT`, 'success');
          refreshTab();
        } else { toast(`Claim failed: ${result.error}`, 'error'); }
      });
    });
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
  return `<tr>
    <td>${copyBtn(b.hash)}</td>
    <td><span class="badge ${typeClass}">${b.type}</span></td>
    <td>${cpBtn(b.accountPub)}${resolveName(b.accountPub)}</td>
    <td>${b.type === 'send' ? resolveName(b.recipient || '') : b.type === 'receive' ? resolveName(b.sendFrom || '') : '-'}</td>
    <td>${b.type === 'send' ? formatUNIT(b.amount || 0) : b.type === 'receive' ? formatUNIT(b.receiveAmount || 0) : b.type === 'open' ? formatUNIT(VERIFICATION_MINT_AMOUNT) : '-'}</td>
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
    syncEl.innerHTML = `<span style="color:var(--success)">&#10003;</span> Synced — ${total} blocks &middot; ${accounts} accounts &middot; ${nodeStats.shards} shards`;
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
    $(sel).innerHTML = localAccounts.map((a) => `<option value="${a.username}">${a.username}</option>`).join('');
  });
  const tbody = $('#contractsList');
  const contracts = Array.from(node.ledger.contracts.entries());
  tbody.innerHTML = contracts.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No contracts yet.</td></tr>'
    : contracts.map(([id, c]) => `<tr>
        <td><span class="hash truncate">${trunc(id, 14)}</span></td><td>${c.name}</td><td>${resolveName(c.owner)}</td>
        <td>${fmtTime(c.deployedAt)}</td><td><button class="btn btn-outline" onclick="document.getElementById('callContractId').value='${id}'">Call</button></td>
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
  await node.gunNet.clearAll();
  node.ledger.reset();
  localAccounts = [];
  node.localKeys.clear();
  localStorage.removeItem(WALLET_KEY);
  localStorage.removeItem('neuronchain_tab');
  localStorage.removeItem('neuronchain_facemaps');
  // Reload page to fully clear Gun's in-memory state
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
  // Publish all local data to Gun (accounts + blocks created before node started)
  node.publishLocalData();

  btn.innerHTML = origText;
  $('#btnStopNode').removeAttribute('disabled');
  $('#btnStartValidating').removeAttribute('disabled');
  $('#statusDot').classList.add('active');
  setNodeDependentTabs(true);
  startKeepAlive(() => refreshTab());
  wireNodeEvents();
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
  $('#btnStartValidating').setAttribute('disabled', '');
  $('#btnStopValidating').setAttribute('disabled', '');
  $('#statusDot').classList.remove('active');
  setNodeDependentTabs(false);
  stopKeepAlive();
  addLog('Node stopped', 'warn');
  refreshNode();
});

$('#btnStartValidating').addEventListener('click', () => {
  node.startValidating();
  $('#btnStartValidating').setAttribute('disabled', '');
  $('#btnStopValidating').removeAttribute('disabled');
  addLog('Validating started', 'success');
  toast('Validating started', 'success');
});

$('#btnStopValidating').addEventListener('click', () => {
  node.stopValidating();
  $('#btnStopValidating').setAttribute('disabled', '');
  $('#btnStartValidating').removeAttribute('disabled');
  addLog('Validating stopped', 'warn');
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
    addLog('FaceID: Loading models...', 'info');
    await loadModels();
    addLog('FaceID: Models loaded', 'success');

    setCameraStatus('<span class="spinner"></span> Starting camera...');
    addLog('FaceID: Starting camera...', 'info');
    cameraStream = await startCamera(video);
    addLog('FaceID: Camera ready', 'success');

    // Step 1: Liveness
    setCameraStatus('<span class="spinner"></span> Step 1/2: Slowly turn your head left and right');
    addLog('FaceID: Step 1/2 — Movement detection started (15s timeout)', 'info');
    const isLive = await detectLiveness(video, 15000, (msg: string) => {
      overlay.textContent = msg;
    });
    if (!isLive) {
      addLog('FaceID: Liveness FAILED — not enough movement detected', 'error');
      toast('Liveness failed — try moving your head more', 'error');
      statusEl.innerHTML = '<span style="color:var(--danger)">Liveness failed. Try again with more head movement.</span>';
      hideCameraModal(); restoreCreateBtn(); return;
    }
    addLog('FaceID: Liveness check PASSED', 'success');

    // Step 2: Face enrollment
    setCameraStatus('<span class="spinner"></span> Step 2/2: Hold still — capturing face map');
    addLog('FaceID: Step 2/2 — Enrolling face (3 samples)...', 'info');
    const faceMap = await enrollFace(video, (step, total, status) => {
      overlay.textContent = `[${step}/${total}] ${status}`;
      setCameraStatus(`<span class="spinner"></span> Step 2/2: Sample ${step}/${total}`);
      addLog(`FaceID: [${step}/${total}] ${status}`, 'info');
    });
    hideCameraModal();

    if (!faceMap) {
      addLog('FaceID: Face enrollment FAILED — could not capture enough samples', 'error');
      toast('Face enrollment failed', 'error');
      statusEl.innerHTML = '<span style="color:var(--danger)">Face enrollment failed. Try again with better lighting.</span>';
      restoreCreateBtn(); return;
    }
    addLog(`FaceID: Face map created (${faceMap.samples} samples, hash: ${faceMap.hash.slice(0, 16)}...)`, 'success');

    statusEl.innerHTML = '<span style="color:var(--accent)"><span class="spinner"></span> Generating keys and encrypting with face...</span>';
    addLog('FaceID: Generating ECDSA key pair...', 'info');

    // Generate ECDSA key pair
    const keys = await generateAccountKeys();
    addLog('FaceID: Key pair generated. Deriving face encryption key (PBKDF2)...', 'info');

    // Encrypt keys with face-derived AES key
    const keyBlob = await createEncryptedKeyBlob(keys, username, faceMap.quantized, faceMap.hash);
    addLog('FaceID: Keys encrypted with face-derived AES-256 key', 'success');

    // Register account
    addLog('FaceID: Registering account on ledger...', 'info');
    statusEl.innerHTML = '<span style="color:var(--accent)"><span class="spinner"></span> Creating account on-chain...</span>';
    const account = buildAccount(username, keys.pub, faceMap.hash);
    node.ledger.registerAccount(account);

    // Create open block (mints 1M UNIT)
    addLog('FaceID: Creating open block (+1M UNIT)...', 'info');
    const openBlock = await node.ledger.openAccount(keys.pub, faceMap.hash, keys);
    addLog(`FaceID: Open block created (hash: ${openBlock.hash.slice(0, 16)}...)`, 'success');

    // Submit through node (publishes to Gun + BroadcastChannel, triggers auto-vote)
    await node.submitBlock(openBlock);
    node.gunNet.saveAccount(keys.pub, { username, pub: keys.pub, balance: 1000000, nonce: 0, createdAt: account.createdAt, faceMapHash: faceMap.hash });
    node.gunNet.saveKeyBlob(keys.pub, keyBlob as unknown as Record<string, unknown>);
    addLog('FaceID: Published block, account, and encrypted key blob', 'success');

    // Store locally
    const fullAcc: AccountWithKeys = { ...account, keys, balance: 1000000 };
    localAccounts.push(fullAcc);
    node.localKeys.set(keys.pub, keys);
    saveWallet();
    addLog('FaceID: Wallet saved locally', 'success');

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
    toast(`Error: ${err}`, 'error');
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

    // Fetch encrypted key blob from Gun
    setCameraStatus('<span class="spinner"></span> Fetching encrypted keys from chain...');
    const blobData = await node.gunNet.findKeyBlobByUsername(username);
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
    };

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
      node.localKeys.set(keys.pub, keys);
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
      node.localKeys.set(keys.pub, keys);
      saveWallet();
    }

    $('#recoverStatus').innerHTML = `<span style="color:var(--success);">Recovered: ${username}</span>`;
    toast(`Recovered: ${username}`, 'success');
    addLog(`Account recovered via key pair: ${username}`, 'success');
    refreshAccount(); refreshTransfer(); refreshContracts();
  } catch { toast('Invalid JSON', 'error'); }
});

// ──── Transfer ────
$('#btnSendTx').addEventListener('click', async () => {
  const from = $<HTMLSelectElement>('#txFrom').value;
  const to = $<HTMLInputElement>('#txTo').value.trim().toLowerCase();
  const amountInput = $<HTMLInputElement>('#txAmount').value;
  const amount = parseUNIT(amountInput);
  if (!from || !to || amount <= 0) { toast('Fill all fields', 'error'); return; }

  const sender = localAccounts.find((a) => a.username === from);
  if (!sender) { toast('Sender not found', 'error'); return; }

  const result = await node.ledger.createSend(sender.pub, to, amount, sender.keys);
  if (result.error) { toast(result.error, 'error'); return; }

  const sub = await node.submitBlock(result.block!);
  if (sub.success) {
    toast(`Sent ${formatUNIT(amount)} UNIT to ${to}`, 'success');
    addLog(`Send: ${formatUNIT(amount)} UNIT to ${to}`, 'success');
    $<HTMLInputElement>('#txAmount').value = '';
    $<HTMLInputElement>('#txTo').value = '';
    refreshTab();
  } else { toast(`Failed: ${sub.error}`, 'error'); }
});

// ──── Explorer ────
$('#explorerLoadMore').addEventListener('click', () => {
  explorerDisplayCount += EXPLORER_PAGE_SIZE;
  refreshExplorer();
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
  if (acc) {
    const chain = node.ledger.getAccountChain(acc.pub);
    detail.innerHTML = `<div class="card"><div class="card-title">Account: ${acc.username}</div><div class="stats-grid">
      <div class="stat-item"><div class="stat-label">Public Key</div><div class="stat-value small">${cpBtn(acc.pub)}${acc.pub}</div></div>
      <div class="stat-item"><div class="stat-label">Balance</div><div class="stat-value">${formatUNIT(node.ledger.getAccountBalance(acc.pub))} UNIT</div></div>
      <div class="stat-item"><div class="stat-label">Chain Length</div><div class="stat-value">${chain.length}</div></div>
      <div class="stat-item"><div class="stat-label">Face Map</div><div class="stat-value small">${cpBtn(acc.faceMapHash)}${trunc(acc.faceMapHash, 20)}</div></div>
    </div></div>`;
    return;
  }

  detail.innerHTML = '<div class="card" style="color:var(--text-muted);text-align:center;">No results found.</div>';
});

// ──── Contracts ────
$('#btnDeployContract').addEventListener('click', async () => {
  const from = $<HTMLSelectElement>('#contractFrom').value;
  const name = $<HTMLInputElement>('#contractName').value.trim();
  const code = $<HTMLTextAreaElement>('#contractCode').value.trim();
  if (!from || !code) { toast('Fill required fields', 'error'); return; }
  const sender = localAccounts.find((a) => a.username === from);
  if (!sender) { toast('Account not found', 'error'); return; }
  const result = await node.ledger.createDeploy(sender.pub, name || 'Unnamed', code, sender.keys);
  if (result.error) { toast(result.error, 'error'); return; }
  const sub = await node.submitBlock(result.block!);
  if (sub.success) { toast('Contract deployed', 'success'); refreshContracts(); }
  else { toast(`Deploy failed: ${sub.error}`, 'error'); }
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
function wireNodeEvents() {
  node.on('block:confirmed', (b: unknown) => {
    const block = b as { type: string; accountPub: string };
    addLog(`Confirmed: ${block.type} by ${resolveName(block.accountPub)}`, 'success');
    refreshTab();
  });
  node.on('block:conflict', (b: unknown) => {
    const block = b as { hash: string; type: string; accountPub: string };
    addLog(`CONFLICT: fork detected for ${block.type} by ${resolveName(block.accountPub)} — voting started`, 'warn');
    refreshTab();
  });
  node.on('block:rejected', (b: unknown) => {
    const block = b as { hash: string };
    addLog(`Rejected: ${trunc(block.hash)}`, 'error');
    refreshTab();
  });
  node.on('peer:connected', (id: unknown) => { addLog(`Peer: ${trunc(String(id))}`, 'info'); refreshNode(); });
  node.on('peer:disconnected', (id: unknown) => { addLog(`Peer left: ${trunc(String(id))}`, 'warn'); refreshNode(); });
  node.on('auto:received', (data: unknown) => {
    const d = data as { from: string; amount: number };
    addLog(`Auto-received: +${formatUNIT(d.amount)} UNIT`, 'success');
    refreshTab();
  });
  node.on('contract:deployed', (data: unknown) => {
    addLog(`Contract: ${(data as { name: string }).name}`, 'success');
    refreshContracts();
  });
  node.on('contract:error', (data: unknown) => {
    addLog(`Contract error: ${(data as { error: string }).error}`, 'error');
  });
  node.on('account:synced', (data: unknown) => {
    const acc = data as { username: string };
    addLog(`Synced account: ${acc.username}`, 'info');
    refreshTab();
  });
  node.on('resync', (data: unknown) => {
    const d = data as { newAccounts: number; newBlocks: number };
    if (d.newAccounts > 0 || d.newBlocks > 0) {
      addLog(`Resync: +${d.newAccounts} accounts, +${d.newBlocks} blocks`, 'info');
      refreshTab();
    }
  });
  node.gunNet.on('relay:connected', (url: unknown) => {
    addLog(`Relay connected: ${url}`, 'success');
  });
  node.gunNet.on('relay:disconnected', (url: unknown) => {
    addLog(`Relay disconnected: ${url}`, 'warn');
  });
}

setInterval(() => refreshTab(), 5000);

// ──── Boot ────
loadWallet();

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
