/**
 * NeuronChain Gun Relay Server (HTTPS)
 *
 * Serves HTTPS with a self-signed cert so browsers can connect
 * directly via WSS — no Vite proxy needed.
 *
 * Usage:   npm run relay
 *
 * IMPORTANT: On mobile, visit https://<IP>:8765/ first and
 * accept the self-signed cert warning, then use the app.
 */

const Gun = require('gun');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const port = process.argv[2] || 8765;
const certDir = path.join(__dirname, '.certs');

function ensureCert() {
  if (!fs.existsSync(certDir)) fs.mkdirSync(certDir);
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=NeuronChain"`,
      { stdio: 'pipe' }
    );
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch {
    console.log('  WARNING: openssl not found — falling back to HTTP');
    return null;
  }
}

const certs = ensureCert();

const handler = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('NeuronChain Gun Relay OK');
};

const server = certs
  ? https.createServer({ key: certs.key, cert: certs.cert }, handler)
  : http.createServer(handler);

Gun({ web: server, file: 'relay-data' });

server.listen(port, '0.0.0.0', () => {
  const proto = certs ? 'https' : 'http';
  const interfaces = require('os').networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }

  console.log('');
  console.log('  NeuronChain Gun Relay');
  console.log('  ─────────────────────');
  console.log(`  ${proto}://localhost:${port}/gun`);
  ips.forEach((ip) => console.log(`  ${proto}://${ip}:${port}/gun`));
  console.log('');
  if (certs) {
    console.log('  Self-signed cert — on each device, visit:');
    console.log(`  ${proto}://${ips[0] || 'localhost'}:${port}/`);
    console.log('  and accept the warning BEFORE using the app.');
  }
  console.log('');
});
